# Zewa Feeds — Backend

One API serving both frontends:

| Surface | Prefix | Who |
|---|---|---|
| Storefront | `/api/v1/*` | Public, or a customer JWT. Published data only. |
| CMS | `/api/v1/admin/*` | Staff JWT + enrolled 2FA + RBAC. |
| Webhooks | `/api/v1/webhooks/*` | No CORS, no auth — verified by HMAC signature. |

Design doc: [`../BACKEND_DESIGN.md`](../BACKEND_DESIGN.md).
Spec: `../CMS/Zewa_Feeds_CMS_Specification_v2.docx` (§ references throughout the code).

---

## Stack

| Layer | Choice |
|---|---|
| Runtime | Node 20 LTS |
| Framework | Express 4 + TypeScript |
| Database | PostgreSQL 16 |
| ORM | Prisma |
| Cache / rate limit | Redis |
| Jobs | BullMQ |
| Auth | JWT + bcrypt (cost 12) + otplib TOTP |
| Storage | Cloudinary (signed uploads) |
| PDF | pdf-lib |
| Email | ZeptoMail |
| Payments | Razorpay |

---

## Running it

Needs **Node 20+** (this repo's default `node` is 16, which Next 14 also rejects)
and Docker for Postgres + Redis.

```bash
cd Backend
nvm use                 # reads .nvmrc → Node 20
npm install

cp .env.example .env    # then fill in the secrets — see below
npm run docker:up       # Postgres :5433, Redis :6380
npm run prisma:migrate  # apply migrations
npm run seed            # load the CMS seed data

npm run dev             # http://localhost:4000
```

### Generating secrets

The app validates every variable at boot and **refuses to start** if one is
missing or malformed — discovering a missing webhook secret during a live payment
is worse than failing to boot.

```bash
openssl rand -base64 48   # JWT_ACCESS_SECRET  (and again for REFRESH, PREVIEW)
openssl rand -hex 32      # TWOFA_ENCRYPTION_KEY (must be exactly 64 hex chars)
```

Use a **different** value for each JWT secret. In production the config also
rejects reused secrets, `http://` origins, and localhost origins.

Integration keys (Razorpay, Cloudinary, ZeptoMail, Sentry) are optional at boot so
Phases 0–2 run without third-party accounts; each integration asserts its own
config when first used.

### Seeded CMS accounts

| Email | Role |
|---|---|
| `aditi@zewafeeds.com` | Admin |
| `rahul@zewafeeds.com` | Ops Manager |
| `priya@zewafeeds.com` | Content Editor |
| `devika@zewafeeds.com` | Content Editor — no 2FA, exercises forced enrolment |

Password for all: `zewa1234` (local dev only).

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server, watch mode |
| `npm run build` | `tsc` + `tsc-alias` → `dist/` |
| `npm start` | Run the built output |
| `npm run typecheck` | Both tsconfig scopes (`src/` and `prisma/`) |
| `npm run lint` / `lint:fix` | ESLint |
| `npm run seed` | Seed the database (idempotent) |
| `npm run prisma:migrate` | Create + apply a migration |
| `npm run prisma:studio` | Browse the data |
| `npm run docker:up` / `down` | Start / stop Postgres + Redis |
| `npm run docker:nuke` | Stop **and delete all data** |

---

## Layout

```
Backend/
├── prisma/
│   ├── schema.prisma        all models (§4 of the design doc)
│   ├── migrations/
│   └── seed.ts              ported from CMS/lib/seed.js
├── docker/
│   └── docker-compose.yml   local Postgres + Redis
├── Dockerfile               multi-stage production image
└── src/
    ├── server.ts            entry: dependency checks + graceful shutdown
    ├── app.ts               Express assembly, middleware order
    ├── routes.ts            THE SECURITY BOUNDARY — see below
    ├── config/env.ts        Zod-validated env, fails fast
    ├── lib/                 prisma, redis, logger, errors
    ├── middleware/          security, rate limits, errors, requestId
    ├── rbac/permissions.ts  ported from CMS/lib/rbac.js — the authority
    ├── modules/             one folder per domain
    │   └── orders/lifecycle.ts   ported from CMS/lib/orderFlow.js
    ├── integrations/        razorpay, cloudinary, zeptomail, pdf
    └── jobs/                BullMQ queues + workers
```

### Path aliases

`@/*` maps to `src/*`. `tsc` does not rewrite these, so the build runs
`tsc-alias` afterwards to turn them into real relative paths — without that step
the compiled output cannot resolve its own imports.

---

## Two design decisions worth knowing

### 1. Admin routes are protected by where they live

In [`src/routes.ts`](src/routes.ts), auth guards mount on the **router**, not on
individual routes:

```ts
adminRouter.use('/auth', authRouter);              // the only public admin path
adminRouter.use(requireAuth, requireEnrolled2fa);  // everything below is staff-only
```

A new admin endpoint is therefore protected because of the router it belongs to,
not because someone remembered to add a guard. Forgetting fails **closed**.
Per-route `requirePermission('...')` then only ever narrows access further.

### 2. The audit log cannot be rewritten, even by us

§12 says the audit log is append-only and no one can edit it, including Admins.
Enforcing that in application code is a promise; the
`20260728143200_audit_log_append_only` migration makes it structural:

```sql
CREATE RULE audit_log_no_update AS ON UPDATE TO "AuditLog" DO INSTEAD NOTHING;
CREATE RULE audit_log_no_delete AS ON DELETE TO "AuditLog" DO INSTEAD NOTHING;
```

Postgres RULEs apply regardless of role — owner and superuser included — so a
bug, a stray ORM call, or a compromised app credential cannot alter history.
Verified: `INSERT` succeeds, `UPDATE`/`DELETE` affect 0 rows.

To legitimately prune old entries, drop the rule in a transaction, delete, and
recreate it. Deliberate and reviewable, rather than accidental.

---

## Conventions

- **Money is `Int` paise.** Never a float, never rupees. `249.00` is `24900`.
- **Orders snapshot everything.** `OrderItem` copies name, SKU, price, HSN, and
  tax rate at purchase time — the catalogue changes, invoices must not.
- **Errors carry a stable `code`.** Frontends branch on `error.code`
  (`OUT_OF_STOCK`, `COUPON_EXPIRED`, `INVALID_TRANSITION`), never on the message.
- **Rich text is sanitised server-side on write.** The client editor is never
  trusted; see the design doc §7.
- **`throw` freely.** Wrap async handlers in `asyncHandler` and the global error
  handler produces the envelope.
- **Use the logger, not `console`.** ESLint enforces it (scripts are exempt).

Response shapes:

```jsonc
// success
{ "data": { ... }, "meta": { "page": 1, "limit": 20, "total": 57 } }

// failure
{ "error": { "code": "VALIDATION_FAILED", "message": "…", "fields": { "slug": "…" } } }
```

---

## Health endpoints

| Route | Purpose |
|---|---|
| `/health` | **Liveness.** No dependency checks — a slow DB must not get the container killed. |
| `/health/ready` | **Readiness.** Checks Postgres + Redis. What Docker HEALTHCHECK and the load balancer poll. |
| `/health/info` | Diagnostics — env, Node version, row counts. |

---

## Production

```bash
docker build -t zewa-api .
docker run -p 4000:4000 --env-file .env.production zewa-api
```

The image is multi-stage (dev deps dropped), runs as non-root `node` (uid 1000),
uses `dumb-init` as PID 1 so SIGTERM reaches Node, and declares a `HEALTHCHECK`
against `/health/ready`.

On SIGTERM the server stops accepting connections, drains in-flight requests,
closes Postgres and Redis, then exits 0 — with a 15s backstop that force-exits if
something hangs. A deploy will not kill a request mid-transaction.

Migrations in production run via `npm run prisma:deploy` (never `migrate dev`).

---

## Build status

### Done

**Phase 0 — foundations.** Scaffold, schema (20 models), migrations, seed, Docker,
config validation, health checks, graceful shutdown, error envelope, rate limiting.

**Auth + RBAC + audit (§2, §12, §14).** Two-step login (password → challenge token
→ 2FA), TOTP + single-use backup codes, forced first-login enrolment,
refresh-token rotation, session list and revocation, password policy with
last-5-reuse checking, server-derived audit trail.

**CMS users (§11).** Full CRUD, invite-based password setup, status toggle, forced
password reset, soft delete, plus self-role-change / self-deactivate /
self-delete / last-Admin protections.

**Products (§5).** List with filters and SKU search, editor CRUD, draft overlay,
publish, discard, status changes, stock quick-update, preview tokens, Admin-only
delete with typed-name confirmation, field-level RBAC (Editors see the catalogue
without pricing).

**Orders (§6).** List with date/status/payment filters and search, detail page with
server-driven transition spec, one `/transition` endpoint enforcing the state
machine, cancellation with automatic restock, Admin-only refunds with
over-refund protection, GST invoice PDFs, Admin-only CSV export.

**Content (§8).** Articles with draft overlay and a create/publish permission split
(Editors author, Ops ship, Admin deletes); spotlights with reorder, toggle and a
3-active cap; homepage on a two-row LIVE/DRAFT model that publishes atomically.
Preview tokens for all three.

**Coupons (§10).** CRUD with derived status (Active / Inactive / Expired computed
from dates, so a coupon expires without a cron job), expired-coupons-cannot-be-
reactivated enforcement, and a public validation endpoint for checkout.

**Reviews (§9).** Pending/Approved/Rejected queue with tab counts, single
moderation, bulk approve, and server-computed `isVerifiedPurchase` from delivered
order history.

**Customers (§7).** List and profile with aggregated lifetime totals (PAID orders
only), order history, addresses, reviews, Admin-only ban/unban.

**Dashboard (§4), search (§3.1), audit log (§12).** Three counters plus a real
activity feed derived from the audit log and recent orders; cross-entity search;
audit listing with row-level scoping.

**Uploads.** Cloudinary signed-upload signatures — image bytes never pass through
this API.

**Settings (§13).** Four groups (shipping, tax, announcement, maintenance),
Redis-cached with 60s TTL, schema-validated per group with defaults.

**78 endpoints across 16 modules.** Typecheck, lint and build clean, 0 npm
vulnerabilities. Every CMS store action from `CMS/lib/store.js` now has a
backing endpoint.

### Verified by test, not assumption

| Attack / behaviour | Result |
|---|---|
| Ops self-promotes to Admin | 403 |
| Editor or Ops reads user list | 403 |
| Admin demotes / deactivates / deletes self | 403 each |
| Mass assignment (`role`, `tokenVersion`, `passwordHash` in a name update) | silently stripped |
| Challenge token replayed as access token | rejected (`typ` mismatch) |
| Backup code reused | rejected (single-use) |
| Unenrolled user skips 2FA | 403 |
| Valid token after deactivation | killed instantly, not at expiry |
| Wrong password vs unknown email | identical message and timing |
| `<script>`, `<iframe>`, `javascript:` href in rich text | stripped; legit links keep href + gain `rel=noopener` |
| Editor reads a product | pricing fields absent from the response |
| Editing a live product | live rows untouched (checked in the DB); overlay applied only on publish |
| Slug change after publish | `SLUG_IMMUTABLE` |
| price > MRP, duplicate SKU, cross-product SKU, >200-char shortDesc, >8 benefits, bad HSN | each rejected with a field-keyed message |
| Skipping a lifecycle state (Pending → Shipped) | `INVALID_TRANSITION` |
| Accepting an order with no invoice number | `MISSING_TRANSITION_FIELD` |
| Shipping with carrier but no tracking number | `MISSING_TRANSITION_FIELD` |
| Moving a Cancelled order | `INVALID_TRANSITION` (terminal) |
| Cancelling a pending order | stock incremented 96 → 97, verified in the DB |
| Ops attempts a refund | 403 (`orders.refund` is Admin-only) |
| Refund with no reason | rejected |
| Refunding more than remains after a partial | `REFUND_NOT_ALLOWED` with the exact cap |
| Invoice download before a number is entered | `INVOICE_REQUIRED` |
| Ops attempts CSV export | 403 (`orders.export` is Admin-only) |
| CSV cell beginning `=` `+` `-` `@` | prefixed, so it cannot execute in Excel |
| Ops or Editor reads settings | 403 |
| Editor publishes an article | 403 (`articles.publish` is Ops+) — but creating works |
| Editor **or Ops** deletes an article | 403 each (`articles.delete` is Admin-only) |
| Editing the live homepage | LIVE row unchanged in the DB; publish moves all sections at once |
| Non-hex announcement colour (`red;background-image:url(...)`) | rejected — those values land in a `style` attribute |
| Partial spotlight reorder list | rejected; the operation takes the full list so it stays idempotent |
| 4th active spotlight | `CONFLICT` — §8.2 supports up to 3 |
| **Ops passes another user's `actorId` to the audit log** | **param ignored — all 23 returned rows carried their own id, verified against the DB** |
| Editor reads the audit log | 403 (holds neither `audit.own` nor `audit.all`) |
| Ops reads the audit actor list | 403 (`audit.all` is Admin-only) |
| Ops bans a customer | 403 (`customers.ban` is Admin-only) |
| Editor reads customers or reviews | 403 each |
| Editor's dashboard | order and review counters return 0 rather than leaking volume |
| Editor's global search | orders and customers sections empty — PII gated |
| Upload folder `../../etc` | rejected by the folder allowlist |
| Reactivating an expired coupon | `CONFLICT` — §10.2 requires a new coupon |
| Percentage discount > 100 | rejected |
| Coupon end date before start date | rejected |
| **Production-mode error responses** | **only `code` + `message`; no stack, no internals** |

Also confirmed: the audit log records every login attempt including failures with
actor, role and IP; stock updates log before→after per SKU in §12.1's format; the
§12 append-only rules hold on Neon; and invoice PDFs were rendered and read
visually — Kerala shows a single **IGST @ 18%** line, Maharashtra splits into
**CGST @ 9% + SGST @ 9%**, and both reconcile to the charged total to the paise.

### Remaining

The CMS surface is complete. What is left is **storefront-facing** and the
**integrations that move money and send mail**:

| Work | Why it matters |
|---|---|
| Public catalogue, content and settings endpoints | the storefront still reads hardcoded data |
| Cart validate + checkout + stock transaction | real orders |
| Razorpay: order creation, signature verification, webhook, refund API | payments |
| ZeptoMail + BullMQ worker | the queued `OrderEmail` rows currently never send |
| Preview routes on the storefront | the token endpoints exist; the pages do not |
| Customer accounts, addresses, public review submission | storefront login |

### Known gaps in what is built

- **Refunds record but do not move money.** The `Refund` row, payment-status
  change and audit entry are correct; the Razorpay API call is Phase 3, so refunds
  must currently be issued manually in the Razorpay dashboard. The service logs a
  warning saying so.
- **Emails queue but do not send.** Transitions write an `OrderEmail` row with
  status `QUEUED`; the BullMQ worker and ZeptoMail integration are Phase 3.
- **Invoice amounts print as `Rs.`** rather than `₹`. pdf-lib's standard fonts are
  WinAnsi-encoded and cannot render U+20B9; embedding a Unicode font for one glyph
  was not worth ~200 KB. Unambiguous on a tax invoice.

### Unresolved before production data

Three content decisions, flagged rather than guessed (design doc §10):

1. **Catalogue conflict** — the CMS seed and the storefront disagree on product
   names, protein percentages, and pack prices (CMS "Cichlid Colour Pellets C7"
   at 38% vs storefront "Cichlid Bites C4" at 46%; F3 1kg ₹1890 vs ₹1785).
   `prisma/seed.ts` currently uses the CMS values.
2. **Shipping** — ₹999 free threshold / ₹60 flat (CMS settings) vs ₹499 / ₹49
   (storefront checkout). Seeded with the CMS numbers; both apps should read
   `GET /settings/public`.
3. **Razorpay or COD first** — the spec assumes Razorpay; the storefront checkout
   is COD-only. The schema supports both.
