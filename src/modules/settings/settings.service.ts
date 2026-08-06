/**
 * System settings — spec §13.
 *
 * Key/value rows rather than columns, so adding a settings group is a data change
 * rather than a migration. Four keys: shipping, tax, announcement, maintenance.
 *
 * Every read goes through a typed getter with defaults, so a missing or partial
 * row cannot crash checkout or invoice generation. Reads are cached in Redis for
 * 60s because checkout and the PDF path hit them on every request.
 */
import { AuditModule, type Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { redis } from '@/lib/redis';
import { type AuditContext, writeAudit } from '@/modules/audit/audit.service';
import { plainText, richText } from '@/lib/sanitize';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';
import type { TaxConfig } from '@/modules/orders/tax';

const log = logger.child({ module: 'settings' });

const CACHE_KEY = 'settings:all';
const CACHE_TTL_SECONDS = 60;

// ---- Schemas (also the source of defaults) ---------------------------------

export const shippingSchema = z.object({
  freeThresholdPaise: z.number().int().nonnegative().default(99900),
  standardRatePaise: z.number().int().nonnegative().default(6000),
  deliveryText: z.string().max(200).transform(plainText).default('3–5 business days across India'),
  /** PIN codes we do not deliver to (§13). */
  pinBlacklist: z.array(z.string().regex(/^\d{6}$/)).default([]),
});

export const taxSchema = z.object({
  gstRatePct: z.number().min(0).max(50).default(18),
  /** True when listed prices already contain GST — drives reverse-calculation. */
  gstInclusive: z.boolean().default(true),
  gstin: z.string().max(20).transform(plainText).default(''),
});

export const announcementSchema = z.object({
  text: z.string().max(200).transform(plainText).default(''),
  linkLabel: z.string().max(60).transform(plainText).default(''),
  linkUrl: z.string().max(500).default('/'),
  bg: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#080C18'),
  fg: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#44E5C2'),
  active: z.boolean().default(false),
});

export const maintenanceSchema = z.object({
  on: z.boolean().default(false),
  message: z.string().max(2000).transform(richText).default(''),
  endAt: z.string().datetime().nullable().default(null),
});

export const settingsSchema = z.object({
  shipping: shippingSchema,
  tax: taxSchema,
  announcement: announcementSchema,
  maintenance: maintenanceSchema,
});

export type Settings = z.infer<typeof settingsSchema>;
export type SettingsKey = keyof Settings;

const SCHEMAS = {
  shipping: shippingSchema,
  tax: taxSchema,
  announcement: announcementSchema,
  maintenance: maintenanceSchema,
} as const;

// ---- Reads -----------------------------------------------------------------

/**
 * All settings, cached.
 *
 * Each group is parsed through its schema, so defaults fill any gap — a
 * half-populated row degrades to sane values rather than throwing at checkout.
 */
export async function getAll(): Promise<Settings> {
  const cached = await redis.get(CACHE_KEY).catch(() => null);
  if (cached) {
    try {
      return settingsSchema.parse(JSON.parse(cached));
    } catch {
      // Cache poisoned or schema changed since it was written — fall through.
      log.warn('settings cache failed to parse, refetching');
    }
  }

  const rows = await prisma.setting.findMany();
  const raw = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  const settings = settingsSchema.parse({
    shipping: raw.shipping ?? {},
    tax: raw.tax ?? {},
    announcement: raw.announcement ?? {},
    maintenance: raw.maintenance ?? {},
  });

  await redis.setex(CACHE_KEY, CACHE_TTL_SECONDS, JSON.stringify(settings)).catch(() => undefined);
  return settings;
}

export async function get<K extends SettingsKey>(key: K): Promise<Settings[K]> {
  const all = await getAll();
  return all[key];
}

/**
 * Tax config for invoices and checkout.
 *
 * The seller's state comes from env, not the database: it is where the business is
 * registered, not something staff should be able to change from a settings form —
 * getting it wrong silently produces invalid tax invoices.
 */
export async function getTaxConfig(): Promise<TaxConfig> {
  const tax = await get('tax');
  return {
    gstRatePct: tax.gstRatePct,
    gstInclusive: tax.gstInclusive,
    sellerState: env.COMPANY_STATE,
  };
}

/** Public subset for the storefront — no GSTIN, no internal config. */
export async function getPublic() {
  const { shipping, announcement, maintenance, tax } = await getAll();
  return {
    shipping: {
      freeThresholdPaise: shipping.freeThresholdPaise,
      standardRatePaise: shipping.standardRatePaise,
      deliveryText: shipping.deliveryText,
    },
    tax: { gstRatePct: tax.gstRatePct, gstInclusive: tax.gstInclusive },
    announcement: announcement.active ? announcement : null,
    maintenance: maintenance.on ? { on: true, message: maintenance.message, endAt: maintenance.endAt } : { on: false },
  };
}

// ---- Writes ----------------------------------------------------------------

export async function updateGroup<K extends SettingsKey>(
  key: K,
  value: unknown,
  actorId: string,
  ctx: AuditContext,
): Promise<Settings[K]> {
  const parsed = SCHEMAS[key].parse(value) as Settings[K];

  await prisma.$transaction(async (tx) => {
    await tx.setting.upsert({
      where: { key },
      create: { key, value: parsed as Prisma.InputJsonValue, updatedById: actorId },
      update: { value: parsed as Prisma.InputJsonValue, updatedById: actorId },
    });
    await writeAudit(
      ctx,
      { module: AuditModule.SETTINGS, action: `Updated ${key} settings`, recordId: key },
      tx,
    );
  });

  await invalidate();
  return parsed;
}

/** Drop the cache so the next read is fresh — called after every write. */
export async function invalidate(): Promise<void> {
  await redis.del(CACHE_KEY).catch(() => undefined);
}
