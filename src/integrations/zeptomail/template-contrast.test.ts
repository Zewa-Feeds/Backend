/**
 * Every email template is a DARK theme, and must stay one.
 *
 * The staff order alert shipped with light panel backgrounds (#FBFCFD /
 * #F8FAFC) left over from an earlier light design, while the shell and its
 * text colours had moved to dark. Near-white INK on a near-white panel gave
 * Customer Details, Payment Information and the Financial Breakdown a contrast
 * ratio of 1.05:1 — the text was there, and invisible.
 *
 * Email has no media queries worth relying on and no CSS variables, so every
 * colour is inlined at render time. Nothing but a test stops a light hex from
 * being pasted back in.
 */
import { describe, expect, it } from 'vitest';
import { staffTemplates, templates, type OrderEmailContext } from './templates';

const ctx: OrderEmailContext = {
  orderNo: '27ZFO124',
  customerName: 'Vinod Vasu',
  customerEmail: 'vinod@example.com',
  customerPhone: '9847539997',
  placedAt: new Date('2026-09-30T08:27:00.000Z'),
  items: [
    {
      productName: 'Zewa Feeds Guppy Bites G2',
      sku: 'G2-200G',
      pack: '200g Pouch',
      qty: 1,
      unitPricePaise: 49900,
      lineTotalPaise: 49900,
    },
  ],
  subtotalPaise: 49900,
  discountPaise: 4990,
  shippingPaise: 0,
  totalPaise: 44910,
  paymentMethod: 'RAZORPAY',
  paymentStatus: 'PAID',
  razorpayOrderId: 'order_ABC123',
  razorpayPaymentId: 'pay_XYZ789',
  addressLine: 'Puthenpura House, Kothamangalam, Kerala, 686692',
};

/** Relative luminance, per WCAG 2.1. */
function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg: string, bg: string): number {
  const [a, b] = [luminance(fg), luminance(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * The brand mint is a deliberate bright surface: it backs the CTA button and
 * carries its own dark text (BRAND_BUTTON_TEXT), so it is not a washed-out
 * panel. Every other bright background is.
 */
const INTENTIONALLY_BRIGHT = new Set(['#44E5C2']);

/**
 * Backgrounds bright enough to wash out near-white text. Anything at or above
 * ~55% luminance is a light surface and has no place in these templates.
 */
function lightBackgrounds(html: string): string[] {
  const found = html.match(/background:\s*(#[0-9A-Fa-f]{6})/g) ?? [];
  return [
    ...new Set(
      found
        .map((m) => m.split(':')[1]!.trim().toUpperCase())
        .filter((hex) => luminance(hex) > 0.55 && !INTENTIONALLY_BRIGHT.has(hex)),
    ),
  ];
}

const STAFF_HTML = Object.entries(staffTemplates).map(([name, build]) => {
  const rendered = (build as (c: unknown) => { html: string })({
    ...ctx,
    sku: 'G2-200G',
    productName: 'Zewa Feeds Guppy Bites G2',
    rating: 5,
    excerpt: 'Great product',
    refundAmountPaise: 10000,
    refundReason: 'Customer request',
    refundState: 'processed',
    cancelledAt: ctx.placedAt,
    cancellationReason: 'Changed mind',
  });
  return [name, rendered.html] as const;
});

describe('email templates stay dark-on-dark', () => {
  it.each(STAFF_HTML)('%s uses no light panel background', (_name, html) => {
    expect(lightBackgrounds(html)).toEqual([]);
  });

  it('order-placed uses no light panel background', () => {
    const html = templates['order-placed'](ctx, ctx.customerEmail!).html;
    expect(lightBackgrounds(html)).toEqual([]);
  });

  it('never reintroduces the exact hexes that caused the bug', () => {
    for (const [, html] of STAFF_HTML) {
      expect(html).not.toContain('#FBFCFD');
      expect(html).not.toContain('#F8FAFC');
    }
  });
});

describe('the palette clears WCAG AA on the panel surface', () => {
  const PANEL = '#151B2A';
  const PANEL_HEADER = '#1B2335';

  it.each([
    ['INK body text', '#F4F7FA', PANEL],
    ['MUTED secondary text', '#9AA7BD', PANEL],
    ['BRAND links', '#44E5C2', PANEL],
    ['MUTED panel labels', '#9AA7BD', PANEL_HEADER],
    ['DANGER discount', '#F87171', PANEL],
    ['WARNING unpaid status', '#FBBF24', PANEL],
  ])('%s reaches 4.5:1', (_label, fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('proves the reported bug would now fail this check', () => {
    // INK on the old light panel — what the operator actually received.
    expect(contrast('#F4F7FA', '#FBFCFD')).toBeLessThan(1.1);
  });
});
