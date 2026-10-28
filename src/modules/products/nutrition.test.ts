import { describe, expect, it } from 'vitest';
import { canonicalNutrition } from './nutrition';

describe('canonicalNutrition', () => {
  it('maps imported label keys to the short keys the CMS form uses', () => {
    expect(
      canonicalNutrition({
        'Crude Fat (min)': '30%',
        'Crude Fiber (max)': '5%',
        'Moisture (max)': '5%',
        'Ash (max)': '6%',
        'Calcium (min)': '2%',
        'Phosphorus (min)': '0.7%',
      }),
    ).toEqual({ fat: '30%', fiber: '5%', moisture: '5%', ash: '6%', calcium: '2%', phosphorus: '0.7%' });
  });

  it('keeps the CMS edit when both spellings exist, in either order (the Dried BSF Larvae duplicate)', () => {
    expect(canonicalNutrition({ fat: '28', 'Crude Fat (min)': '30%' })).toEqual({ fat: '28' });
    expect(canonicalNutrition({ 'Crude Fat (min)': '30%', fat: '28' })).toEqual({ fat: '28' });
  });

  it('treats an emptied CMS field as a cleared nutrient', () => {
    expect(canonicalNutrition({ ash: '', 'Ash (max)': '6%' })).toEqual({});
    expect(canonicalNutrition({ 'Ash (max)': '6%', ash: '' })).toEqual({});
  });

  it('drops crude protein, which lives on proteinPct', () => {
    expect(canonicalNutrition({ 'Crude Protein (min)': '40%', protein: '40', fat: '9%' })).toEqual({ fat: '9%' });
  });

  it('passes custom nutrients through and tolerates bad input', () => {
    expect(canonicalNutrition({ 'Omega-3': '1.2%', fibre: '4%' })).toEqual({ 'Omega-3': '1.2%', fiber: '4%' });
    expect(canonicalNutrition(null)).toEqual({});
    expect(canonicalNutrition(['x'])).toEqual({});
  });
});
