/**
 * Transactional email templates (§6.3, §15).
 *
 * Plain string templates, deliberately: email clients (Outlook especially) ignore
 * most modern CSS, so these use table-free simple markup with inline styles and no
 * external assets.
 *
 * Every interpolated value passes through `esc()`. Customer names and product
 * names reach these templates, and an unescaped `<` would either break the layout
 * or inject markup into someone's inbox.
 */
import { env } from '@/config/env';
import { formatInr } from '@/modules/orders/tax';

/** HTML-escape an interpolated value. */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/*
 * Email palette.
 *
 * The storefront's mint (#44E5C2) is a dark-ground accent — on the white card an
 * email needs, it fails contrast badly. BRAND is that hue taken down to a weight
 * that reads as the same brand while staying legible on white, which is the
 * trade every email version of a dark UI has to make.
 */
const BRAND = '#0E8C77';
const BRAND_SOFT = '#E7F5F1';
const INK = '#0B1620';
const MUTED = '#64748B';
const HAIRLINE = '#E6EBF0';
const CANVAS = '#F4F6F8';

export interface OrderEmailContext {
  orderNo: string;
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  items: {
    productName: string;
    pack: string;
    qty: number;
    lineTotalPaise: number;
    sku?: string;
    unitPricePaise?: number;
  }[];
  subtotalPaise: number;
  discountPaise: number;
  shippingPaise: number;
  taxPaise?: number;
  totalPaise: number;
  paymentMethod: 'RAZORPAY' | 'COD';
  paymentStatus?: 'PAID' | 'UNPAID';
  addressLine: string;
  placedAt?: Date | string | null;
  customerNote?: string | null;
  internalNote?: string | null;
  razorpayOrderId?: string | null;
  razorpayPaymentId?: string | null;
  invoiceNumber?: string | null;
  carrier?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  cancelReason?: string | null;
  deliveredOn?: Date | null;
}

/** Formats a date nicely in Indian standard format (IST). */
function formatDate(d: Date | string | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Kolkata',
  });
}

/**
 * Page frame for every email.
 *
 * Tables and inline styles throughout, not because it is nice but because
 * Outlook still renders with Word's engine: flexbox, grid and most of a
 * stylesheet are simply dropped there. `role="presentation"` keeps screen
 * readers from announcing the layout scaffolding as data tables.
 *
 * `preheader` is the grey line a client shows next to the subject in the inbox
 * list. Left unset, clients scrape the first text they find — usually the
 * wordmark — so every message previews identically. It is hidden in the body
 * itself by the zero-size span below.
 */
function shell(heading: string, intro: string, body: string, preheader?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="color-scheme" content="light"/>
<title>${esc(heading)}</title>
</head>
<body style="margin:0;padding:0;background:${CANVAS};-webkit-font-smoothing:antialiased;">
  <span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;mso-hide:all;">${esc(preheader ?? intro.replace(/<[^>]+>/g, ''))}</span>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CANVAS};">
    <tr>
      <td align="center" style="padding:32px 16px;">

        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:#ffffff;border:1px solid ${HAIRLINE};border-radius:14px;overflow:hidden;">

          <!-- Wordmark -->
          <tr>
            <td style="padding:26px 32px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding-bottom:8px;">
                    <span style="font-family:Georgia,'Times New Roman',serif;font-size:19px;font-weight:700;color:${INK};letter-spacing:-0.2px;">Zewa&nbsp;Feeds</span>
                  </td>
                </tr>
                <tr><td style="height:2px;background:${BRAND};font-size:0;line-height:0;">&nbsp;</td></tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:28px 32px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
              <h1 style="margin:0 0 12px;font-size:23px;line-height:1.28;font-weight:700;color:${INK};letter-spacing:-0.35px;">${heading}</h1>
              <p style="margin:0 0 24px;font-size:15px;line-height:1.65;color:${MUTED};">${intro}</p>
              ${body}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 32px 24px;background:#FBFCFD;border-top:1px solid ${HAIRLINE};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
              <p style="margin:0 0 8px;font-size:12.5px;line-height:1.6;color:${MUTED};">
                Need a hand? Just reply to this email — it reaches a person.
              </p>
              <p style="margin:0;font-size:11px;line-height:1.65;color:#94A3B0;">
                ${esc(env.COMPANY_NAME)} · GSTIN ${esc(env.COMPANY_GSTIN)}<br/>
                ${esc(supportAddress())}
              </p>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * The address printed in the footer.
 *
 * Prefers the reply-to, because that is genuinely where a reply lands. Mail goes
 * out from `orders@` to keep the transactional stream separate, so printing the
 * sender would invite people to write to the wrong mailbox — and the line right
 * above it promises a human reads it.
 */
function supportAddress(): string {
  return env.ZEPTOMAIL_REPLY_TO || env.COMPANY_EMAIL;
}

/** Key/value strip for the facts that identify an order at a glance. */
function factsBlock(pairs: [string, string][]): string {
  const cells = pairs
    .map(
      ([k, v]) => `
        <td style="padding:14px 16px;vertical-align:top;">
          <div style="font-size:10.5px;letter-spacing:0.09em;text-transform:uppercase;color:${MUTED};margin-bottom:4px;">${esc(k)}</div>
          <div style="font-size:14px;font-weight:600;color:${INK};">${esc(v)}</div>
        </td>`,
    )
    .join('');

  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND_SOFT};border-radius:10px;margin:0 0 24px;">
    <tr>${cells}</tr>
  </table>`;
}

function itemsBlock(ctx: OrderEmailContext): string {
  const rows = ctx.items
    .map(
      (i) => `
      <tr>
        <td style="padding:11px 0;border-bottom:1px solid ${HAIRLINE};font-size:14px;color:${INK};line-height:1.45;">
          <strong>${esc(i.productName)}</strong><br/>
          <span style="font-size:12.5px;color:${MUTED};">${esc(i.pack)}${i.sku ? ` · SKU: ${esc(i.sku)}` : ''} · Qty ${i.qty}${i.unitPricePaise ? ` · ${esc(formatInr(i.unitPricePaise))} each` : ''}</span>
        </td>
        <td style="padding:11px 0;border-bottom:1px solid ${HAIRLINE};font-size:14px;color:${INK};text-align:right;white-space:nowrap;vertical-align:top;">
          ${esc(formatInr(i.lineTotalPaise))}
        </td>
      </tr>`,
    )
    .join('');

  const totalRow = (label: string, value: string, strong = false) => `
      <tr>
        <td style="padding:${strong ? '12' : '5'}px 0 ${strong ? '0' : '5'}px;font-size:${strong ? '15' : '13.5'}px;color:${strong ? INK : MUTED};${strong ? 'font-weight:700;border-top:1px solid ' + HAIRLINE + ';' : ''}">${esc(label)}</td>
        <td style="padding:${strong ? '12' : '5'}px 0 ${strong ? '0' : '5'}px;font-size:${strong ? '18' : '13.5'}px;color:${strong ? BRAND : INK};text-align:right;white-space:nowrap;${strong ? 'font-weight:700;border-top:1px solid ' + HAIRLINE + ';' : ''}">${esc(value)}</td>
      </tr>`;

  const customerNoteBlock = ctx.customerNote
    ? `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0 0;">
    <tr>
      <td style="padding:14px 16px;background:#FBFCFD;border:1px solid ${HAIRLINE};border-radius:10px;">
        <div style="font-size:10.5px;letter-spacing:0.09em;text-transform:uppercase;color:${MUTED};margin-bottom:4px;">Delivery instructions / Note</div>
        <div style="font-size:13px;line-height:1.5;color:${INK};">${esc(ctx.customerNote)}</div>
      </td>
    </tr>
  </table>`
    : '';

  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
    <tbody>
      ${rows}
      ${totalRow('Subtotal', formatInr(ctx.subtotalPaise))}
      ${ctx.discountPaise > 0 ? totalRow('Discount', `− ${formatInr(ctx.discountPaise)}`) : ''}
      ${totalRow('Shipping', ctx.shippingPaise === 0 ? 'Free' : formatInr(ctx.shippingPaise))}
      ${ctx.taxPaise !== undefined && ctx.taxPaise > 0 ? totalRow('Tax (GST incl.)', formatInr(ctx.taxPaise)) : ''}
      ${totalRow(ctx.paymentMethod === 'COD' ? 'Total, pay on delivery' : 'Total paid', formatInr(ctx.totalPaise), true)}
    </tbody>
  </table>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0;">
    <tr>
      <td style="padding:16px;background:#FBFCFD;border:1px solid ${HAIRLINE};border-radius:10px;">
        <div style="font-size:10.5px;letter-spacing:0.09em;text-transform:uppercase;color:${MUTED};margin-bottom:6px;">Delivering to</div>
        <div style="font-size:13.5px;line-height:1.6;color:${INK};">${esc(ctx.addressLine)}</div>
      </td>
    </tr>
  </table>
  ${customerNoteBlock}`;
}

/**
 * Internal order details block for staff notifications sent to info@zewafeeds.com.
 *
 * Clearly displays customer details, comprehensive items breakdown with SKUs,
 * complete financials, payment gateway IDs, and strictly separates
 * CUSTOMER NOTE from INTERNAL NOTE.
 */
function staffOrderBlock(ctx: OrderEmailContext): string {
  const itemRows = ctx.items
    .map(
      (i) => `
      <tr>
        <td style="padding:10px 8px;border-bottom:1px solid ${HAIRLINE};font-size:13px;color:${INK};">
          <strong>${esc(i.productName)}</strong>
        </td>
        <td style="padding:10px 8px;border-bottom:1px solid ${HAIRLINE};font-size:12.5px;color:${MUTED};font-family:monospace;">
          ${esc(i.sku ?? '—')}
        </td>
        <td style="padding:10px 8px;border-bottom:1px solid ${HAIRLINE};font-size:12.5px;color:${MUTED};">
          ${esc(i.pack)}
        </td>
        <td style="padding:10px 8px;border-bottom:1px solid ${HAIRLINE};font-size:13px;color:${INK};text-align:center;">
          ${esc(i.qty)}
        </td>
        <td style="padding:10px 8px;border-bottom:1px solid ${HAIRLINE};font-size:13px;color:${INK};text-align:right;">
          ${esc(i.unitPricePaise ? formatInr(i.unitPricePaise) : '—')}
        </td>
        <td style="padding:10px 8px;border-bottom:1px solid ${HAIRLINE};font-size:13px;color:${INK};font-weight:600;text-align:right;">
          ${esc(formatInr(i.lineTotalPaise))}
        </td>
      </tr>`,
    )
    .join('');

  return `
  <!-- Customer Details -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border:1px solid ${HAIRLINE};border-radius:10px;background:#FBFCFD;overflow:hidden;">
    <tr>
      <td style="padding:12px 16px;background:${BRAND_SOFT};border-bottom:1px solid ${HAIRLINE};">
        <strong style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:${BRAND};">Customer Details</strong>
      </td>
    </tr>
    <tr>
      <td style="padding:14px 16px;font-size:13.5px;line-height:1.6;color:${INK};">
        <strong>Name:</strong> ${esc(ctx.customerName)}<br/>
        <strong>Email:</strong> <a href="mailto:${esc(ctx.customerEmail ?? '')}" style="color:${BRAND};text-decoration:none;">${esc(ctx.customerEmail ?? '—')}</a><br/>
        <strong>Phone:</strong> ${esc(ctx.customerPhone ?? '—')}<br/>
        <strong>Shipping Address:</strong> ${esc(ctx.addressLine)}
      </td>
    </tr>
  </table>

  <!-- Order & Items Table -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border:1px solid ${HAIRLINE};border-radius:10px;overflow:hidden;border-collapse:collapse;">
    <thead>
      <tr style="background:#F8FAFC;">
        <th style="padding:10px 8px;border-bottom:1px solid ${HAIRLINE};text-align:left;font-size:11px;text-transform:uppercase;color:${MUTED};">Product</th>
        <th style="padding:10px 8px;border-bottom:1px solid ${HAIRLINE};text-align:left;font-size:11px;text-transform:uppercase;color:${MUTED};">SKU</th>
        <th style="padding:10px 8px;border-bottom:1px solid ${HAIRLINE};text-align:left;font-size:11px;text-transform:uppercase;color:${MUTED};">Pack</th>
        <th style="padding:10px 8px;border-bottom:1px solid ${HAIRLINE};text-align:center;font-size:11px;text-transform:uppercase;color:${MUTED};">Qty</th>
        <th style="padding:10px 8px;border-bottom:1px solid ${HAIRLINE};text-align:right;font-size:11px;text-transform:uppercase;color:${MUTED};">Unit Price</th>
        <th style="padding:10px 8px;border-bottom:1px solid ${HAIRLINE};text-align:right;font-size:11px;text-transform:uppercase;color:${MUTED};">Line Total</th>
      </tr>
    </thead>
    <tbody>
      ${itemRows}
    </tbody>
  </table>

  <!-- Financial & Gateway Details -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">
    <tr>
      <td width="48%" style="vertical-align:top;padding-right:8px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${HAIRLINE};border-radius:10px;background:#FBFCFD;">
          <tr>
            <td style="padding:10px 14px;background:#F8FAFC;border-bottom:1px solid ${HAIRLINE};">
              <strong style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${MUTED};">Payment Information</strong>
            </td>
          </tr>
          <tr>
            <td style="padding:12px 14px;font-size:12.5px;line-height:1.6;color:${INK};">
              <strong>Method:</strong> ${esc(ctx.paymentMethod)}<br/>
              <strong>Status:</strong> <span style="font-weight:700;color:${ctx.paymentStatus === 'PAID' ? BRAND : '#D97706'};">${esc(ctx.paymentStatus ?? 'PAID')}</span><br/>
              <strong>Razorpay Order:</strong> <span style="font-family:monospace;">${esc(ctx.razorpayOrderId ?? '—')}</span><br/>
              <strong>Razorpay Payment:</strong> <span style="font-family:monospace;">${esc(ctx.razorpayPaymentId ?? '—')}</span>
            </td>
          </tr>
        </table>
      </td>
      <td width="52%" style="vertical-align:top;padding-left:8px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${HAIRLINE};border-radius:10px;background:#FBFCFD;">
          <tr>
            <td style="padding:10px 14px;background:#F8FAFC;border-bottom:1px solid ${HAIRLINE};">
              <strong style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${MUTED};">Financial Breakdown</strong>
            </td>
          </tr>
          <tr>
            <td style="padding:12px 14px;font-size:12.5px;line-height:1.6;color:${INK};">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr><td style="color:${MUTED};">Subtotal:</td><td style="text-align:right;">${esc(formatInr(ctx.subtotalPaise))}</td></tr>
                ${ctx.discountPaise > 0 ? `<tr><td style="color:${MUTED};">Discount:</td><td style="text-align:right;color:#DC2626;">− ${esc(formatInr(ctx.discountPaise))}</td></tr>` : ''}
                <tr><td style="color:${MUTED};">Shipping:</td><td style="text-align:right;">${ctx.shippingPaise === 0 ? 'Free' : esc(formatInr(ctx.shippingPaise))}</td></tr>
                ${ctx.taxPaise !== undefined && ctx.taxPaise > 0 ? `<tr><td style="color:${MUTED};">Tax (GST):</td><td style="text-align:right;">${esc(formatInr(ctx.taxPaise))}</td></tr>` : ''}
                <tr><td style="padding-top:6px;border-top:1px solid ${HAIRLINE};font-weight:700;font-size:14px;color:${INK};">Total:</td><td style="padding-top:6px;border-top:1px solid ${HAIRLINE};text-align:right;font-weight:700;font-size:15px;color:${BRAND};">${esc(formatInr(ctx.totalPaise))}</td></tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>

  <!-- Strictly Separated Notes -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 10px;border:1px solid ${HAIRLINE};border-radius:10px;background:#FBFCFD;overflow:hidden;">
    <tr>
      <td style="padding:10px 14px;background:#F8FAFC;border-bottom:1px solid ${HAIRLINE};">
        <strong style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${MUTED};">CUSTOMER NOTE</strong>
      </td>
    </tr>
    <tr>
      <td style="padding:12px 14px;font-size:13px;line-height:1.5;color:${INK};">
        ${ctx.customerNote ? esc(ctx.customerNote) : `<span style="color:${MUTED};font-style:italic;">None provided by customer</span>`}
      </td>
    </tr>
  </table>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border:1px solid ${HAIRLINE};border-radius:10px;background:#FBFCFD;overflow:hidden;">
    <tr>
      <td style="padding:10px 14px;background:#F8FAFC;border-bottom:1px solid ${HAIRLINE};">
        <strong style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${MUTED};">INTERNAL NOTE</strong>
      </td>
    </tr>
    <tr>
      <td style="padding:12px 14px;font-size:13px;line-height:1.5;color:${INK};">
        ${ctx.internalNote ? esc(ctx.internalNote) : `<span style="color:${MUTED};font-style:italic;">None</span>`}
      </td>
    </tr>
  </table>`;
}

/**
 * Call to action.
 *
 * A padded table cell rather than a styled <a>: Outlook ignores padding on
 * inline elements, which collapses a CSS button into bare underlined text.
 */
const button = (label: string, url: string) => `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 0;">
    <tr>
      <td style="background:${BRAND};border-radius:8px;">
        <a href="${esc(url)}" style="display:inline-block;padding:13px 26px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;letter-spacing:0.2px;">${esc(label)}</a>
      </td>
    </tr>
  </table>`;

/** Muted note under a CTA — tracking numbers, expiry, fallback links. */
const note = (html: string) => `
  <p style="margin:20px 0 0;font-size:12.5px;line-height:1.65;color:${MUTED};">${html}</p>`;

const trackUrl = (orderNo: string, email: string) =>
  `${env.STOREFRONT_ORIGIN}/orders/track?orderNo=${encodeURIComponent(orderNo)}&email=${encodeURIComponent(email)}`;

// ---- Customer templates (§6.3) ---------------------------------------------

export const templates = {
  /** Sent immediately on order placement. */
  'order-placed': (ctx: OrderEmailContext, email: string) => ({
    subject: `Order ${ctx.orderNo} confirmed`,
    html: shell(
      `Thanks, ${esc(firstName(ctx.customerName))}.`,
      ctx.paymentMethod === 'COD'
        ? `We've got your order. You'll pay <strong style="color:${INK};">${esc(formatInr(ctx.totalPaise))}</strong> in cash when it arrives, and we'll call to confirm before it ships.`
        : `We've got your order and your payment is confirmed. You'll hear from us again the moment it ships.`,
      factsBlock([
        ['Order', ctx.orderNo],
        ['Date', formatDate(ctx.placedAt)],
        ['Total', formatInr(ctx.totalPaise)],
        ['Payment', ctx.paymentMethod === 'COD' ? 'On delivery' : 'Paid online'],
      ]) +
        itemsBlock(ctx) +
        button('Track your order', trackUrl(ctx.orderNo, email)),
      `Order ${ctx.orderNo} · ${formatInr(ctx.totalPaise)} · we'll email again when it ships`,
    ),
  }),

  /** PROCESSING — invoice attached (§6.5). */
  'order-confirmed': (ctx: OrderEmailContext, email: string) => ({
    subject: `Order ${ctx.orderNo} is being packed`,
    html: shell(
      'Your order is being packed.',
      `We've accepted order <strong style="color:${INK};">${esc(ctx.orderNo)}</strong> and it's with our packing team.${
        ctx.invoiceNumber ? ' Your tax invoice is attached to this email.' : ''
      }`,
      factsBlock([
        ['Order', ctx.orderNo],
        ['Invoice', ctx.invoiceNumber ?? '—'],
        ['Total', formatInr(ctx.totalPaise)],
      ]) +
        itemsBlock(ctx) +
        button('Track your order', trackUrl(ctx.orderNo, email)),
      `${ctx.orderNo} accepted and being packed`,
    ),
  }),

  'order-shipped': (ctx: OrderEmailContext, email: string) => ({
    subject: `Order ${ctx.orderNo} is on its way`,
    html: shell(
      'On its way.',
      `Order <strong style="color:${INK};">${esc(ctx.orderNo)}</strong> left us${
        ctx.carrier ? ` with ${esc(ctx.carrier)}` : ''
      } and is heading to you.`,
      factsBlock([
        ['Carrier', ctx.carrier ?? '—'],
        ['Tracking number', ctx.trackingNumber ?? '—'],
      ]) +
        button('Track shipment', ctx.trackingUrl || trackUrl(ctx.orderNo, email)) +
        (ctx.trackingUrl
          ? ''
          : note(
              `Tracking can take a few hours to go live on the carrier's site after dispatch.`,
            )),
      `${ctx.carrier ?? 'Your parcel'} · ${ctx.trackingNumber ?? ctx.orderNo}`,
    ),
  }),

  'order-delivered': (ctx: OrderEmailContext, _email: string) => ({
    subject: `Order ${ctx.orderNo} was delivered`,
    html: shell(
      'Delivered.',
      `Order <strong style="color:${INK};">${esc(ctx.orderNo)}</strong> was delivered${
        ctx.deliveredOn
          ? ` on ${esc(ctx.deliveredOn.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }))}`
          : ''
      }. We'd genuinely like to know how your fish take to it.`,
      button('Write a review', `${env.STOREFRONT_ORIGIN}/products`) +
        note('Feeding guidance for the first week is on each product page.'),
      `${ctx.orderNo} delivered`,
    ),
  }),

  /*
   * Cancellation does NOT refund. A member of the team processes the gateway
   * refund afterwards, so this email must not imply the money is already
   * moving, and must not start the 5–7 day clock at cancellation — the wait
   * begins when the refund is processed, which may be later.
   *
   * The refund sentence is also conditional: a COD order was never charged, so
   * promising it money back would invent a refund that cannot exist.
   */
  'order-cancelled': (ctx: OrderEmailContext, _email: string) => {
    const isPrepaid = ctx.paymentMethod !== 'COD' && ctx.paymentStatus === 'PAID';

    return {
      subject: `Order ${ctx.orderNo} was cancelled`,
      html: shell(
        'Your order was cancelled.',
        `Order <strong style="color:${INK};">${esc(ctx.orderNo)}</strong> has been cancelled.${
          ctx.cancelReason ? ` Reason: ${esc(ctx.cancelReason)}.` : ''
        }${
          isPrepaid
            ? ' Any payment you have made will be refunded to the original source automatically in full, after deducting applicable gateway charges, within 5 working days. You can track your refund status from your order page.'
            : ' No payment was collected for this order, so no refund is required.'
        }`,
        note(
          isPrepaid
            ? `After the refund is processed by your bank, it may take 5–7 working days to reflect. If this cancellation wasn't expected, reply to this email and we'll look into it.`
            : `If this cancellation wasn't expected, reply to this email and we'll look into it.`,
        ),
        isPrepaid
          ? `${ctx.orderNo} cancelled · refund initiated`
          : `${ctx.orderNo} cancelled`,
      ),
    };
  },

  'refund-processed': (
    ctx: OrderEmailContext & { refundPaise: number; refundReason: string },
    _email: string,
  ) => ({
    subject: `Refund sent for order ${ctx.orderNo}`,
    html: shell(
      'Your refund is on its way.',
      `We've refunded <strong style="color:${INK};">${esc(formatInr(ctx.refundPaise))}</strong> for order <strong style="color:${INK};">${esc(ctx.orderNo)}</strong>.`,
      factsBlock([
        ['Refunded', formatInr(ctx.refundPaise)],
        ['Order', ctx.orderNo],
      ]) +
        note(
          `It usually reaches your account in 5–7 working days, back on the method you paid with. Reason: ${esc(ctx.refundReason)}`,
        ),
      `${formatInr(ctx.refundPaise)} refunded for ${ctx.orderNo}`,
    ),
  }),
} as const;

/** "Priya Nair" → "Priya". Falls back to something addressable. */
function firstName(full: string): string {
  return full?.trim().split(/\s+/)[0] || 'there';
}

export type CustomerTemplateName = keyof typeof templates;

// ---- Account templates -----------------------------------------------------
//
// Kept apart from `templates` above because those are all keyed to an order and
// render from OrderEmailContext. Account mail has no order behind it, so giving
// it its own registry keeps both context types honest rather than making every
// order field optional.

export const accountTemplates = {
  /**
   * CMS staff invitation link.
   */
  'cms-user-invitation': (ctx: {
    recipientName: string;
    recipientEmail: string;
    roleLabel: string;
    inviteUrl: string;
    expiresInHours: number;
  }) => ({
    subject: "You're invited to Zewa Feeds CMS",
    html: shell(
      "You've been invited to Zewa Feeds CMS.",
      `Hi ${esc(ctx.recipientName)}, you have been invited to join the Zewa Feeds CMS team as <strong style="color:${BRAND};">${esc(ctx.roleLabel)}</strong>. Click the button below to set your password and activate your account.`,
      factsBlock([
        ['Assigned Role', ctx.roleLabel],
        ['Account Email', ctx.recipientEmail],
        ['Link Validity', `${ctx.expiresInHours} hours`],
      ]) +
        button('Accept Invitation & Set Password', ctx.inviteUrl) +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0;">
           <tr>
             <td style="padding:14px 16px;background:#FBFCFD;border:1px solid ${HAIRLINE};border-radius:10px;">
               <div style="font-size:11px;color:${MUTED};margin-bottom:6px;">If the button doesn't work, paste this into your browser:</div>
               <div style="font-size:12px;line-height:1.5;color:${INK};word-break:break-all;">${esc(ctx.inviteUrl)}</div>
             </td>
           </tr>
         </table>` +
        note(
          `<strong style="color:${INK};">Security notice:</strong> This invitation link is single-use and expires in ${ctx.expiresInHours} hours. Two-factor authentication (2FA) will be configured on your first sign-in.`,
        ),
      `You're invited to Zewa Feeds CMS as ${esc(ctx.roleLabel)}`,
    ),
  }),

  /**
   * Password reset link.
   *
   * States the expiry and says what to do if it was not requested — an
   * unexpected reset mail is exactly when someone needs to know their address is
   * known to someone else, and silence there is its own security failure.
   */
  'password-reset': (ctx: { firstName: string; resetUrl: string; expiresInMinutes: number }) => ({
    subject: 'Reset your Zewa Feeds password',
    html: shell(
      'Reset your password.',
      `Hi ${esc(ctx.firstName)}, we got a request to reset the password on your Zewa Feeds account. Choose a new one using the button below.`,
      button('Choose a new password', ctx.resetUrl) +
        note(
          `This link works once and expires in ${esc(ctx.expiresInMinutes)} minutes.`,
        ) +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 0;">
           <tr>
             <td style="padding:14px 16px;background:#FBFCFD;border:1px solid ${HAIRLINE};border-radius:10px;">
               <div style="font-size:11px;color:${MUTED};margin-bottom:6px;">If the button doesn't work, paste this into your browser:</div>
               <div style="font-size:12px;line-height:1.5;color:${INK};word-break:break-all;">${esc(ctx.resetUrl)}</div>
             </td>
           </tr>
         </table>` +
        note(
          `<strong style="color:${INK};">Didn't ask for this?</strong> You can ignore this email — your password stays exactly as it is, and nobody can use this link without your inbox.`,
        ),
      'Reset your password — the link expires in 60 minutes',
    ),
  }),

  /**
   * Customer account email verification link.
   */
  'customer-email-verification': (ctx: {
    firstName: string;
    verifyUrl: string;
    expiresInHours: number;
  }) => ({
    subject: 'Verify your Zewa Feeds account',
    html: shell(
      'Verify your email address.',
      `Hi ${esc(ctx.firstName)}, thank you for creating an account with Zewa Feeds. Click the button below to verify your email address and activate your account.`,
      button('Verify Email Address', ctx.verifyUrl) +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 0;">
           <tr>
             <td style="padding:14px 16px;background:#FBFCFD;border:1px solid ${HAIRLINE};border-radius:10px;">
               <div style="font-size:11px;color:${MUTED};margin-bottom:6px;">If the button doesn't work, paste this link into your browser:</div>
               <div style="font-size:12px;line-height:1.5;color:${INK};word-break:break-all;">${esc(ctx.verifyUrl)}</div>
             </td>
           </tr>
         </table>` +
        note(
          `This link works once and expires in ${esc(ctx.expiresInHours)} hours. <strong style="color:${INK};">Didn't create an account?</strong> You can safely ignore this email — no account will be activated without your confirmation.`,
        ),
      'Verify your email to activate your Zewa Feeds account',
    ),
  }),

  /**
   * Confirmation that a password actually changed.
   *
   * Sent after both the reset flow and a signed-in change, because this is the
   * message that lets someone notice a takeover they did not perform.
   */
  'password-changed': (ctx: { firstName: string }) => ({
    subject: 'Your Zewa Feeds password was changed',
    html: shell(
      'Your password was changed.',
      `Hi ${esc(ctx.firstName)}, the password on your Zewa Feeds account was just changed.`,
      note(
        `If that was you, there's nothing to do. <strong style="color:${INK};">If it wasn't</strong>, reply to this email straight away and we'll lock the account down.`,
      ),
      'Your account password was just changed',
    ),
  }),
} as const;

export type AccountTemplateName = keyof typeof accountTemplates;

export interface StaffRefundContext extends OrderEmailContext {
  refundPaise: number;
  refundReason: string;
  gatewayRefundId?: string | null;
  refundDate?: Date | string | null;
  processedByName?: string | null;
}

/**
 * Internal alert for a cancellation the CUSTOMER initiated.
 *
 * Distinct from a staff cancellation, which ops already know about because
 * they performed it. This one arrives unannounced and usually needs a refund
 * decision, so it carries the payment identifiers needed to act on it.
 */
export interface StaffCancellationContext extends OrderEmailContext {
  cancelledBy: 'customer' | 'staff';
  cancelledAtDate?: Date | string | null;
  /** 'pending' when money was captured and not yet returned. */
  refundState: 'none' | 'pending' | 'processed' | 'partial';
}

export const staffTemplates = {
  'staff-new-order': (ctx: OrderEmailContext) => ({
    subject: `New Order Placed — #${ctx.orderNo}`,
    html: shell(
      `New Order Placed — #${esc(ctx.orderNo)}`,
      `A new order was placed on ${esc(formatDate(ctx.placedAt))} for <strong style="color:${BRAND};">${esc(formatInr(ctx.totalPaise))}</strong> via ${esc(ctx.paymentMethod)} (${esc(ctx.paymentStatus ?? (ctx.paymentMethod === 'COD' ? 'UNPAID' : 'PAID'))}).`,
      staffOrderBlock(ctx) + button('Open in CMS', `${env.CMS_ORIGIN}/orders/${ctx.orderNo}`),
      `New order #${ctx.orderNo} from ${esc(ctx.customerName)} · ${formatInr(ctx.totalPaise)}`,
    ),
  }),

  'staff-refund-processed': (ctx: StaffRefundContext) => ({
    subject: `Refund Processed — #${ctx.orderNo}`,
    html: shell(
      `Refund Processed — #${esc(ctx.orderNo)}`,
      `A refund of <strong style="color:${BRAND};">${esc(formatInr(ctx.refundPaise))}</strong> has been processed for order <strong style="color:${INK};">${esc(ctx.orderNo)}</strong>.`,
      `
      <!-- Internal Refund Summary -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border:1px solid ${HAIRLINE};border-radius:10px;background:#FBFCFD;overflow:hidden;">
        <tr>
          <td style="padding:12px 16px;background:${BRAND_SOFT};border-bottom:1px solid ${HAIRLINE};">
            <strong style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:${BRAND};">Refund Details (Internal Notice)</strong>
          </td>
        </tr>
        <tr>
          <td style="padding:14px 16px;font-size:13.5px;line-height:1.6;color:${INK};">
            <strong>Refund Amount:</strong> <strong style="color:${BRAND};">${esc(formatInr(ctx.refundPaise))}</strong><br/>
            <strong>Original Order Total:</strong> ${esc(formatInr(ctx.totalPaise))}<br/>
            <strong>Payment Method:</strong> ${esc(ctx.paymentMethod)} (${esc(ctx.paymentStatus ?? 'PAID')})<br/>
            <strong>Razorpay Payment ID:</strong> <code style="font-family:monospace;font-size:12px;background:#F1F3F5;padding:2px 4px;border-radius:4px;">${esc(ctx.razorpayPaymentId ?? '—')}</code><br/>
            <strong>Razorpay Refund ID:</strong> <code style="font-family:monospace;font-size:12px;background:#F1F3F5;padding:2px 4px;border-radius:4px;">${esc(ctx.gatewayRefundId ?? '—')}</code><br/>
            <strong>Refund Reason:</strong> ${esc(ctx.refundReason)}<br/>
            <strong>Processed On:</strong> ${esc(formatDate(ctx.refundDate ?? new Date()))}${ctx.processedByName ? `<br/><strong>Processed By:</strong> ${esc(ctx.processedByName)}` : ''}
          </td>
        </tr>
      </table>

      <!-- Customer Details -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border:1px solid ${HAIRLINE};border-radius:10px;background:#FBFCFD;overflow:hidden;">
        <tr>
          <td style="padding:12px 16px;background:${BRAND_SOFT};border-bottom:1px solid ${HAIRLINE};">
            <strong style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:${BRAND};">Customer Information</strong>
          </td>
        </tr>
        <tr>
          <td style="padding:14px 16px;font-size:13.5px;line-height:1.6;color:${INK};">
            <strong>Customer Name:</strong> ${esc(ctx.customerName)}<br/>
            <strong>Email:</strong> <a href="mailto:${esc(ctx.customerEmail ?? '')}" style="color:${BRAND};text-decoration:none;">${esc(ctx.customerEmail ?? '—')}</a><br/>
            <strong>Phone:</strong> ${esc(ctx.customerPhone ?? '—')}
          </td>
        </tr>
      </table>
      ` + button('Open Order in CMS', `${env.CMS_ORIGIN}/orders/${ctx.orderNo}`),
      `Refund of ${formatInr(ctx.refundPaise)} processed for order #${ctx.orderNo} (${esc(ctx.customerName)})`,
    ),
  }),

  'staff-order-cancelled': (ctx: StaffCancellationContext) => ({
    subject: `Order Cancelled by Customer — #${ctx.orderNo}`,
    html: shell(
      `Order Cancelled by Customer — #${esc(ctx.orderNo)}`,
      `Order <strong style="color:${INK};">${esc(ctx.orderNo)}</strong> for <strong style="color:${BRAND};">${esc(formatInr(ctx.totalPaise))}</strong> was cancelled by the customer on ${esc(formatDate(ctx.cancelledAtDate ?? new Date()))}. Stock has been returned automatically.`,
      `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border:1px solid ${HAIRLINE};border-radius:10px;background:#FBFCFD;overflow:hidden;">
        <tr>
          <td style="padding:12px 16px;background:${BRAND_SOFT};border-bottom:1px solid ${HAIRLINE};">
            <strong style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:${BRAND};">Cancellation Details (Internal Notice)</strong>
          </td>
        </tr>
        <tr>
          <td style="padding:14px 16px;font-size:13.5px;line-height:1.6;color:${INK};">
            <strong>Cancelled By:</strong> Customer<br/>
            <strong>Reason:</strong> ${esc(ctx.cancelReason ?? 'No reason given')}<br/>
            <strong>Order Total:</strong> ${esc(formatInr(ctx.totalPaise))}<br/>
            <strong>Payment Method:</strong> ${esc(ctx.paymentMethod)} (${esc(ctx.paymentStatus ?? '—')})<br/>
            <strong>Refund Status:</strong> ${
              ctx.refundState === 'pending'
                ? `<strong style="color:#C0392F;">ACTION REQUIRED — payment captured, refund not yet processed</strong>`
                : ctx.refundState === 'processed'
                  ? 'Already refunded'
                  : ctx.refundState === 'partial'
                    ? 'Partially refunded'
                    : 'No refund due (nothing captured)'
            }<br/>
            <strong>Razorpay Order ID:</strong> <code style="font-family:monospace;font-size:12px;background:#F1F3F5;padding:2px 4px;border-radius:4px;">${esc(ctx.razorpayOrderId ?? '—')}</code><br/>
            <strong>Razorpay Payment ID:</strong> <code style="font-family:monospace;font-size:12px;background:#F1F3F5;padding:2px 4px;border-radius:4px;">${esc(ctx.razorpayPaymentId ?? '—')}</code>
          </td>
        </tr>
      </table>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border:1px solid ${HAIRLINE};border-radius:10px;background:#FBFCFD;overflow:hidden;">
        <tr>
          <td style="padding:12px 16px;background:${BRAND_SOFT};border-bottom:1px solid ${HAIRLINE};">
            <strong style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:${BRAND};">Customer Information</strong>
          </td>
        </tr>
        <tr>
          <td style="padding:14px 16px;font-size:13.5px;line-height:1.6;color:${INK};">
            <strong>Customer Name:</strong> ${esc(ctx.customerName)}<br/>
            <strong>Email:</strong> <a href="mailto:${esc(ctx.customerEmail ?? '')}" style="color:${BRAND};text-decoration:none;">${esc(ctx.customerEmail ?? '—')}</a><br/>
            <strong>Phone:</strong> ${esc(ctx.customerPhone ?? '—')}
          </td>
        </tr>
      </table>
      ` + button('Open Order in CMS', `${env.CMS_ORIGIN}/orders/${ctx.orderNo}`),
      `Order #${ctx.orderNo} cancelled by ${esc(ctx.customerName)} · ${formatInr(ctx.totalPaise)}${ctx.refundState === 'pending' ? ' · refund required' : ''}`,
    ),
  }),

  'staff-stock-zero': (ctx: { sku: string; productName: string }) => ({
    subject: `Stock alert: ${ctx.sku} is out of stock`,
    html: shell(
      'Stock reached zero',
      `<strong>${esc(ctx.productName)}</strong> (${esc(ctx.sku)}) has sold out and is no longer purchasable.`,
      button('Update stock', `${env.CMS_ORIGIN}/products`),
    ),
  }),

  'staff-new-review': (ctx: { productName: string; rating: number; excerpt: string }) => ({
    subject: `New ${ctx.rating}★ review on ${ctx.productName}`,
    html: shell(
      'Review awaiting moderation',
      `${esc(ctx.rating)}★ on <strong>${esc(ctx.productName)}</strong>: “${esc(ctx.excerpt)}”`,
      button('Moderate reviews', `${env.CMS_ORIGIN}/reviews`),
    ),
  }),
} as const;

export type StaffTemplateName = keyof typeof staffTemplates;
