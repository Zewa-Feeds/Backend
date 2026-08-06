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
import { CustomerStatus } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '@/middleware/asyncHandler';
import {
  emailSchema,
  phoneSchema,
  pincodeSchema,
  validate,
} from '@/middleware/validate';
import { loginLimiter, passwordResetLimiter } from '@/middleware/rateLimit';
import { fakeVerify, hashPassword, verifyPassword } from '@/lib/crypto';
import { signCustomerToken, verifyCustomerToken } from '@/lib/tokens';
import { AppError, ErrorCode, notFound, unauthenticated } from '@/lib/errors';
import { plainText } from '@/lib/sanitize';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS, formatAddress } from '@/modules/orders/orders.serializer';
import { toRupees } from '@/modules/products/products.serializer';
import { buildTimeline } from '@/modules/orders/lifecycle';
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

    const customer = await prisma.customer.findUnique({
      where: { id: claims.sub },
      select: { id: true, email: true, status: true },
    });
    if (!customer) throw unauthenticated('Account not found.', ErrorCode.TOKEN_INVALID);

    if (customer.status === CustomerStatus.BANNED) {
      throw new AppError(403, ErrorCode.ACCOUNT_BANNED, 'Your account has been suspended.');
    }

    req.customer = { id: customer.id, email: customer.email };
    next();
  } catch (err) {
    next(err);
  }
};

// ============================================================================
// AUTH
// ============================================================================

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
          },
          select: { id: true, email: true, firstName: true, lastName: true },
        });

    res.status(201).json({
      data: {
        accessToken: signCustomerToken({ sub: customer.id, email: customer.email }),
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

customerAuthRouter.post(
  '/login',
  loginLimiter,
  validate({ body: z.object({ email: emailSchema, password: z.string().min(1).max(200) }) }),
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

    res.json({
      data: {
        accessToken: signCustomerToken({ sub: customer.id, email: customer.email }),
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
customerAuthRouter.post(
  '/forgot-password',
  passwordResetLimiter,
  validate({ body: z.object({ email: emailSchema }) }),
  asyncHandler(async (req, res) => {
    const customer = await prisma.customer.findUnique({
      where: { email: req.body.email },
      select: { id: true, passwordHash: true },
    });

    if (customer?.passwordHash) {
      // TODO: queue a reset email once the customer-reset template lands.
      log.info({ customerId: customer.id }, 'password reset requested');
    }

    res.json({
      data: { message: 'If that email has an account, a reset link is on its way.' },
    });
  }),
);

// ============================================================================
// ACCOUNT (customer session required)
// ============================================================================

accountRouter.use(requireCustomer);

accountRouter.get(
  '/me',
  asyncHandler(async (req, res) => {
    const customer = await prisma.customer.findUniqueOrThrow({
      where: { id: req.customer!.id },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        registeredAt: true,
      },
    });
    res.json({ data: customer });
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

    await prisma.customer.update({
      where: { id: req.customer!.id },
      data: { passwordHash: await hashPassword(req.body.newPassword) },
    });

    res.json({ data: { ok: true } });
  }),
);

/**
 * Order history.
 *
 * Matched by BOTH customerId and email, so orders placed as a guest before
 * registering still appear.
 */
accountRouter.get(
  '/orders',
  asyncHandler(async (req, res) => {
    const orders = await prisma.order.findMany({
      where: {
        OR: [{ customerId: req.customer!.id }, { email: req.customer!.email }],
      },
      orderBy: { placedAt: 'desc' },
      select: {
        orderNo: true,
        placedAt: true,
        acceptedAt: true,
        shippedAt: true,
        deliveredAt: true,
        cancelledAt: true,
        status: true,
        paymentStatus: true,
        paymentMethod: true,
        totalPaise: true,
        carrier: true,
        trackingNumber: true,
        trackingUrl: true,
        shippingAddress: true,
        items: {
          select: { productName: true, pack: true, qty: true, lineTotalPaise: true, sku: true },
        },
      },
    });

    res.json({
      data: orders.map((o) => ({
        orderNo: o.orderNo,
        placedAt: o.placedAt,
        status: o.status,
        statusLabel: ORDER_STATUS_LABELS[o.status],
        paymentStatus: o.paymentStatus,
        paymentLabel: PAYMENT_STATUS_LABELS[o.paymentStatus],
        paymentMethod: o.paymentMethod,
        totalPaise: o.totalPaise,
        total: toRupees(o.totalPaise),
        timeline: buildTimeline(o),
        fulfilment: {
          carrier: o.carrier,
          trackingNumber: o.trackingNumber,
          trackingUrl: o.trackingUrl,
        },
        addressLine: formatAddress(o.shippingAddress),
        items: o.items.map((i) => ({
          productName: i.productName,
          sku: i.sku,
          pack: i.pack,
          qty: i.qty,
          lineTotal: toRupees(i.lineTotalPaise),
        })),
      })),
    });
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
