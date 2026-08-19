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
          ${esc(i.productName)}<br/>
          <span style="font-size:12.5px;color:${MUTED};">${esc(i.pack)} · Qty ${i.qty}</span>
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

  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
    <tbody>
      ${rows}
      ${totalRow('Subtotal', formatInr(ctx.subtotalPaise))}
      ${ctx.discountPaise > 0 ? totalRow('Discount', `− ${formatInr(ctx.discountPaise)}`) : ''}
      ${totalRow('Shipping', ctx.shippingPaise === 0 ? 'Free' : formatInr(ctx.shippingPaise))}
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

  'order-cancelled': (ctx: OrderEmailContext, _email: string) => ({
    subject: `Order ${ctx.orderNo} was cancelled`,
    html: shell(
      'Your order was cancelled.',
      `Order <strong style="color:${INK};">${esc(ctx.orderNo)}</strong> has been cancelled.${
        ctx.cancelReason ? ` Reason given: ${esc(ctx.cancelReason)}.` : ''
      } Any payment already made goes back to the method you paid with.`,
      note(
        `Refunds usually land within 5–7 working days. If this cancellation wasn't expected, reply to this email and we'll look into it.`,
      ),
      `${ctx.orderNo} cancelled · any payment will be refunded`,
    ),
  }),

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
