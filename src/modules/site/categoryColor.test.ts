import { describe, expect, it } from 'vitest';
import { categoryColor } from './categoryColor';

// Same fixtures as CMS/lib/categoryColor.test.js.
describe('categoryColor', () => {
  it('gives every blog topic its fixed colour, whatever the case or spacing', () => {
    expect(categoryColor('NUTRITION')).toBe('#fb923c');
    expect(categoryColor('Nutrition')).toBe('#fb923c');
    expect(categoryColor('  feed   science ')).toBe('#60a5fa');
    expect(categoryColor('Species Guide')).toBe('#a78bfa');
  });
  it('gives an unknown category a stable palette colour', () => {
    expect(categoryColor('Shrimp Care')).toBe(categoryColor('SHRIMP CARE'));
    expect(categoryColor('Shrimp Care')).toBe('#c084fc');
  });
  it('falls back to the brand teal when there is no category', () => {
    expect(categoryColor('')).toBe('#44e5c2');
    expect(categoryColor(null)).toBe('#44e5c2');
  });
});
