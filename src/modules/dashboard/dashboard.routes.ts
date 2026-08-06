/**
 * Dashboard, global search and audit log routes.
 *
 * Dashboard (§4) and search (§3.1) are available to every authenticated role, but
 * both filter their contents by permission — an Editor's dashboard omits order and
 * review counts, and their search returns products only.
 *
 * The audit log (§12.2) is the one place with ROW-LEVEL filtering: `audit.all`
 * (Admin) sees everything, `audit.own` (Ops) sees only their own entries.
 */
import { Router } from 'express';
import { AuditModule } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '@/middleware/asyncHandler';
import { currentUser, requirePermission } from '@/middleware/auth';
import { enumFilter, paginationSchema, validate } from '@/middleware/validate';
import * as dashboardService from './dashboard.service';

export const dashboardRouter = Router();

/** §4 — three counters plus the activity feed, in one call. */
dashboardRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const [counters, activity] = await Promise.all([
      dashboardService.counters(user.role),
      dashboardService.activity(user.role),
    ]);
    res.json({ data: { counters, activity } });
  }),
);

/** §3.1 — topbar search across orders, customers and products. */
export const searchRouter = Router();

searchRouter.get(
  '/',
  validate({ query: z.object({ q: z.string().trim().min(1).max(120) }) }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const results = await dashboardService.search(req.query.q as string, user.role);
    res.json({ data: results });
  }),
);

/** §12 — append-only audit log. */
export const auditRouter = Router();

// audit.own is the lower bar; Admins additionally hold audit.all, which widens
// the scope inside the service.
auditRouter.use(requirePermission('audit.own'));

auditRouter.get(
  '/',
  validate({
    query: paginationSchema.extend({
      module: enumFilter(z.nativeEnum(AuditModule)),
      actorId: z.string().uuid().optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const result = await dashboardService.listAudit(req.query as never, user.role, user.id);
    res.json(result);
  }),
);

/** Actor list for the §12.2 user filter — only useful to those who see all. */
auditRouter.get(
  '/actors',
  requirePermission('audit.all'),
  asyncHandler(async (_req, res) => {
    res.json({ data: await dashboardService.auditActors() });
  }),
);
