/**
 * Clear the per-article colours the old CMS colour picker saved by default.
 *
 * Article colour is now automatic from the category (site/categoryColor.ts),
 * with `tagColor` kept only for a DELIBERATE override. The old editor always
 * submitted a colour — "#44e5c2" if nobody touched it — so every existing
 * article carries one, and would otherwise count as an override forever.
 *
 * Clears `tagColor` on every article, and inside `draftPayload` for articles
 * with unpublished edits. Prints each article's previous colour so any that
 * were meant to stay can be set again as a custom colour in the CMS. Dry run
 * unless --apply. The live site changes at the next publication.
 *
 *   npx tsx scripts/clear-article-colours.ts [--apply]
 */
import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

async function main() {
  const articles = await prisma.article.findMany({
    where: { deletedAt: null },
    select: { id: true, slug: true, tag: true, tagColor: true, draftPayload: true },
    orderBy: { slug: 'asc' },
  });
  for (const a of articles) {
    const draft = a.draftPayload as Record<string, unknown> | null;
    const draftColour = draft && typeof draft === 'object' ? (draft.tagColor as string | null | undefined) : undefined;
    if (!a.tagColor && !draftColour) continue;
    console.log(`${apply ? 'CLEAR' : 'DRY  '} ${a.slug} [${a.tag}] colour ${a.tagColor ?? '—'}${draftColour ? `, draft ${draftColour}` : ''}`);
    if (!apply) continue;
    await prisma.article.update({
      where: { id: a.id },
      data: {
        tagColor: null,
        ...(draftColour ? { draftPayload: { ...draft!, tagColor: null } as Prisma.InputJsonValue } : {}),
      },
    });
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
