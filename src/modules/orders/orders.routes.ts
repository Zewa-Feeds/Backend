/**
 * Order routes — /api/v1/admin/orders
 *
 * Permissions per §2.1:
 *   orders.view     Ops + Admin  (Editors have no access at all)
 *   orders.status   Ops + Admin
 *   orders.invoice  Ops + Admin
 *   orders.refund   Admin only
 *   orders.export   Admin only
 */
import { Router } from 'express';
import { OrderStatus, PaymentStatus } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '@/middleware/asyncHandler';
import { currentUser, requirePermission } from '@/middleware/auth';
import { enumFilter, paginationSchema, validate } from '@/middleware/validate';
import { plainText } from '@/lib/sanitize';
import { auditContext } from '@/modules/audit/audit.service';
import { formatInvoiceFilename, generateInvoicePdf } from '@/integrations/pdf/invoice';
import * as settingsService from '@/modules/settings/settings.service';
import * as ordersService from './orders.service';

export const ordersRouter = Router();

// Editors are denied the whole module (§2.1) — applied once on the router.
ordersRouter.use(requirePermission('orders.view'));

/** Order numbers are 27ZFO### (legacy: ZW-YYYYMMDD-NNNN). */
const orderNoParam = z.object({
  orderNo: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^(?:\d{2}ZFO\d{3,}|ZW-\d{8}-\d{4})$/, 'Not a valid order number.'),
});

const listQuerySchema = paginationSchema.extend({
  status: enumFilter(z.nativeEnum(OrderStatus)),
  paymentStatus: enumFilter(z.nativeEnum(PaymentStatus)),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/**
 * Transition body.
 *
 * `fields` is a loose record on purpose — the state machine declares which keys
 * each step accepts, and the service reads ONLY those. A client cannot set
 * arbitrary order columns by adding keys here.
 */
const transitionSchema = z.object({
  to: z.nativeEnum(OrderStatus),
  fields: z.record(z.string(), z.unknown()).default({}),
  internalNote: z.string().max(2000).transform(plainText).optional(),
  notifyCustomer: z.boolean().default(true),
});

const refundSchema = z.object({
  // Rupees from the CMS modal; stored as paise.
  amount: z.coerce.number().positive('Enter an amount greater than zero.').max(10_000_000),
  reason: z
    .string()
    .trim()
    .min(3, 'A refund reason is required.')
    .max(500)
    .transform(plainText),
});

// ---- Reads -----------------------------------------------------------------

ordersRouter.get(
  '/',
  validate({ query: listQuerySchema }),
  asyncHandler(async (req, res) => {
    const result = await ordersService.list(req.query as never);
    res.json(result);
  }),
);

/**
 * CSV export (§6.1) — Admin only.
 * Mounted before /:orderNo so "export.csv" is not parsed as an order number.
 */
ordersRouter.get(
  '/export.csv',
  requirePermission('orders.export'),
  validate({ query: listQuerySchema }),
  asyncHandler(async (req, res) => {
    const csv = await ordersService.exportCsv(req.query as never);
    const stamp = new Date().toISOString().slice(0, 10);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="zewa-orders-${stamp}.csv"`);
    // U+FEFF byte-order mark: without it Excel misreads UTF-8 (₹ and names with
    // accents become mojibake). Written as an escape rather than a literal so it
    // stays visible in the source.
    res.send(`\uFEFF${csv}`);
  }),
);

ordersRouter.get(
  '/:orderNo',
  validate({ params: orderNoParam }),
  asyncHandler(async (req, res) => {
    const order = await ordersService.byOrderNo(req.params.orderNo as string);
    res.json({ data: order });
  }),
);

/**
 * Invoice PDF (§6.5).
 *
 * Available only once an invoice number has been entered — the number is a
 * required field on the document, so generating without one would produce an
 * invalid invoice.
 */
ordersRouter.get(
  '/:orderNo/invoice',
  requirePermission('orders.invoice'),
  validate({ params: orderNoParam }),
  asyncHandler(async (req, res) => {
    const orderNo = req.params.orderNo as string;
    const order = await ordersService.rawByOrderNo(orderNo);

    if (!order.invoiceNumber) {
      res.status(409).json({
        error: {
          code: 'INVOICE_REQUIRED',
          message: 'Enter the invoice number before downloading the invoice.',
        },
      });
      return;
    }

    const taxConfig = await settingsService.getTaxConfig();
    const pdf = await generateInvoicePdf(order, taxConfig);

    const customerName =
      (order.shippingAddress as any)?.name ||
      (order.customer ? `${order.customer.firstName} ${order.customer.lastName}`.trim() : '');
    const filename = formatInvoiceFilename(order.invoiceNumber, customerName);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(pdf));
  }),
);

// ---- Writes ----------------------------------------------------------------

/**
 * Advance the order (§6.3).
 *
 * One endpoint for every move rather than four: the state machine decides what is
 * legal and what each step requires, so the rules live in one place and the CMS's
 * modal is driven by the server's own spec.
 */
ordersRouter.post(
  '/:orderNo/transition',
  requirePermission('orders.status'),
  validate({ params: orderNoParam, body: transitionSchema }),
  asyncHandler(async (req, res) => {
    const order = await ordersService.transition(
      req.params.orderNo as string,
      req.body,
      auditContext(req),
    );
    res.json({ data: order });
  }),
);

/** Refund (§6.4) — Admin only, reason required. */
ordersRouter.post(
  '/:orderNo/refund',
  requirePermission('orders.refund'),
  validate({ params: orderNoParam, body: refundSchema }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const order = await ordersService.refund(
      req.params.orderNo as string,
      Math.round(req.body.amount * 100),
      req.body.reason,
      user.id,
      auditContext(req),
    );
    res.json({ data: order });
  }),
);

/** Internal note — never sent to the customer (§6.3). */
ordersRouter.patch(
  '/:orderNo/note',
  requirePermission('orders.status'),
  validate({
    params: orderNoParam,
    body: z.object({ internalNote: z.string().max(2000).transform(plainText) }),
  }),
  asyncHandler(async (req, res) => {
    const order = await ordersService.updateNote(
      req.params.orderNo as string,
      req.body.internalNote,
      auditContext(req),
    );
    res.json({ data: order });
  }),
);

/**
 * Reconcile / verify payment with gateway.
 * Checks Razorpay for captured payment and confirms/restores order.
 */
ordersRouter.post(
  '/:orderNo/reconcile-payment',
  requirePermission('orders.status'),
  validate({
    params: orderNoParam,
    body: z
      .object({
        paymentId: z.string().trim().optional(),
      })
      .default({}),
  }),
  asyncHandler(async (req, res) => {
    const result = await ordersService.reconcilePayment(
      req.params.orderNo as string,
      req.body.paymentId,
      auditContext(req),
    );
    res.json(result);
  }),
);
