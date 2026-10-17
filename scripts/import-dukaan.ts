/**
 * Imports customer and order history from the old Dukaan store.
 *
 *   python3 scripts/parse-dukaan-export.py <orders.xlsx> <customers.xlsx>
 *   npx tsx -r dotenv/config scripts/import-dukaan.ts            # dry run
 *   npx tsx -r dotenv/config scripts/import-dukaan.ts --confirm  # writes
 *
 * Input: scripts/dukaan/dukaan-import.json (gitignored — real addresses).
 * The parser has already reconciled every order to the paisa and every
 * customer against Dukaan's own customer list; this step only writes.
 *
 * WHAT THIS IS: a historical RECORD, written straight to the tables. It is
 * deliberately NOT a replay through checkout or the order state machine, so:
 *
 *   - no stock moves      — these parcels left the warehouse long ago
 *   - no email is sent    — nobody should get a 2024 order confirmation
 *   - no Z-coins accrue   — coins come only from status-transition events,
 *                           and none are fired. Every order is linked to its
 *                           Customer rather than left as a guest order, which
 *                           is what keeps guest-claiming from retro-crediting
 *                           them either. Coins for this history are a separate,
 *                           deliberate grant.
 *   - no CouponRedemption — ZEWA1 / SPECIAL10 used on Dukaan were Dukaan's
 *                           coupons; counting them would silently exhaust
 *                           per-customer limits on this site's codes.
 *
 * Line items keep Dukaan's product name, SKU and price as their snapshot. A
 * line links to today's catalogue variant only on an EXACT SKU match: old M2
 * Micro Pellets are not today's M3, and linking them would misreport sales.
 *
 * A customer whose email already has an account here is NOT modified — their
 * Dukaan orders are attached to it, and their address book is left alone.
 *
 * IDEMPOTENT: customers and orders are keyed on (externalSource, externalRef).
 * Anything already imported is skipped, never overwritten, so a re-run cannot
 * clobber something staff have since changed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuditModule, OrderStatus, PaymentMethod, PaymentStatus, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

const SOURCE = 'Dukaan';
/** The HSN today's catalogue uses for every feed; Dukaan exported none. */
const DEFAULT_HSN = '23099039';

interface DukaanItem {
  productName: string;
  sku: string;
  skuDerived: boolean;
  pack: string;
  qty: number;
  unitPricePaise: number;
  lineTotalPaise: number;
  discountPaise: number;
}

interface DukaanOrder {
  dukaanOrderId: string;
  dukaanSystemId: string;
  dukaanCustomerId: string;
  customerPhone: string;
  orderEmail: string | null;
  status: 'DELIVERED' | 'CANCELLED';
  cancelReason: string | null;
  placedAt: string;
  deliveredAt: string | null;
  cancelledAt: string | null;
  subtotalPaise: number;
  shippingPaise: number;
  discountPaise: number;
  totalPaise: number;
  couponCode: string | null;
  shippingAddress: {
    name: string;
    line1: string;
    line2: string | null;
    city: string;
    state: string;
    pincode: string;
    phone: string;
  };
  items: DukaanItem[];
  raw: Record<string, unknown>[];
}

interface DukaanCustomer {
  dukaanCustomerId: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  emailFrom: string;
  phone: string;
  city: string | null;
  orderIds: string[];
  raw: Record<string, unknown>;
}

const orderNoFor = (o: DukaanOrder) => `DK-${o.dukaanOrderId}`;

function orderData(o: DukaanOrder, email: string, customerId: string, variants: Map<string, { id: string; hsn: string }>) {
  const derived = o.items.filter((i) => i.skuDerived).map((i) => i.sku);
  const note = [
    `Imported from Dukaan order #${o.dukaanOrderId} (the old zewafeeds.com store).`,
    'Historical record: no stock was moved, no email sent and no Z-coins awarded on import.',
    derived.length ? `Dukaan exported no SKU for ${derived.join(', ')}; derived from the product name and pack code.` : null,
  ]
    .filter(Boolean)
    .join(' ');

  return {
    orderNo: orderNoFor(o),
    customerId,
    email,
    phone: o.customerPhone,
    status: o.status === 'DELIVERED' ? OrderStatus.DELIVERED : OrderStatus.CANCELLED,
    // Every Dukaan order was prepaid through a payment link, and the export
    // marks every payment Completed with no refund recorded — cancelled ones
    // included. Recorded as exported; staff can reconcile refunds separately.
    paymentStatus: PaymentStatus.PAID,
    paymentMethod: PaymentMethod.RAZORPAY,
    // Dukaan's Razorpay order ids stay in externalData only. Putting them in
    // razorpayOrderId would invite this site's refund and reconcile paths to
    // act on payments that belong to another merchant integration.
    subtotalPaise: o.subtotalPaise,
    discountPaise: o.discountPaise,
    shippingPaise: o.shippingPaise,
    taxPaise: 0,
    totalPaise: o.totalPaise,
    couponCode: o.couponCode,
    couponCodes: o.couponCode ? [o.couponCode] : [],
    shippingAddress: o.shippingAddress,
    internalNote: note,
    cancelReason: o.cancelReason,
    placedAt: new Date(o.placedAt),
    deliveredAt: o.deliveredAt ? new Date(o.deliveredAt) : null,
    cancelledAt: o.cancelledAt ? new Date(o.cancelledAt) : null,
    externalSource: SOURCE,
    externalRef: o.dukaanOrderId,
    externalData: {
      dukaanOrderId: `#${o.dukaanOrderId}`,
      dukaanSystemId: o.dukaanSystemId,
      dukaanCustomerId: o.dukaanCustomerId,
      lines: o.raw,
    } as Prisma.InputJsonValue,
    items: {
      create: o.items.map((i) => {
        const v = variants.get(i.sku);
        return {
          variantId: v?.id ?? null,
          productName: i.productName,
          sku: i.sku,
          pack: i.pack,
          unitPricePaise: i.unitPricePaise,
          qty: i.qty,
          hsn: v?.hsn ?? DEFAULT_HSN,
          // Dukaan charged no GST on any of these orders (GST and Tax Value
          // are 0 on every row); the snapshot records what was charged.
          taxRatePct: new Prisma.Decimal(0),
          lineTotalPaise: i.lineTotalPaise,
          allocatedCouponDiscountPaise: i.discountPaise,
          preTaxNetPaidPaise: i.lineTotalPaise - i.discountPaise,
        };
      }),
    },
  } satisfies Prisma.OrderUncheckedCreateInput;
}

async function main() {
  const confirm = process.argv.includes('--confirm');
  const data: { customers: DukaanCustomer[]; orders: DukaanOrder[] } = JSON.parse(
    readFileSync(join(__dirname, 'dukaan', 'dukaan-import.json'), 'utf8'),
  );

  /*
   * The dry run must work BEFORE the provenance migration is deployed — that is
   * when it is most useful. Without the columns nothing can have been imported
   * yet, so every lookup on them is simply skipped.
   */
  const [probe] = await prisma.$queryRaw<{ migrated: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'Order' AND column_name = 'externalSource'
    ) AS migrated`;
  const migrated = probe?.migrated === true;
  if (!migrated && confirm) {
    throw new Error('Migration 20261003090000_external_order_provenance is not applied. Run `npm run prisma:deploy` first.');
  }

  const variants = new Map(
    (await prisma.productVariant.findMany({ select: { id: true, sku: true, hsn: true } })).map((v) => [v.sku, v]),
  );
  const ordersOf = new Map<string, DukaanOrder[]>();
  for (const o of data.orders) ordersOf.set(o.dukaanCustomerId, [...(ordersOf.get(o.dukaanCustomerId) ?? []), o]);

  // Collisions this script must never paper over.
  const taken = await prisma.order.findMany({
    where: { orderNo: { in: data.orders.map(orderNoFor) }, ...(migrated ? { NOT: { externalSource: SOURCE } } : {}) },
    select: { orderNo: true },
  });
  if (taken.length) throw new Error(`orderNo already used by a non-Dukaan order: ${taken.map((t) => t.orderNo).join(', ')}`);

  const report = {
    customersCreated: 0,
    customersAttachedToExisting: [] as string[],
    customersAlreadyImported: 0,
    addressesCreated: 0,
    ordersCreated: 0,
    ordersAlreadyImported: 0,
    linesLinked: 0,
    linesUnlinked: new Map<string, number>(),
    paise: { delivered: 0, cancelled: 0 },
  };

  for (const c of data.customers) {
    const orders = (ordersOf.get(c.dukaanCustomerId) ?? []).sort((a, b) => a.placedAt.localeCompare(b.placedAt));

    const imported = migrated
      ? await prisma.customer.findUnique({
          where: { externalSource_externalRef: { externalSource: SOURCE, externalRef: c.dukaanCustomerId } },
          select: { id: true },
        })
      : null;
    // Case-insensitive: a native signup may have stored the address with capitals.
    const native = imported
      ? null
      : await prisma.customer.findFirst({
          where: { email: { equals: c.email, mode: 'insensitive' } },
          select: { id: true, email: true, firstName: true, lastName: true },
        });

    const existingOrders = new Set(
      migrated
        ? (
            await prisma.order.findMany({
              where: { externalSource: SOURCE, externalRef: { in: orders.map((o) => o.dukaanOrderId) } },
              select: { externalRef: true },
            })
          ).map((o) => o.externalRef)
        : [],
    );
    const pending = orders.filter((o) => !existingOrders.has(o.dukaanOrderId));
    report.ordersAlreadyImported += orders.length - pending.length;

    if (imported) report.customersAlreadyImported++;
    else if (native) report.customersAttachedToExisting.push(`${c.name} → existing account ${native.email}`);
    else report.customersCreated++;

    // Distinct delivery addresses, most recent last so it becomes the default.
    const addresses = new Map<string, DukaanOrder['shippingAddress']>();
    for (const o of orders) {
      const a = o.shippingAddress;
      const key = `${a.line1}|${a.line2}|${a.pincode}`.toLowerCase();
      addresses.delete(key);
      addresses.set(key, a);
    }
    const newAddresses = imported || native ? [] : [...addresses.values()];
    report.addressesCreated += newAddresses.length;

    for (const o of pending) {
      report.paise[o.status === 'DELIVERED' ? 'delivered' : 'cancelled'] += o.totalPaise;
      for (const i of o.items) {
        if (variants.has(i.sku)) report.linesLinked++;
        else report.linesUnlinked.set(i.sku, (report.linesUnlinked.get(i.sku) ?? 0) + 1);
      }
    }
    report.ordersCreated += pending.length;

    if (!confirm || (imported && pending.length === 0)) continue;

    await prisma.$transaction(async (tx) => {
      const customerId =
        imported?.id ??
        native?.id ??
        (
          await tx.customer.create({
            data: {
              email: c.email,
              phone: c.phone,
              firstName: c.firstName,
              lastName: c.lastName,
              // No password: a guest-only record. Registering with this email
              // claims it, and their Dukaan history comes with them.
              passwordHash: null,
              // When they became a customer, not when this script ran — the
              // CMS sorts and filters on it.
              registeredAt: new Date(orders[0]?.placedAt ?? Date.now()),
              externalSource: SOURCE,
              externalRef: c.dukaanCustomerId,
              addresses: {
                create: newAddresses.map((a, idx) => ({
                  name: a.name,
                  phone: a.phone,
                  line1: a.line1,
                  line2: a.line2,
                  city: a.city,
                  state: a.state,
                  pincode: a.pincode,
                  isDefault: idx === newAddresses.length - 1,
                })),
              },
            },
            select: { id: true },
          })
        ).id;

      for (const o of pending) {
        // The order's own email when Dukaan recorded one (Jimson Scaria used
        // two), otherwise the customer's.
        await tx.order.create({ data: orderData(o, (o.orderEmail ?? c.email).toLowerCase(), customerId, variants) });
      }
    });
  }

  const summary = {
    ...report,
    linesUnlinked: Object.fromEntries(report.linesUnlinked),
    rupees: { delivered: report.paise.delivered / 100, cancelled: report.paise.cancelled / 100 },
  };

  if (confirm && (report.customersCreated || report.ordersCreated)) {
    // One entry for the whole run — the audit trail should say this data
    // arrived by migration, not by anyone's hand in the CMS.
    await prisma.auditLog.create({
      data: {
        actorName: 'Dukaan import script',
        actorRole: 'SYSTEM',
        module: AuditModule.ORDERS,
        action: `Imported ${report.ordersCreated} orders and ${report.customersCreated} customers from Dukaan (export through 19 Sep 2026)`,
        diff: summary as Prisma.InputJsonValue,
        ip: 'script',
      },
    });
  }

  console.log(JSON.stringify(summary, null, 2));
  console.log(confirm ? '\nimport complete' : '\nDRY RUN — nothing written. Re-run with --confirm to import.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
