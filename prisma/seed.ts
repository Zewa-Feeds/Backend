/**
 * Database seed — ported from CMS/lib/seed.js.
 *
 * Idempotent: safe to re-run. Everything upserts on a natural key, so this can be
 * used to refresh a dev database without a full reset.
 *
 * ── IMPORTANT ───────────────────────────────────────────────────────────────
 * The product data below is the CMS's seed data, NOT confirmed production data.
 * The CMS and the storefront currently disagree on product names, protein
 * percentages, and pack prices (e.g. CMS "Cichlid Colour Pellets C7" vs
 * storefront "Cichlid Bites C4"; F3 1kg at ₹1890 vs ₹1785). See §10 of
 * BACKEND_DESIGN.md. Resolve that before seeding anything customer-facing.
 *
 * Likewise the shipping numbers here come from the CMS settings (₹999 / ₹60); the
 * storefront checkout hardcodes ₹499 / ₹49.
 * ────────────────────────────────────────────────────────────────────────────
 */
import {
  Badge,
  Category,
  ContentStatus,
  ContentVersion,
  DiscountType,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PrismaClient,
  ProductStatus,
  Role,
  TwofaMethod,
} from '@prisma/client';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import { createCipheriv, randomBytes, createHash } from 'node:crypto';

const prisma = new PrismaClient();

/**
 * Encrypt a TOTP secret the same way src/lib/crypto.ts does.
 *
 * Duplicated rather than imported because the seed runs via tsx outside the app's
 * path aliases, and importing @/config/env would drag in the whole validated
 * config. Keep the format (iv:authTag:ciphertext, base64) in sync.
 */
function encryptSecret(plain: string): string {
  const key = Buffer.from(process.env.TWOFA_ENCRYPTION_KEY ?? '', 'hex');
  if (key.length !== 32) {
    throw new Error('TWOFA_ENCRYPTION_KEY must be 64 hex chars — check your .env');
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

/** Rupees -> paise. The DB stores paise as Int, never a float. */
const paise = (rupees: number) => Math.round(rupees * 100);

/** Local dev password for every seeded CMS account. Matches the CMS README. */
const DEV_PASSWORD = 'zewa1234';

/**
 * Fixed TOTP secret for all seeded accounts, so local logins are reproducible and
 * one authenticator entry covers every dev account.
 *
 * DEV ONLY. Real accounts generate a unique secret during enrolment (§14.3), and
 * this constant never reaches production because the seed is not run there.
 */
const DEV_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

/** Known backup codes for dev, so 2FA is testable without an authenticator app. */
const DEV_BACKUP_CODES = [
  'ZEWA-DEV1',
  'ZEWA-DEV2',
  'ZEWA-DEV3',
  'ZEWA-DEV4',
  'ZEWA-DEV5',
  'ZEWA-DEV6',
  'ZEWA-DEV7',
  'ZEWA-DEV8',
];

/** Match src/lib/crypto.ts normaliseBackupCode. */
const normaliseCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');

// ============================================================================
// CMS USERS (§11) — from target user profiles
// ============================================================================
const CMS_USERS = [
  {
    email: 'nikhildevm@zewafeeds.com',
    name: 'Nik Mulakkal',
    role: Role.ADMIN,
    twofaMethod: TwofaMethod.TOTP,
  },
  {
    email: 'it@zewafeeds.com',
    name: 'Zewa Feeds IT',
    role: Role.ADMIN,
    twofaMethod: TwofaMethod.TOTP,
  },
  {
    email: 'aromals@zewafeeds.com',
    name: 'Aromal Santhosh',
    role: Role.OPS_MANAGER,
    twofaMethod: TwofaMethod.TOTP,
  },
  {
    email: 'info@zewafeeds.com',
    name: 'Zewa Feeds',
    role: Role.OPS_MANAGER,
    twofaMethod: TwofaMethod.TOTP,
  },
  {
    email: 'vaishnavip@zewafeeds.com',
    name: 'Vaishnavi Prabhakar',
    role: Role.CONTENT_EDITOR,
    twofaMethod: TwofaMethod.SMS_OTP,
  },
] as const;

// ============================================================================
// PRODUCTS (§5) — from seed.js PRODUCTS
// ============================================================================
const PRODUCTS = [
  {
    slug: 'betta-bites-f3',
    name: 'Betta Bites F3',
    category: Category.BETTA,
    status: ProductStatus.ACTIVE,
    badge: Badge.BESTSELLER,
    proteinPct: 42,
    shortDesc: 'Floating micro-pellet engineered for colour and finnage in bettas.',
    fullDescHtml:
      '<p>Betta Bites F3 is a 42% insect-protein floating micro-pellet built for the way bettas actually feed — at the surface, in small bursts.</p><h2>Why insect protein</h2><p>Astaxanthin from black soldier fly larvae deepens reds and blues within three weeks, and the chitin acts as a natural prebiotic.</p><ul><li>Floats for up to 10 minutes, so nothing is wasted</li><li>No soy, no wheat filler</li><li>Graded to 1.2 mm for a betta’s mouth</li></ul>',
    feedFreq: '2 times daily',
    feedPortion: '3–4 pellets per feed',
    feedNotesHtml:
      '<p>Feed only what the fish finishes in two minutes.</p><ul><li>Remove uneaten pellets after 5 minutes</li><li>Fast one day a week to aid digestion</li></ul>',
    nutrition: { fat: '12%', fibre: '3%', moisture: '8%', ash: '9%', astaxanthin: '50 ppm' },
    benefits: [
      '42% insect protein',
      'Colour-deepening astaxanthin',
      'Floating micro-pellet',
      'No fillers or soy',
    ],
    seoTitle: 'Betta Bites F3 — 42% Insect Protein Betta Food',
    seoDesc: 'Colour you can see in three weeks. 42% protein floating micro-pellet.',
    variants: [
      { sku: 'F3-45G', pack: '45 g', mrp: 299, price: 249, stock: 96, weightGrams: 45 },
      { sku: 'F3-1KG', pack: '1 kg', mrp: 2100, price: 1890, stock: 46, weightGrams: 1000 },
    ],
  },
  {
    slug: 'cichlid-colour-pellets-c7',
    name: 'Cichlid Colour Pellets C7',
    category: Category.CICHLID,
    status: ProductStatus.ACTIVE,
    badge: Badge.NEW,
    proteinPct: 38,
    shortDesc: 'Astaxanthin-rich sinking pellet for African and American cichlids.',
    fullDescHtml:
      '<p>A sinking colour pellet formulated for mid-water and bottom-feeding cichlids. 38% protein with a carotenoid blend that intensifies natural pigment.</p>',
    nutrition: {},
    benefits: ['38% insect protein', 'Sinking pellet', 'Astaxanthin-rich'],
    seoTitle: 'Cichlid Colour Pellets C7',
    seoDesc: 'New sinking colour pellet, astaxanthin-rich, 38% protein.',
    variants: [{ sku: 'C7-100G', pack: '100 g', mrp: 449, price: 399, stock: 7, weightGrams: 100 }],
  },
  {
    slug: 'hatchery-fry-starter-h1',
    name: 'Hatchery Fry Starter H1',
    category: Category.HATCHERY,
    status: ProductStatus.ACTIVE,
    badge: Badge.PRO,
    proteinPct: 55,
    shortDesc: '200-micron grade first food for the critical first 14 days.',
    fullDescHtml:
      '<p>A 55% protein powdered starter graded to 200 microns — small enough for newly free-swimming fry. Built for hatcheries running high-density grow-out.</p>',
    nutrition: {},
    benefits: ['55% insect protein', '200-micron grade', 'Built for the first 14 days'],
    seoTitle: 'Hatchery Fry Starter H1 — 55% Protein Fry Food',
    seoDesc: 'Built for the first 14 days. 55% protein, 200-micron grade.',
    variants: [
      { sku: 'H1-50G', pack: '50 g', mrp: 520, price: 475, stock: 0, weightGrams: 50 },
      { sku: 'H1-250G', pack: '250 g', mrp: 1990, price: 1790, stock: 0, weightGrams: 250 },
    ],
  },
  {
    slug: 'guppy-micro-flakes-g2',
    name: 'Guppy Micro Flakes G2',
    category: Category.GUPPY,
    status: ProductStatus.ACTIVE,
    badge: null,
    proteinPct: 36,
    shortDesc: 'Fine flake sized for guppies, endlers, and small livebearers.',
    fullDescHtml:
      '<p>A 36% protein micro-flake that stays intact in the water column and breaks down cleanly. Fine enough for guppy fry, palatable enough for adults.</p>',
    nutrition: {},
    benefits: ['36% insect protein', 'Fine flake', 'Low water clouding'],
    seoTitle: 'Guppy Micro Flakes G2',
    seoDesc: 'Fine flake for guppies and small livebearers.',
    variants: [{ sku: 'G2-30G', pack: '30 g', mrp: 199, price: 179, stock: 64, weightGrams: 30 }],
  },
  {
    slug: 'betta-bloodworm-treat-f5',
    name: 'Betta Bloodworm Treat F5',
    category: Category.BETTA,
    status: ProductStatus.DRAFT,
    badge: null,
    proteinPct: 48,
    shortDesc: 'Freeze-dried insect treat for conditioning and variety.',
    fullDescHtml:
      '<p>A high-protein freeze-dried treat for conditioning bettas before spawning or as an occasional variety feed.</p>',
    nutrition: {},
    benefits: ['48% insect protein', 'Freeze-dried', 'Conditioning feed'],
    seoTitle: 'Betta Bloodworm Treat F5',
    seoDesc: 'Freeze-dried insect treat for conditioning.',
    variants: [{ sku: 'F5-20G', pack: '20 g', mrp: 340, price: 310, stock: 30, weightGrams: 20 }],
  },
  {
    slug: 'cichlid-growth-sinking-c4',
    name: 'Cichlid Growth Sinking C4',
    category: Category.CICHLID,
    status: ProductStatus.ACTIVE,
    badge: null,
    proteinPct: 40,
    shortDesc: 'Growth-focused sinking pellet for juvenile and adult cichlids.',
    fullDescHtml:
      '<p>A 40% protein sinking pellet built for lean growth and muscle development in growing cichlids.</p>',
    nutrition: {},
    benefits: ['40% insect protein', 'Sinking pellet', 'Growth formula'],
    seoTitle: 'Cichlid Growth Sinking C4',
    seoDesc: 'Growth-focused sinking pellet for cichlids.',
    variants: [
      { sku: 'C4-250G', pack: '250 g', mrp: 690, price: 625, stock: 52, weightGrams: 250 },
      { sku: 'C4-1KG', pack: '1 kg', mrp: 2290, price: 2050, stock: 36, weightGrams: 1000 },
    ],
  },
  {
    slug: 'hatchery-infusoria-boost-h3',
    name: 'Hatchery Infusoria Boost H3',
    category: Category.HATCHERY,
    status: ProductStatus.COMING_SOON,
    badge: null,
    proteinPct: 0,
    shortDesc: 'Liquid infusoria culture booster for the very smallest fry.',
    fullDescHtml: '<p>A liquid culture booster for raising infusoria to feed the smallest fry.</p>',
    nutrition: {},
    benefits: ['Liquid culture', 'For smallest fry'],
    seoTitle: 'Hatchery Infusoria Boost H3',
    seoDesc: 'Liquid infusoria culture booster.',
    variants: [
      { sku: 'H3-100ML', pack: '100 ml', mrp: 399, price: 399, stock: 0, weightGrams: 120 },
    ],
  },
  {
    slug: 'guppy-colour-enhancer-g6',
    name: 'Guppy Colour Enhancer G6',
    category: Category.GUPPY,
    status: ProductStatus.DISCONTINUED,
    badge: null,
    proteinPct: 34,
    shortDesc: 'Carotenoid-boosted flake for show guppies.',
    fullDescHtml: '<p>A colour-enhancing flake with a carotenoid blend for show-grade guppies.</p>',
    nutrition: {},
    benefits: ['34% insect protein', 'Carotenoid blend'],
    seoTitle: 'Guppy Colour Enhancer G6',
    seoDesc: 'Carotenoid-boosted flake for show guppies.',
    variants: [{ sku: 'G6-45G', pack: '45 g', mrp: 289, price: 259, stock: 12, weightGrams: 45 }],
  },
] as const;

// ============================================================================
// COUPONS (§10) — from seed.js COUPONS
// ============================================================================
const COUPONS = [
  {
    code: 'MONSOON10',
    discountType: DiscountType.PERCENTAGE,
    discountValue: 10,
    minOrder: 999,
    startsAt: '2026-07-01',
    endsAt: '2026-07-31',
    usedCount: 184,
    totalUsageLimit: 500,
    perCustomerLimit: 1,
    isActive: true,
  },
  {
    code: 'FIRSTTANK',
    discountType: DiscountType.FLAT,
    discountValue: 100,
    minOrder: 499,
    startsAt: '2026-04-01',
    endsAt: '2027-03-31',
    usedCount: 612,
    totalUsageLimit: null,
    perCustomerLimit: 1,
    isActive: true,
  },
  {
    code: 'BULK15',
    discountType: DiscountType.PERCENTAGE,
    discountValue: 15,
    minOrder: 5000,
    startsAt: '2026-07-15',
    endsAt: '2026-08-15',
    usedCount: 23,
    totalUsageLimit: 200,
    perCustomerLimit: 3,
    isActive: true,
  },
  {
    code: 'PREVIEW25',
    discountType: DiscountType.PERCENTAGE,
    discountValue: 25,
    minOrder: 1500,
    startsAt: '2026-08-01',
    endsAt: '2026-08-07',
    usedCount: 0,
    totalUsageLimit: 50,
    perCustomerLimit: 1,
    isActive: false,
  },
] as const;

// ============================================================================
// ARTICLES (§8.1) — from seed.js ARTICLES
// ============================================================================
const ARTICLES = [
  {
    slug: 'feeding-fry-first-14-days',
    title: 'Feeding fry in the first 14 days',
    tag: 'Hatchery',
    readMinutes: 6,
    status: ContentStatus.PUBLISHED,
    authorName: 'Priya Shah',
    excerpt:
      'The first two weeks decide the survival curve. Here is the feeding cadence we run in our own grow-out.',
    bodyHtml:
      '<h2>The first 14 days decide everything</h2><p>Fry mortality is front-loaded. Get the first two weeks right and the rest of grow-out is comparatively forgiving.</p>',
  },
  {
    slug: 'protein-percentage-buying-signal',
    title: 'Why protein percentage alone is a bad buying signal',
    tag: 'Science',
    readMinutes: 9,
    status: ContentStatus.PUBLISHED,
    authorName: 'Priya Shah',
    excerpt: 'A 55% protein feed your fish cannot digest is worse than a 40% feed it can.',
    bodyHtml:
      '<h2>Digestibility beats the headline number</h2><p>The number on the tub is crude protein. What matters is how much of it your fish actually absorbs.</p>',
  },
  {
    slug: 'betta-colour-what-works',
    title: 'Betta colour: what actually moves the needle',
    tag: 'Betta',
    readMinutes: 7,
    status: ContentStatus.DRAFT,
    authorName: 'Priya Shah',
    excerpt: 'Carotenoids, water quality, and genetics — in that order of controllability.',
    bodyHtml:
      '<h2>What you can control</h2><p>Genetics set the ceiling. Diet and water quality decide whether the fish reaches it.</p>',
  },
  {
    slug: 'low-tech-guppy-breeding',
    title: 'Setting up a low-tech guppy breeding tank',
    tag: 'Guppy',
    readMinutes: 11,
    status: ContentStatus.DRAFT,
    authorName: 'Devika Rao',
    excerpt: 'No CO2, no fancy lights — just a stable, well-fed colony.',
    bodyHtml:
      '<h2>Keep it simple</h2><p>Guppies breed readily. Your job is to keep the water stable and the fry fed.</p>',
  },
] as const;

// ============================================================================
// HOMEPAGE + SETTINGS (§8.3, §13) — from seed.js HOMEPAGE / SETTINGS
// ============================================================================
const ANNOUNCEMENT = {
  text: 'Free shipping on orders over ₹999 · Monsoon sale live',
  linkLabel: 'Shop now',
  linkUrl: '/products',
  bg: '#080C18',
  fg: '#44E5C2',
  active: true,
};

const HOMEPAGE_SECTIONS = {
  hero: {
    eyebrow: 'Insect-protein aquatic nutrition',
    title: 'Your fish is built to digest insects.',
    sub: 'Most fish food feeds it soy. Zewa is engineered for the way aquatic species actually digest.',
    cta: 'Shop the range',
  },
  science: {
    title: 'Lab-verified, not marketing-verified',
    sub: 'Every claim on this site traces back to a NABL-accredited lab report.',
  },
  why: {
    title: 'Why choose Zewa',
    sub: 'Higher digestibility, cleaner water, visible colour.',
  },
  knowledge: {
    title: 'Knowledge Hub',
    sub: 'Practical, science-backed guides for keepers and breeders.',
  },
  announcement: ANNOUNCEMENT,
};

const SETTINGS = {
  shipping: {
    // NOTE: CMS values. Storefront checkout hardcodes 499 / 49 — unresolved.
    freeThresholdPaise: paise(999),
    standardRatePaise: paise(60),
    deliveryText: '3–5 business days across India',
    pinBlacklist: ['744101', '682555', '796001'],
  },
  tax: { gstRatePct: 18, gstInclusive: true, gstin: '27AABCZ1234E1Z5' },
  announcement: ANNOUNCEMENT,
  maintenance: {
    on: false,
    message: "We'll be back shortly — performing scheduled maintenance.",
    endAt: null,
  },
};

// ============================================================================
// SEED
// ============================================================================
async function main() {
  console.log('▸ Seeding Zewa Feeds database…\n');

  // ---- CMS users --------------------------------------------------------
  const passwordHash = await bcrypt.hash(DEV_PASSWORD, 12);
  const encryptedSecret = encryptSecret(DEV_TOTP_SECRET);

  for (const u of CMS_USERS) {
    // Enrolled accounts need a REAL secret, not just a timestamp — without one
    // the 2FA step can never succeed and the account is unusable.
    const enrolled = Boolean(u.twofaMethod);

    const user = await prisma.cmsUser.upsert({
      where: { email: u.email },
      update: {
        name: u.name,
        role: u.role,
        ...(enrolled ? { twofaSecret: encryptedSecret, twofaEnrolledAt: new Date() } : {}),
      },
      create: {
        email: u.email,
        name: u.name,
        role: u.role,
        passwordHash,
        twofaMethod: u.twofaMethod,
        twofaSecret: enrolled ? encryptedSecret : null,
        // Devika has no method => forced enrolment, exercising that path (§14.3).
        twofaEnrolledAt: enrolled ? new Date() : null,
      },
    });

    if (enrolled) {
      // Replace rather than append, so re-seeding does not accumulate codes.
      await prisma.backupCode.deleteMany({ where: { userId: user.id } });
      await prisma.backupCode.createMany({
        data: DEV_BACKUP_CODES.map((c) => ({
          userId: user.id,
          codeHash: sha256(normaliseCode(c)),
        })),
      });
    }
  }

  const devCode = authenticator.generate(DEV_TOTP_SECRET);
  console.log(`  ✓ ${CMS_USERS.length} CMS users (password: ${DEV_PASSWORD})`);
  console.log(`    TOTP secret: ${DEV_TOTP_SECRET}`);
  console.log(`    current code: ${devCode}  (30s window)`);

  const admin = await prisma.cmsUser.findUniqueOrThrow({
    where: { email: 'nikhildevm@zewafeeds.com' },
  });

  // ---- Products + variants ----------------------------------------------
  let variantCount = 0;
  for (const p of PRODUCTS) {
    const family = await prisma.productFamily.upsert({
      where: { slug: p.slug },
      update: {
        name: p.name,
        category: p.category,
        status: p.status,
        badge: p.badge,
        proteinPct: p.proteinPct,
        shortDesc: p.shortDesc,
        fullDescHtml: p.fullDescHtml,
        benefits: [...p.benefits],
        nutrition: p.nutrition,
        seoTitle: p.seoTitle,
        seoDesc: p.seoDesc,
      },
      create: {
        slug: p.slug,
        name: p.name,
        category: p.category,
        status: p.status,
        badge: p.badge,
        proteinPct: p.proteinPct,
        shortDesc: p.shortDesc,
        fullDescHtml: p.fullDescHtml,
        benefits: [...p.benefits],
        nutrition: p.nutrition,
        feedFreq: 'feedFreq' in p ? p.feedFreq : null,
        feedPortion: 'feedPortion' in p ? p.feedPortion : null,
        feedNotesHtml: 'feedNotesHtml' in p ? p.feedNotesHtml : null,
        seoTitle: p.seoTitle,
        seoDesc: p.seoDesc,
        publishedAt: p.status === ProductStatus.ACTIVE ? new Date() : null,
        updatedById: admin.id,
      },
    });

    for (const [i, v] of p.variants.entries()) {
      await prisma.productVariant.upsert({
        where: { sku: v.sku },
        update: {
          pack: v.pack,
          mrpPaise: paise(v.mrp),
          pricePaise: paise(v.price),
          stock: v.stock,
          weightGrams: v.weightGrams,
          position: i,
        },
        create: {
          familyId: family.id,
          sku: v.sku,
          pack: v.pack,
          mrpPaise: paise(v.mrp),
          pricePaise: paise(v.price),
          stock: v.stock,
          weightGrams: v.weightGrams,
          position: i,
        },
      });
      variantCount++;
    }
  }
  console.log(`  ✓ ${PRODUCTS.length} product families, ${variantCount} variants`);

  // ---- Coupons ----------------------------------------------------------
  for (const c of COUPONS) {
    const data = {
      discountType: c.discountType,
      // FLAT is paise; PERCENTAGE is a whole percent.
      discountValue: c.discountType === DiscountType.FLAT ? paise(c.discountValue) : c.discountValue,
      minOrderPaise: paise(c.minOrder),
      startsAt: new Date(c.startsAt),
      endsAt: new Date(c.endsAt),
      totalUsageLimit: c.totalUsageLimit,
      perCustomerLimit: c.perCustomerLimit,
      usedCount: c.usedCount,
      isActive: c.isActive,
    };
    await prisma.coupon.upsert({
      where: { code: c.code },
      update: data,
      create: { code: c.code, ...data },
    });
  }
  console.log(`  ✓ ${COUPONS.length} coupons`);

  // ---- Articles ---------------------------------------------------------
  for (const a of ARTICLES) {
    const data = {
      title: a.title,
      tag: a.tag,
      readMinutes: a.readMinutes,
      excerpt: a.excerpt,
      bodyHtml: a.bodyHtml,
      status: a.status,
      authorName: a.authorName,
      publishedAt: a.status === ContentStatus.PUBLISHED ? new Date() : null,
    };
    await prisma.article.upsert({
      where: { slug: a.slug },
      update: data,
      create: { slug: a.slug, ...data, updatedById: admin.id },
    });
  }
  console.log(`  ✓ ${ARTICLES.length} articles`);

  // ---- Spotlights (§8.2) ------------------------------------------------
  const spotlightSpecs = [
    {
      slug: 'betta-bites-f3',
      tagline: 'Colour you can see in three weeks',
      subText: '42% protein, floating micro-pellet',
      badge: 'BESTSELLER',
      isActive: true,
    },
    {
      slug: 'hatchery-fry-starter-h1',
      tagline: 'Built for the first 14 days',
      subText: '55% protein, 200-micron grade',
      badge: 'PRO',
      isActive: true,
    },
    {
      slug: 'cichlid-colour-pellets-c7',
      tagline: 'New: sinking colour pellet',
      subText: 'Astaxanthin-rich, 38% protein',
      badge: 'NEW',
      isActive: false,
    },
  ];

  // Spotlights have no natural unique key, so replace the set wholesale.
  await prisma.spotlight.deleteMany();
  for (const [i, s] of spotlightSpecs.entries()) {
    const family = await prisma.productFamily.findUnique({ where: { slug: s.slug } });
    if (!family) continue;
    await prisma.spotlight.create({
      data: {
        familyId: family.id,
        tagline: s.tagline,
        subText: s.subText,
        badge: s.badge,
        position: i,
        isActive: s.isActive,
      },
    });
  }
  console.log(`  ✓ ${spotlightSpecs.length} spotlights`);

  // ---- Homepage: LIVE + DRAFT (§8.3) ------------------------------------
  for (const version of [ContentVersion.LIVE, ContentVersion.DRAFT]) {
    await prisma.homepageContent.upsert({
      where: { version },
      update: { sections: HOMEPAGE_SECTIONS },
      create: {
        version,
        sections: HOMEPAGE_SECTIONS,
        publishedAt: version === ContentVersion.LIVE ? new Date() : null,
        updatedById: admin.id,
      },
    });
  }
  console.log('  ✓ homepage (LIVE + DRAFT)');

  // ---- Settings (§13) ---------------------------------------------------
  for (const [key, value] of Object.entries(SETTINGS)) {
    await prisma.setting.upsert({
      where: { key },
      update: { value },
      create: { key, value, updatedById: admin.id },
    });
  }
  console.log(`  ✓ ${Object.keys(SETTINGS).length} settings groups`);

  // ---- Customers + orders (§6, §7) --------------------------------------
  // Orders exercise the lifecycle: one PENDING to accept, one PROCESSING to ship,
  // one DELIVERED and PAID so refunds are testable.
  const customerSpecs = [
    {
      email: 'meera.iyer@gmail.com',
      firstName: 'Meera',
      lastName: 'Iyer',
      phone: '9820411234',
      city: 'Mumbai',
      state: 'Maharashtra',
      pincode: '400050',
      line1: 'B-402 Sea Pearl, Carter Road, Bandra West',
    },
    {
      email: 'orders@aquatrends.in',
      firstName: 'Aqua Trends',
      lastName: 'Store',
      phone: '9930055210',
      city: 'Mumbai',
      state: 'Maharashtra',
      pincode: '400070',
      line1: 'Shop 14, Fish Market Complex, Kurla West',
    },
    {
      // Kerala — exercises the inter-state IGST path on invoices (§6.5).
      email: 'hello@coralcove.in',
      firstName: 'Coral Cove',
      lastName: 'Pets',
      phone: '8879044339',
      city: 'Thrissur',
      state: 'Kerala',
      pincode: '680001',
      line1: '21 Marine Drive, Thrissur',
    },
  ];

  const customers = [];
  for (const c of customerSpecs) {
    const row = await prisma.customer.upsert({
      where: { email: c.email },
      update: {},
      create: {
        email: c.email,
        firstName: c.firstName,
        lastName: c.lastName,
        phone: c.phone,
        addresses: {
          create: {
            name: `${c.firstName} ${c.lastName}`,
            phone: c.phone,
            line1: c.line1,
            city: c.city,
            state: c.state,
            pincode: c.pincode,
            isDefault: true,
          },
        },
      },
    });
    customers.push({ ...c, id: row.id });
  }
  console.log(`  ✓ ${customers.length} customers`);

  const variants = await prisma.productVariant.findMany({
    where: { sku: { in: ['F3-45G', 'F3-1KG', 'G2-30G', 'C4-1KG'] } },
    include: { family: { select: { name: true } } },
  });
  const variantBySku = new Map(variants.map((v) => [v.sku, v]));

  const GST_RATE = 18;

  const orderSpecs = [
    {
      orderNo: 'ZW-20260724-0041',
      customer: customers[0]!,
      status: OrderStatus.PENDING,
      paymentStatus: PaymentStatus.PAID,
      paymentMethod: PaymentMethod.RAZORPAY,
      razorpayPaymentId: 'pay_Qk8fT2mLxA91',
      lines: [
        { sku: 'F3-45G', qty: 2 },
        { sku: 'G2-30G', qty: 1 },
      ],
    },
    {
      orderNo: 'ZW-20260723-0039',
      customer: customers[1]!,
      status: OrderStatus.PROCESSING,
      paymentStatus: PaymentStatus.PAID,
      paymentMethod: PaymentMethod.RAZORPAY,
      razorpayPaymentId: 'pay_Qk7xM4pQzD73',
      invoiceNumber: 'ZEW/26-27/0318',
      lines: [{ sku: 'C4-1KG', qty: 3 }],
    },
    {
      orderNo: 'ZW-20260722-0036',
      customer: customers[2]!,
      status: OrderStatus.DELIVERED,
      paymentStatus: PaymentStatus.PAID,
      paymentMethod: PaymentMethod.RAZORPAY,
      razorpayPaymentId: 'pay_Qk6gJ3dNuG46',
      invoiceNumber: 'ZEW/26-27/0315',
      carrier: 'Blue Dart',
      trackingNumber: 'BD9930112277',
      lines: [
        { sku: 'F3-1KG', qty: 1 },
        { sku: 'G2-30G', qty: 2 },
      ],
    },
    {
      orderNo: 'ZW-20260721-0035',
      customer: customers[2]!,
      status: OrderStatus.PENDING,
      paymentStatus: PaymentStatus.UNPAID,
      paymentMethod: PaymentMethod.COD,
      lines: [{ sku: 'F3-45G', qty: 1 }],
    },
  ];

  for (const spec of orderSpecs) {
    const items = spec.lines.flatMap((line) => {
      const variant = variantBySku.get(line.sku);
      if (!variant) return [];
      return [
        {
          variantId: variant.id,
          productName: variant.family.name,
          sku: variant.sku,
          pack: variant.pack,
          unitPricePaise: variant.pricePaise,
          qty: line.qty,
          hsn: variant.hsn,
          taxRatePct: GST_RATE,
          lineTotalPaise: variant.pricePaise * line.qty,
        },
      ];
    });
    if (items.length === 0) continue;

    const subtotal = items.reduce((sum, i) => sum + i.lineTotalPaise, 0);
    // Settings default: free shipping above ₹999.
    const shipping = subtotal >= SETTINGS.shipping.freeThresholdPaise ? 0 : SETTINGS.shipping.standardRatePaise;
    const total = subtotal + shipping;
    // Prices are GST-inclusive, so tax is reverse-calculated out of the total.
    const tax = Math.round((total * GST_RATE) / (100 + GST_RATE));

    const c = spec.customer;
    await prisma.order.upsert({
      where: { orderNo: spec.orderNo },
      update: {},
      create: {
        orderNo: spec.orderNo,
        customerId: c.id,
        email: c.email,
        phone: c.phone,
        status: spec.status,
        paymentStatus: spec.paymentStatus,
        paymentMethod: spec.paymentMethod,
        razorpayPaymentId: spec.razorpayPaymentId ?? null,
        subtotalPaise: subtotal,
        shippingPaise: shipping,
        taxPaise: tax,
        totalPaise: total,
        shippingAddress: {
          name: `${c.firstName} ${c.lastName}`,
          line1: c.line1,
          city: c.city,
          state: c.state,
          pincode: c.pincode,
          phone: c.phone,
        },
        invoiceNumber: spec.invoiceNumber ?? null,
        carrier: spec.carrier ?? null,
        trackingNumber: spec.trackingNumber ?? null,
        acceptedAt: spec.status === OrderStatus.PENDING ? null : new Date(),
        shippedAt: spec.trackingNumber ? new Date() : null,
        deliveredAt: spec.status === OrderStatus.DELIVERED ? new Date() : null,
        items: { create: items },
      },
    });
  }
  console.log(`  ✓ ${orderSpecs.length} orders (PENDING / PROCESSING / DELIVERED)`);

  console.log('\n▸ Seed complete.\n');
  console.log('  Sign in to the CMS with:');
  console.log('    nikhildevm@zewafeeds.com  (Admin)');
  console.log('    it@zewafeeds.com          (Admin)');
  console.log('    aromals@zewafeeds.com     (Ops Manager)');
  console.log('    info@zewafeeds.com        (Ops Manager)');
  console.log('    vaishnavip@zewafeeds.com  (Content Editor)');
  console.log(`    password: ${DEV_PASSWORD}`);
  console.log(`\n  2FA: add secret ${DEV_TOTP_SECRET} to an authenticator app,`);
  console.log(`       or use a backup code: ${DEV_BACKUP_CODES.slice(0, 3).join(', ')}, …\n`);
}

main()
  .catch((err) => {
    console.error('\n✖ Seed failed:\n', err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
