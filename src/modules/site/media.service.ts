/**
 * Media library — every file the website content can reference.
 *
 * Content never stores a URL; it stores `{ assetId }`. The URL, dimensions and
 * alt text are resolved into the publication snapshot at publish time. That one
 * indirection is what makes three things work:
 *
 *   replace   swap the file behind an asset and every placement using it picks
 *             up the new one on the next publish — no hunting for references
 *   validate  the publish gate checks real dimensions, not what someone typed
 *   remove    "is this used anywhere?" is a lookup, not a guess
 *
 * NOTHING HERE DESTROYS A FILE. Archiving hides an asset from the picker; a
 * replaced file is kept and recorded. Rollback has to be able to republish any
 * retained version, and that version may point at a file this library has since
 * moved on from.
 */
import type { Prisma} from '@prisma/client';
import { AuditModule, MediaStorage, MediaType, UploadTicketStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AppError, ErrorCode, conflict, notConfigured, notFound } from '@/lib/errors';
import { type AuditContext, writeAudit } from '@/modules/audit/audit.service';
import { probeAsset } from '@/integrations/cloudinary/cloudinary.service';
import { env } from '@/config/env';
import type { z } from 'zod';
import type { mediaListQuerySchema, registerMediaSchema, updateMediaSchema } from './site.schemas';
import { collectAssetIds } from './resolve';

type ListQuery = z.infer<typeof mediaListQuerySchema>;
type RegisterBody = z.infer<typeof registerMediaSchema>;
type UpdateBody = z.infer<typeof updateMediaSchema>;

export const MEDIA_SELECT = {
  id: true,
  storage: true,
  type: true,
  publicId: true,
  url: true,
  format: true,
  mimeType: true,
  width: true,
  height: true,
  bytes: true,
  durationSec: true,
  posterUrl: true,
  title: true,
  altText: true,
  tags: true,
  revision: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: { name: true } },
} satisfies Prisma.MediaAssetSelect;

export type MediaRow = Prisma.MediaAssetGetPayload<{ select: typeof MEDIA_SELECT }>;

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
};

export const mimeFor = (format: string | null | undefined) =>
  (format && MIME[format.toLowerCase()]) || null;

/**
 * Where the CMS can actually load the file from.
 *
 * STATIC files are site-relative paths ("/videos/brand_poster.jpg") served by
 * the storefront. In the CMS — a different origin — that path resolves against
 * the CMS and 404s, so every thumbnail and crop preview was blank. `url` stays
 * relative (it is what the storefront renders); this is for display only.
 */
export function displayUrlFor(storage: MediaStorage, url: string): string {
  if (storage !== MediaStorage.STATIC) return url;
  // Per segment: encodeURI leaves '&' alone, and "Incorporation& first
  // office.jpg" then 404s on the storefront's static file server.
  const path = url.split('/').map(encodeURIComponent).join('/');
  return `${env.STOREFRONT_ORIGIN.replace(/\/$/, '')}${path}`;
}

export function serializeMedia(m: MediaRow, usages?: Usage[]) {
  return {
    id: m.id,
    storage: m.storage,
    type: m.type,
    url: m.url,
    displayUrl: displayUrlFor(m.storage, m.url),
    posterDisplayUrl: m.posterUrl ? displayUrlFor(m.storage, m.posterUrl) : null,
    format: m.format,
    mimeType: m.mimeType,
    width: m.width,
    height: m.height,
    bytes: m.bytes,
    durationSec: m.durationSec,
    posterUrl: m.posterUrl,
    title: m.title,
    altText: m.altText,
    tags: m.tags,
    revision: m.revision,
    archived: Boolean(m.archivedAt),
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    createdBy: m.createdBy?.name ?? null,
    ...(usages ? { usages, usageCount: usages.length } : {}),
  };
}

// ============================================================================
// USAGE
// ============================================================================

export interface Usage {
  /** Where, in words an editor recognises. */
  label: string;
  /** draft = the website workspace; live = the version customers see. */
  scope: 'draft' | 'live' | 'article' | 'spotlight';
  href?: string;
}

/**
 * Every place an asset is referenced, for a set of asset ids.
 *
 * Scans by value. The content is small — one draft document, one current
 * snapshot, a few dozen articles — so a scan is cheaper and far harder to get
 * wrong than a reference table that every writer would have to maintain.
 */
export async function usagesFor(assetIds: string[]): Promise<Map<string, Usage[]>> {
  const wanted = new Set(assetIds);
  const result = new Map<string, Usage[]>(assetIds.map((id) => [id, []]));
  const add = (id: string, usage: Usage) => {
    if (!wanted.has(id)) return;
    const list = result.get(id)!;
    if (!list.some((u) => u.label === usage.label && u.scope === usage.scope)) list.push(usage);
  };

  const [draft, current, articles, assets] = await Promise.all([
    prisma.siteContentDraft.findUnique({ where: { key: 'site' }, select: { sections: true } }),
    prisma.sitePublication.findFirst({ where: { isCurrent: true }, select: { snapshot: true, version: true } }),
    prisma.article.findMany({
      where: { deletedAt: null },
      select: {
        slug: true,
        title: true,
        coverAssetId: true,
        coverMobileAssetId: true,
        contentBlocks: true,
        draftPayload: true,
      },
    }),
    prisma.mediaAsset.findMany({ where: { id: { in: assetIds } }, select: { id: true, url: true } }),
  ]);

  if (draft) {
    for (const [id, where] of collectAssetIds(draft.sections)) add(id, { label: `Website draft — ${where}`, scope: 'draft', href: '/content/website' });
  }
  if (current) {
    const snap = current.snapshot as { sections?: unknown; articles?: unknown };
    for (const [id, where] of collectAssetIds(snap.sections)) add(id, { label: `Live site v${current.version} — ${where}`, scope: 'live', href: '/content/publishing' });
    for (const [id, where] of collectAssetIds(snap.articles)) add(id, { label: `Live site v${current.version} — ${where}`, scope: 'live', href: '/content/publishing' });
  }
  for (const a of articles) {
    const label = `Article “${a.title}”`;
    const href = `/content/articles/${a.slug}/edit`;
    if (a.coverAssetId) add(a.coverAssetId, { label: `${label} — cover`, scope: 'article', href });
    if (a.coverMobileAssetId) add(a.coverMobileAssetId, { label: `${label} — mobile cover`, scope: 'article', href });
    for (const [id] of collectAssetIds(a.contentBlocks)) add(id, { label: `${label} — body`, scope: 'article', href });
    for (const [id] of collectAssetIds(a.draftPayload)) add(id, { label: `${label} — unpublished changes`, scope: 'article', href });
    const overlay = a.draftPayload as { coverAssetId?: string; coverMobileAssetId?: string } | null;
    if (overlay?.coverAssetId) add(overlay.coverAssetId, { label: `${label} — cover (unpublished)`, scope: 'article', href });
    if (overlay?.coverMobileAssetId) add(overlay.coverMobileAssetId, { label: `${label} — mobile cover (unpublished)`, scope: 'article', href });
  }

  // Spotlights still store a plain URL (they predate the library).
  if (assets.length) {
    const spotlights = await prisma.spotlight.findMany({
      where: { imageUrl: { in: assets.map((a) => a.url) } },
      select: { imageUrl: true, family: { select: { name: true } } },
    });
    for (const s of spotlights) {
      const asset = assets.find((a) => a.url === s.imageUrl);
      if (asset) add(asset.id, { label: `Spotlight — ${s.family.name}`, scope: 'spotlight', href: '/content/banners' });
    }
  }

  return result;
}

// ============================================================================
// QUERIES
// ============================================================================

export async function listMedia(params: ListQuery) {
  const where: Prisma.MediaAssetWhereInput = {
    archivedAt: params.archived === 'true' ? { not: null } : null,
    ...(params.type ? { type: params.type as MediaType } : {}),
    ...(params.q
      ? {
          OR: [
            { title: { contains: params.q, mode: 'insensitive' } },
            { altText: { contains: params.q, mode: 'insensitive' } },
            { url: { contains: params.q, mode: 'insensitive' } },
            { tags: { has: params.q.toLowerCase() } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.mediaAsset.findMany({
      where,
      select: MEDIA_SELECT,
      orderBy: { createdAt: 'desc' },
      skip: (params.page - 1) * params.limit,
      take: params.limit,
    }),
    prisma.mediaAsset.count({ where }),
  ]);

  const usages = await usagesFor(rows.map((r) => r.id));
  return {
    data: rows.map((r) => serializeMedia(r, usages.get(r.id))),
    meta: { page: params.page, limit: params.limit, total, pages: Math.max(1, Math.ceil(total / params.limit)) },
  };
}

export async function getMedia(id: string) {
  const row = await prisma.mediaAsset.findUnique({ where: { id }, select: MEDIA_SELECT });
  if (!row) throw notFound('Media');
  const usages = await usagesFor([id]);
  return serializeMedia(row, usages.get(id));
}

// ============================================================================
// MUTATIONS
// ============================================================================

/**
 * Read an uploaded file's facts from Cloudinary rather than from the client.
 *
 * The browser could report any width it likes; validation against the
 * placement spec is only meaningful if the numbers come from the CDN.
 */
async function factsFromCloudinary(publicId: string) {
  const ticket = await prisma.uploadTicket.findUnique({
    where: { publicId },
    select: { id: true, resourceType: true, status: true },
  });
  // Only files this API signed may enter the library — a client cannot register
  // an arbitrary asset in the account (or someone else's URL).
  if (!ticket) throw new AppError(422, ErrorCode.VALIDATION_FAILED, 'That upload was not signed by this CMS.');

  if (!env.CLOUDINARY_CLOUD_NAME) throw notConfigured('Cloudinary');
  const resourceType = ticket.resourceType === 'video' ? 'video' : 'image';
  const probe = await probeAsset(publicId, resourceType);
  if (!probe) throw new AppError(502, ErrorCode.UPSTREAM_FAILED, 'Could not reach Cloudinary to read the file. Try again.');
  if (!probe.exists) throw new AppError(422, ErrorCode.VALIDATION_FAILED, 'Cloudinary has no file for that upload — it may have failed.');

  const type = resourceType === 'video' ? MediaType.VIDEO : MediaType.IMAGE;
  const format = probe.format?.toLowerCase() ?? null;
  const url =
    probe.secureUrl ??
    `https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/${resourceType}/upload/${publicId}${format ? `.${format}` : ''}`;

  return {
    ticketId: ticket.id,
    type,
    url,
    format,
    mimeType: mimeFor(format),
    width: probe.width ?? null,
    height: probe.height ?? null,
    bytes: probe.bytes ?? null,
    durationSec: probe.durationSec ?? null,
    posterUrl:
      type === MediaType.VIDEO
        ? `https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/video/upload/so_0,q_auto,f_jpg/${publicId}.jpg`
        : null,
  };
}

const titleFromId = (publicId: string) => publicId.split('/').pop() ?? publicId;

export async function registerUpload(body: RegisterBody, actorId: string, ctx: AuditContext) {
  const existing = await prisma.mediaAsset.findUnique({ where: { publicId: body.publicId }, select: MEDIA_SELECT });
  // Registering twice (a double-click, a retried request) is a no-op.
  if (existing) return serializeMedia(existing, []);

  const facts = await factsFromCloudinary(body.publicId);

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.mediaAsset.create({
      data: {
        storage: MediaStorage.CLOUDINARY,
        type: facts.type,
        publicId: body.publicId,
        url: facts.url,
        format: facts.format,
        mimeType: facts.mimeType,
        width: facts.width,
        height: facts.height,
        bytes: facts.bytes,
        durationSec: facts.durationSec,
        posterUrl: facts.posterUrl,
        title: body.title || titleFromId(body.publicId),
        altText: body.altText ?? '',
        tags: (body.tags ?? []).map((t) => t.toLowerCase()),
        createdById: actorId,
      },
      select: MEDIA_SELECT,
    });
    // ATTACHED, so the orphan sweep never mistakes a library file for an
    // abandoned upload.
    await tx.uploadTicket.update({
      where: { id: facts.ticketId },
      data: { status: UploadTicketStatus.ATTACHED, attachedAt: new Date() },
    });
    await writeAudit(
      ctx,
      { module: AuditModule.CONTENT, action: `Added “${row.title}” to the media library`, recordId: row.id },
      tx,
    );
    return row;
  });

  return serializeMedia(created, []);
}

export async function updateMedia(id: string, body: UpdateBody, ctx: AuditContext) {
  const existing = await prisma.mediaAsset.findUnique({ where: { id }, select: { title: true, altText: true, tags: true } });
  if (!existing) throw notFound('Media');

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.mediaAsset.update({
      where: { id },
      data: {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.altText !== undefined ? { altText: body.altText } : {}),
        ...(body.tags !== undefined ? { tags: body.tags.map((t) => t.toLowerCase()) } : {}),
      },
      select: MEDIA_SELECT,
    });
    await writeAudit(
      ctx,
      {
        module: AuditModule.CONTENT,
        action: `Updated details of “${row.title}”`,
        recordId: id,
        diff: { before: existing, after: { title: row.title, altText: row.altText, tags: row.tags } } as Prisma.InputJsonValue,
      },
      tx,
    );
    return row;
  });
  return getMedia(updated.id);
}

/**
 * Put a new file behind an existing asset.
 *
 * The id stays, so every draft placement and article using it shows the new
 * file immediately, and the live site switches on the next publish. The old
 * file is recorded and KEPT: the current publication (and any rollback target)
 * still serves it until a new version replaces them.
 */
export async function replaceFile(id: string, publicId: string, ctx: AuditContext) {
  const existing = await prisma.mediaAsset.findUnique({
    where: { id },
    select: { id: true, type: true, url: true, publicId: true, title: true, archivedAt: true, previousUrls: true },
  });
  if (!existing) throw notFound('Media');
  if (existing.archivedAt) throw conflict('Restore this file before replacing it.');
  if (existing.publicId === publicId) throw conflict('That is already the current file.');

  const taken = await prisma.mediaAsset.findUnique({ where: { publicId }, select: { id: true } });
  if (taken) throw conflict('That upload already belongs to another library item.');

  const facts = await factsFromCloudinary(publicId);
  if (facts.type !== existing.type) {
    throw new AppError(
      422,
      ErrorCode.VALIDATION_FAILED,
      `Replace a ${existing.type.toLowerCase()} with another ${existing.type.toLowerCase()} — placements expect the same kind of file.`,
    );
  }

  const history = Array.isArray(existing.previousUrls) ? (existing.previousUrls as Prisma.JsonArray) : [];

  await prisma.$transaction(async (tx) => {
    await tx.mediaAsset.update({
      where: { id },
      data: {
        storage: MediaStorage.CLOUDINARY,
        publicId,
        url: facts.url,
        format: facts.format,
        mimeType: facts.mimeType,
        width: facts.width,
        height: facts.height,
        bytes: facts.bytes,
        durationSec: facts.durationSec,
        posterUrl: facts.posterUrl,
        revision: { increment: 1 },
        previousUrls: [
          ...history,
          { url: existing.url, publicId: existing.publicId, replacedAt: new Date().toISOString() },
        ] as Prisma.InputJsonValue,
        ...(existing.publicId ? { previousPublicIds: { push: existing.publicId } } : {}),
      },
    });
    await tx.uploadTicket.update({
      where: { id: facts.ticketId },
      data: { status: UploadTicketStatus.ATTACHED, attachedAt: new Date() },
    });
    await writeAudit(
      ctx,
      {
        module: AuditModule.CONTENT,
        action: `Replaced the file behind “${existing.title}”`,
        recordId: id,
        diff: { before: { url: existing.url }, after: { url: facts.url } },
      },
      tx,
    );
  });

  return getMedia(id);
}

/**
 * Hide an asset from the picker.
 *
 * Refused while anything references it — the draft, an article, a spotlight or
 * the live site. Archiving is reversible and never deletes the file.
 */
export async function archiveMedia(id: string, ctx: AuditContext) {
  const existing = await prisma.mediaAsset.findUnique({ where: { id }, select: { title: true, archivedAt: true } });
  if (!existing) throw notFound('Media');
  if (existing.archivedAt) return getMedia(id);

  const usages = (await usagesFor([id])).get(id) ?? [];
  if (usages.length > 0) {
    throw new AppError(409, ErrorCode.CONFLICT, `“${existing.title}” is still in use (${usages.length} place${usages.length === 1 ? '' : 's'}). Remove it from those first.`, {
      details: { usages },
    });
  }

  await prisma.$transaction(async (tx) => {
    await tx.mediaAsset.update({ where: { id }, data: { archivedAt: new Date() } });
    await writeAudit(ctx, { module: AuditModule.CONTENT, action: `Archived “${existing.title}”`, recordId: id }, tx);
  });
  return getMedia(id);
}

export async function restoreMedia(id: string, ctx: AuditContext) {
  const existing = await prisma.mediaAsset.findUnique({ where: { id }, select: { title: true } });
  if (!existing) throw notFound('Media');
  await prisma.$transaction(async (tx) => {
    await tx.mediaAsset.update({ where: { id }, data: { archivedAt: null } });
    await writeAudit(ctx, { module: AuditModule.CONTENT, action: `Restored “${existing.title}”`, recordId: id }, tx);
  });
  return getMedia(id);
}
