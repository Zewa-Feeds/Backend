# Payments — how the test-mode mock works, and how to go live

There is exactly **one** piece of temporary code in this backend: a payment
provider that auto-confirms after 30 seconds instead of charging a card. This
document explains the seam it sits behind and the checklist for removing it.

---

## Current state

`RAZORPAY_AUTO_CONFIRM=true` in `.env`, so:

- **COD** — fully production-ready. Order is created, stock decremented,
  `paymentStatus = UNPAID` (payment is collected on delivery), staff alert and
  customer confirmation queued. Nothing about this path is mocked.
- **Razorpay** — order created with `paymentStatus = UNPAID`, then a BullMQ job
  fires 30 s later and marks it `PAID`. No card, no credentials, no money.

The storefront can tell the difference: `POST /checkout` returns
`payment.simulated: true` and `payment.publicKey: null`, so it shows a test-mode
notice and polls `/checkout/:orderNo/status` instead of opening the Razorpay widget.

---

## The seam

Everything talks to one interface, `PaymentProvider`
([src/integrations/razorpay/payment.types.ts](src/integrations/razorpay/payment.types.ts)):

```
                       ┌─────────────────────────┐
  checkout.service ───▶│   PaymentProvider       │
  orders.service       │   (interface)           │
  webhook.routes       └───────────┬─────────────┘
                                   │
                    ┌──────────────┴──────────────┐
                    ▼                             ▼
        RazorpayProvider                 MockPaymentProvider
        (production, complete)           (TEMPORARY, dev only)
        real HMAC verification           auto-confirms after 30s
```

`payment.service.ts` picks one at first use, based on config:

| Config | Provider |
|---|---|
| `RAZORPAY_AUTO_CONFIRM=true` | `MockPaymentProvider` — refuses to construct in production |
| `RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET` set | `RazorpayProvider` |
| neither | `null` — online payment disabled, COD still works |

**`RazorpayProvider` is already written and complete.** It is not a stub: it
creates real gateway orders, verifies the `orderId|paymentId` HMAC in constant
time, fetches the payment to confirm it is actually captured, verifies webhook
signatures over the raw body, and calls the refund API.

---

## Going live — the whole checklist

```bash
# 1. Real credentials from the Razorpay dashboard
RAZORPAY_KEY_ID=rzp_live_xxxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxx
RAZORPAY_WEBHOOK_SECRET=xxxxxxxx

# 2. Turn the mock off
RAZORPAY_AUTO_CONFIRM=false
```

Then, in the Razorpay dashboard, point a webhook at
`https<your-api>/api/v1/webhooks/razorpay` subscribed to `payment.captured` and
`order.paid`.

**No code changes.** Production config validation enforces this — the app refuses
to boot if `NODE_ENV=production` and `RAZORPAY_AUTO_CONFIRM=true`, or if Razorpay
is enabled without a key and webhook secret.

### Optional cleanup once live

Not required, but tidy:

1. Delete [src/integrations/razorpay/mock.provider.ts](src/integrations/razorpay/mock.provider.ts)
2. Delete `handleAutoConfirm` from [src/jobs/workers/payment.worker.ts](src/jobs/workers/payment.worker.ts)
3. Delete the `isSimulated` branch at the end of `checkout()` in
   [src/modules/checkout/checkout.service.ts](src/modules/checkout/checkout.service.ts)
4. Remove `RAZORPAY_AUTO_CONFIRM` from `config/env.ts`
5. Drop `simulated` / `autoConfirmInSeconds` from `CheckoutResult`

Every one of these is marked in-source with
`TODO: Replace with production Razorpay verification`.

---

## Why the mock is not a security hole

Three properties, each verified by test:

**It cannot run in production.** `MockPaymentProvider`'s constructor throws when
`NODE_ENV=production`, and config validation rejects the flag before that even
runs. A production deploy that forgets to flip it crash-loops rather than
accepting fake orders.

**It still verifies signatures.** The mock signs its own order and payment ids with
an HMAC over a server-side secret and checks them on confirmation. So a client
cannot POST `/checkout/:orderNo/confirm` with an invented payment id — tested, and
rejected with `PAYMENT_VERIFICATION_FAILED`. The trust boundary has the same shape
as production; only the source of truth differs.

**The signing key never leaves the server.** `paymentSignatureFor()` is called only
by the worker. Nothing in any HTTP response contains a usable mock signature.

---

## What is production-ready right now

Everything except the final confirmation step:

| Concern | Status |
|---|---|
| Stock transaction (conditional decrement, no overselling) | production |
| Order number generation (per-day counter, concurrency-safe) | production |
| Idempotency (`Idempotency-Key` header) | production |
| Server-side pricing (client prices never trusted) | production |
| Coupon validation, per-customer limits, redemption records | production |
| GST computation and invoice PDFs | production |
| Order lifecycle, restocking, audit trail | production |
| Unpaid-order stock release sweep | production |
| Webhook signature verification | production |
| Refund API call | production (calls the provider) |
| ZeptoMail sends via BullMQ, retries, dead-letter | production |
| **Final payment confirmation** | **mocked (30 s auto-confirm)** |

---

## Disabling a payment method

Either method can be switched off without code changes:

```bash
PAYMENT_RAZORPAY_ENABLED=false   # COD only
PAYMENT_COD_ENABLED=false        # online only
```

`GET /settings/public` reports the enabled set so the storefront renders only the
options that will actually work, and `POST /checkout` rejects a disabled method
with a clear message rather than failing obscurely. Config validation refuses a
deployment with both disabled.
