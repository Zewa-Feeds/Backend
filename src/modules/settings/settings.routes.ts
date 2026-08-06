/**
 * Settings routes — /api/v1/admin/settings
 *
 * Admin only (§13). Groups are updated individually so the four CMS tabs save
 * independently and one tab cannot clobber another's values.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '@/middleware/asyncHandler';
import { currentUser, requirePermission } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { auditContext } from '@/modules/audit/audit.service';
import * as settingsService from './settings.service';

export const settingsRouter = Router();

settingsRouter.use(requirePermission('settings.manage'));

const groupParam = z.object({
  group: z.enum(['shipping', 'tax', 'announcement', 'maintenance']),
});

settingsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const settings = await settingsService.getAll();
    res.json({ data: settings });
  }),
);

/**
 * Update one group. The body is validated by that group's own schema inside the
 * service, so each tab's rules (colour hex, PIN format, GST range) apply.
 */
settingsRouter.put(
  '/:group',
  validate({ params: groupParam }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const group = req.params.group as settingsService.SettingsKey;

    const updated = await settingsService.updateGroup(
      group,
      req.body,
      user.id,
      auditContext(req),
    );
    res.json({ data: { [group]: updated } });
  }),
);
