/**
 * Checkout routes — /api/v1/checkout, plus guest order tracking.
 *
 * Public, rate limited, and idempotent. The `Idempotency-Key` header is honoured so
 * a double-clicked Place Order button cannot create two orders.
 */
import { Router } from 'express';
import { PaymentMethod } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '@/middleware/asyncHandler';
import { validate, emailSchema, phoneSchema, pincodeSchema } from '@/middleware/validate';
import { checkoutLimiter } from '@/middleware/rateLimit';
import { plainText } from '@/lib/sanitize';
import { AppError, ErrorCode, notFound } from '@/lib/errors';
import { auditContext } from '@/modules/audit/audit.service';
import { prisma } from '@/lib/prisma';
import { paymentProvider } from '@/integrations/razorpay/payment.service';
import { ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS, formatAddress } from '@/modules/orders/orders.serializer';
import { toRupees } from '@/modules/products/products.serializer';
import { buildTimeline } from '@/modules/orders/lifecycle';
import * as checkoutService from './checkout.service';

export const checkoutRouter = Router();

const addressSchema = z.object({
  name: z.string().trim().min(2, 'Enter a name.').max(120).transform(plainText),
  phone: phoneSchema,
  line1: z.string().trim().min(4, 'Enter an address.').max(200).transform(plainText),
  line2: z.string().trim().max(200).transform(plainText).optional(),
  city: z.string().trim().min(2, 'Enter a city.').max(80).transform(plainText),
  state: z.string().trim().min(2, 'Select a state.').max(60).transform(plainText),
  pincode: pincodeSchema,
});

const checkoutSchema = z.object({
  lines: z
    .array(
      z.object({
        sku: z.string().trim().max(40),
        qty: z.coerce.number().int().min(1).max(99),
      }),
    )
    .min(1, 'Your cart is empty.')
    .max(50),
  email: emailSchema,
  phone: phoneSchema,
  shippingAddress: addressSchema,
  paymentMethod: z.nativeEnum(PaymentMethod),
  couponCode: z.string().trim().max(30).optional().nullable(),
  customerNote: z.string().trim().max(1000).transform(plainText).optional(),
});

const orderNoSchema = z
  .string()
  .trim()
  .toUpperCase()
  // 27ZFO### going forward; ZW-YYYYMMDD-NNNN kept so older orders stay trackable.
  .regex(/^(?:\d{2}ZFO\d{3,}|ZW-\d{8}-\d{4})$/, 'Not a valid order number.');

/**
 * Place an order.
 *
 * Prices, stock and discounts are all resolved server-side — the request supplies
 * only SKUs and quantities.
 */
checkoutRouter.post(
  '/',
  checkoutLimiter,
  validate({ body: checkoutSchema }),
  asyncHandler(async (req, res) => {
    // Scoped by email so one client's key cannot collide with another's.
    const rawKey = req.get('idempotency-key');
    const idempotencyKey =
      rawKey && /^[\w-]{8,128}$/.test(rawKey) ? `${req.body.email}:${rawKey}` : undefined;

    const result = await checkoutService.checkout(
      { ...req.body, idempotencyKey },
      auditContext(req),
    );

    res.status(201).json({ data: result });
  }),
);

/**
 * Confirm an online payment from the browser callback.
 *
 * The signature is verified against the provider before anything is marked paid —
 * a client cannot mark its own order paid.
 *
 * In test mode this endpoint is not needed (the auto-confirm job handles it), but
 * it stays wired so switching to live Razorpay needs no route changes.
 */
checkoutRouter.post(
  '/:orderNo/confirm',
  checkoutLimiter,
  validate({
    params: z.object({ orderNo: orderNoSchema }),
    body: z.object({
      razorpayPaymentId: z.string().trim().min(4).max(120),
      razorpaySignature: z.string().trim().min(8).max(256),
    }),
  }),
  asyncHandler(async (req, res) => {
    const orderNo = req.params.orderNo as string;

    const order = await prisma.order.findUnique({
      where: { orderNo },
      select: { razorpayOrderId: true },
    });
    if (!order?.razorpayOrderId) throw notFound('Order');

    const provider = paymentProvider();
    if (!provider) {
      throw new AppError(503, ErrorCode.INTEGRATION_NOT_CONFIGURED, 'Payment is unavailable.');
    }

    const verification = await provider.verifyPayment({
      gatewayOrderId: order.razorpayOrderId,
      gatewayPaymentId: req.body.razorpayPaymentId,
      signature: req.body.razorpaySignature,
    });

    if (!verification.verified) {
      // The reason is logged by the provider; the client gets no detail, since a
      // precise message would help someone probe the verification logic.
      throw new AppError(
        400,
        ErrorCode.PAYMENT_VERIFICATION_FAILED,
        'We could not verify that payment. Please contact support if you were charged.',
      );
    }

    const confirmed = await checkoutService.confirmPayment(
      orderNo,
      verification.gatewayPaymentId ?? req.body.razorpayPaymentId,
      auditContext(req),
    );

    res.json({ data: { orderNo: confirmed.orderNo, paymentStatus: confirmed.paymentStatus } });
  }),
);

/**
 * Payment status polling.
 *
 * Needed in test mode (the storefront waits out the 30s auto-confirm) and useful
 * in production when a customer returns before the webhook lands.
 *
 * Requires the email as a shared secret so an order number alone does not expose
 * someone else's order state.
 */
checkoutRouter.get(
  '/:orderNo/status',
  validate({
    params: z.object({ orderNo: orderNoSchema }),
    query: z.object({ email: emailSchema }),
  }),
  asyncHandler(async (req, res) => {
    const order = await prisma.order.findUnique({
      where: { orderNo: req.params.orderNo as string },
      select: { orderNo: true, email: true, status: true, paymentStatus: true, totalPaise: true },
    });

    // Same 404 whether the order is missing or the email does not match, so the
    // endpoint cannot be used to confirm that an order number exists.
    if (!order || order.email !== (req.query.email as string).toLowerCase()) {
      throw notFound('Order');
    }

    res.json({
      data: {
        orderNo: order.orderNo,
        status: order.status,
        statusLabel: ORDER_STATUS_LABELS[order.status],
        paymentStatus: order.paymentStatus,
        paymentLabel: PAYMENT_STATUS_LABELS[order.paymentStatus],
        totalPaise: order.totalPaise,
        total: toRupees(order.totalPaise),
      },
    });
  }),
);

// ---- Guest order tracking ---------------------------------------------------

export const trackingRouter = Router();

/** Order + email acts as the credential pair for a guest with no account. */
trackingRouter.get(
  '/track',
  validate({
    query: z.object({ orderNo: orderNoSchema, email: emailSchema }),
  }),
  asyncHandler(async (req, res) => {
    const order = await prisma.order.findUnique({
      where: { orderNo: req.query.orderNo as string },
      select: {
        orderNo: true,
        email: true,
        status: true,
        paymentStatus: true,
        paymentMethod: true,
        placedAt: true,
        acceptedAt: true,
        shippedAt: true,
        deliveredAt: true,
        cancelledAt: true,
        carrier: true,
        trackingNumber: true,
        trackingUrl: true,
        cancelReason: true,
        totalPaise: true,
        shippingAddress: true,
        items: { select: { productName: true, pack: true, qty: true, lineTotalPaise: true } },
      },
    });

    if (!order || order.email !== (req.query.email as string).toLowerCase()) {
      throw notFound('Order');
    }

    res.json({
      data: {
        orderNo: order.orderNo,
        status: order.status,
        statusLabel: ORDER_STATUS_LABELS[order.status],
        paymentStatus: order.paymentStatus,
        paymentLabel: PAYMENT_STATUS_LABELS[order.paymentStatus],
        paymentMethod: order.paymentMethod,
        placedAt: order.placedAt,
        timeline: buildTimeline(order),
        fulfilment: {
          carrier: order.carrier,
          trackingNumber: order.trackingNumber,
          trackingUrl: order.trackingUrl,
        },
        cancelReason: order.cancelReason,
        totalPaise: order.totalPaise,
        total: toRupees(order.totalPaise),
        addressLine: formatAddress(order.shippingAddress),
        items: order.items.map((i) => ({
          productName: i.productName,
          pack: i.pack,
          qty: i.qty,
          lineTotal: toRupees(i.lineTotalPaise),
        })),
      },
    });
  }),
);
