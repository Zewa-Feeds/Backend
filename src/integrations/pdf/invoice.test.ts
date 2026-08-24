import { describe, expect, it } from 'vitest';
import { formatInvoiceFilename } from './invoice';

describe('formatInvoiceFilename', () => {
  it('formats filename with invoice number and customer name', () => {
    expect(formatInvoiceFilename('27ZFI003', 'Nikhildev M')).toBe('27ZFI003-Nikhildev M.pdf');
  });

  it('sanitizes illegal path and header characters in invoice number and customer name', () => {
    expect(formatInvoiceFilename('ZEW/26-27/0319', 'Priya <Nair>')).toBe('ZEW-26-27-0319-Priya Nair.pdf');
    expect(formatInvoiceFilename('INV:123*?', 'John "Doe"|')).toBe('INV-123---John Doe.pdf');
  });

  it('handles missing or empty customer name by returning invoice number only', () => {
    expect(formatInvoiceFilename('27ZFI003', '')).toBe('27ZFI003.pdf');
    expect(formatInvoiceFilename('27ZFI003', null)).toBe('27ZFI003.pdf');
    expect(formatInvoiceFilename('27ZFI003', undefined)).toBe('27ZFI003.pdf');
  });

  it('handles null/undefined invoice number gracefully', () => {
    expect(formatInvoiceFilename(null, 'Nikhildev M')).toBe('invoice-Nikhildev M.pdf');
    expect(formatInvoiceFilename(undefined, null)).toBe('invoice.pdf');
  });
});
