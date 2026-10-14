/**
 * Scheduled article publishing.
 *
 * An editor (with articles.publish) sets `scheduledAt`. Every minute the
 * maintenance worker publishes whatever has come due, through the same
 * `publishArticle` path a person would use — same validation, same audit, same
 * site publication — attributed to "Scheduler" with the scheduling editor named
 * in the audit text.
 *
 * Due articles are published one site publication at a time per article; a
 * burst of simultaneous schedules is rare enough that batching would add
 * complexity for no visible gain.
 */
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { type AuditContext, writeAuditSafe } from '@/modules/audit/audit.service';
import { AuditModule } from '@prisma/client';
import { publishArticle } from '@/modules/content/content.service';

const log = logger.child({ module: 'site.scheduler' });

export const SCHEDULER_CONTEXT: AuditContext = {
  actorId: null,
  actorName: 'Scheduler',
  actorRole: 'System',
  ip: 'internal',
};

export async function publishDueArticles(now = new Date()): Promise<{ published: number; failed: number }> {
  const due = await prisma.article.findMany({
    where: { deletedAt: null, scheduledAt: { lte: now } },
    select: { slug: true, updatedById: true },
    orderBy: { scheduledAt: 'asc' },
    take: 20,
  });

  let published = 0;
  let failed = 0;
  for (const article of due) {
    try {
      await publishArticle(article.slug, article.updatedById ?? null, SCHEDULER_CONTEXT, { scheduled: true });
      published += 1;
    } catch (err) {
      failed += 1;
      // Clear the schedule so a permanently invalid article is not retried
      // every minute forever; the reason is in the audit log and the article
      // stays a draft for its editor to fix.
      await prisma.article.update({ where: { slug: article.slug }, data: { scheduledAt: null } });
      writeAuditSafe(SCHEDULER_CONTEXT, {
        module: AuditModule.CONTENT,
        action: `Scheduled publish of article "${article.slug}" failed and was cancelled: ${(err as Error).message}`.slice(0, 500),
        recordId: article.slug,
      });
      log.error({ err, slug: article.slug }, 'scheduled article could not be published — schedule cleared');
    }
  }
  return { published, failed };
}
