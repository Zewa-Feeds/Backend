/**
 * ORDER LIFECYCLE — spec §6.3, §6.5.
 *
 * Ported from CMS/lib/orderFlow.js, which the CMS modal already drives its UI
 * from. This file is the authority: the CMS decides which buttons to show, the
 * backend decides whether a transition is legal.
 *
 *   PENDING ──accept──▶ PROCESSING ──ship──▶ SHIPPED ──deliver──▶ DELIVERED
 *             invoice no.          carrier +           deliveredOn
 *             (required)           tracking (required)  (optional)
 *      └──────────── CANCELLED (cancelReason required) ────────────┘
 *
 * Each step gates on the field it produces, so an order cannot reach SHIPPED
 * without an invoice number, or DELIVERED without tracking details.
 */
import { OrderStatus } from '@prisma/client';

/** The forward path. CANCELLED sits outside it as a branch from any pre-delivery state. */
export const ORDER_FLOW: readonly OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.PROCESSING,
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERED,
] as const;

/** Terminal states — nothing moves out of these. */
export const TERMINAL_STATES: readonly OrderStatus[] = [
  OrderStatus.DELIVERED,
  OrderStatus.CANCELLED,
] as const;

export interface TransitionField {
  /** Key on the Order model this field writes to. */
  key: 'invoiceNumber' | 'carrier' | 'trackingNumber' | 'trackingUrl' | 'deliveredOn' | 'cancelReason';
  label: string;
  required: boolean;
  maxLength?: number;
  /**
   * Must parse as an http(s) URL when present.
   *
   * The value is staff-entered free text that ends up in an href on the
   * customer's order page, so a typo would either render a dead link or, worse,
   * a `javascript:` one. Rejecting it here tells the person who typed it, while
   * they still have the box open.
   */
  url?: boolean;
  /** Shown greyed inside the input in the CMS. */
  placeholder?: string;
  /** Shown under the input in the CMS. */
  hint?: string;
}

export interface TransitionSpec {
  /** Human label for the action, e.g. "Accept order". */
  verb: string;
  fields: readonly TransitionField[];
  /** Subject line of the customer email sent on completion (§6.3, §15). */
  email: { subject: string; template: string };
  /** Cancelling before dispatch must return reserved stock to the variants. */
  restocks: boolean;
}

/**
 * What each target state requires, and what it sends. Mirrors the CMS's STEPS
 * object so the modal's payload lands here unchanged.
 */
export const TRANSITIONS: Record<Exclude<OrderStatus, 'PENDING'>, TransitionSpec> = {
  [OrderStatus.PROCESSING]: {
    /*
     * No fields.
     *
     * This step used to demand a hand-typed invoice number to match an external
     * Tally sequence. Invoice numbers are now issued automatically as `27ZFI###`
     * when the order is created, from the same atomic counter as the order
     * number — so the series is gapless by construction and there is nothing
     * left for staff to type.
     */
    verb: 'Accept order',
    fields: [],
    email: {
      subject: 'Your Zewa Feeds order is confirmed',
      template: 'order-confirmed',
    },
    restocks: false,
  },

  [OrderStatus.SHIPPED]: {
    verb: 'Mark shipped',
    fields: [
      {
        key: 'carrier',
        label: 'Shipping Carrier',
        required: true,
        maxLength: 60,
        placeholder: 'DTDC, Blue Dart, India Post…',
        hint: 'Shown to the customer on their order page.',
      },
      {
        key: 'trackingNumber',
        label: 'Tracking Number',
        required: true,
        maxLength: 60,
        placeholder: 'D77219845611',
        hint: 'The customer can copy this from their account.',
      },
      {
        key: 'trackingUrl',
        label: 'Tracking URL',
        required: false,
        maxLength: 500,
        url: true,
        placeholder: 'https://www.dtdc.in/tracking?ref=D77219845611',
        hint: 'Optional. Paste the direct tracking link and the customer gets a "Track shipment" button on their order page and in the dispatch email. Leave blank and they only see the number to copy.',
      },
    ],
    email: {
      subject: 'Your order has shipped',
      template: 'order-shipped',
    },
    restocks: false,
  },

  [OrderStatus.DELIVERED]: {
    verb: 'Mark delivered',
    fields: [{ key: 'deliveredOn', label: 'Delivered on', required: false }],
    email: {
      subject: 'Your order was delivered',
      template: 'order-delivered',
    },
    restocks: false,
  },

  [OrderStatus.CANCELLED]: {
    verb: 'Cancel order',
    fields: [{ key: 'cancelReason', label: 'Reason for cancellation', required: true, maxLength: 500 }],
    email: {
      subject: 'Your order was cancelled',
      template: 'order-cancelled',
    },
    // Anything not yet delivered returns its stock.
    restocks: true,
  },
};

/**
 * Which statuses can legally be reached from `current`.
 * One step forward, plus cancellation until delivery.
 */
export function nextStates(current: OrderStatus): OrderStatus[] {
  if (TERMINAL_STATES.includes(current)) return [];

  const i = ORDER_FLOW.indexOf(current);
  const forward = i >= 0 && i < ORDER_FLOW.length - 1 ? ORDER_FLOW[i + 1] : undefined;

  return [...(forward ? [forward] : []), OrderStatus.CANCELLED];
}

export function isValidTransition(from: OrderStatus, to: OrderStatus): boolean {
  return nextStates(from).includes(to);
}

/**
 * Which states a CUSTOMER may cancel from — deliberately narrower than the
 * lifecycle above.
 *
 * `nextStates` permits SHIPPED → CANCELLED because ops genuinely need it: a
 * parcel refused at the door or returned to origin is cancelled after
 * dispatch. That is a staff judgement made with the courier's status in hand,
 * and it must keep working.
 *
 * A customer has none of that context. Once a parcel is moving, self-service
 * cancellation would strand goods in transit with the order already restocked
 * and marked cancelled, so the customer is sent to support instead.
 *
 * This is a POLICY layer over the lifecycle, not a replacement for it. The
 * lifecycle still decides what is structurally legal; this decides what a
 * customer is allowed to ask for. Both are checked, in that order.
 */
export const CUSTOMER_CANCELLABLE_STATES: readonly OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.PROCESSING,
] as const;

/** May the customer cancel an order currently in this state? */
export function isCustomerCancellable(status: OrderStatus): boolean {
  return CUSTOMER_CANCELLABLE_STATES.includes(status);
}

/**
 * Why a customer cannot cancel, phrased for the customer.
 *
 * Returns null when cancellation IS allowed. The wording avoids blaming them
 * and points at the next useful action, because this text is the whole of what
 * they see when the button is gone.
 */
export function customerCancelBlockedReason(status: OrderStatus): string | null {
  if (isCustomerCancellable(status)) return null;

  switch (status) {
    case OrderStatus.SHIPPED:
      return 'This order has already shipped and can no longer be cancelled online. Contact us and we will help.';
    case OrderStatus.DELIVERED:
      return 'This order has already been delivered and cannot be cancelled.';
    case OrderStatus.CANCELLED:
      return 'This order is already cancelled.';
    default:
      return 'This order can no longer be cancelled.';
  }
}

/**
 * Validate a transition payload against its spec.
 * Returns field-keyed errors for §17.3 inline display, or null when valid.
 */
export function validateTransitionFields(
  to: OrderStatus,
  payload: Record<string, unknown>,
): Record<string, string> | null {
  const spec = TRANSITIONS[to as Exclude<OrderStatus, 'PENDING'>];
  if (!spec) return null;

  const errors: Record<string, string> = {};

  for (const field of spec.fields) {
    const raw = payload[field.key];
    const value = typeof raw === 'string' ? raw.trim() : raw;

    if (field.required && (value === undefined || value === null || value === '')) {
      errors[field.key] = `${field.label} is required.`;
      continue;
    }
    if (
      field.maxLength &&
      typeof value === 'string' &&
      value.length > field.maxLength
    ) {
      errors[field.key] = `${field.label} must be ${field.maxLength} characters or fewer.`;
      continue;
    }

    // Optional-but-present URLs still have to be real ones.
    if (field.url && typeof value === 'string' && value !== '') {
      let parsed: URL | null = null;
      try {
        parsed = new URL(value);
      } catch {
        parsed = null;
      }
      if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
        errors[field.key] = `${field.label} must be a full link starting with https://`;
      }
    }
  }

  return Object.keys(errors).length > 0 ? errors : null;
}

/** Which timestamp column a transition stamps. */
export const STATUS_TIMESTAMP: Record<OrderStatus, keyof OrderTimestamps | null> = {
  [OrderStatus.PENDING]: 'placedAt',
  [OrderStatus.PROCESSING]: 'acceptedAt',
  [OrderStatus.SHIPPED]: 'shippedAt',
  [OrderStatus.DELIVERED]: 'deliveredAt',
  [OrderStatus.CANCELLED]: 'cancelledAt',
};

export interface OrderTimestamps {
  placedAt: Date;
  acceptedAt: Date | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  cancelledAt: Date | null;
}

/** Timeline model for the CMS order detail page. */
export function buildTimeline(order: { status: OrderStatus } & OrderTimestamps) {
  if (order.status === OrderStatus.CANCELLED) {
    return [
      { label: 'Placed', state: 'done' as const, at: order.placedAt },
      { label: 'Cancelled', state: 'cancelled' as const, at: order.cancelledAt },
    ];
  }

  const idx = ORDER_FLOW.indexOf(order.status);
  const at: Record<OrderStatus, Date | null> = {
    [OrderStatus.PENDING]: order.placedAt,
    [OrderStatus.PROCESSING]: order.acceptedAt,
    [OrderStatus.SHIPPED]: order.shippedAt,
    [OrderStatus.DELIVERED]: order.deliveredAt,
    [OrderStatus.CANCELLED]: order.cancelledAt,
  };

  return ORDER_FLOW.map((status, i) => ({
    label: status === OrderStatus.PENDING ? 'Placed' : titleCase(status),
    state: i < idx ? ('done' as const) : i === idx ? ('current' as const) : ('todo' as const),
    at: at[status],
  }));
}

const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();
