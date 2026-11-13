/**
 * Invoices that do not change after they are issued.
 *
 * An invoice is re-rendered every time someone downloads it. The line items
 * always came from the order, but the seller block (company name, address,
 * GSTIN, state) came from today's environment variables, and the GST basis
 * from today's settings. So changing any of them rewrote every past invoice,
 * and a GST invoice must not change once issued (flagged in the Nov 2026
 * close-out review).
 *
 * Now each order carries `invoiceSnapshot`: written at checkout for new orders,
 * and the first time the invoice is produced for orders placed before this
 * existed. Every render after that uses the frozen copy.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  currentSellerDetails,
  generateInvoicePdf,
  type InvoiceOrder,
  type SellerDetails,
} from '@/integrations/pdf/invoice';
import type { TaxConfig } from '@/modules/orders/tax';
import { getTaxConfig } from '@/modules/settings/settings.service';

export interface InvoiceSnapshot extends SellerDetails {
  gstRatePct: number;
  gstInclusive: boolean;
}

/** What an order placed right now would freeze. */
export async function currentInvoiceSnapshot(tax?: TaxConfig): Promise<InvoiceSnapshot> {
  const t = tax ?? (await getTaxConfig());
  return { ...currentSellerDetails(), gstRatePct: t.gstRatePct, gstInclusive: t.gstInclusive };
}

function isSnapshot(v: unknown): v is InvoiceSnapshot {
  return !!v && typeof v === 'object' && typeof (v as InvoiceSnapshot).gstin === 'string';
}

/** The order's frozen snapshot, freezing today's values first if it has none. */
export async function invoiceSnapshotFor(orderNo: string): Promise<InvoiceSnapshot> {
  const row = await prisma.order.findUniqueOrThrow({ where: { orderNo }, select: { invoiceSnapshot: true } });
  if (isSnapshot(row.invoiceSnapshot)) return row.invoiceSnapshot;

  const snap = await currentInvoiceSnapshot();
  // Conditional, so two simultaneous first downloads cannot freeze different values.
  await prisma.order.updateMany({
    where: { orderNo, invoiceSnapshot: { equals: Prisma.DbNull } },
    data: { invoiceSnapshot: snap as unknown as Prisma.InputJsonValue },
  });
  const after = await prisma.order.findUniqueOrThrow({ where: { orderNo }, select: { invoiceSnapshot: true } });
  return isSnapshot(after.invoiceSnapshot) ? after.invoiceSnapshot : snap;
}

/** Render an order's invoice from its frozen seller details and tax basis. */
export async function renderInvoice(order: InvoiceOrder): Promise<Uint8Array> {
  const snap = await invoiceSnapshotFor(order.orderNo);
  // Seeds redeemed: the order's total discount includes them, but only the
  // loyalty record says how much of it was Seeds (1 Seed = ₹1).
  if (order.seedsRedeemedPaise === undefined) {
    const loyalty = await prisma.orderLoyalty.findFirst({
      where: { order: { orderNo: order.orderNo } },
      select: { coinsRedeemed: true },
    });
    order = { ...order, seedsRedeemedPaise: (loyalty?.coinsRedeemed ?? 0) * 100 };
  }
  const { gstRatePct, gstInclusive, ...seller } = snap;
  return generateInvoicePdf(order, { gstRatePct, gstInclusive, sellerState: seller.state }, seller);
}
