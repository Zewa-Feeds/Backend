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

const BRAND = '#0d9f8c';
const INK = '#0b1220';
const MUTED = '#5b6572';

export interface OrderEmailContext {
  orderNo: string;
  customerName: string;
  items: { productName: string; pack: string; qty: number; lineTotalPaise: number }[];
  subtotalPaise: number;
  discountPaise: number;
  shippingPaise: number;
  totalPaise: number;
  paymentMethod: 'RAZORPAY' | 'COD';
  addressLine: string;
  invoiceNumber?: string | null;
  carrier?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  cancelReason?: string | null;
  deliveredOn?: Date | null;
}

function shell(heading: string, intro: string, body: string): string {
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f5f7fa;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e6eaf0;">
    <div style="padding:20px 28px;border-bottom:3px solid ${BRAND};">
      <span style="font-size:17px;font-weight:700;color:${INK};letter-spacing:-0.2px;">Zewa Feeds</span>
    </div>
    <div style="padding:28px;">
      <h1 style="margin:0 0 10px;font-size:20px;color:${INK};">${heading}</h1>
      <p style="margin:0 0 22px;font-size:14px;line-height:1.6;color:${MUTED};">${intro}</p>
      ${body}
    </div>
    <div style="padding:18px 28px;background:#fafbfc;border-top:1px solid #e6eaf0;">
      <p style="margin:0;font-size:11px;line-height:1.6;color:#8b94a1;">
        ${esc(env.COMPANY_NAME)} · GSTIN ${esc(env.COMPANY_GSTIN)}<br/>
        Questions? Reply to this email or write to ${esc(env.COMPANY_EMAIL)}.
      </p>
    </div>
  </div>
</body></html>`;
}

function itemsBlock(ctx: OrderEmailContext): string {
  const rows = ctx.items
    .map(
      (i) => `
      <tr>
        <td style="padding:8px 0;font-size:13px;color:${INK};">
          ${esc(i.productName)}
          <span style="color:${MUTED};">· ${esc(i.pack)} × ${i.qty}</span>
        </td>
        <td style="padding:8px 0;font-size:13px;color:${INK};text-align:right;white-space:nowrap;">
          ${esc(formatInr(i.lineTotalPaise))}
        </td>
      </tr>`,
    )
    .join('');

  const totalRow = (label: string, value: string, strong = false) => `
      <tr>
        <td style="padding:5px 0;font-size:${strong ? '15' : '13'}px;color:${strong ? INK : MUTED};${strong ? 'font-weight:700;' : ''}">${esc(label)}</td>
        <td style="padding:5px 0;font-size:${strong ? '15' : '13'}px;color:${INK};text-align:right;${strong ? 'font-weight:700;' : ''}">${esc(value)}</td>
      </tr>`;

  return `
  <table style="width:100%;border-collapse:collapse;">
    <tbody>
      ${rows}
      <tr><td colspan="2" style="border-top:1px solid #e6eaf0;padding-top:8px;"></td></tr>
      ${totalRow('Subtotal', formatInr(ctx.subtotalPaise))}
      ${ctx.discountPaise > 0 ? totalRow('Discount', `- ${formatInr(ctx.discountPaise)}`) : ''}
      ${totalRow('Shipping', ctx.shippingPaise === 0 ? 'FREE' : formatInr(ctx.shippingPaise))}
      ${totalRow(ctx.paymentMethod === 'COD' ? 'Total (pay on delivery)' : 'Total paid', formatInr(ctx.totalPaise), true)}
    </tbody>
  </table>
  <p style="margin:20px 0 0;font-size:12px;line-height:1.6;color:${MUTED};">
    <strong style="color:${INK};">Delivering to</strong><br/>${esc(ctx.addressLine)}
  </p>`;
}

const button = (label: string, url: string) => `
  <p style="margin:22px 0 0;">
    <a href="${esc(url)}" style="display:inline-block;padding:11px 20px;background:${BRAND};color:#fff;text-decoration:none;border-radius:8px;font-size:13px;font-weight:600;">${esc(label)}</a>
  </p>`;

const trackUrl = (orderNo: string, email: string) =>
  `${env.STOREFRONT_ORIGIN}/orders/track?orderNo=${encodeURIComponent(orderNo)}&email=${encodeURIComponent(email)}`;

// ---- Customer templates (§6.3) ---------------------------------------------

export const templates = {
  /** Sent immediately on order placement. */
  'order-placed': (ctx: OrderEmailContext, email: string) => ({
    subject: `We've received your order ${ctx.orderNo}`,
    html: shell(
      `Thanks, ${esc(ctx.customerName.split(' ')[0] ?? 'there')}!`,
      ctx.paymentMethod === 'COD'
        ? `Your order <strong>${esc(ctx.orderNo)}</strong> is placed. You'll pay ${esc(formatInr(ctx.totalPaise))} in cash when it arrives. We'll call to confirm before dispatch.`
        : `Your order <strong>${esc(ctx.orderNo)}</strong> is placed and payment is confirmed. We'll email again as soon as it ships.`,
      itemsBlock(ctx) + button('Track your order', trackUrl(ctx.orderNo, email)),
    ),
  }),

  /** PROCESSING — invoice attached (§6.5). */
  'order-confirmed': (ctx: OrderEmailContext, email: string) => ({
    subject: 'Your Zewa Feeds order is confirmed',
    html: shell(
      'Your order is confirmed',
      `We've accepted order <strong>${esc(ctx.orderNo)}</strong> and it's being packed.${
        ctx.invoiceNumber ? ` Your tax invoice (${esc(ctx.invoiceNumber)}) is attached.` : ''
      }`,
      itemsBlock(ctx) + button('Track your order', trackUrl(ctx.orderNo, email)),
    ),
  }),

  'order-shipped': (ctx: OrderEmailContext, email: string) => ({
    subject: 'Your order has shipped',
    html: shell(
      'On its way',
      `Order <strong>${esc(ctx.orderNo)}</strong> has been dispatched${
        ctx.carrier ? ` via ${esc(ctx.carrier)}` : ''
      }.`,
      `<p style="margin:0 0 6px;font-size:13px;color:${INK};">
         <strong>Carrier</strong> ${esc(ctx.carrier ?? '—')}<br/>
         <strong>Tracking</strong> <span style="font-family:monospace;">${esc(ctx.trackingNumber ?? '—')}</span>
       </p>` +
        button('Track shipment', ctx.trackingUrl || trackUrl(ctx.orderNo, email)),
    ),
  }),

  'order-delivered': (ctx: OrderEmailContext, _email: string) => ({
    subject: 'Your order was delivered',
    html: shell(
      'Delivered',
      `Order <strong>${esc(ctx.orderNo)}</strong> was delivered${
        ctx.deliveredOn
          ? ` on ${esc(ctx.deliveredOn.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }))}`
          : ''
      }. We'd love to know how your fish are getting on.`,
      button('Write a review', `${env.STOREFRONT_ORIGIN}/products`),
    ),
  }),

  'order-cancelled': (ctx: OrderEmailContext, _email: string) => ({
    subject: 'Your order was cancelled',
    html: shell(
      'Order cancelled',
      `Order <strong>${esc(ctx.orderNo)}</strong> has been cancelled.${
        ctx.cancelReason ? ` Reason: ${esc(ctx.cancelReason)}.` : ''
      } Any payment made will be refunded to the original method.`,
      `<p style="margin:0;font-size:13px;color:${MUTED};">If this wasn't expected, reply to this email and we'll look into it.</p>`,
    ),
  }),

  'refund-processed': (
    ctx: OrderEmailContext & { refundPaise: number; refundReason: string },
    _email: string,
  ) => ({
    subject: 'Your refund has been processed',
    html: shell(
      'Refund processed',
      `We've refunded <strong>${esc(formatInr(ctx.refundPaise))}</strong> for order <strong>${esc(ctx.orderNo)}</strong>. It usually reaches your account in 5–7 working days.`,
      `<p style="margin:0;font-size:13px;color:${MUTED};">Reason: ${esc(ctx.refundReason)}</p>`,
    ),
  }),
} as const;

export type CustomerTemplateName = keyof typeof templates;

// ---- Staff alert templates (§15) -------------------------------------------

export const staffTemplates = {
  'staff-new-order': (ctx: { orderNo: string; customerName: string; totalPaise: number; itemCount: number; paymentMethod: string }) => ({
    subject: `New order ${ctx.orderNo} — ${formatInr(ctx.totalPaise)}`,
    html: shell(
      'New order placed',
      `<strong>${esc(ctx.orderNo)}</strong> from ${esc(ctx.customerName)} — ${esc(ctx.itemCount)} item(s), ${esc(formatInr(ctx.totalPaise))} (${esc(ctx.paymentMethod)}).`,
      button('Open in CMS', `${env.CMS_ORIGIN}/orders/${ctx.orderNo}`),
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
