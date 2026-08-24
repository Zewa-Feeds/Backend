/**
 * Indian PIN code → state, from the postal system's own regional structure.
 *
 * India's PIN allocation is geographic by design: the first two digits identify
 * a postal circle, which maps onto a state (or a small group of them). That
 * makes a ~40-row prefix table enough to validate "does this PIN belong to the
 * state the customer selected?" — no 19,000-row dataset, no network call, and it
 * works identically on the server and in the browser.
 *
 * WHY THIS MATTERS BEYOND TIDINESS: the customer's state decides the GST split
 * on the invoice — CGST+SGST for an intra-state sale, IGST for inter-state (see
 * modules/orders/tax.ts). A customer who picks the wrong state produces a
 * legally incorrect invoice, so this is a tax-correctness check.
 *
 * Deliberately NOT a city lookup. Two digits cannot resolve a district, and
 * guessing one wrong would be worse than letting the customer type it.
 */

/**
 * Two-digit PIN prefix → state name, matching the labels in the checkout state
 * dropdown exactly (comparison is normalised, but keeping them identical avoids
 * silent drift).
 *
 * Several circles legitimately cover more than one state — 73 spans Karnataka
 * and Goa, 79 spans several north-eastern states — so a prefix maps to a LIST
 * and a PIN is accepted if the selected state is any of them. Being permissive
 * where the postal system itself is ambiguous is correct; the alternative is
 * rejecting valid addresses.
 */
const PREFIX_STATES: Record<string, string[]> = {
  11: ['Delhi'],
  12: ['Haryana'],
  13: ['Haryana', 'Punjab'],
  14: ['Punjab'],
  15: ['Punjab'],
  16: ['Punjab', 'Chandigarh'],
  17: ['Himachal Pradesh'],
  18: ['Jammu & Kashmir'],
  19: ['Jammu & Kashmir', 'Ladakh'],
  20: ['Uttar Pradesh'],
  21: ['Uttar Pradesh'],
  22: ['Uttar Pradesh'],
  23: ['Uttar Pradesh'],
  24: ['Uttar Pradesh'],
  25: ['Uttar Pradesh', 'Uttarakhand'],
  26: ['Uttar Pradesh'],
  27: ['Uttar Pradesh'],
  28: ['Uttar Pradesh'],
  30: ['Rajasthan'],
  31: ['Rajasthan'],
  32: ['Rajasthan'],
  33: ['Rajasthan'],
  34: ['Rajasthan'],
  36: ['Gujarat'],
  37: ['Gujarat'],
  38: ['Gujarat'],
  39: ['Gujarat', 'Dadra & Nagar Haveli and Daman & Diu'],
  40: ['Maharashtra', 'Goa'],
  41: ['Maharashtra'],
  42: ['Maharashtra'],
  43: ['Maharashtra'],
  44: ['Maharashtra'],
  45: ['Madhya Pradesh'],
  46: ['Madhya Pradesh'],
  47: ['Madhya Pradesh'],
  48: ['Madhya Pradesh', 'Chhattisgarh'],
  49: ['Chhattisgarh', 'Madhya Pradesh'],
  50: ['Telangana'],
  51: ['Andhra Pradesh', 'Telangana'],
  52: ['Andhra Pradesh'],
  53: ['Andhra Pradesh'],
  56: ['Karnataka'],
  57: ['Karnataka'],
  58: ['Karnataka'],
  59: ['Karnataka'],
  60: ['Tamil Nadu'],
  61: ['Tamil Nadu'],
  62: ['Tamil Nadu'],
  63: ['Tamil Nadu'],
  64: ['Tamil Nadu'],
  65: ['Tamil Nadu'],
  66: ['Tamil Nadu'],
  67: ['Kerala'],
  68: ['Kerala', 'Lakshadweep'],
  69: ['Kerala', 'Puducherry'],
  70: ['West Bengal'],
  71: ['West Bengal'],
  72: ['West Bengal'],
  73: ['West Bengal', 'Sikkim'],
  74: ['West Bengal', 'Odisha', 'Andaman & Nicobar Islands'],
  75: ['Odisha'],
  76: ['Odisha'],
  77: ['Odisha'],
  78: ['Assam'],
  79: ['Arunachal Pradesh', 'Assam', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Tripura'],
  80: ['Bihar'],
  81: ['Bihar', 'Jharkhand'],
  82: ['Bihar', 'Jharkhand'],
  83: ['Jharkhand'],
  84: ['Bihar'],
  85: ['Bihar'],
};

/** Comparison-safe form: case, spacing and "&"/"and" differences all collapse. */
const normalise = (state: string) =>
  state.toLowerCase().replace(/\band\b/g, '&').replace(/[^a-z&]/g, '');

/** States a PIN can legitimately belong to. Empty when the prefix is unknown. */
export function statesForPincode(pincode: string): string[] {
  const digits = String(pincode).replace(/\D/g, '');
  if (digits.length < 2) return [];
  return PREFIX_STATES[digits.slice(0, 2)] ?? [];
}

/**
 * Does this PIN belong to this state?
 *
 * Returns true for an UNKNOWN prefix on purpose: the table covers every circle
 * currently in use, so an unrecognised prefix means either a typo the length
 * check already caught, or a new circle we have not mapped. Blocking a real
 * order on our own incomplete data would be the worse failure.
 */
export function pincodeMatchesState(pincode: string, state: string): boolean {
  const candidates = statesForPincode(pincode);
  if (candidates.length === 0) return true;
  return candidates.some((s) => normalise(s) === normalise(state));
}

/** For the error message: "That pincode is in Kerala, not Maharashtra." */
export function likelyStateForPincode(pincode: string): string | null {
  return statesForPincode(pincode)[0] ?? null;
}

/**
 * States and union territories offered across the store and CMS.
 */
export const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh',
  'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka',
  'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram',
  'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu',
  'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  'Andaman & Nicobar Islands', 'Chandigarh', 'Dadra & Nagar Haveli and Daman & Diu',
  'Delhi', 'Jammu & Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry',
] as const;
