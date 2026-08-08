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
import { computeInvoiceTax, formatInr, type TaxConfig } from '@/modules/orders/tax';
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
  discountPaise: number;
  shippingPaise: number;
  totalPaise: number;
  couponCode: string | null;
  items: {
    productName: string;
    sku: string;
    pack: string;
    qty: number;
    unitPricePaise: number;
    lineTotalPaise: number;
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

// A4 in points.
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 40;

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
const money = (paise: number): string => formatInr(paise).replace('₹', 'Rs.');

export async function generateInvoicePdf(order: InvoiceOrder, taxConfig: TaxConfig): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Invoice ${order.invoiceNumber ?? order.orderNo}`);
  doc.setProducer('Zewa Feeds');
  doc.setCreationDate(new Date());

  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const addr = (order.shippingAddress ?? {}) as Address;
  const customerState = addr.state ?? taxConfig.sellerState;

  const tax = computeInvoiceTax(
    order.items.map((i) => ({
      lineTotalPaise: i.lineTotalPaise,
      taxRatePct: Number(i.taxRatePct),
    })),
    taxConfig,
    customerState,
  );

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
   * Drawn first so `y` can drop by its height before "TAX INVOICE" is placed —
   * the company block on the right is anchored to the same `y`, so both stay
   * aligned whether or not the logo loaded.
   */
  const logo = await loadLogo();
  if (logo) {
    try {
      const img = await doc.embedPng(logo);
      // 26pt read as an afterthought beside an 18pt title; 44 gives the mark
      // presence without competing with "TAX INVOICE".
      const LOGO_H = 44;
      const scaled = img.scale(LOGO_H / img.height);
      y -= LOGO_H;
      page.drawImage(img, { x: MARGIN, y, width: scaled.width, height: scaled.height });
      y -= 18;
    } catch (err) {
      // A corrupt PNG must not break invoice generation.
      log.warn({ err }, 'could not embed invoice logo');
    }
  }

  text('TAX INVOICE', MARGIN, y, { size: 18, font: bold });
  textRight(env.COMPANY_NAME, PAGE_WIDTH - MARGIN, y, { size: 11, font: bold });
  y -= 16;
  textRight(env.COMPANY_ADDRESS, PAGE_WIDTH - MARGIN, y, { size: 8, color: MUTED });
  y -= 11;
  textRight(`GSTIN: ${env.COMPANY_GSTIN}`, PAGE_WIDTH - MARGIN, y, { size: 8, color: MUTED });
  y -= 11;
  textRight(`${env.COMPANY_EMAIL} · ${env.COMPANY_PHONE}`, PAGE_WIDTH - MARGIN, y, {
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
  text(addr.name ?? '—', colRight, y, { size: 10, font: bold });
  y -= 14;

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

  const rowCount = Math.max(metaRows.length, addressLines.length);
  for (let i = 0; i < rowCount; i++) {
    const meta = metaRows[i];
    if (meta) {
      text(meta[0], MARGIN, y, { size: 7.5, color: MUTED });
      text(meta[1], MARGIN + 90, y, { size: 8.5 });
    }
    const line = addressLines[i];
    if (line) text(line, colRight, y, { size: 8.5, color: i === 0 ? INK : MUTED });
    y -= 12;
  }

  y -= 8;
  rule(y);
  y -= 16;

  // ---- Line items --------------------------------------------------------
  // Columns are right-edge positions for numerics, left for text.
  const COL = {
    item: MARGIN,
    hsn: 268,
    qty: 320,
    rate: 392,
    taxPct: 440,
    total: PAGE_WIDTH - MARGIN,
  };

  text('ITEM', COL.item, y, { size: 7, font: bold, color: MUTED });
  text('HSN', COL.hsn, y, { size: 7, font: bold, color: MUTED });
  textRight('QTY', COL.qty, y, { size: 7, font: bold, color: MUTED });
  textRight('RATE', COL.rate, y, { size: 7, font: bold, color: MUTED });
  textRight('GST', COL.taxPct, y, { size: 7, font: bold, color: MUTED });
  textRight('AMOUNT', COL.total, y, { size: 7, font: bold, color: MUTED });
  y -= 6;
  rule(y);
  y -= 14;

  for (const item of order.items) {
    // Truncate rather than wrap: keeps row height fixed so the table stays aligned.
    const name = item.productName.length > 38 ? `${item.productName.slice(0, 37)}…` : item.productName;
    text(name, COL.item, y, { size: 8.5 });
    text(item.hsn, COL.hsn, y, { size: 8 , color: MUTED });
    textRight(String(item.qty), COL.qty, y, { size: 8.5 });
    textRight(money(item.unitPricePaise), COL.rate, y, { size: 8.5 });
    textRight(`${Number(item.taxRatePct)}%`, COL.taxPct, y, { size: 8, color: MUTED });
    textRight(money(item.lineTotalPaise), COL.total, y, { size: 8.5 });
    y -= 11;

    text(`${item.sku} · ${item.pack}`, COL.item, y, { size: 7.5, color: MUTED });
    y -= 14;
  }

  rule(y);
  y -= 18;

  // ---- Totals ------------------------------------------------------------
  const labelX = PAGE_WIDTH - MARGIN - 170;
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

  totalRow('Taxable value', money(tax.taxableValuePaise));

  // §6.5: CGST + SGST intra-state, IGST inter-state.
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

  if (order.discountPaise > 0) {
    totalRow(
      order.couponCode ? `Discount (${order.couponCode})` : 'Discount',
      `- ${money(order.discountPaise)}`,
    );
  }
  totalRow('Shipping', order.shippingPaise === 0 ? 'FREE' : money(order.shippingPaise));

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
  textRight(`${env.COMPANY_NAME} · ${env.COMPANY_GSTIN}`, PAGE_WIDTH - MARGIN, footerY - 5, {
    size: 7.5,
    color: MUTED,
  });

  return doc.save();
}
