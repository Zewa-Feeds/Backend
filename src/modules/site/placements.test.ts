/**
 * The asset-spec rules. The SAME fixtures are asserted in CMS/lib/placements.test.js
 * against the CMS's client-side copy, so the two cannot drift apart unnoticed.
 */
import { describe, expect, it } from 'vitest';
import { PLACEMENTS, validateAsset } from './placements';
import { blocksSchema } from './site.schemas';

const img = (format: string, width: number, height: number) => ({ type: 'IMAGE' as const, format, width, height });

describe('validateAsset', () => {
  it('accepts the spec’s own export for each placement', () => {
    for (const p of Object.values(PLACEMENTS)) {
      if (p.kind !== 'IMAGE' || !p.width || !p.height) continue;
      const issues = validateAsset(p.key, img(p.recommendedFormats[0]!, p.width, p.height), 'x');
      expect(issues, p.key).toEqual([]);
    }
  });

  it('refuses a video in an image slot (an error, so publishing is blocked)', () => {
    const issues = validateAsset('home.hero.banner.desktop', { type: 'VIDEO', format: 'mp4', width: 1920, height: 814 }, 'p');
    expect(issues).toEqual([{ level: 'error', path: 'p', message: 'Hero banner — desktop needs an image.' }]);
  });

  it('refuses a codec the <source> tag does not declare', () => {
    const issues = validateAsset('home.hero.video.mp4', { type: 'VIDEO', format: 'mov', width: 2880, height: 1440 }, 'p');
    expect(issues[0]).toMatchObject({ level: 'error' });
  });

  it('warns — not errors — on an off-ratio photo, naming the crop', () => {
    // The 2023 milestone photo: portrait in a 16:10 landscape well (spec §10, issue 1).
    const issues = validateAsset('about.milestone', img('jpg', 2210, 3072), 'p');
    expect(issues).toEqual([
      { level: 'warning', path: 'p', message: 'Ratio is 0.72:1 but the slot is 16:10 — the edges will be cropped.' },
    ]);
  });

  it('warns on an undersized file', () => {
    const issues = validateAsset('article.cover', img('jpg', 1024, 576), 'p');
    expect(issues.map((i) => i.level)).toEqual(['warning']);
    expect(issues[0]!.message).toContain('smaller than the 2000×1125');
  });

  it('asks for a transparent PNG where the slot is a cutout', () => {
    const issues = validateAsset('about.logo', img('jpg', 470, 290), 'p');
    expect(issues[0]!.message).toBe('Institution logo should be a transparent PNG — a JPG will show its background.');
  });

  it('cannot check ratio without dimensions, and says so', () => {
    const issues = validateAsset('article.cover', { type: 'IMAGE', format: 'jpg', width: null, height: null }, 'p');
    expect(issues[0]!.message).toMatch(/Dimensions are unknown/);
  });

  it('tolerates a rounding pixel (2000×1124 is still 16:9)', () => {
    expect(validateAsset('article.cover', img('jpg', 2000, 1124), 'p')).toEqual([]);
  });
});

describe('article blocks', () => {
  it('accepts a plain bulleted or numbered list, and refuses an empty one', () => {
    expect(blocksSchema.safeParse([{ type: 'list', items: ['Less waste', 'Clearer water'] }]).success).toBe(true);
    expect(blocksSchema.safeParse([{ type: 'list', ordered: true, items: ['One'] }]).success).toBe(true);
    expect(blocksSchema.safeParse([{ type: 'list', items: [] }]).success).toBe(false);
  });
});
