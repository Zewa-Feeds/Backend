/**
 * Stock status is judged per SKU (Micro Pellets M3, Nov 2026: "In Stock · 26"
 * while two of its packs were at 0).
 */
import { describe, it, expect } from 'vitest';
import { skuStockSummary } from './products.serializer';

const v = (stock: number, isActive = true) => ({ stock, isActive });

describe('skuStockSummary', () => {
  it('one empty SKU makes the product Out of Stock, whatever the total', () => {
    expect(skuStockSummary([v(0), v(8), v(9), v(9), v(0)])).toEqual({ worst: 'Out of Stock', out: 2, low: 3, activeSkus: 5 });
  });
  it('any SKU under 10 makes it Low Stock', () => {
    expect(skuStockSummary([v(50), v(9)]).worst).toBe('Low Stock');
  });
  it('every SKU at 10 or more is In Stock', () => {
    expect(skuStockSummary([v(10), v(110)]).worst).toBe('In Stock');
  });
  it('ignores SKUs that are switched off', () => {
    expect(skuStockSummary([v(40), v(0, false)])).toEqual({ worst: 'In Stock', out: 0, low: 0, activeSkus: 1 });
  });
  it('a product with no active SKU cannot be bought, so it is Out of Stock', () => {
    expect(skuStockSummary([v(5, false)]).worst).toBe('Out of Stock');
  });
});
