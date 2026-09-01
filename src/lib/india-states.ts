/**
 * The states and union territories the storefront ships to, and the shipping
 * zone each one starts in.
 *
 * ONE list, shared by pricing, settings validation and the CMS editor, because
 * three copies would drift and a state missing from one of them silently falls
 * back to the default rate. The names match the checkout dropdown and
 * lib/pincode.ts exactly — comparison is normalised, but keeping them identical
 * avoids surprises.
 *
 * Zones are only a STARTING POINT. The real rate for every state is stored
 * individually in settings, so moving one state to a different price is a CMS
 * edit rather than a code change; these tiers exist to seed that map and to
 * give a sensible answer for a state that has never been configured.
 */

export const INDIA_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh',
  'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka',
  'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram',
  'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu',
  'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  'Andaman & Nicobar Islands', 'Chandigarh',
  'Dadra & Nagar Haveli and Daman & Diu', 'Delhi', 'Jammu & Kashmir', 'Ladakh',
  'Lakshadweep', 'Puducherry',
] as const;

export type IndiaState = (typeof INDIA_STATES)[number];

/** Home state — the cheapest to reach. */
export const HOME_STATE = 'Kerala';

/** Neighbouring southern states, cheaper than the rest of the country. */
export const SOUTH_ZONE_STATES: readonly string[] = [
  'Tamil Nadu', 'Karnataka', 'Telangana', 'Andhra Pradesh', 'Goa',
];

/**
 * Comparison-safe form: case, spacing and "&"/"and" differences all collapse.
 * Identical to the normaliser in lib/pincode.ts and pricing.service.ts.
 */
export const normaliseStateName = (state: string): string =>
  state.toLowerCase().replace(/\band\b/g, '&').replace(/[^a-z&]/g, '');

/** Which starting tier a state belongs to. */
export function zoneForState(state: string): 'home' | 'south' | 'rest' {
  const n = normaliseStateName(state);
  if (n === normaliseStateName(HOME_STATE)) return 'home';
  if (SOUTH_ZONE_STATES.some((s) => normaliseStateName(s) === n)) return 'south';
  return 'rest';
}

/**
 * Build a full per-state rate map from three tier rates.
 *
 * Used to seed the setting the first time, and to fill in any state a saved map
 * does not mention — so adding a new UT to INDIA_STATES cannot leave a hole.
 */
export function buildStateRates(tiers: {
  homePaise: number;
  southPaise: number;
  restPaise: number;
}): Record<string, number> {
  const map: Record<string, number> = {};
  for (const state of INDIA_STATES) {
    const zone = zoneForState(state);
    map[state] =
      zone === 'home' ? tiers.homePaise : zone === 'south' ? tiers.southPaise : tiers.restPaise;
  }
  return map;
}

/**
 * The country every address is currently assumed to be in.
 *
 * There is no country field on an address yet: the checkout validates a +91
 * phone and a 6-digit PIN that must match an Indian state, and the invoice
 * splits GST by that state. So `isDomestic` is true for every order the system
 * can actually take today.
 *
 * It exists so the international shipping rate has a single, honest place to be
 * consulted from, rather than the rate being read in a branch that cannot run.
 * When a country field is added, this is the one function that has to change.
 */
export const DEFAULT_COUNTRY = 'India';

export function isDomestic(country?: string | null): boolean {
  if (!country) return true; // no country captured == the India-only flow
  return normaliseStateName(country) === normaliseStateName(DEFAULT_COUNTRY);
}
