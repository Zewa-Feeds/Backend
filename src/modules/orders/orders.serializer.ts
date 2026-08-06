/**
 * Order serialization for the CMS.
 *
 * The CMS was built against a denormalised mock where an order carried
 * `lines: [[name, sku, qty, price]]` and `no`/`pay`/`inv` as short keys. Real
 * orders are normalised with snapshot line items. Translate here so the CMS's
 * tables and detail page keep working with minimal change.
 */
import { OrderStatus, PaymentStatus, type Prisma } from '@prisma/client';
import { buildTimeline, nextStates, TRANSITIONS } from './lifecycle';
import { toRupees } from '@/modules/products/products.serializer';

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  [OrderStatus.PENDING]: 'Pending',
  [OrderStatus.PROCESSING]: 'Processing',
  [OrderStatus.SHIPPED]: 'Shipped',
  [OrderStatus.DELIVERED]: 'Delivered',
  [OrderStatus.CANCELLED]: 'Cancelled',
};

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  [PaymentStatus.PAID]: 'Paid',
  [PaymentStatus.UNPAID]: 'Unpaid',
  [PaymentStatus.REFUNDED]: 'Refunded',
  [PaymentStatus.PARTIALLY_REFUNDED]: 'Partially Refunded',
};

export const ORDER_SELECT = {
  id: true,
  orderNo: true,
  customerId: true,
  email: true,
  phone: true,
  status: true,
  paymentStatus: true,
  paymentMethod: true,
  razorpayOrderId: true,
  razorpayPaymentId: true,
  subtotalPaise: true,
  discountPaise: true,
  shippingPaise: true,
  taxPaise: true,
  totalPaise: true,
  couponCode: true,
  shippingAddress: true,
  invoiceNumber: true,
  carrier: true,
  trackingNumber: true,
  trackingUrl: true,
  customerNote: true,
  internalNote: true,
  cancelReason: true,
  placedAt: true,
  acceptedAt: true,
  shippedAt: true,
  deliveredAt: true,
  cancelledAt: true,
  items: {
    select: {
      id: true,
      productName: true,
      sku: true,
      pack: true,
      qty: true,
      unitPricePaise: true,
      lineTotalPaise: true,
      hsn: true,
      taxRatePct: true,
      variantId: true,
    },
  },
  emails: {
    select: { id: true, subject: true, toEmail: true, status: true, sentAt: true, queuedAt: true },
    orderBy: { queuedAt: 'desc' },
  },
  refunds: {
    select: { id: true, amountPaise: true, reason: true, createdAt: true, processedBy: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  },
  customer: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.OrderSelect;

type OrderRow = Prisma.OrderGetPayload<{ select: typeof ORDER_SELECT }>;

interface ShippingAddress {
  name?: string;
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  pincode?: string;
  phone?: string;
}

/** One-line address, matching the CMS's `order.addr` string. */
export function formatAddress(addr: unknown): string {
  const a = (addr ?? {}) as ShippingAddress;
  return [a.line1, a.line2, a.city, a.state, a.pincode].filter(Boolean).join(', ');
}

/** Compact row for the §6.1 list. */
export function serializeListRow(order: OrderRow) {
  return {
    orderNo: order.orderNo,
    placedAt: order.placedAt,
    customerName:
      order.customer ? `${order.customer.firstName} ${order.customer.lastName}`.trim() : (order.shippingAddress as ShippingAddress)?.name ?? 'Guest',
    customerId: order.customerId,
    email: order.email,
    phone: order.phone,
    itemCount: order.items.reduce((sum, i) => sum + i.qty, 0),
    // Feeds the CMS's hover tooltip listing the items.
    itemSummary: order.items.map((i) => `${i.productName} (${i.sku}) ×${i.qty}`),
    totalPaise: order.totalPaise,
    total: toRupees(order.totalPaise),
    status: order.status,
    statusLabel: ORDER_STATUS_LABELS[order.status],
    paymentStatus: order.paymentStatus,
    paymentLabel: PAYMENT_STATUS_LABELS[order.paymentStatus],
    paymentMethod: order.paymentMethod,
    razorpayPaymentId: order.razorpayPaymentId,
    invoiceNumber: order.invoiceNumber,
  };
}

/**
 * Full order for the §6.2 detail page.
 *
 * Includes `nextStates` and the field spec for each, so the CMS's advance modal is
 * driven by the server's state machine rather than a client-side copy that could
 * drift out of sync.
 */
export function serializeOrder(order: OrderRow) {
  const refundedPaise = order.refunds.reduce((sum, r) => sum + r.amountPaise, 0);

  return {
    ...serializeListRow(order),
    id: order.id,

    items: order.items.map((i) => ({
      id: i.id,
      productName: i.productName,
      sku: i.sku,
      pack: i.pack,
      qty: i.qty,
      unitPricePaise: i.unitPricePaise,
      unitPrice: toRupees(i.unitPricePaise),
      lineTotalPaise: i.lineTotalPaise,
      lineTotal: toRupees(i.lineTotalPaise),
      hsn: i.hsn,
      taxRatePct: Number(i.taxRatePct),
    })),

    totals: {
      subtotalPaise: order.subtotalPaise,
      discountPaise: order.discountPaise,
      shippingPaise: order.shippingPaise,
      taxPaise: order.taxPaise,
      totalPaise: order.totalPaise,
      subtotal: toRupees(order.subtotalPaise),
      discount: toRupees(order.discountPaise),
      shipping: toRupees(order.shippingPaise),
      tax: toRupees(order.taxPaise),
      total: toRupees(order.totalPaise),
    },

    couponCode: order.couponCode,
    shippingAddress: order.shippingAddress,
    addressLine: formatAddress(order.shippingAddress),

    fulfilment: {
      invoiceNumber: order.invoiceNumber,
      carrier: order.carrier,
      trackingNumber: order.trackingNumber,
      trackingUrl: order.trackingUrl,
    },

    customerNote: order.customerNote,
    internalNote: order.internalNote,
    cancelReason: order.cancelReason,

    timeline: buildTimeline(order),

    /** Legal moves from here, with the fields each requires (§6.3). */
    availableTransitions: nextStates(order.status).map((to) => {
      const spec = TRANSITIONS[to as Exclude<OrderStatus, 'PENDING'>];
      return {
        to,
        label: ORDER_STATUS_LABELS[to],
        verb: spec.verb,
        fields: spec.fields,
        email: spec.email,
      };
    }),

    emails: order.emails,

    refunds: order.refunds.map((r) => ({
      id: r.id,
      amountPaise: r.amountPaise,
      amount: toRupees(r.amountPaise),
      reason: r.reason,
      createdAt: r.createdAt,
      processedBy: r.processedBy?.name ?? null,
    })),
    refundedPaise,
    refundableePaise: Math.max(0, order.totalPaise - refundedPaise),

    /** §6.4: refunds are Admin-only AND only when payment is captured. */
    canRefund:
      (order.paymentStatus === PaymentStatus.PAID ||
        order.paymentStatus === PaymentStatus.PARTIALLY_REFUNDED) &&
      refundedPaise < order.totalPaise,

    /**
     * Money still held against an order that will never ship.
     *
     * Cancelling restocks inventory and reverses the coupon, but deliberately
     * does NOT move money: a refund is irreversible and needs an amount and a
     * reason, so it stays a separate action. That leaves a real failure mode —
     * a CANCELLED order sitting at PAID, where the customer has been charged
     * for nothing and no screen says so.
     *
     * Surfacing it as a flag lets the CMS show an unmissable warning rather
     * than relying on whoever cancelled the order to remember.
     */
    awaitingRefund:
      order.status === OrderStatus.CANCELLED &&
      (order.paymentStatus === PaymentStatus.PAID ||
        order.paymentStatus === PaymentStatus.PARTIALLY_REFUNDED) &&
      refundedPaise < order.totalPaise,

    /** §6.5: the invoice PDF appears once a number has been entered. */
    canDownloadInvoice: Boolean(order.invoiceNumber),
  };
}
