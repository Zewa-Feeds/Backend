/**
 * Multi-value filter parsing for the CMS filter bar.
 *
 * The orders list lets an operator tick several statuses at once, which arrive
 * as one comma-separated query param. The parsing carries two traps worth
 * pinning down:
 *
 *   - "All" must cancel the whole filter, not contribute a value — otherwise
 *     ticking everything would validate as an unknown enum and 422.
 *   - The result must be `undefined`, never `[]`, when nothing is selected.
 *     Prisma reads `{ in: [] }` as "match nothing", so an empty array would
 *     silently return zero orders where the operator meant "no filter".
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { enumListFilter } from './validate';

enum Status {
  PENDING = 'PENDING',
  SHIPPED = 'SHIPPED',
  DELIVERED = 'DELIVERED',
  PARTIALLY_REFUNDED = 'PARTIALLY_REFUNDED',
}

const schema = z.object({ status: enumListFilter(z.nativeEnum(Status)) });
const parse = (status?: unknown) => schema.parse({ status }).status;

describe('enumListFilter', () => {
  it('reads a comma-separated list', () => {
    expect(parse('SHIPPED,DELIVERED')).toEqual([Status.SHIPPED, Status.DELIVERED]);
  });

  it('still accepts a single value, so existing sidebar links keep working', () => {
    expect(parse('PENDING')).toEqual([Status.PENDING]);
  });

  it('accepts a repeated query param', () => {
    expect(parse(['SHIPPED', 'DELIVERED'])).toEqual([Status.SHIPPED, Status.DELIVERED]);
  });

  it('treats an absent, empty or "All" filter as no filter', () => {
    expect(parse(undefined)).toBeUndefined();
    expect(parse('')).toBeUndefined();
    expect(parse('All')).toBeUndefined();
    expect(parse([])).toBeUndefined();
  });

  it('lets "All" anywhere in the list cancel the whole filter', () => {
    expect(parse('SHIPPED,All')).toBeUndefined();
  });

  it('ignores blank entries from a trailing comma', () => {
    expect(parse('SHIPPED,,')).toEqual([Status.SHIPPED]);
  });

  it('collapses duplicates so they cannot pad the IN list', () => {
    expect(parse('SHIPPED,SHIPPED')).toEqual([Status.SHIPPED]);
  });

  it('normalises case, surrounding space and display labels', () => {
    expect(parse(' shipped , Partially Refunded ')).toEqual([
      Status.SHIPPED,
      Status.PARTIALLY_REFUNDED,
    ]);
  });

  it('rejects a list containing an unknown value', () => {
    expect(() => parse('SHIPPED,NOT_A_STATUS')).toThrow();
  });
});
