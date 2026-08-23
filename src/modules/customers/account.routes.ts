/**
 * Customer accounts — /api/v1/auth/customer/* and /api/v1/account/*
 *
 * Separate from staff auth by design: customers get a single-factor session (no
 * mandatory 2FA — that would be hostile for a shop), a different token type, and a
 * different table. A customer token can never satisfy a staff guard because
 * `verifyAccessToken` checks the `typ` claim.
 *
 * Registration is optional throughout — guest checkout works, and a guest's past
 * orders are adopted by email when they later register.
 */
import { Router } from 'express';
import { CustomerStatus, OrderStatus, PaymentStatus } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '@/middleware/asyncHandler';
import {
  emailSchema,
  phoneSchema,
  pincodeSchema,
  validate,
} from '@/middleware/validate';
import { loginLimiter, passwordResetLimiter } from '@/middleware/rateLimit';
import { fakeVerify, generateToken, hashPassword, hashToken, verifyPassword } from '@/lib/crypto';
import { sendAccountEmail } from '@/modules/customers/account.mailer';
import { env } from '@/config/env';
import { signCustomerToken, verifyCustomerToken } from '@/lib/tokens';
import { AppError, ErrorCode, notFound, unauthenticated } from '@/lib/errors';
import { plainText } from '@/lib/sanitize';
import { prisma } from '@/lib/prisma';
import * as ordersService from '@/modules/orders/orders.service';
import { logger } from '@/lib/logger';
import { ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS, formatAddress } from '@/modules/orders/orders.serializer';
import { toRupees } from '@/modules/products/products.serializer';
import {
  buildTimeline,
  customerCancelBlockedReason,
  isCustomerCancellable,
} from '@/modules/orders/lifecycle';
import { generateInvoicePdf } from '@/integrations/pdf/invoice';
import { getTaxConfig } from '@/modules/settings/settings.service';
import type { RequestHandler } from 'express';

const log = logger.child({ module: 'customer.auth' });

export const customerAuthRouter = Router();
export const accountRouter = Router();

/** Minimum viable password policy for customers — deliberately gentler than §14.2
 * for staff, but still long enough to resist casual guessing. */
const customerPasswordSchema = z
  .string()
  .min(8, 'Use at least 8 characters.')
  .max(72, 'Use 72 characters or fewer.');

/**
 * Customer session guard.
 *
 * Checks the BANNED flag on every request (§7.2: banning prevents login), so a ban
 * takes effect immediately rather than when the token expires.
 */
export const requireCustomer: RequestHandler = async (req, _res, next) => {
  try {
    const header = req.get('authorization');
    if (!header?.startsWith('Bearer ')) throw unauthenticated('Sign in to continue.');

    const claims = verifyCustomerToken(header.slice(7).trim());

    /*
     * Selects the whole profile, not just the identity.
     *
     * This row has to be read on every /account/* request regardless — the ban
     * check below is the reason — so the four extra columns are free, and
     * `/account/me` no longer needs a query of its own. One round trip saved
     * per request against a database that is ~180ms away.
     */
    const customer = await prisma.customer.findUnique({
      where: { id: claims.sub },
      select: {
        id: true,
        email: true,
        status: true,
        firstName: true,
        lastName: true,
        phone: true,
        registeredAt: true,
      },
    });
    if (!customer) throw unauthenticated('Account not found.', ErrorCode.TOKEN_INVALID);

    if (customer.status === CustomerStatus.BANNED) {
      throw new AppError(403, ErrorCode.ACCOUNT_BANNED, 'Your account has been suspended.');
    }

    /*
     * `status` is dropped here on purpose. It is the guard's business and
     * nothing downstream should branch on it — leaving it off the principal
     * makes it impossible for a handler to leak it into a response.
     */
    req.customer = {
      id: customer.id,
      email: customer.email,
      firstName: customer.firstName,
      lastName: customer.lastName,
      phone: customer.phone,
      registeredAt: customer.registeredAt,
    };
    next();
  } catch (err) {
    next(err);
  }
};

// ============================================================================
// AUTH
// ============================================================================

const VERIFICATION_TTL_HOURS = 24;

customerAuthRouter.post(
  '/register',
  loginLimiter,
  validate({
    body: z.object({
      firstName: z.string().trim().min(1, 'Enter your first name.').max(60).transform(plainText),
      lastName: z.string().trim().min(1, 'Enter your last name.').max(60).transform(plainText),
      email: emailSchema,
      phone: phoneSchema.optional(),
      password: customerPasswordSchema,
    }),
  }),
  asyncHandler(async (req, res) => {
    const existing = await prisma.customer.findUnique({
      where: { email: req.body.email },
      select: { id: true, passwordHash: true, status: true },
    });

    // A guest who has ordered before has a row with no password — claim it rather
    // than rejecting, so their order history carries over.
    if (existing?.passwordHash) {
      throw new AppError(409, ErrorCode.CONFLICT, 'An account with that email already exists.', {
        fields: { email: 'Already registered — try signing in.' },
      });
    }
    if (existing?.status === CustomerStatus.BANNED) {
      throw new AppError(403, ErrorCode.ACCOUNT_BANNED, 'Your account has been suspended.');
    }

    const passwordHash = await hashPassword(req.body.password);

    const customer = existing
      ? await prisma.customer.update({
          where: { id: existing.id },
          data: {
            passwordHash,
            firstName: req.body.firstName,
            lastName: req.body.lastName,
            emailVerifiedAt: null,
            ...(req.body.phone ? { phone: req.body.phone } : {}),
          },
          select: { id: true, email: true, firstName: true, lastName: true },
        })
      : await prisma.customer.create({
          data: {
            email: req.body.email,
            firstName: req.body.firstName,
            lastName: req.body.lastName,
            phone: req.body.phone ?? null,
            passwordHash,
            emailVerifiedAt: null,
          },
          select: { id: true, email: true, firstName: true, lastName: true },
        });

    // Invalidate any old verification tokens for this customer
    await prisma.customerEmailVerification.updateMany({
      where: { customerId: customer.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    const verifyToken = generateToken(32);
    await prisma.customerEmailVerification.create({
      data: {
        customerId: customer.id,
        tokenHash: hashToken(verifyToken),
        expiresAt: new Date(Date.now() + VERIFICATION_TTL_HOURS * 3600 * 1000),
      },
    });

    sendAccountEmail(customer.email, 'customer-email-verification', {
      firstName: customer.firstName,
      verifyUrl: `${env.STOREFRONT_ORIGIN}/verify-email?token=${encodeURIComponent(verifyToken)}`,
      expiresInHours: VERIFICATION_TTL_HOURS,
    });

    log.info({ customerId: customer.id }, 'customer registered; verification email sent');

    res.status(201).json({
      data: {
        pendingVerification: true,
        email: customer.email,
        message: 'Account created. Please check your email to verify your account.',
      },
    });
  }),
);

customerAuthRouter.post(
  '/verify-email',
  loginLimiter,
  validate({
    body: z.object({
      token: z.string().min(1, 'Verification link is missing its token.').max(200),
    }),
  }),
  asyncHandler(async (req, res) => {
    const record = await prisma.customerEmailVerification.findUnique({
      where: { tokenHash: hashToken(req.body.token) },
      select: {
        id: true,
        usedAt: true,
        expiresAt: true,
        customer: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            status: true,
            emailVerifiedAt: true,
          },
        },
      },
    });

    if (!record) {
      throw new AppError(
        400,
        ErrorCode.TOKEN_INVALID,
        'This verification link is invalid or has expired. Please request a new one.',
      );
    }

    if (record.usedAt) {
      if (record.customer.emailVerifiedAt) {
        return res.json({
          data: {
            alreadyVerified: true,
            message: 'Your email address is already verified. You can sign in to your account.',
          },
        });
      }
      throw new AppError(
        400,
        ErrorCode.TOKEN_INVALID,
        'This verification link has already been used. Please request a new one.',
      );
    }

    if (record.expiresAt < new Date()) {
      throw new AppError(
        400,
        ErrorCode.TOKEN_EXPIRED,
        'This verification link has expired. Please request a new one.',
        { details: { expired: true, email: record.customer.email } },
      );
    }

    if (record.customer.status === CustomerStatus.BANNED) {
      throw new AppError(403, ErrorCode.ACCOUNT_BANNED, 'Your account has been suspended.');
    }

    await prisma.$transaction([
      prisma.customer.update({
        where: { id: record.customer.id },
        data: { emailVerifiedAt: new Date() },
      }),
      prisma.customerEmailVerification.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
      prisma.customerEmailVerification.updateMany({
        where: { customerId: record.customer.id, usedAt: null },
        data: { usedAt: new Date() },
      }),
    ]);

    log.info({ customerId: record.customer.id }, 'customer email verified');

    res.json({
      data: {
        verified: true,
        accessToken: signCustomerToken({ sub: record.customer.id, email: record.customer.email }),
        customer: {
          id: record.customer.id,
          email: record.customer.email,
          firstName: record.customer.firstName,
          lastName: record.customer.lastName,
        },
      },
    });
  }),
);

customerAuthRouter.post(
  '/resend-verification',
  passwordResetLimiter,
  validate({ body: z.object({ email: emailSchema }) }),
  asyncHandler(async (req, res) => {
    const customer = await prisma.customer.findUnique({
      where: { email: req.body.email },
      select: {
        id: true,
        email: true,
        firstName: true,
        passwordHash: true,
        status: true,
        emailVerifiedAt: true,
      },
    });

    if (
      customer?.passwordHash &&
      customer.status !== CustomerStatus.BANNED &&
      !customer.emailVerifiedAt
    ) {
      await prisma.customerEmailVerification.updateMany({
        where: { customerId: customer.id, usedAt: null },
        data: { usedAt: new Date() },
      });

      const verifyToken = generateToken(32);
      await prisma.customerEmailVerification.create({
        data: {
          customerId: customer.id,
          tokenHash: hashToken(verifyToken),
          expiresAt: new Date(Date.now() + VERIFICATION_TTL_HOURS * 3600 * 1000),
        },
      });

      sendAccountEmail(customer.email, 'customer-email-verification', {
        firstName: customer.firstName,
        verifyUrl: `${env.STOREFRONT_ORIGIN}/verify-email?token=${encodeURIComponent(verifyToken)}`,
        expiresInHours: VERIFICATION_TTL_HOURS,
      });

      log.info({ customerId: customer.id }, 'verification email resent');
    }

    res.json({
      data: {
        message: 'If an unverified account exists for that email, a verification link has been sent.',
      },
    });
  }),
);

customerAuthRouter.post(
  '/login',
  loginLimiter,
  validate({
    body: z.object({
      email: emailSchema,
      password: z.string().min(1).max(200),
      /** "Keep me signed in" — lengthens the token's own TTL, not just storage. */
      remember: z.boolean().optional().default(false),
    }),
  }),
  asyncHandler(async (req, res) => {
    const customer = await prisma.customer.findUnique({
      where: { email: req.body.email },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        passwordHash: true,
        status: true,
        emailVerifiedAt: true,
      },
    });

    // Constant-work path for unknown accounts and guest rows, so response timing
    // does not reveal which emails have passwords.
    if (!customer?.passwordHash) {
      await fakeVerify();
      throw new AppError(401, ErrorCode.INVALID_CREDENTIALS, 'Incorrect email or password.');
    }
    if (!(await verifyPassword(req.body.password, customer.passwordHash))) {
      throw new AppError(401, ErrorCode.INVALID_CREDENTIALS, 'Incorrect email or password.');
    }
    if (customer.status === CustomerStatus.BANNED) {
      throw new AppError(403, ErrorCode.ACCOUNT_BANNED, 'Your account has been suspended.');
    }
    if (!customer.emailVerifiedAt) {
      throw new AppError(
        403,
        ErrorCode.EMAIL_UNVERIFIED,
        'Please verify your email address before signing in.',
        { details: { email: customer.email, unverified: true } },
      );
    }

    res.json({
      data: {
        accessToken: signCustomerToken(
          { sub: customer.id, email: customer.email },
          { remember: req.body.remember },
        ),
        customer: {
          id: customer.id,
          email: customer.email,
          firstName: customer.firstName,
          lastName: customer.lastName,
        },
      },
    });
  }),
);

/**
 * Forgot password.
 *
 * Always returns 200, whether or not the address exists — otherwise this becomes
 * an account-enumeration oracle.
 */
const RESET_TTL_MINUTES = 60;

customerAuthRouter.post(
  '/forgot-password',
  passwordResetLimiter,
  validate({ body: z.object({ email: emailSchema }) }),
  asyncHandler(async (req, res) => {
    const customer = await prisma.customer.findUnique({
      where: { email: req.body.email },
      select: { id: true, email: true, firstName: true, passwordHash: true, status: true },
    });

    // Guest rows (no password) and banned accounts get the same silent no-op as
    // an unknown address — issuing a token for either would let someone set a
    // password on an account that was never registered, or unban themselves.
    if (customer?.passwordHash && customer.status !== CustomerStatus.BANNED) {
      // Outstanding tokens are burned first: requesting a new link must retire
      // the old one, or an intercepted earlier email stays usable.
      await prisma.customerPasswordReset.updateMany({
        where: { customerId: customer.id, usedAt: null },
        data: { usedAt: new Date() },
      });

      const token = generateToken();
      await prisma.customerPasswordReset.create({
        data: {
          customerId: customer.id,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60_000),
        },
      });

      // Not awaited — see account.mailer.ts. Awaiting would make this branch
      // slower than the unknown-address branch and leak which emails exist.
      sendAccountEmail(customer.email, 'password-reset', {
        firstName: customer.firstName,
        resetUrl: `${env.STOREFRONT_ORIGIN}/reset-password?token=${encodeURIComponent(token)}`,
        expiresInMinutes: RESET_TTL_MINUTES,
      });

      log.info({ customerId: customer.id }, 'password reset issued');
    }

    res.json({
      data: { message: 'If that email has an account, a reset link is on its way.' },
    });
  }),
);

/**
 * Complete a reset.
 *
 * The token is looked up by HASH — the plaintext is never stored, so a database
 * dump yields nothing replayable. A row is valid only if it is unused and unexpired,
 * and it is marked used inside the same transaction that changes the password, so
 * a replayed request cannot set the password twice.
 */
customerAuthRouter.post(
  '/reset-password',
  passwordResetLimiter,
  validate({
    body: z.object({
      token: z.string().min(1, 'Reset link is missing its token.').max(200),
      password: customerPasswordSchema,
    }),
  }),
  asyncHandler(async (req, res) => {
    const record = await prisma.customerPasswordReset.findUnique({
      where: { tokenHash: hashToken(req.body.token) },
      select: {
        id: true,
        usedAt: true,
        expiresAt: true,
        customer: {
          select: { id: true, email: true, firstName: true, lastName: true, status: true },
        },
      },
    });

    // One message for missing, spent and expired alike — distinguishing them
    // tells a probe which tokens once existed.
    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw new AppError(
        400,
        ErrorCode.TOKEN_INVALID,
        'This reset link is invalid or has expired. Request a new one.',
      );
    }
    if (record.customer.status === CustomerStatus.BANNED) {
      throw new AppError(403, ErrorCode.ACCOUNT_BANNED, 'Your account has been suspended.');
    }

    const passwordHash = await hashPassword(req.body.password);

    await prisma.$transaction([
      prisma.customer.update({
        where: { id: record.customer.id },
        data: { passwordHash },
      }),
      prisma.customerPasswordReset.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
      // Any other live token for this account dies with the one just spent.
      prisma.customerPasswordReset.updateMany({
        where: { customerId: record.customer.id, usedAt: null },
        data: { usedAt: new Date() },
      }),
    ]);

    sendAccountEmail(record.customer.email, 'password-changed', {
      firstName: record.customer.firstName,
    });

    // Signed in immediately: bouncing someone to a login form to retype the
    // password they just chose is friction with no security benefit.
    res.json({
      data: {
        accessToken: signCustomerToken({
          sub: record.customer.id,
          email: record.customer.email,
        }),
        customer: {
          id: record.customer.id,
          email: record.customer.email,
          firstName: record.customer.firstName,
          lastName: record.customer.lastName,
        },
      },
    });
  }),
);

// ============================================================================
// ACCOUNT (customer session required)
// ============================================================================

accountRouter.use(requireCustomer);

/**
 * The signed-in customer's own profile.
 *
 * No query: `requireCustomer` has already loaded this row to check the ban
 * flag, so re-fetching it was a second round trip for data sitting in memory.
 *
 * The projection is written out rather than sending `req.customer` straight
 * through, so the response stays exactly the six fields it has always been
 * even if the principal grows another field later.
 */
accountRouter.get(
  '/me',
  asyncHandler(async (req, res) => {
    const { id, email, firstName, lastName, phone, registeredAt } = req.customer!;
    res.json({ data: { id, email, firstName, lastName, phone, registeredAt } });
  }),
);

accountRouter.patch(
  '/me',
  validate({
    body: z.object({
      firstName: z.string().trim().min(1).max(60).transform(plainText).optional(),
      lastName: z.string().trim().min(1).max(60).transform(plainText).optional(),
      phone: phoneSchema.optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    // Email is intentionally not updatable — it keys order history.
    const customer = await prisma.customer.update({
      where: { id: req.customer!.id },
      data: req.body,
      select: { id: true, email: true, firstName: true, lastName: true, phone: true },
    });
    res.json({ data: customer });
  }),
);

accountRouter.post(
  '/change-password',
  validate({
    body: z.object({
      currentPassword: z.string().min(1).max(200),
      newPassword: customerPasswordSchema,
    }),
  }),
  asyncHandler(async (req, res) => {
    const customer = await prisma.customer.findUniqueOrThrow({
      where: { id: req.customer!.id },
      select: { passwordHash: true },
    });

    if (
      !customer.passwordHash ||
      !(await verifyPassword(req.body.currentPassword, customer.passwordHash))
    ) {
      throw new AppError(400, ErrorCode.INVALID_CREDENTIALS, 'Current password is incorrect.', {
        fields: { currentPassword: 'Incorrect password.' },
      });
    }

    const updated = await prisma.customer.update({
      where: { id: req.customer!.id },
      data: { passwordHash: await hashPassword(req.body.newPassword) },
      select: { email: true, firstName: true },
    });

    // Tells the owner an account takeover happened if it wasn't them.
    sendAccountEmail(updated.email, 'password-changed', { firstName: updated.firstName });

    res.json({ data: { ok: true } });
  }),
);

/**
 * Order history.
 *
 * Matched by BOTH customerId and email, so orders placed as a guest before
 * registering still appear.
 */
/**
 * Ownership predicate, in one place.
 *
 * Matching on customerId OR email is what lets orders placed as a guest appear
 * once that person registers with the same address. Both routes below build
 * their WHERE from this, so the detail endpoint cannot accidentally be looser
 * than the list — which is exactly how an IDOR gets shipped.
 */
const ownedBy = (customer: { id: string; email: string }) => ({
  OR: [{ customerId: customer.id }, { email: customer.email }],
});

/** Everything the account UI renders for an order, list or detail. */
const orderSelect = {
  orderNo: true,
  placedAt: true,
  acceptedAt: true,
  shippedAt: true,
  deliveredAt: true,
  cancelledAt: true,
  cancelReason: true,
  status: true,
  paymentStatus: true,
  paymentMethod: true,
  subtotalPaise: true,
  discountPaise: true,
  shippingPaise: true,
  totalPaise: true,
  carrier: true,
  trackingNumber: true,
  trackingUrl: true,
  shippingAddress: true,
  customerNote: true,
  invoiceNumber: true,
  items: {
    select: { productName: true, pack: true, qty: true, lineTotalPaise: true, sku: true },
  },
} as const;

type AccountOrder = Awaited<
  ReturnType<typeof prisma.order.findFirstOrThrow<{ select: typeof orderSelect }>>
>;

/** Wire shape for one order. Money is sent as paise AND formatted rupees. */
/**
 * How the customer should be told their money stands.
 *
 * Only meaningful once an order is cancelled; everything else is ordinary
 * payment status and the page already shows that.
 *
 * "pending" is the honest answer for a paid order that has been cancelled: the
 * refund is a manual admin step, so claiming anything stronger would be a
 * promise the system has not kept yet.
 */
function refundStateFor(o: AccountOrder): 'none' | 'pending' | 'processed' | 'partial' {
  if (o.paymentStatus === PaymentStatus.REFUNDED) return 'processed';
  if (o.paymentStatus === PaymentStatus.PARTIALLY_REFUNDED) return 'partial';

  // Nothing was captured, so there is nothing to send back — COD included.
  if (o.status !== OrderStatus.CANCELLED) return 'none';
  if (o.paymentStatus !== PaymentStatus.PAID) return 'none';

  return 'pending';
}

function serialiseOrder(o: AccountOrder) {
  return {
    orderNo: o.orderNo,
    placedAt: o.placedAt,
    status: o.status,
    statusLabel: ORDER_STATUS_LABELS[o.status],
    paymentStatus: o.paymentStatus,
    paymentLabel: PAYMENT_STATUS_LABELS[o.paymentStatus],
    paymentMethod: o.paymentMethod,
    invoiceNumber: o.invoiceNumber,
    customerNote: o.customerNote,
    subtotalPaise: o.subtotalPaise,
    discountPaise: o.discountPaise,
    shippingPaise: o.shippingPaise,
    totalPaise: o.totalPaise,
    total: toRupees(o.totalPaise),
    timeline: buildTimeline(o),
    fulfilment: {
      carrier: o.carrier,
      trackingNumber: o.trackingNumber,
      trackingUrl: o.trackingUrl,
    },
    /*
     * Whether the Cancel button may appear — decided HERE, by the same
     * predicate the cancel route enforces with.
     *
     * The button could be derived from `status` on the client, but then the
     * rule would exist in two places and drift. The server owns it; the client
     * renders what it is told, and the route re-checks on the way in
     * regardless, because a stale page is not evidence of anything.
     */
    canCancel: isCustomerCancellable(o.status),
    cancelBlockedReason: customerCancelBlockedReason(o.status),
    cancelReason: o.cancelReason,
    cancelledAt: o.cancelledAt,
    /*
     * What to say about the money on a cancelled order.
     *
     * Cancelling does not refund — that is a separate admin action — so a paid
     * order sits at PAID with status CANCELLED. Left to itself the page would
     * show "Cancelled" beside "Payment successful", which reads as a mistake.
     * This names the actual state instead.
     */
    refundState: refundStateFor(o),
    addressLine: formatAddress(o.shippingAddress),
    shippingAddress: o.shippingAddress,
    items: o.items.map((i) => ({
      productName: i.productName,
      sku: i.sku,
      pack: i.pack,
      qty: i.qty,
      lineTotalPaise: i.lineTotalPaise,
      lineTotal: toRupees(i.lineTotalPaise),
    })),
  };
}

accountRouter.get(
  '/orders',
  asyncHandler(async (req, res) => {
    const orders = await prisma.order.findMany({
      where: ownedBy(req.customer!),
      orderBy: { placedAt: 'desc' },
      select: orderSelect,
    });

    res.json({ data: orders.map(serialiseOrder) });
  }),
);

/**
 * One order.
 *
 * The ownership clause is part of the QUERY, not a check after the fetch: an
 * order belonging to someone else is simply not found, so guessing an order
 * number reveals nothing about whether it exists.
 */
/**
 * The customer's own tax invoice, as a PDF.
 *
 * The PDF is NOT stored anywhere — it is rendered on demand from the order row
 * each time. That is safe because every field an invoice needs (product name,
 * HSN, unit price, tax rate, address) is snapshot onto the order at purchase
 * time, so regenerating it in five years reproduces the same document rather
 * than one reflecting today's catalogue.
 *
 * Ownership is part of the WHERE clause, exactly as in the order detail route:
 * another customer's invoice is not found rather than found-and-refused.
 */
accountRouter.get(
  '/orders/:orderNo/invoice',
  validate({ params: z.object({ orderNo: z.string().trim().min(3).max(40) }) }),
  asyncHandler(async (req, res) => {
    const order = await prisma.order.findFirst({
      where: { orderNo: req.params.orderNo as string, ...ownedBy(req.customer!) },
      select: {
        orderNo: true,
        invoiceNumber: true,
        placedAt: true,
        email: true,
        phone: true,
        shippingAddress: true,
        subtotalPaise: true,
        discountPaise: true,
        shippingPaise: true,
        totalPaise: true,
        couponCode: true,
        items: {
          select: {
            productName: true,
            sku: true,
            pack: true,
            qty: true,
            unitPricePaise: true,
            lineTotalPaise: true,
            hsn: true,
            taxRatePct: true,
          },
        },
      },
    });
    if (!order) throw notFound('Order');

    /*
     * The invoice number is issued when staff ACCEPT the order, not at
     * checkout, so a freshly placed order legitimately has none yet. 409 rather
     * than 404 — the order exists, the document just does not yet.
     */
    if (!order.invoiceNumber) {
      throw new AppError(
        409,
        ErrorCode.CONFLICT,
        'Your invoice will be available once we have accepted this order.',
      );
    }

    const pdf = await generateInvoicePdf(order, await getTaxConfig());

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="invoice-${order.invoiceNumber.replace(/[^\w.-]/g, '-')}.pdf"`,
    );
    res.send(Buffer.from(pdf));
  }),
);

accountRouter.get(
  '/orders/:orderNo',
  validate({ params: z.object({ orderNo: z.string().trim().min(3).max(40) }) }),
  asyncHandler(async (req, res) => {
    const order = await prisma.order.findFirst({
      where: { orderNo: req.params.orderNo as string, ...ownedBy(req.customer!) },
      select: orderSelect,
    });
    if (!order) throw notFound('Order');

    res.json({ data: serialiseOrder(order) });
  }),
);

/**
 * Cancel one's own order.
 *
 * The heavy lifting is `ordersService.cancelByCustomer`, which reuses the same
 * `transition()` an admin cancellation runs through — same restock, same
 * coupon reversal, same audit trail, same customer email. This route only
 * supplies identity and shapes the reply.
 *
 * No refund is triggered. Refunds remain an admin action behind the
 * orders.refund permission, so a paid order cancelled here stays PAID until
 * someone processes it — and the response says so rather than implying the
 * money is already on its way back.
 */
accountRouter.post(
  '/orders/:orderNo/cancel',
  validate({
    params: z.object({ orderNo: z.string().trim().min(3).max(40) }),
    body: z.object({
      /*
       * Optional, and capped well under the column's 500 so the
       * "Cancelled by customer — " prefix cannot push it over.
       */
      reason: z.string().trim().max(400).transform(plainText).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const customer = req.customer!;

    const order = await ordersService.cancelByCustomer(req.params.orderNo as string, {
      customer: { id: customer.id, email: customer.email },
      reason: (req.body as { reason?: string }).reason ?? null,
      ctx: {
        /*
         * actorId stays null: the column is for CmsUser ids, and writing a
         * customer id there would make the audit log lie about who staff
         * were looking at. The name and role carry the attribution instead.
         */
        actorId: null,
        actorName: customer.email,
        actorRole: 'CUSTOMER',
        ip: req.ip ?? '',
        userAgent: req.get('user-agent') ?? undefined,
      },
    });

    /*
     * Re-read through the customer serialiser. `cancelByCustomer` returns the
     * ADMIN shape, which carries internal notes and staff attribution — none
     * of which may reach a customer.
     */
    const row = await prisma.order.findFirstOrThrow({
      where: { orderNo: order.orderNo, ...ownedBy(customer) },
      select: orderSelect,
    });

    res.json({ data: serialiseOrder(row) });
  }),
);

// ---- Addresses --------------------------------------------------------------

const addressBodySchema = z.object({
  name: z.string().trim().min(2).max(120).transform(plainText),
  phone: phoneSchema,
  line1: z.string().trim().min(4).max(200).transform(plainText),
  line2: z.string().trim().max(200).transform(plainText).optional(),
  city: z.string().trim().min(2).max(80).transform(plainText),
  state: z.string().trim().min(2).max(60).transform(plainText),
  pincode: pincodeSchema,
  isDefault: z.boolean().optional().default(false),
});

accountRouter.get(
  '/addresses',
  asyncHandler(async (req, res) => {
    const addresses = await prisma.address.findMany({
      where: { customerId: req.customer!.id },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
    res.json({ data: addresses });
  }),
);

accountRouter.post(
  '/addresses',
  validate({ body: addressBodySchema }),
  asyncHandler(async (req, res) => {
    const customerId = req.customer!.id;

    const address = await prisma.$transaction(async (tx) => {
      // Only one default at a time.
      if (req.body.isDefault) {
        await tx.address.updateMany({ where: { customerId }, data: { isDefault: false } });
      }
      const count = await tx.address.count({ where: { customerId } });
      return tx.address.create({
        // The first address is the default whether asked for or not.
        data: { ...req.body, customerId, isDefault: req.body.isDefault || count === 0 },
      });
    });

    res.status(201).json({ data: address });
  }),
);

accountRouter.patch(
  '/addresses/:id',
  validate({
    params: z.object({ id: z.string().uuid() }),
    body: addressBodySchema.partial(),
  }),
  asyncHandler(async (req, res) => {
    const customerId = req.customer!.id;
    const id = req.params.id as string;

    // customerId in the WHERE clause, not merely checked — this is what stops one
    // customer editing another's address by guessing an id (IDOR).
    const owned = await prisma.address.findFirst({
      where: { id, customerId },
      select: { id: true },
    });
    if (!owned) throw notFound('Address');

    const address = await prisma.$transaction(async (tx) => {
      if (req.body.isDefault) {
        await tx.address.updateMany({ where: { customerId }, data: { isDefault: false } });
      }
      return tx.address.update({ where: { id }, data: req.body });
    });

    res.json({ data: address });
  }),
);

accountRouter.delete(
  '/addresses/:id',
  validate({ params: z.object({ id: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    // deleteMany with both keys: a non-owned id simply deletes nothing.
    const result = await prisma.address.deleteMany({
      where: { id: req.params.id as string, customerId: req.customer!.id },
    });
    if (result.count === 0) throw notFound('Address');
    res.json({ data: { ok: true } });
  }),
);
