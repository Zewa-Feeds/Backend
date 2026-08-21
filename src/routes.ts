/**
 * Route composition — the security boundary of the whole API.
 *
 * Two surfaces, and the difference is STRUCTURAL rather than per-route:
 *
 *   publicRouter  →  /api/v1/*         open (or customer JWT), published data only
 *   adminRouter   →  /api/v1/admin/*   staff JWT + enrolled 2FA
 *
 * The guards mount on the admin ROUTER, so an endpoint is protected because of
 * WHERE IT LIVES — not because someone remembered to decorate it. Adding a file
 * under adminRouter inherits requireAuth + requireEnrolled2fa automatically, and
 * forgetting fails CLOSED.
 *
 * Order below is load-bearing:
 *   1. authRouter mounts FIRST, above the guard, because /login must be reachable
 *      unauthenticated. It guards its own post-session routes individually.
 *   2. adminRouter.use(requireAuth, requireEnrolled2fa) — the blanket guard.
 *   3. Everything after inherits it. Per-route requirePermission() only narrows.
 */
import { Router } from 'express';
import { adminLimiter, publicLimiter } from '@/middleware/rateLimit';
import { requireAuth, requireEnrolled2fa } from '@/middleware/auth';
import { authRouter } from '@/modules/auth/auth.routes';
import { cloudinaryWebhookRouter } from '@/modules/uploads/webhook.routes';
import { usersRouter } from '@/modules/users/users.routes';
import { productsRouter } from '@/modules/products/products.routes';
import { ordersRouter } from '@/modules/orders/orders.routes';
import { settingsRouter } from '@/modules/settings/settings.routes';
import { contentRouter } from '@/modules/content/content.routes';
import { couponsRouter } from '@/modules/coupons/coupons.routes';
import { reviewsRouter } from '@/modules/reviews/reviews.routes';
import { customersRouter } from '@/modules/customers/customers.routes';
import {
  auditRouter,
  dashboardRouter,
  searchRouter,
} from '@/modules/dashboard/dashboard.routes';
import { uploadsRouter } from '@/modules/uploads/uploads.routes';
import { catalogRouter } from '@/modules/catalog/catalog.routes';
import { previewRouter } from '@/modules/catalog/preview.routes';
import { checkoutRouter, trackingRouter } from '@/modules/checkout/checkout.routes';
import { webhookRouter } from '@/modules/checkout/webhook.routes';
import { accountRouter, customerAuthRouter } from '@/modules/customers/account.routes';

export const apiRouter = Router();

// ============================================================================
// PUBLIC — storefront
// ============================================================================
const publicRouter = Router();
publicRouter.use(publicLimiter);

// Catalogue, content, settings, cart, coupon validation and review submission.
/* Cloudinary media notifications. Unauthenticated by necessity — the
   signature is the authentication. See webhook.routes.ts. */
publicRouter.use('/webhooks/cloudinary', cloudinaryWebhookRouter);
publicRouter.use('/', catalogRouter);
// Draft preview — signed short-lived token, scoped to one resource.
publicRouter.use('/preview', previewRouter);
// Checkout and payment confirmation.
publicRouter.use('/checkout', checkoutRouter);
// Guest order tracking: /orders/track?orderNo=&email=
publicRouter.use('/orders', trackingRouter);
// Customer accounts.
publicRouter.use('/auth/customer', customerAuthRouter);
publicRouter.use('/account', accountRouter); // customer session required inside

// ============================================================================
// ADMIN — CMS
// ============================================================================
const adminRouter = Router();
adminRouter.use(adminLimiter);

// --- Public admin surface: login and the 2FA handshake ---------------------
adminRouter.use('/auth', authRouter);

// --- THE GUARD. Everything below this line requires an authenticated staff
//     member with 2FA enrolment complete. ----------------------------------
adminRouter.use(requireAuth, requireEnrolled2fa);

// Each router applies its own permission gate internally, so the permission a
// module requires lives next to its handlers rather than being restated here.
adminRouter.use('/dashboard', dashboardRouter); // all roles; contents filtered by permission
adminRouter.use('/search', searchRouter); // all roles; sections filtered by permission
adminRouter.use('/users', usersRouter); // users.manage
adminRouter.use('/products', productsRouter); // products.view → edit / sku
adminRouter.use('/orders', ordersRouter); // orders.view → status / invoice / refund / export
adminRouter.use('/customers', customersRouter); // customers.view → ban
adminRouter.use('/reviews', reviewsRouter); // reviews.moderate
adminRouter.use('/coupons', couponsRouter); // coupons.edit → delete
adminRouter.use('/content', contentRouter); // articles.* / banners.edit / homepage.edit
adminRouter.use('/uploads', uploadsRouter); // articles.create
adminRouter.use('/audit-log', auditRouter); // audit.own (row-filtered) / audit.all
adminRouter.use('/settings', settingsRouter); // settings.manage

// ============================================================================
// WEBHOOKS — no CORS, no auth. Verified by HMAC signature over the RAW body.
// Mounted from src/modules/checkout/webhook.routes.ts.
// ============================================================================

apiRouter.use('/admin', adminRouter);
apiRouter.use('/webhooks', webhookRouter);
// Mounted last: the public router owns the remaining surface of /api/v1.
apiRouter.use('/', publicRouter);

/** Discovery marker — confirms the mount points without exposing anything. */
apiRouter.get('/', (_req, res) => {
  res.json({
    data: {
      version: 'v1',
      surfaces: {
        public: '/api/v1',
        admin: '/api/v1/admin',
        webhooks: '/api/v1/webhooks',
      },
    },
  });
});
