# Z-Coin Loyalty — implementation notes

Implements **ZSOP004 v3.3**. The specification is the source of truth for
business rules; this file records how those rules map onto the Zewa codebase,
every deviation, and every assumption made where the specification was silent.

## Architecture

| Layer | File | Responsibility |
|---|---|---|
| Arithmetic | `coin-math.ts` | Pure, no DB, no clock. Earn base, allocation, restore/clawback maths. |
| Ledger | `ledger.service.ts` | **The only writer of coin balances.** Locking, idempotency, the −50 floor. |
| Accounts | `account.service.ts` | Account creation, lot grants, FIFO consumption planning. |
| Rules | `rules.service.ts` | Versioned config, rollout/holdout bucketing. |
| Earning | `earn.service.ts` | §3 gates, pending grants. Fails **open**. |
| Lifecycle | `lifecycle.service.ts` | Unlock, void, expiry, stuck-shipment failsafe. |
| Redemption | `redemption.service.ts` | Reservations, FIFO spend, confirmation. Fails **closed**. |
| Reversal | `reversal.service.ts` | §7.3 algorithm — cancel, return, RTO, clawback, grace lots. |
| Reconcile | `reconcile.service.ts` | Nightly repair to the ledger, event-inbox replay. |
| Notify | `notify.service.ts` | §10.4 mail, claimed before sending so events cannot double-send. |
| Fraud | `fraud.service.ts` | §12.1 RTO prepaid-only, risk assessment, monitoring. |
| Earn cap | `earn-cap.service.ts` | §3.3 monthly cap, per-customer overrides, staff exclusion. |

**The invariant that governs everything** (§7.1): after any modification, the
customer's coin position must equal what it would have been had the order been
placed in its final form. Asserted directly in `reversal.test.ts`.

## Deviations from ZSOP004 v3.3

### 1. GST is 0%, not the specification's illustrative 5%

ZSOP004's worked examples use 5% GST on a tax-exclusive catalogue. Zewa's actual
catalogue rate is **0%**, confirmed by the product owner. At 0%:

- pre-tax value == displayed product value
- 1 coin == ₹1 off, with no gross-down
- the §3.2 gross-down rule (`coins ÷ (1 + rate)`) is a no-op, not a deviation

Every §6 worked example therefore reproduces with the specification's own
figures (24, 23, 30, 14 coins for §6.1–6.4).

**Kept flexible deliberately.** §7.4 requires historical GST-rate snapshots, so
`taxRatePct` is threaded through every function and snapshotted onto each order
line. `preTaxValuePaise()` delegates to the existing `computeLineTax()` rather
than reimplementing GST, so there is exactly one tax implementation and the earn
base can never drift from the invoice. Two tests pin the rated path at 5% and
18% so the capability cannot rot before it is needed. **Production tax behaviour
is untouched.**

### 2. The ledger's append-only guard RAISES; the audit log's discards silently

The existing `AuditLog` uses `DO INSTEAD NOTHING`, which silently discards
UPDATE/DELETE. That is correct for an audit log — a stray ORM write should not
take the API down.

It is wrong for a financial record. §9.2 requires a bad write to "fail loudly
rather than quietly creating value", so `CoinLedger` uses a `BEFORE UPDATE OR
DELETE` trigger that raises `restrict_violation`. A RULE cannot raise, only
rewrite, which is why this is a trigger.

### 3. `CoinLedger` reference columns carry no foreign keys

`lotId`, `orderId`, `actorId`, `approvedById` are plain ids.

They were briefly `onDelete: SetNull`. SetNull is implemented as an UPDATE on the
referencing row, so deleting an order made Postgres try to rewrite its ledger
entries and the append-only trigger correctly refused — **making any order with
coin history undeletable**. Caught by the existing coupon/promotion suites.

A financial record must outlive what it refers to: §9.2 retains the ledger for 8
years "even after PII is anonymised on account deletion". Resolution is a lookup,
not a join. `accountId` keeps its cascade — an entry belonging to no account is
an orphan, not history.

### 4. `LOCKED` is a reservation state, not a lot state

§5 lists LOCKED as a coin state. Modelled as a row in `CoinReservation` rather
than a state on `CoinLot`, because one lot can back several concurrent carts and
a per-lot flag cannot express that. The customer-visible semantics are identical;
`lockedCoins` on the account is the sum of live holds.

### 5. Split shipments

§8.2 #16 requires unlock to be driven by the last delivered line. This codebase
marks delivery at **order** level, so `deliveredAt` already is the
last-delivered moment. No extra handling needed; documented rather than assumed.

### 6. Identity verification uses email, not SMS OTP

Zewa has no SMS provider and none is being built.

**Guest claiming (§3.4)** is gated on the customer's **verified email**, matched
against the email the guest order was placed with. §3.4's control is "prove you
are the person who placed that order", and since guest orders in this codebase
are keyed by `Order.email` — not by phone — a verified email is the identifier
that actually links the order to a person. Same strength, existing
infrastructure. Claiming fires automatically the moment the email is verified.

**Three requirements that name OTP are BLOCKED, not approximated:**

| Requirement | Why email cannot substitute |
|---|---|
| §12.1 large-redemption re-verification above 500 coins | Guards against account takeover; the attacker already controls the session and mailbox |
| §13.3 backfill release | Migrated records have no verified email either; the gate exists so records cannot be claimed by whoever guesses an address |
| §8.4 #29 migrated customer with no verified phone | Same |

`Customer.phoneVerifiedAt` is retained as the switch those gates turn on once an
SMS provider exists, avoiding a later migration against live balances. The
`CustomerPhoneOtp` table was dropped — an empty table modelling a flow that
cannot run implies a control that does not exist.

### 7. Reservations subtract live holds when computing spendable coins

Found by `concurrency.test.ts`, not by inspection. A lot's `coinsRemaining` is
only decremented when a redemption is **confirmed** at payment, so between apply
and payment the lot still reads full. The first implementation planned against
raw lot remainders, and two tabs were each told the whole balance was available —
**both holds succeeded, 200 coins held against a 100-coin balance.**

`reserve()` now computes spendable as `lot remainders − live PENDING holds`, and
plans per-lot capacity net of other carts' holds. The account row is locked
`FOR UPDATE` for the whole read-compute-write cycle, so a concurrent tab blocks
until the first commits and then sees the hold.

Related: `cartKey` is cleared on every release path (release, expire, confirm),
so the `(accountId, cartKey)` unique index constrains only **live** holds. Without
that, a customer who removed coins and re-applied them collided with their own
released row.

### 8. An unrecognised SKU on a coin route is a 400, not a skipped line

Found by the end-to-end run, not by unit tests.

`/coins/quote` and `/coins/apply` both resolved cart SKUs and silently skipped
any they could not find. The result was two endpoints disagreeing about the same
cart: `quote` reported the customer's full balance as `available` while computing
a ceiling of **zero** from an empty line set, so the box rendered and then
`apply` refused with `NOTHING_REDEEMABLE`.

Both now share one `resolveCoinLines()` helper that raises a 400 naming the
missing SKUs. Two endpoints disagreeing is far harder to diagnose than one clear
error. SKUs are uppercased on lookup, matching `pricing.service`.

### 9. Test fixtures must opt out of the holdout

Not a production deviation — a testing note that cost real time to find.

`ensureAccount` assigns the §13.5 holdout deterministically from a hash of the
customer id, so **~5% of randomly generated customer UUIDs land in the control
group and correctly earn nothing**. A loyalty suite creating ~40 fixtures gets
about two holdout accounts per run, at random, and whichever test owns one fails.

The symptom is distinctive and misleading: a single failure that **moves to a
different test on every run**, which reads like a concurrency bug and is not.
Every loyalty fixture therefore sets `holdout: false` explicitly. Holdout
behaviour itself is covered on purpose in `concurrency.test.ts`.

### 10. Notification sends are claimed before they are sent

Coin mail is driven by order and payment events, and §9.1 says to assume every
event arrives at least twice. Mail cannot be un-sent, so each message is claimed
first by inserting a zero-delta ledger row whose `idempotencyKey` is unique. The
second delivery loses the insert and sends nothing.

Only a `P2002` unique violation counts as "already sent" — any other error is
logged loudly and the message is skipped, so a broken pipeline cannot masquerade
as a well-behaved duplicate.

### 11. The expiry reminder window is a calendar day

§4.3 allows exactly ONE reminder, 7 days out, which makes a missed one
unrecoverable. Anchoring the window to the instant the job runs meant a lot
expiring seven days out to the millisecond could fall on either side of the
boundary depending on scheduler jitter. The window is normalised to midnight, so
it means "lots expiring on the day that is 7 days from today" — stable under any
run time, and what the copy actually promises.

### 12. ONE "coins earned" email, not an earn + unlock pair

**Product decision, overriding §10.4.** The specification lists a "coins
unlocked" notification ("30 Zewa Coins are ready to use") separate from the
order-confirmation earning message. Zewa sends **one** customer-facing email
instead, at delivery confirmation.

The reasoning: two emails about one grant read as two rewards, and a customer
told twice about the same coins reasonably expects twice the coins. So the
single message carries the whole story — coins earned on this order, the balance
spendable *today*, and when the new coins join it.

Two details this forces:

- `availableCoins` in the email **excludes** the coins just earned. They are
  still `PENDING`, so the account's `availableCoins` is already "what you can
  spend now"; summing the two would promise money the customer cannot spend.
- The unlock window is **computed, never hardcoded**. It is derived from the
  lot's `maturesAt`, which `onDelivered` sets from the order's frozen rule
  version — so an order above the §3.5 large-order threshold says 21 days where
  an ordinary one says 7, without the mailer knowing either number.

`notifyUnlocked` was removed outright rather than left dormant; a test asserts it
no longer exists, so the second email cannot be reintroduced by accident.

### 13. Coin copy uses "Zewa Coins balance", never "wallet"

§10.3 forbids "wallet" because it implies stored value the customer owns and
could withdraw — a distinction §12.2 flags as legally load-bearing for the RBI
prepaid-instrument boundary, whose analysis rests on coins *not* reading as a
wallet.

The earning email briefly said "Coin wallet balance" and was corrected to
"Zewa Coins balance". No customer-facing coin copy uses the word anywhere; the
only remaining occurrences in the tree are comments recording the prohibition
itself, and unrelated payment-method copy about UPI/card wallets.

### 14. Per-coupon coin block (§4) — added by the final audit

§4: "Coupon stacking: allowed — coupon first, coins second. **With a per-coupon
block flag for aggressive promotions.**" The flag was missing; the rest of the
stacking rule (coupon first, coins second) was already correct.

`Coupon.blocksCoins` defaults false, so the programme's normal behaviour is what
every existing and new coupon gets. Deliberately NOT a new `CouponStacking`
value: that enum governs which COUPONS may ride together, a different question
from whether COINS may be spent alongside one of them — a 50%-off promotion can
be freely stackable and still be too thin to absorb a coin discount on top.

Enforced at both `quote` (the box is hidden) and `reserve` (the hold is refused),
because an input the customer can fill in but never submit is worse than no
input. Checked before any lot is walked — the answer does not depend on the
balance, and refusing after planning would leave a hold to unwind.

### Requirements deliberately NOT implemented

Recorded so a later reader does not mistake absence for oversight:

- **Staff/internal account exclusion (§3.3).** This codebase has no staff or
  test-account marker on `Customer`. Adding one would invent a concept the
  application does not have; `LoyaltyAccount.earnEnabled` and `holdout` already
  give ops a per-account off switch.
- **Gift card and free-replacement exclusions (§3.3).** Neither order type
  exists — there are no gift cards and no replacement-order flow. An exclusion
  for something that cannot be ordered is untestable.
- **Monthly earn cap (§3.3).** Named in the eligibility list but given no value
  anywhere in the specification. Implementing it would mean inventing the
  number, which §15.1 reserves for the founder.

### 15. Monthly earning cap and per-customer overrides (§3.3)

§3.3 gates earning on "monthly earn cap not exceeded" but names no figure. The
default is **1,000 coins per calendar month**, stored on `LoyaltyRuleVersion`
(`monthlyEarnCapCoins`) so the CMS can change it without a deployment and so
historical orders keep the cap they earned under (§8.4 #35). Zero disables it.

`CustomerEarnCapOverride` raises or lowers it per customer. Deliberately generic
— a cap, a mandatory reason, an optional expiry — rather than a "wholesale"
flag: the exception needing a higher cap today is a wholesale buyer, the next
will be something else. Overrides are revoked, never deleted; the history of
what a customer was allowed is the audit trail.

Two behaviours worth stating:

- **The cap TRUNCATES, it does not refuse.** A customer 10 coins below their cap
  earns those 10. Refusing the whole grant would make the cap a cliff that
  punishes whichever order happens to cross it.
- **It counts `EARN` rows only, not net of clawbacks.** Letting a clawback refund
  headroom would let a customer earn, return, and earn again against the same cap
  indefinitely.

The cap governs **issuance only** — it never touches the redemption engine and
never alters coins already earned.

### 16. Internal/staff accounts do not earn (§3.3)

There is no staff flag on `Customer`, so the classification is the existing
`CmsUser` table, matched on email. A CMS operator placing an order is exactly who
§3.3 means by "internal / test / staff accounts".

Deliberately **not** an email-domain check: a `@zewafeeds.com` address is neither
necessary nor sufficient — staff use personal addresses, and a founder's relative
on the company domain is not staff. `DEACTIVATED` operators earn again, because
someone who has left is an ordinary customer.

This gates **automatic earning only**. Admins can still gift, remove and adjust
coins for any account, including staff, through the ledger.

### 17. Pre-existing: a CmsUser with audit history cannot be deleted

Found while writing the earn-cap tests; **outside Z-Coin and not changed here.**

`AuditLog.actorId` is `onDelete: SetNull`, so deleting a `CmsUser` makes Postgres
issue an UPDATE against `AuditLog` — which the `audit_log_no_update` RULE
rewrites to nothing, and the FK integrity check then fails with
`XX000 … gave unexpected result`.

This is the same class of defect fixed for `CoinLedger` (deviation 3), still
present on the audit log because that table predates Z-Coin. It affects the live
re-invitation path in `users.service.ts` (deleting a soft-deleted operator before
re-inviting them). Disabling **both** rules is required to delete — disabling
only `audit_log_no_delete` changes nothing, which is a genuinely confusing
failure mode.

Worth fixing in the audit-log module; deliberately left alone here so this pass
does not change unrelated behaviour.

## Assumptions (specification silent)

1. **Reservation cart key.** §4.3 requires account-anchored reservations but does
   not name the key. Uses a caller-supplied `cartKey`, unique per account, so
   re-applying a different amount replaces rather than stacks.
2. **Reconciliation scope.** §9.2 says "every balance" nightly. Scoped to
   accounts touched in the last 36 hours — a dormant account cannot drift, and a
   full scan grows linearly with the customer base for no benefit.
3. **Inbox retry cap.** §9 does not specify one. Capped at 5 attempts so a
   permanently bad event surfaces as an exception rather than retrying forever.
4. **Rule-version cache TTL.** 60 seconds, chosen to match §9.3's requirement
   that a kill switch take effect within 60 seconds without a deployment.

## Running the end-to-end script

`scripts/zcoin-e2e.ts` drives the real Express app over HTTP — earn, unlock,
history, quote, hold, two-tab double-spend, release, auth. Everything else in the
suite calls services directly; this proves the routes are mounted and the whole
cycle holds together.

    # Terminal 1 — API against the LOCAL containers, not the hosted services.
    DATABASE_URL=<.env.test value> REDIS_URL=<.env.test value> PORT=4001 npx tsx src/server.ts

    # Terminal 2
    DATABASE_URL=<.env.test value> npx tsx scripts/zcoin-e2e.ts

Both overrides matter. Booting with `.env` points the API at the hosted Render
Redis, which is unreachable locally, and every rate-limited route then hangs for
~26s instead of failing — the symptom looks like an application deadlock.

Two caveats the script documents inline: the customer is seeded directly because
`POST /register` sends a verification email and no provider is configured
locally; and the script flips `redemptionEnabled` on the shared active rule
version, so **do not run it concurrently with `vitest`** — the concurrency suite
reads the same flag and will fail spuriously.

## Open blockers

- **Annex ZSOP004-A is missing.** Referenced for the full 72-case matrix, SQL
  DDL, API contracts and copy deck. Built against the ~37 cases in §8; the rest
  are not invented.
- **No SMS provider.** §12.1 large-redemption re-verification, §13.3 backfill
  release and §8.4 #29 cannot ship. Guest claiming works via verified email
  (deviation 6). These three gates need an SMS provider decision.

  The large-redemption control is **structured but not enforced**:
  `fraud.assessRedemptionRisk()` still computes `requiresStepUp`, and
  `riskReport()` counts `largeRedemptionsUnverified` so the exposure is a number
  someone can look at. Redemption is deliberately NOT refused — §4 permits up to
  100% of product value and nothing in ZSOP004 says to refuse when verification
  is unavailable, so refusing would invent a rule. When SMS exists, the only
  change needed is a consumer for `requiresStepUp`; the redemption engine is
  untouched.
- **Launch backfill (§13.3) not built.** Depends on the OTP gate above and on a
  clean Dukaan export (§13.4), neither of which exists yet.
- **Sign-off.** §15.4 has four empty signature rows; several §15.1 decisions are
  marked *Critical* and hard to reverse once customers hold balances.

## Surfaces built

| Surface | Path |
|---|---|
| Customer API | `/api/v1/account/coins` — balance, history, quote, apply, release, claimable, claim |
| Admin API | `/api/v1/admin/loyalty` — customers, detail, adjust, freeze, liability, export, rules, reconcile |
| Storefront | `/account/coins`, `components/checkout/CoinsPanel.jsx` |
| CMS | `/loyalty` (balances), `/loyalty/[customerId]` (support panel + earning-cap override), `/loyalty/liability`, `/loyalty/rules`, `/loyalty/risk` |
| Jobs | `loyalty-reservations` (5 min), `loyalty-unlock` (hourly), `loyalty-expiry` (hourly), `loyalty-reconcile` (daily) |

RBAC adds three keys mirrored between backend and CMS: `loyalty.view` (OPS +
ADMIN — support can read a balance without being able to move it),
`loyalty.adjust` and `loyalty.config` (ADMIN only).

## Rollout posture

Rule version `v1` is seeded by the migration with **earning on, redemption off,
rollout 0%** — the §13.2 "silent accrual" stage. Redemption stays behind
`redemptionEnabled` until earning, reversals and reconciliation are proven in
production. Both kill switches take effect within 60s without a deploy (§9.3).
