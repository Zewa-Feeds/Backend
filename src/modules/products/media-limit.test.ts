import { describe, expect, it } from 'vitest';
import { productBodySchema } from './products.schemas';
import { MediaType } from '@prisma/client';

const validBaseProduct = {
  name: 'Zewa Test Pellet Range',
  category: 'BETTA',
  status: 'DRAFT',
  badge: 'None',
  shortDesc: 'Test short description for fish food.',
  fullDesc: '<p>Complete fish nutrition formula.</p>',
  protein: 48,
  benefits: ['High protein', 'Easy digestion'],
  tags: ['betta', 'pellet'],
  nutrition: {
    crudeProteinMin: '48%',
    crudeFatMin: '8%',
    crudeFiberMax: '4%',
    moistureMax: '10%',
    calciumMin: '1.2%',
    phosphorusMin: '1.0%',
  },
  variants: [
    {
      sku: 'TEST-45G',
      pack: '45g Bottle',
      price: 199,
      mrp: 249,
      stock: 100,
      hsn: '23099090',
      isActive: true,
      position: 0,
    },
  ],
};

function generateMedia(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `00000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`,
    type: MediaType.IMAGE,
    url: `https://res.cloudinary.com/zewa/image/upload/v1234567890/products/test-image-${i + 1}.jpg`,
    publicId: `products/test-image-${i + 1}`,
    alt: `Test Image ${i + 1}`,
    skus: ['TEST-45G'],
  }));
}

describe('Product Media Gallery Limit (40 items) & Item Replacement', () => {
  it('allows an existing product with 20 gallery images and replaces one', () => {
    const media = generateMedia(20);
    // Replace image #5
    media[4] = {
      id: media[4]!.id,
      type: MediaType.IMAGE,
      url: 'https://res.cloudinary.com/zewa/image/upload/v1234567890/products/replaced-image-5.jpg',
      publicId: 'products/replaced-image-5',
      alt: 'Replaced Image 5',
      skus: ['TEST-45G'],
    };

    const parsed = productBodySchema.safeParse({
      ...validBaseProduct,
      media,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.media).toHaveLength(20);
      expect(parsed.data.media![4]?.url).toContain('replaced-image-5.jpg');
    }
  });

  it('allows an existing product with 21 gallery images and replaces image #8', () => {
    const media = generateMedia(21);
    // Replace image #8 (index 7)
    media[7] = {
      id: media[7]!.id,
      type: MediaType.IMAGE,
      url: 'https://res.cloudinary.com/zewa/image/upload/v1234567890/products/replaced-image-8.jpg',
      publicId: 'products/replaced-image-8',
      alt: 'Replaced Image 8',
      skus: ['TEST-45G'],
    };

    const parsed = productBodySchema.safeParse({
      ...validBaseProduct,
      media,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.media).toHaveLength(21);
      expect(parsed.data.media![7]?.url).toContain('replaced-image-8.jpg');
    }
  });

  it('allows an existing product with 25 gallery images and replaces image #12', () => {
    const media = generateMedia(25);
    // Replace image #12 (index 11)
    media[11] = {
      id: media[11]!.id,
      type: MediaType.IMAGE,
      url: 'https://res.cloudinary.com/zewa/image/upload/v1234567890/products/replaced-image-12.jpg',
      publicId: 'products/replaced-image-12',
      alt: 'Replaced Image 12',
      skus: ['TEST-45G'],
    };

    const parsed = productBodySchema.safeParse({
      ...validBaseProduct,
      media,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.media).toHaveLength(25);
      expect(parsed.data.media![11]?.url).toContain('replaced-image-12.jpg');
    }
  });

  it('allows an existing product with 39 images to add one new image (total 40)', () => {
    const media = generateMedia(39);
    // Add 1 new image
    media.push({
      id: undefined as never,
      type: MediaType.IMAGE,
      url: 'https://res.cloudinary.com/zewa/image/upload/v1234567890/products/new-image-40.jpg',
      publicId: 'products/new-image-40',
      alt: 'New Image 40',
      skus: ['TEST-45G'],
    });

    const parsed = productBodySchema.safeParse({
      ...validBaseProduct,
      media,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.media).toHaveLength(40);
    }
  });

  it('allows an existing product with 40 images to replace an existing image', () => {
    const media = generateMedia(40);
    // Replace image #1
    media[0] = {
      id: media[0]!.id,
      type: MediaType.IMAGE,
      url: 'https://res.cloudinary.com/zewa/image/upload/v1234567890/products/replaced-hero.jpg',
      publicId: 'products/replaced-hero',
      alt: 'Replaced Hero',
      skus: ['TEST-45G'],
    };

    const parsed = productBodySchema.safeParse({
      ...validBaseProduct,
      media,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.media).toHaveLength(40);
      expect(parsed.data.media![0]?.url).toContain('replaced-hero.jpg');
    }
  });

  it('rejects adding a 41st gallery image with the exact 40-item maximum limit error', () => {
    const media = generateMedia(41);

    const parsed = productBodySchema.safeParse({
      ...validBaseProduct,
      media,
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const mediaError = parsed.error.issues.find((i) => i.path.includes('media'));
      expect(mediaError?.message).toBe('A product can have at most 40 gallery items.');
    }
  });

  it('allows creating or editing products with fewer than 40 gallery items', () => {
    for (const count of [1, 5, 10, 15, 20, 25, 30, 35, 40]) {
      const media = generateMedia(count);
      const parsed = productBodySchema.safeParse({
        ...validBaseProduct,
        media,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it('preserves all items without truncation or silent drops', () => {
    const media = generateMedia(35);
    const parsed = productBodySchema.safeParse({
      ...validBaseProduct,
      media,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.media).toHaveLength(35);
      for (let i = 0; i < 35; i++) {
        expect(parsed.data.media![i]?.url).toBe(media[i]!.url);
        expect(parsed.data.media![i]?.publicId).toBe(media[i]!.publicId);
      }
    }
  });
});
