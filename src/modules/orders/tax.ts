/**
 * Indian GST calculation for invoices — spec §6.5.
 *
 * Two rules that drive everything here:
 *
 * 1. **Place of supply decides the split.** If the customer's state matches the
 *    seller's, GST splits into CGST + SGST (half each). Otherwise it is a single
 *    IGST line at the full rate. Same total either way — but an invoice showing
 *    the wrong split is not a valid tax invoice.
 *
 * 2. **Inclusive vs exclusive changes the arithmetic.** Zewa's settings default
 *    to GST-inclusive (`gstInclusive: true`), meaning the displayed price already
 *    contains tax and must be REVERSE-calculated:
 *        tax = price × rate / (100 + rate)
 *    Applying `price × rate / 100` to an inclusive price over-charges — a real and
 *    easy mistake.
 *
 * All amounts are integer paise. Rounding happens once per line, then totals are
 * summed from rounded lines so the invoice adds up exactly.
 */

export interface TaxConfig {
  /** Whole percent, e.g. 18. */
  gstRatePct: number;
  /** True when listed prices already include GST. */
  gstInclusive: boolean;
  /** Seller's state — the place of supply. */
  sellerState: string;
}

export interface TaxableLine {
  /** Line total as charged to the customer, in paise. */
  lineTotalPaise: number;
  /** Per-line rate, so a future mixed-rate catalogue still works. */
  taxRatePct: number;
}

export interface LineTax {
  /** Pre-tax value of the line. */
  taxableValuePaise: number;
  taxPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
}

export interface InvoiceTax {
  isInterState: boolean;
  taxableValuePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalTaxPaise: number;
  /** Rate → its component totals, for the invoice's tax summary table. */
  byRate: {
    ratePct: number;
    taxableValuePaise: number;
    cgstPaise: number;
    sgstPaise: number;
    igstPaise: number;
  }[];
}

/** Case- and whitespace-insensitive state comparison. */
function sameState(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  return norm(a) === norm(b);
}

/**
 * Tax for one line.
 *
 * Splitting CGST/SGST uses floor + remainder rather than two independent
 * roundings, so the halves always sum to the total exactly (an odd paise goes to
 * SGST).
 */
export function computeLineTax(
  line: TaxableLine,
  config: TaxConfig,
  customerState: string,
): LineTax {
  const rate = line.taxRatePct;
  const isInterState = !sameState(customerState, config.sellerState);

  let taxableValuePaise: number;
  let taxPaise: number;

  if (config.gstInclusive) {
    // Reverse-calculate: the charged amount already contains the tax.
    taxPaise = Math.round((line.lineTotalPaise * rate) / (100 + rate));
    taxableValuePaise = line.lineTotalPaise - taxPaise;
  } else {
    taxableValuePaise = line.lineTotalPaise;
    taxPaise = Math.round((line.lineTotalPaise * rate) / 100);
  }

  if (isInterState) {
    return { taxableValuePaise, taxPaise, cgstPaise: 0, sgstPaise: 0, igstPaise: taxPaise };
  }

  const half = Math.floor(taxPaise / 2);
  return {
    taxableValuePaise,
    taxPaise,
    cgstPaise: half,
    sgstPaise: taxPaise - half,
    igstPaise: 0,
  };
}

/** Aggregate tax across an order's lines, grouped by rate for the invoice. */
export function computeInvoiceTax(
  lines: TaxableLine[],
  config: TaxConfig,
  customerState: string,
): InvoiceTax {
  const isInterState = !sameState(customerState, config.sellerState);

  const groups = new Map<number, { taxable: number; cgst: number; sgst: number; igst: number }>();
  let taxableValuePaise = 0;
  let cgstPaise = 0;
  let sgstPaise = 0;
  let igstPaise = 0;

  for (const line of lines) {
    const tax = computeLineTax(line, config, customerState);

    taxableValuePaise += tax.taxableValuePaise;
    cgstPaise += tax.cgstPaise;
    sgstPaise += tax.sgstPaise;
    igstPaise += tax.igstPaise;

    const group = groups.get(line.taxRatePct) ?? { taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    group.taxable += tax.taxableValuePaise;
    group.cgst += tax.cgstPaise;
    group.sgst += tax.sgstPaise;
    group.igst += tax.igstPaise;
    groups.set(line.taxRatePct, group);
  }

  return {
    isInterState,
    taxableValuePaise,
    cgstPaise,
    sgstPaise,
    igstPaise,
    totalTaxPaise: cgstPaise + sgstPaise + igstPaise,
    byRate: [...groups.entries()]
      .sort(([a], [b]) => a - b)
      .map(([ratePct, g]) => ({
        ratePct,
        taxableValuePaise: g.taxable,
        cgstPaise: g.cgst,
        sgstPaise: g.sgst,
        igstPaise: g.igst,
      })),
  };
}

/** Format paise as an Indian-locale rupee string, for PDFs and emails. */
export function formatInr(paise: number): string {
  const rupees = paise / 100;
  return `₹${rupees.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
