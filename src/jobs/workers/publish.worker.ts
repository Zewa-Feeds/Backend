/**
 * Website publish worker — see modules/site/publisher.ts for what a run does.
 *
 * Concurrency 1, across the queue: two regenerations racing each other would
 * each read back pages the other had just invalidated, and neither could prove
 * anything. Publications are minutes apart; serialising them costs nothing.
 */
import { Worker } from 'bullmq';
import { queueRedis } from '@/lib/redis';
import { logger } from '@/lib/logger';
import { QUEUE_NAMES, type SitePublishJob } from '@/jobs/queues';
import { guardWorker } from '@/jobs/workers/guard';
import { recordFailure, runPublication } from '@/modules/site/publisher';
import { enqueuePublish } from '@/modules/site/site.service';

const log = logger.child({ module: 'worker.publish' });

export function startPublishWorker(): Worker<SitePublishJob> {
  const worker = new Worker<SitePublishJob>(
    QUEUE_NAMES.publish,
    async (job) => {
      try {
        return await runPublication(job.data.publicationId, job.data.mode);
      } catch (err) {
        const final = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
        const next = await recordFailure(job.data.publicationId, err as Error, final);
        if (next === 'escalated') {
          log.warn({ publicationId: job.data.publicationId }, 'targeted regeneration failed — triggering a full rebuild');
          await enqueuePublish(job.data.publicationId, 'deploy-hook', `escalated-${Date.now()}`);
          return { result: 'escalated' };
        }
        throw err;
      }
    },
    {
      connection: queueRedis,
      concurrency: 1,
      // Verification polls for up to 20 minutes on a full rebuild; BullMQ
      // renews the lock while the processor runs, this is the renewal window.
      lockDuration: 60_000,
    },
  );

  worker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, err: err.message }, 'website publish attempt failed');
  });

  guardWorker(worker, 'publish');
  return worker;
}
