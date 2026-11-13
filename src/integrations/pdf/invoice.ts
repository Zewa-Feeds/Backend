/**
 * Tax invoice PDF — spec §6.5.
 *
 * Built with pdf-lib: deterministic, no headless browser, no template engine.
 *
 * Everything printed comes from the ORDER SNAPSHOT (productName, sku, hsn,
 * taxRatePct, unitPricePaise on OrderItem) rather than the live catalogue. An
 * invoice is a legal document: if a product's price or name changes next month,
 * last month's invoice must still show what was actually charged.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import { computeInvoiceTax, formatInr, type TaxConfig, type TaxableLine } from '@/modules/orders/tax';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'pdf.invoice' });

/**
 * Brand mark for the invoice header.
 *
 * Resolved from the project root rather than `__dirname`: `tsc` compiles TS to
 * dist/ but does not copy assets, so a path relative to the compiled file would
 * exist in development and 404 in production.
 *
 * Read once and cached — an invoice PDF is generated per order, and re-reading
 * a 64KB file each time is pointless. `null` means we tried and failed; the
 * header then falls back to the company name in text, because a missing logo
 * must never stop a legally required document from being produced.
 */
const LOGO_PATH = join(process.cwd(), 'assets', 'logo.png');
let logoBytes: Uint8Array | null | undefined;

async function loadLogo(): Promise<Uint8Array | null> {
  if (logoBytes !== undefined) return logoBytes;
  try {
    logoBytes = new Uint8Array(await readFile(LOGO_PATH));
  } catch (err) {
    log.warn({ err, path: LOGO_PATH }, 'invoice logo missing — falling back to text header');
    logoBytes = null;
  }
  return logoBytes;
}

export interface InvoiceOrder {
  orderNo: string;
  invoiceNumber: string | null;
  placedAt: Date;
  email: string;
  phone: string;
  shippingAddress: unknown;
  subtotalPaise: number;
  /** Everything taken off the order: coupons AND Zewa Seeds (checkout adds the two). */
  discountPaise: number;
  /**
   * Rupee value of the Zewa Seeds redeemed on this order (1 Seed = ₹1), from
   * OrderLoyalty.coinsRedeemed. Seeds are a discount, not a payment (§11.2), so
   * they reduce the taxable value and get their own "Less:" line. Missing on
   * 27ZFO158's first invoice (Nov 2026): the ₹33 of Seeds sat inside
   * discountPaise with no line, so the rows didn't add up to the Grand Total.
   */
  seedsRedeemedPaise?: number;
  shippingPaise: number;
  totalPaise: number;
  couponCode?: string | null;
  couponCodes?: string[];
  appliedCoupons?: unknown;
  redemptions?: {
    couponId?: string;
    discountPaise?: number;
    coupon?: {
      code?: string;
      discountType?: string;
      scope?: string;
      name?: string | null;
    } | null;
  }[];
  items: {
    productName: string;
    sku: string;
    pack: string;
    qty: number;
    unitPricePaise: number;
    lineTotalPaise: number;
    allocatedCouponDiscountPaise?: number;
    hsn: string;
    taxRatePct: unknown;
  }[];
}

interface Address {
  name?: string;
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  pincode?: string;
  phone?: string;
}

export interface AppliedCouponRecord {
  code: string;
  scope: 'item' | 'cart' | 'shipping';
  discountType?: string;
  amountPaise: number;
}

// A4 in points.
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 36;
const DEFAULT_STANDARD_SHIPPING_PAISE = 6000; // ₹60.00 default standard shipping fee

const INK = rgb(0.05, 0.07, 0.1);
const MUTED = rgb(0.45, 0.48, 0.55);
const RULE = rgb(0.85, 0.87, 0.9);
const TEAL = rgb(0.05, 0.72, 0.62);

/**
 * pdf-lib's StandardFonts are WinAnsi-encoded and cannot render "₹" (U+20B9) —
 * attempting it throws. Embedding a Unicode font would add a ~200 KB binary
 * dependency for one glyph, so amounts print as "Rs." instead, which is
 * unambiguous on a tax invoice.
 */
const money = (paise: number): string => formatInr(paise).replace('₹', 'Rs. ');
const formatDecimal = (paise: number): string => (paise / 100).toFixed(2);

/**
 * Resolves coupon records from order snapshot or redemptions.
 * Distinguishes shipping coupons (e.g. ZEWA1) from item/cart coupons (e.g. SPECIAL10).
 */
export function resolveOrderAppliedCoupons(
  order: InvoiceOrder,
  defaultShippingFeePaise = DEFAULT_STANDARD_SHIPPING_PAISE,
): AppliedCouponRecord[] {
  if (Array.isArray(order.appliedCoupons) && order.appliedCoupons.length > 0) {
    return (order.appliedCoupons as any[]).map((c) => ({
      code: String(c.code || ''),
      scope: (c.scope === 'shipping' ? 'shipping' : c.scope === 'item' ? 'item' : 'cart') as
        | 'item'
        | 'cart'
        | 'shipping',
      discountType: c.discountType ? String(c.discountType) : undefined,
      amountPaise: Number(c.amountPaise) || 0,
    }));
  }

  if (order.redemptions && order.redemptions.length > 0) {
    const list: AppliedCouponRecord[] = [];
    for (const r of order.redemptions) {
      const code = r.coupon?.code || 'COUPON';
      const isShipping = r.coupon?.discountType === 'FREE_SHIPPING';
      const isItem = r.coupon?.scope === 'SPECIFIC_PRODUCTS';
      const scope: 'item' | 'cart' | 'shipping' = isShipping ? 'shipping' : isItem ? 'item' : 'cart';
      const amountPaise = isShipping
        ? (order.shippingPaise > 0 ? order.shippingPaise : defaultShippingFeePaise)
        : (r.discountPaise ?? 0);
      list.push({ code, scope, discountType: r.coupon?.discountType, amountPaise });
    }
    const nonShipping = list.filter((c) => c.scope !== 'shipping');
    const nonShippingTotal = nonShipping.reduce((sum, c) => sum + c.amountPaise, 0);
    const firstNonShipping = nonShipping[0];
    const couponOnlyDiscount = order.discountPaise - (order.seedsRedeemedPaise ?? 0);
    if (nonShippingTotal === 0 && couponOnlyDiscount > 0 && firstNonShipping) {
      firstNonShipping.amountPaise = couponOnlyDiscount;
    }
    return list;
  }

  const couponOnly = order.discountPaise - (order.seedsRedeemedPaise ?? 0);
  if (order.couponCode && couponOnly > 0) {
    return [{ code: order.couponCode, scope: 'cart', amountPaise: couponOnly }];
  }

  return [];
}

/**
 * Allocates cart discount pro-rata across item lines according to each line's gross value.
 * Guaranteed to add up exactly to totalDiscountPaise.
 */
export function allocateCartDiscount(
  lines: { lineTotalPaise: number; allocatedCouponDiscountPaise?: number }[],
  totalDiscountPaise: number,
): number[] {
  const existingSum = lines.reduce((sum, l) => sum + (l.allocatedCouponDiscountPaise ?? 0), 0);
  if (existingSum > 0 && existingSum === totalDiscountPaise) {
    return lines.map((l) => l.allocatedCouponDiscountPaise ?? 0);
  }

  const totalGross = lines.reduce((sum, l) => sum + l.lineTotalPaise, 0);
  if (totalDiscountPaise <= 0 || totalGross <= 0) return lines.map(() => 0);

  let assigned = 0;
  const out = lines.map((l) => {
    const share = Math.floor((totalDiscountPaise * l.lineTotalPaise) / totalGross);
    assigned += share;
    return share;
  });

  const remainder = totalDiscountPaise - assigned;
  if (remainder > 0 && lines.length > 0) {
    let biggest = 0;
    for (let i = 1; i < lines.length; i++) {
      const curr = lines[i];
      const prev = lines[biggest];
      if (curr && prev && curr.lineTotalPaise > prev.lineTotalPaise) biggest = i;
    }
    const currentShare = out[biggest];
    if (currentShare !== undefined) {
      out[biggest] = currentShare + remainder;
    }
  }
  return out;
}

/**
 * Break a comma-separated address into lines that fit the invoice's right-hand
 * column, without splitting mid-component.
 *
 * Helvetica at 8pt averages a little under half the point size per character;
 * 60 characters keeps a line inside roughly 240pt, which clears the heading on
 * the opposite side of the page.
 */
function wrapAddress(address: string, maxChars = 60): string[] {
  const parts = address.split(',').map((s) => s.trim()).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  for (const part of parts) {
    const candidate = current ? `${current}, ${part}` : part;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = part;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Word-wrap text to a width in points, using the real glyph widths.
 *
 * Customer address fields are free text and often one long line ("8 B Artha
 * Reviera Chandapura Anekal Road, Marsur Gate Junction, Landmark…"); drawn
 * as-is it ran off the right edge of the page (27ZFI032, Nov 2026). Breaks on
 * spaces; a single word wider than the column is broken by characters.
 */
export function wrapToWidth(value: string, maxWidth: number, measure: (s: string) => number): string[] {
  const words = value.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines: string[] = [];
  let current = '';
  const pushWord = (word: string) => {
    // A word too wide for any line: split it by characters.
    let rest = word;
    while (measure(rest) > maxWidth && rest.length > 1) {
      let cut = rest.length - 1;
      while (cut > 1 && measure(rest.slice(0, cut)) > maxWidth) cut--;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    return rest;
  };
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (measure(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = pushWord(word);
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Sanitize and format invoice download filename as:
 * {invoiceNumber}-{customerName}.pdf
 * e.g. 27ZFI003-Nikhildev M.pdf
 */
export function formatInvoiceFilename(
  invoiceNumber: string | null | undefined,
  customerName?: string | null | undefined,
): string {
  const cleanInv = (invoiceNumber || 'invoice').trim().replace(/[/\\?%*:|"<>]/g, '-');
  const cleanName = (customerName || '').trim().replace(/[/\\?%*:|"<>]/g, '');
  return cleanName ? `${cleanInv}-${cleanName}.pdf` : `${cleanInv}.pdf`;
}

/**
 * The seller block printed on an invoice. Frozen onto the order (see
 * modules/orders/invoice-seller.ts) so that changing the company's name,
 * address or GSTIN never rewrites an invoice already issued.
 */
export interface SellerDetails {
  name: string;
  address: string;
  gstin: string;
  state: string;
  stateCode: string;
  email: string;
  phone: string;
}

/** Today's seller details, from the environment. Used only when an order has no frozen copy. */
export function currentSellerDetails(): SellerDetails {
  return {
    name: env.COMPANY_NAME,
    address: env.COMPANY_ADDRESS,
    gstin: env.COMPANY_GSTIN,
    state: env.COMPANY_STATE,
    stateCode: env.COMPANY_STATE_CODE,
    email: env.COMPANY_EMAIL,
    phone: env.COMPANY_PHONE,
  };
}

export async function generateInvoicePdf(
  order: InvoiceOrder,
  taxConfig: TaxConfig,
  seller: SellerDetails = currentSellerDetails(),
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Invoice ${order.invoiceNumber ?? order.orderNo}`);
  doc.setProducer('Zewa Feeds');
  doc.setCreationDate(new Date());

  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const addr = (order.shippingAddress ?? {}) as Address;
  const customerState = addr.state ?? taxConfig.sellerState;

  // Resolve applied coupons (distinguishing shipping coupons like ZEWA1 from item/cart coupons like SPECIAL10)
  const appliedCoupons = resolveOrderAppliedCoupons(order);
  const shippingCoupon = appliedCoupons.find((c) => c.scope === 'shipping');
  const cartCoupons = appliedCoupons.filter((c) => c.scope === 'cart');
  const itemCoupons = appliedCoupons.filter((c) => c.scope === 'item');

  // Shipping fee and discount
  let shippingFeePaise = order.shippingPaise;
  let shippingDiscountPaise = 0;

  if (shippingCoupon) {
    shippingFeePaise =
      shippingCoupon.amountPaise > 0 ? shippingCoupon.amountPaise : DEFAULT_STANDARD_SHIPPING_PAISE;
    shippingDiscountPaise = shippingFeePaise;
  }

  // Cart discount pro-rata across item lines: cart coupons plus Zewa Seeds,
  // which apply to products only, never shipping.
  const seedsPaise = Math.max(0, order.seedsRedeemedPaise ?? 0);
  /*
   * Cart AND item coupons come off the product lines. Item-scope coupons
   * (checkout records SPECIAL10 that way) used to be left out here, so the
   * line showed 0.00 discount and an overstated taxable value while the
   * totals block still subtracted them (27ZFI032, Nov 2026). Each line's own
   * allocatedCouponDiscountPaise is used when it adds up; otherwise pro-rata.
   */
  const couponLineDiscounts = allocateCartDiscount(
    order.items,
    [...cartCoupons, ...itemCoupons].reduce((sum, c) => sum + c.amountPaise, 0),
  );
  // Seeds split pro-rata over what is left of each line after its coupons.
  const seedLineDiscounts = allocateCartDiscount(
    order.items.map((i, idx) => ({ lineTotalPaise: Math.max(0, i.lineTotalPaise - (couponLineDiscounts[idx] ?? 0)) })),
    seedsPaise,
  );
  const lineDiscounts = couponLineDiscounts.map((d, idx) => d + (seedLineDiscounts[idx] ?? 0));

  const productTaxRatePct = Number(order.items[0]?.taxRatePct ?? taxConfig.gstRatePct ?? 0);
  const taxableLines: TaxableLine[] = [
    ...order.items.map((item, idx) => ({
      grossPaise: item.lineTotalPaise,
      discountPaise: lineDiscounts[idx],
      taxRatePct: Number(item.taxRatePct),
    })),
    {
      grossPaise: shippingFeePaise,
      discountPaise: shippingDiscountPaise,
      taxRatePct: productTaxRatePct,
    },
  ];

  const tax = computeInvoiceTax(taxableLines, taxConfig, customerState);

  let y = PAGE_HEIGHT - MARGIN;

  const text = (
    value: string,
    x: number,
    yPos: number,
    opts: { size?: number; font?: PDFFont; color?: typeof INK } = {},
  ) => {
    page.drawText(value, {
      x,
      y: yPos,
      size: opts.size ?? 9,
      font: opts.font ?? font,
      color: opts.color ?? INK,
    });
  };

  /** Right-align — essential for money columns. */
  const textRight = (
    value: string,
    rightEdge: number,
    yPos: number,
    opts: { size?: number; font?: PDFFont; color?: typeof INK } = {},
  ) => {
    const f = opts.font ?? font;
    const size = opts.size ?? 9;
    text(value, rightEdge - f.widthOfTextAtSize(value, size), yPos, opts);
  };

  const rule = (yPos: number, color = RULE) => {
    page.drawLine({
      start: { x: MARGIN, y: yPos },
      end: { x: PAGE_WIDTH - MARGIN, y: yPos },
      thickness: 0.75,
      color,
    });
  };

  // ---- Header ------------------------------------------------------------
  /*
   * Logo above the title, on the left.
   *
   * Drawn first so `y` can drop by its height before "Invoice" is placed —
   * the company block on the right is anchored to the same `y`, so both stay
   * aligned whether or not the logo loaded.
   */
  const logo = await loadLogo();
  if (logo) {
    try {
      const img = await doc.embedPng(logo);
      // 54pt gives the mark a prominent, clear brand presentation.
      const LOGO_H = 54;
      const scaled = img.scale(LOGO_H / img.height);
      y -= LOGO_H;
      page.drawImage(img, { x: MARGIN, y, width: scaled.width, height: scaled.height });
      y -= 18;
    } catch (err) {
      // A corrupt PNG must not break invoice generation.
      log.warn({ err }, 'could not embed invoice logo');
    }
  }

  text('INVOICE', MARGIN, y, { size: 18, font: bold });
  textRight(seller.name, PAGE_WIDTH - MARGIN, y, { size: 11, font: bold });
  y -= 16;
  /*
   * The registered address is long enough to run into the "Invoice"
   * heading on the left as a single right-aligned line, so it is wrapped on
   * commas into chunks that fit the right-hand column.
   */
  for (const line of wrapAddress(seller.address)) {
    textRight(line, PAGE_WIDTH - MARGIN, y, { size: 8, color: MUTED });
    y -= 11;
  }
  textRight(`GSTIN/UIN: ${seller.gstin}`, PAGE_WIDTH - MARGIN, y, { size: 8, color: MUTED });
  y -= 11;
  // State and code are both required on a GST invoice.
  textRight(
    `State Name: ${seller.state}, Code: ${seller.stateCode}`,
    PAGE_WIDTH - MARGIN,
    y,
    { size: 8, color: MUTED },
  );
  y -= 11;
  textRight(`${seller.email} · ${seller.phone}`, PAGE_WIDTH - MARGIN, y, {
    size: 8,
    color: MUTED,
  });

  y -= 18;
  rule(y, TEAL);
  y -= 22;

  // ---- Invoice meta / billing --------------------------------------------
  const colRight = PAGE_WIDTH / 2 + 20;

  text('Invoice Number', MARGIN, y, { size: 7.5, color: MUTED });
  text('Billed & shipped to', colRight, y, { size: 7.5, color: MUTED });
  y -= 12;
  // §6.5: entered manually to match the Tally sequence. No auto-generation.
  text(order.invoiceNumber ?? '—', MARGIN, y, { size: 10, font: bold });
  const addrWidth = PAGE_WIDTH - MARGIN - colRight;
  const nameLines = wrapToWidth(addr.name ?? '—', addrWidth, (v) => bold.widthOfTextAtSize(v, 10));
  for (const [i, nl] of nameLines.entries()) text(nl, colRight, y - i * 12, { size: 10, font: bold });
  y -= 14;
  const nameExtra = (nameLines.length - 1) * 12;

  const metaRows: [string, string][] = [
    ['Order Number', order.orderNo],
    [
      'Invoice Date',
      order.placedAt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
    ],
    ['Place of Supply', customerState],
  ];
  const addressLines = [
    addr.line1,
    addr.line2,
    [addr.city, addr.pincode].filter(Boolean).join(' '),
    addr.state,
    addr.phone ?? order.phone,
    order.email,
  ].filter((v): v is string => Boolean(v));

  // The two columns run independently: a long address wraps over as many
  // lines as it needs without stretching the invoice details beside it.
  let yLeft = y;
  for (const [label, value] of metaRows) {
    text(label, MARGIN, yLeft, { size: 7.5, color: MUTED });
    text(value, MARGIN + 90, yLeft, { size: 8.5 });
    yLeft -= 12;
  }
  let yRight = y - nameExtra;
  addressLines.forEach((field, i) => {
    for (const line of wrapToWidth(field, addrWidth, (v) => font.widthOfTextAtSize(v, 8.5))) {
      text(line, colRight, yRight, { size: 8.5, color: i === 0 ? INK : MUTED });
      yRight -= 12;
    }
  });
  y = Math.min(yLeft, yRight);

  y -= 8;
  rule(y);
  y -= 16;

  // ---- Line items (10 columns as specified in doc) -------------------------
  // Columns: right-edge positions for numerics, left for text.
  const COL = {
    item: MARGIN,     // 36 (left)
    hsn: 180,         // 180 (left)
    qty: 238,         // right
    rate: 282,        // right
    gross: 326,       // right
    discount: 410,    // right
    taxable: 456,     // right
    gstPct: 488,      // right
    gstInr: 522,      // right
    total: PAGE_WIDTH - MARGIN, // 559.28 (right)
  };

  text('ITEM / SKU', COL.item, y, { size: 7, font: bold, color: MUTED });
  text('HSN', COL.hsn, y, { size: 7, font: bold, color: MUTED });
  textRight('QTY', COL.qty, y, { size: 7, font: bold, color: MUTED });
  textRight('RATE', COL.rate, y, { size: 7, font: bold, color: MUTED });
  textRight('GROSS', COL.gross, y, { size: 7, font: bold, color: MUTED });
  textRight('DISCOUNT', COL.discount, y, { size: 7, font: bold, color: MUTED });
  textRight('TAXABLE', COL.taxable, y, { size: 7, font: bold, color: MUTED });
  textRight('GST %', COL.gstPct, y, { size: 7, font: bold, color: MUTED });
  textRight('GST (Rs.)', COL.gstInr, y, { size: 7, font: bold, color: MUTED });
  textRight('AMOUNT', COL.total, y, { size: 7, font: bold, color: MUTED });
  y -= 6;
  rule(y);
  y -= 14;

  // One source fits beside the amount ("31.40 (SPECIAL10)"). Two or more would
  // run into the GROSS column, so the line shows the amount alone and the totals
  // block below names each discount.
  const discountSources = [...cartCoupons.map((c) => c.code), ...itemCoupons.map((c) => c.code), ...(seedsPaise > 0 ? ['Seeds'] : [])];
  const cartCodeLabel = discountSources.length === 1 ? discountSources[0] : '';

  for (let idx = 0; idx < order.items.length; idx++) {
    const item = order.items[idx];
    if (!item) continue;
    const lineDiscount = lineDiscounts[idx] ?? 0;
    const lineTaxable = Math.max(0, item.lineTotalPaise - lineDiscount);
    const ratePct = Number(item.taxRatePct);
    const lineTax = Math.round((lineTaxable * ratePct) / 100);
    const lineAmount = lineTaxable + lineTax;

    const discountLabel =
      lineDiscount > 0
        ? `${formatDecimal(lineDiscount)}${cartCodeLabel ? ` (${cartCodeLabel})` : ''}`
        : '0.00';

    // Truncate rather than wrap: keeps row height fixed so the table stays aligned.
    const name = item.productName.length > 28 ? `${item.productName.slice(0, 27)}…` : item.productName;
    text(name, COL.item, y, { size: 8 });
    text(item.hsn, COL.hsn, y, { size: 7.5, color: MUTED });
    textRight(String(item.qty), COL.qty, y, { size: 8 });
    textRight(formatDecimal(item.unitPricePaise), COL.rate, y, { size: 8 });
    textRight(formatDecimal(item.lineTotalPaise), COL.gross, y, { size: 8 });
    textRight(discountLabel, COL.discount, y, { size: 7.5 });
    textRight(formatDecimal(lineTaxable), COL.taxable, y, { size: 8 });
    textRight(`${ratePct}%`, COL.gstPct, y, { size: 7.5 });
    textRight(formatDecimal(lineTax), COL.gstInr, y, { size: 7.5 });
    textRight(formatDecimal(lineAmount), COL.total, y, { size: 8 });
    y -= 10;

    text(`${item.sku} · ${item.pack}`, COL.item, y, { size: 7, color: MUTED });
    y -= 13;
  }

  // Shipping & Handling row
  const shippingTaxable = Math.max(0, shippingFeePaise - shippingDiscountPaise);
  const shipTax = Math.round((shippingTaxable * productTaxRatePct) / 100);
  const shipAmount = shippingTaxable + shipTax;
  const shipDiscountLabel =
    shippingDiscountPaise > 0
      ? `${formatDecimal(shippingDiscountPaise)} (${shippingCoupon?.code || 'ZEWA1'})`
      : '0.00';

  text('Shipping & Handling', COL.item, y, { size: 8 });
  text('—', COL.hsn, y, { size: 7.5, color: MUTED });
  textRight('1', COL.qty, y, { size: 8 });
  textRight(formatDecimal(shippingFeePaise), COL.rate, y, { size: 8 });
  textRight(formatDecimal(shippingFeePaise), COL.gross, y, { size: 8 });
  textRight(shipDiscountLabel, COL.discount, y, { size: 7.5 });
  textRight(formatDecimal(shippingTaxable), COL.taxable, y, { size: 8 });
  textRight(`${productTaxRatePct}%`, COL.gstPct, y, { size: 7.5 });
  textRight(formatDecimal(shipTax), COL.gstInr, y, { size: 7.5 });
  textRight(formatDecimal(shipAmount), COL.total, y, { size: 8 });
  y -= 10;

  text('Standard Delivery', COL.item, y, { size: 7, color: MUTED });
  y -= 14;

  rule(y);
  y -= 18;

  // ---- Summary block (in requested sequence) ------------------------------
  const totalGrossPaise = order.items.reduce((sum, i) => sum + i.lineTotalPaise, 0) + shippingFeePaise;
  const totalTaxablePaise = tax.taxableValuePaise;

  const labelX = PAGE_WIDTH - MARGIN - 180;
  const totalRow = (label: string, value: string, opts: { strong?: boolean } = {}) => {
    text(label, labelX, y, {
      size: opts.strong ? 10 : 8.5,
      font: opts.strong ? bold : font,
      color: opts.strong ? INK : MUTED,
    });
    textRight(value, PAGE_WIDTH - MARGIN, y, {
      size: opts.strong ? 10 : 8.5,
      font: opts.strong ? bold : font,
    });
    y -= opts.strong ? 16 : 13;
  };

  // 1. Gross value
  totalRow('Gross value', money(totalGrossPaise));

  // 2. Less: Cart/Item coupons
  for (const c of cartCoupons) {
    if (c.amountPaise > 0) {
      totalRow(`Less: ${c.code}`, `- ${money(c.amountPaise)}`);
    }
  }
  for (const c of itemCoupons) {
    if (c.amountPaise > 0) {
      totalRow(`Less: ${c.code}`, `- ${money(c.amountPaise)}`);
    }
  }

  // 2b. Less: Zewa Seeds
  if (seedsPaise > 0) {
    const seeds = Math.round(seedsPaise / 100);
    totalRow(`Less: Zewa Seeds (${seeds} Seed${seeds === 1 ? '' : 's'})`, `- ${money(seedsPaise)}`);
  }

  // 3. Less: Shipping coupon
  if (shippingCoupon && shippingDiscountPaise > 0) {
    totalRow(`Less: ${shippingCoupon.code} (shipping)`, `- ${money(shippingDiscountPaise)}`);
  }

  // 4. Taxable Value
  totalRow('Taxable Value', money(totalTaxablePaise));

  // 5. Taxes (CGST & SGST or IGST)
  if (tax.isInterState) {
    for (const g of tax.byRate) {
      totalRow(`IGST @ ${g.ratePct}%`, money(g.igstPaise));
    }
  } else {
    for (const g of tax.byRate) {
      totalRow(`CGST @ ${g.ratePct / 2}%`, money(g.cgstPaise));
      totalRow(`SGST @ ${g.ratePct / 2}%`, money(g.sgstPaise));
    }
  }

  // 6. Grand Total
  y -= 4;
  page.drawLine({
    start: { x: labelX, y },
    end: { x: PAGE_WIDTH - MARGIN, y },
    thickness: 0.75,
    color: RULE,
  });
  y -= 16;
  totalRow('Grand Total', money(order.totalPaise), { strong: true });

  // ---- Footer ------------------------------------------------------------
  const footerY = MARGIN + 30;
  rule(footerY + 20);
  text(
    taxConfig.gstInclusive
      ? 'Listed prices are inclusive of GST.'
      : 'GST charged in addition to listed prices.',
    MARGIN,
    footerY + 6,
    { size: 7.5, color: MUTED },
  );
  text('This is a computer-generated invoice.', MARGIN, footerY - 5, { size: 7.5, color: MUTED });
  textRight(seller.name, PAGE_WIDTH - MARGIN, footerY - 5, {
    size: 7.5,
    color: MUTED,
  });

  return doc.save();
}
