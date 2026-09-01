/**
 * System settings — spec §13.
 *
 * Key/value rows rather than columns, so adding a settings group is a data change
 * rather than a migration. Four keys: shipping, tax, announcement, maintenance.
 *
 * Every read goes through a typed getter with defaults, so a missing or partial
 * row cannot crash checkout or invoice generation. Reads are cached in Redis for
 * 60s because checkout and the PDF path hit them on every request.
 */
import { AuditModule, type Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { INDIA_STATES, buildStateRates, zoneForState } from '@/lib/india-states';
import { redis } from '@/lib/redis';
import { type AuditContext, writeAudit } from '@/modules/audit/audit.service';
import { plainText, richText } from '@/lib/sanitize';
import { env } from '@/config/env';
import { logger } from '@/lib/logger';
import type { TaxConfig } from '@/modules/orders/tax';

const log = logger.child({ module: 'settings' });

const CACHE_KEY = 'settings:all';
const CACHE_TTL_SECONDS = 60;

// ---- Schemas (also the source of defaults) ---------------------------------

export const shippingSchema = z.object({
  /**
   * Rate per weight slab, in paise, FOR EACH STATE.
   *
   * The authoritative shipping price. Keyed by the state names in
   * lib/india-states.ts, which are also the checkout dropdown's labels.
   *
   * Replaced a two-tier Kerala/everywhere-else pair. Three tiers were wanted
   * (Kerala, southern neighbours, rest of India) and a fourth would have meant
   * another code change, so the price is stored per state and the tiers only
   * seed it. Moving one state to a different price is now a CMS edit.
   */
  stateRatesPaise: z.record(z.string(), z.number().int().nonnegative()).default({}),
  /** Charged for any state not present in the map above. */
  defaultRatePaise: z.number().int().nonnegative().default(6000),
  /**
   * Rate per weight slab for addresses OUTSIDE India, in paise.
   *
   * NOT REACHABLE YET, and deliberately stored anyway. The checkout has no
   * country field — it validates a +91 phone and a 6-digit PIN that must belong
   * to an Indian state, and the invoice splits GST by that state — so every
   * order today is domestic and this value is never read. Pricing consults it
   * through `isDomestic()` so that turning international shipping on later is a
   * change in one place rather than a new pricing branch invented under
   * deadline. See the note beside the field in CMS settings.
   */
  internationalRatePaise: z.number().int().nonnegative().default(0),
  /*
   * Superseded by `stateRatesPaise`, kept so an old settings row still parses
   * and can be migrated from on first read. Nothing reads these to price an
   * order. Safe to delete once every environment has saved settings once.
   */
  keralaRatePerKgPaise: z.number().int().nonnegative().default(4500),
  outsideKeralaRatePerKgPaise: z.number().int().nonnegative().default(7000),
  /** Packaging weight overhead in grams added to net product weight (default 100g). */
  packagingWeightGrams: z.number().int().nonnegative().default(100),
  /** Weight slab granularity in grams (default 500g = 0.5kg). */
  slabWeightGrams: z.number().int().positive().default(500),
  /** Free shipping threshold in paise (0 = disabled, default 99900 = ₹999). */
  freeThresholdPaise: z.number().int().nonnegative().default(99900),
  /** Fallback flat rate in paise if weight cannot be determined. */
  standardRatePaise: z.number().int().nonnegative().default(6000),
  deliveryText: z.string().max(200).transform(plainText).default('3–5 business days across India'),
  /** PIN codes we do not deliver to (§13). */
  pinBlacklist: z.array(z.string().regex(/^\d{6}$/)).default([]),
});

export const taxSchema = z.object({
  /*
   * Defaults to 0, and is edited from the CMS (Settings -> Tax) rather than in
   * code. The rate applicable to these products is not settled yet, so the
   * safe default is to charge none — an 18% default silently adds tax to every
   * order the moment a fresh environment comes up without a saved setting.
   */
  gstRatePct: z.number().min(0).max(50).default(0),
  /** True when listed prices already contain GST — drives reverse-calculation. */
  gstInclusive: z.boolean().default(true),
  gstin: z.string().max(20).transform(plainText).default(''),
});

export const announcementSchema = z.object({
  text: z.string().max(200).transform(plainText).default(''),
  linkLabel: z.string().max(60).transform(plainText).default(''),
  linkUrl: z.string().max(500).default('/'),
  bg: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#080C18'),
  fg: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#44E5C2'),
  active: z.boolean().default(false),
});

export const maintenanceSchema = z.object({
  on: z.boolean().default(false),
  message: z.string().max(2000).transform(richText).default(''),
  endAt: z.string().datetime().nullable().default(null),
});

export const settingsSchema = z.object({
  shipping: shippingSchema,
  tax: taxSchema,
  announcement: announcementSchema,
  maintenance: maintenanceSchema,
});

export type Settings = z.infer<typeof settingsSchema>;
/** The shipping group on its own — the per-state rate map lives here. */
export type ShippingSettings = z.infer<typeof shippingSchema>;
export type SettingsKey = keyof Settings;

const SCHEMAS = {
  shipping: shippingSchema,
  tax: taxSchema,
  announcement: announcementSchema,
  maintenance: maintenanceSchema,
} as const;

// ---- Reads -----------------------------------------------------------------

/**
 * All settings, cached.
 *
 * Each group is parsed through its schema, so defaults fill any gap — a
 * half-populated row degrades to sane values rather than throwing at checkout.
 */
/**
 * Fill in the per-state rate map.
 *
 * Runs on every read so three things are always true, without a migration:
 *   - a settings row written before per-state rates existed still prices orders,
 *     seeded from the Kerala / outside-Kerala pair it does carry
 *   - a state added to INDIA_STATES later cannot leave a hole in a saved map
 *   - a hand-edited row missing the field is repaired rather than rejected
 *
 * An explicitly saved rate always wins; this only supplies what is absent.
 */
function withStateRates(shipping: ShippingSettings): ShippingSettings {
  const seeded = buildStateRates({
    homePaise: shipping.keralaRatePerKgPaise,
    // No southern tier existed before, so those states start where they were:
    // on the outside-Kerala rate. The CMS is where they get their own price.
    southPaise: shipping.outsideKeralaRatePerKgPaise,
    restPaise: shipping.outsideKeralaRatePerKgPaise,
  });

  const stateRatesPaise: Record<string, number> = { ...seeded };
  for (const [state, paise] of Object.entries(shipping.stateRatesPaise ?? {})) {
    stateRatesPaise[state] = paise;
  }
  return { ...shipping, stateRatesPaise };
}

export async function getAll(): Promise<Settings> {
  const cached = await redis.get(CACHE_KEY).catch(() => null);
  if (cached) {
    try {
      const fromCache = settingsSchema.parse(JSON.parse(cached));
      return { ...fromCache, shipping: withStateRates(fromCache.shipping) };
    } catch {
      // Cache poisoned or schema changed since it was written — fall through.
      log.warn('settings cache failed to parse, refetching');
    }
  }

  const rows = await prisma.setting.findMany();
  const raw = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  const parsed = settingsSchema.parse({
    shipping: raw.shipping ?? {},
    tax: raw.tax ?? {},
    announcement: raw.announcement ?? {},
    maintenance: raw.maintenance ?? {},
  });
  const settings = { ...parsed, shipping: withStateRates(parsed.shipping) };

  await redis.setex(CACHE_KEY, CACHE_TTL_SECONDS, JSON.stringify(settings)).catch(() => undefined);
  return settings;
}

export async function get<K extends SettingsKey>(key: K): Promise<Settings[K]> {
  const all = await getAll();
  return all[key];
}

/**
 * Tax config for invoices and checkout.
 *
 * The seller's state comes from env, not the database: it is where the business is
 * registered, not something staff should be able to change from a settings form —
 * getting it wrong silently produces invalid tax invoices.
 */
export async function getTaxConfig(): Promise<TaxConfig> {
  const tax = await get('tax');
  return {
    gstRatePct: tax.gstRatePct,
    gstInclusive: tax.gstInclusive,
    sellerState: env.COMPANY_STATE,
  };
}

/** Public subset for the storefront — no GSTIN, no internal config. */
export async function getPublic() {
  const { shipping, announcement, maintenance, tax } = await getAll();
  return {
    shipping: {
      stateRatesPaise: shipping.stateRatesPaise,
      defaultRatePaise: shipping.defaultRatePaise,
      internationalRatePaise: shipping.internationalRatePaise,
      packagingWeightGrams: shipping.packagingWeightGrams,
      slabWeightGrams: shipping.slabWeightGrams,
      freeThresholdPaise: shipping.freeThresholdPaise,
      standardRatePaise: shipping.standardRatePaise,
      deliveryText: shipping.deliveryText,
    },
    tax: { gstRatePct: tax.gstRatePct, gstInclusive: tax.gstInclusive },
    announcement: announcement.active ? announcement : null,
    maintenance: maintenance.on ? { on: true, message: maintenance.message, endAt: maintenance.endAt } : { on: false },
  };
}

// ---- Writes ----------------------------------------------------------------

export async function updateGroup<K extends SettingsKey>(
  key: K,
  value: unknown,
  actorId: string,
  ctx: AuditContext,
): Promise<Settings[K]> {
  const parsed = SCHEMAS[key].parse(value) as Settings[K];

  await prisma.$transaction(async (tx) => {
    await tx.setting.upsert({
      where: { key },
      create: { key, value: parsed as Prisma.InputJsonValue, updatedById: actorId },
      update: { value: parsed as Prisma.InputJsonValue, updatedById: actorId },
    });
    await writeAudit(
      ctx,
      { module: AuditModule.SETTINGS, action: `Updated ${key} settings`, recordId: key },
      tx,
    );
  });

  await invalidate();
  return parsed;
}

/** Drop the cache so the next read is fresh — called after every write. */
export async function invalidate(): Promise<void> {
  await redis.del(CACHE_KEY).catch(() => undefined);
}
