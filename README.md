# OptiSigns Billing Demo — NestJS + React + Stripe + MongoDB

A demo app that simulates OptiSigns' subscription + add-on mechanics, where **all
the charging, proration, downgrade and refund rules are runnable configuration** —
editing the policy changes Stripe's real behaviour.

| Component | Port |
|---|---|
| Backend (NestJS) | `3123` |
| Frontend (React + Vite) | `5555` |
| MongoDB | `27099` |

Further reading:
- [`docs/scio-integration-context.md`](docs/scio-integration-context.md) — **handover context** for bringing these mechanics into the SCIO Portal
- [`docs/business-rules.md`](docs/business-rules.md) — **charging rules in business language** (start here)
- [`docs/scio-portal-mvp.md`](docs/scio-portal-mvp.md) — scope carried over to the **SCIO Portal**: Standard plan + X add-on
- [`docs/optisigns-billing-model.md`](docs/optisigns-billing-model.md) — how OptiSigns charges (with sources)
- [`docs/stripe-mapping.md`](docs/stripe-mapping.md) — which Stripe parameter each knob maps to

---

## 1. Running

### MongoDB (port 27099)

```bash
mongod --port 27099 --dbpath ./.mongo-data
```

### Backend

```bash
cd backend
cp .env.example .env     # then fill in STRIPE_SECRET_KEY (sk_test_...)
npm install
npm run build && npm start      # or: npm run dev
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5555

### Push the price list to Stripe

```bash
node scripts/seed.mjs
```

Or click **Sync catalog → Stripe** in the UI. The script is idempotent: prices are
matched by `lookup_key`, so re-running it creates no duplicates.

### Webhook (optional but recommended)

```bash
stripe listen --forward-to localhost:3123/api/webhooks/stripe
```

Paste the `whsec_...` into `STRIPE_WEBHOOK_SECRET`. Without a secret the endpoint
still accepts unsigned payloads (handy for a local demo).

### Testing the full lifecycle

```bash
node scripts/verify.mjs               # add --keep to keep the account in Stripe
node scripts/verify-x-v6.mjs          # X add-on per MODEL V6 (run on its own, not in parallel)
node scripts/test-x-quota.mjs         # V6 quota arithmetic, no Stripe needed (build the backend first)
```

The script walks all 15 steps: trial → subscribe → add screens (prorate) → add-on →
add-on ≤ screens constraint → remove screens (credit) → downgrade with refund to card
→ switch to annual → scheduled downgrade → invoice refund → refund guard rail →
advance the clock to the renewal → pause/resume → immediate Cancel with prorate → audit log.
The backend must be running; the script creates and then deletes the demo account itself (use `--keep`
to keep it for inspection in the Stripe dashboard).

---

## 2. Simulated price list

Prices are taken from optisigns.com/pricing (both Monthly and Annual checked on
17/09/2026). Plans are charged **per screen / month**; annual is exactly 10% off and
collects the full 12 months:

| Plan | Monthly | Annual | Notes |
|---|---|---|---|
| Free | $0 | — | up to 3 screens, no Stripe subscription created |
| Standard | $10.00 | $9.00 | up to 25 users |
| Pro Plus | $15.00 | $13.50 | Most Popular · unlimited users |
| Engage | $30.00 | $27.00 | interactive kiosk |

Add-ons live on the same subscription, with the same term as the base plan:

| Add-on | Unit | Monthly | Annual |
|---|---|---|---|
| Video Wall | wall | $25.00 | $22.50 |
| Background Music | screen | $15.00 | $13.50 |
| Wireless Presentation | screen | $20.00 | $18.00 |

**X Social** follows **MODEL V6**: each tenant has **at most 1 add-on, with quantity fixed
at 1**; there are no longer Standard/Pro tiers:

| Add-on | Monthly | Annual | Quota |
|---|---|---|---|
| X Social | $20.00 | $216.00 ($20 × 12 × 90%) | 2,000 Post Updates / fully paid quota cycle |

There are **two clocks** (V6 row 6):

- **Money belongs to Stripe.** X is an ordinary item on the same subscription,
  same card, same interval as the base plan, and is **prorated natively by Stripe**. Buying
  mid-period pays for the remainder of the period, collected immediately (`always_invoice` +
  `error_if_incomplete`); if the card fails, nothing changes.
- **Quota belongs to SCIO**, computed over a **quota cycle stepped in whole months from a
  per-tenant quota anchor** (`account.xAddon.quotaAnchor`). The anchor is the base plan's
  `billing_cycle_anchor` at the moment X is first bought, so the quota cycle starts out **equal to
  the billing month** (billed on the 10th → 10/09 → 10/10); the day is clamped like Stripe's
  (31/01 → 28/02 → 31/03). A base-plan interval change restarts Stripe's billing
  (`billing_cycle_anchor=now`) but **never moves the quota anchor**, so from then on the two
  cycles can run apart:

```
GrantedTarget(Q) = floor(2,000 × paid seconds falling within Q / number of seconds in Q)
Remaining        = max(0, Granted − Used)
```

Paid time is read back from **the X lines on `paid` invoices** (no
`invoice.paid` means no quota yet) and takes the **union** of the intervals, so switching Monthly →
Yearly never grants twice. Renewal or an interval change **does not reset Used**;
it only adds the positive delta; no rollover. The yearly plan still grants per quota cycle:
with aligned cycles a paid year is 12 whole quota cycles of 2,000 = 24,000 (yearly bought 05/09 →
quota cycles on the 5th, 2,000 each).

> **Quota anchor — MODEL V6 row 46 and the operator, 2026-09-25.** The tab's third revision gives
> each tenant a quota cycle anchored at `xQuotaAnchorAt`, stepped in calendar-month anniversaries and
> never moved. The tab places the anchor at X's activation; the operator places it on the **base
> plan's billing cycle at X's first charge**, and this demo implements that reading (the API still
> names the cycle `quotaMonth`). The two differ only for a first purchase mid billing period: bought
> 30/08 on a base billed on the 5th measures **387** in one quota cycle 05/08 → 05/09. The tab's
> examples with a quota cycle on the 15th and billing on the 20th (333 then +1,667; a Cancel crediting
> 15/10 → 20/10) arise here once an interval change has moved billing off the anchor.

| Action | Money (Stripe) | Quota (SCIO) |
|---|---|---|
| Buy mid quota cycle | prorate to the billing boundary, collected immediately | `floor(2,000 × paid portion / month)` — base billed on the 1st, buy 15/09, paid through 01/10 → **1,066**; bought 10/09 on a base billed on the 10th → the full **2,000** for 10/09 → 10/10 |
| Renewal | Stripe collects the new period | with aligned cycles the renewal opens the next quota cycle at **2,000**, Used 0; once the cycles run apart, any shortfall is added to the **same** ledger |
| Monthly ⇄ Yearly (X is ACTIVE) | native proration together with the base plan; Stripe restarts billing | the quota anchor does not move; keep Used, only increase if coverage increases |
| **Cancel X** | **keep the same item, quantity 1 → 0** (not deleted immediately), for both Monthly and Yearly: if `quotaCycleEnd < xPaidThrough` then `proration_date = quotaCycleEnd` → credit `quotaCycleEnd → xPaidThrough` to the customer balance; otherwise `proration_behavior=none`, no credit. Never credit the part of the quota cycle in progress. With aligned cycles a Monthly Cancel has no future coverage (`quotaCycleEnd = xPaidThrough`); a credit arises only on Yearly, or after an interval change has moved billing away from the quota cycle | **FROZEN** until quotaCycleEnd, fan-out off, capacity released; FrozenRemaining is kept; store `AlreadyPaidUntil = min(oldPaidThrough, quotaCycleEnd)` |
| **Cleanup** at `AlreadyPaidUntil` | delete the quantity-0 item with `proration_behavior=none` — no money moves anywhere; retry on error, alert after 24 hours | only runs when the item is still quantity 0, the tenant is still FROZEN and no purchase is in progress (locked per tenant) |
| **Buy X again** before `AlreadyPaidUntil` | **no separate restore button** — turning X back on is a purchase; **same item 0 → 1** with `proration_date = AlreadyPaidUntil`: no double charge, whatever was credited is debited back at exactly that point | restore **FrozenRemaining** (Granted/Used as before) after payment succeeds, still expires at quotaCycleEnd |
| Buy X again from `AlreadyPaidUntil` onward | new activation, Stripe prorates normally from the time of purchase — reuses the quantity-0 item if cleanup has not run, otherwise creates a new item | that cycle's quota is granted per paid coverage; the quota anchor of the first charge is **kept** — measured: first charged on a base billed on the 1st, base moved to yearly on 12/09 while frozen, bought again 05/10 → quota cycle 01/10 → 01/11, granted 1,741 |
| Downgrade the base plan to Free | at the end of the paid period, no prorate | X runs until the boundary, then ENDED together with the base plan |
| Payment fail | no new coverage | only the already granted amount is usable; fetching stops past paidThrough; once paid, the delta is added |

**Trial X** (row 50): 14 days, 200 Post Updates in a separate ledger, once per
account, **Manual Refresh only**, no Stripe item. Buying the add-on ends the trial;
the trial balance does not carry over.

**Quota deduction** (row 12): by the number of X Posts **actually returned and billed** — ask for 50, X
returns 12, deduct 12 — clamped by Remaining, **exactly-once** per `actionId`. When the
quota runs out the provider is no longer called, and no overage is charged.

**Capacity admission** (row 17): before calling Stripe, the tenant holds a
2,000 reservation (TTL 15 minutes); it can be sold only if `Committed + Pending + 2,000 ≤ 2,500,000`;
paid commits it, fail/expiry releases it. The remaining 500,000 up to the hard cap of
3,000,000 is an unsold buffer. Changing the interval reserves nothing extra.

**Enterprise** ($45.00 / $40.50, minimum 25 screens) is a "Talk With
Sales" channel, so it is not built in this self-serve demo — add it back with one entry in
[`catalog.constants.ts`](backend/src/catalog/catalog.constants.ts). The OptiSigns
price list **has no "Pro" plan**.

Constraints enforced in the backend: the plan's `minQuantity`, Free ≤ 3 screens and
no add-ons, per-screen add-ons cannot exceed the number of screens.

---

## 3. Where the mechanics are configured

The **Billing policy** tab in the UI (or `GET/PUT /api/policy`) adjusts:

- **8 change rules** — `screensIncrease`, `screensDecrease`, `planUpgrade`,
  `planDowngrade`, `addOnIncrease`, `addOnDecrease`, `termToYearly`,
  `termToMonthly`. Each rule has `timing`, `prorationBehavior`,
  `billingCycleAnchor`, `paymentBehavior`, `creditHandling`.
  `creditHandling` has 5 values: `customer_balance` (leave it where Stripe put it),
  `push_to_account_balance` (always shown as account credit),
  `refund_to_payment_method` (refund to card), `none` (claw back the credit),
  `block` (**reject** the action if it would make the company pay money back).
- **Per-add-on override** (`addOnRules`) — overrides rules for each add-on by
  code. X Social does **not** go through here: its buy / Cancel / buy again flows are hard-wired
  by MODEL V6 in `backend/src/x-addon/`.
- **Cancellation** — Cancel at period end or Cancel immediately, with or without prorate, whether the unused portion
  becomes credit or is refunded to the card.
- **Trial** — `appliesTo` (`only_without_payment_method` like OptiSigns / `always` /
  `never`), number of days, `requirePaymentMethod`, handling when the trial ends without a card.
  Each subscription creation also has its own checkbox to turn the trial on/off for that time,
  and an **End trial now** button to end the trial midway (`trial_end: 'now'`).
- **Invoicing** — `collection_method`, `days_until_due`, `billing_mode`
  (flexible/classic), automatic tax, `payment_behavior`, anchor the period to day 1.
- **Refunds** — day window, credit note or plain refund, allow partial
  refunds, auto-approval ceiling.
- **Constraints** — min/max quantity, add-on ↔ screen relationship, allow going down to 0
  screens, **add-ons require a paid subscription** before they can be bought, and
  X capacity (`xCommercialCeilingUnits`, `xProviderHardCapUnits`).
- **Dunning** — what to do on `invoice.payment_failed`, `pause_collection.behavior`.

### 6 built-in presets

| Preset | Behaviour |
|---|---|
| `scio_portal_mvp` | **Scope migrated to the SCIO Portal**: Standard plan + X Social (MODEL V6), monthly or yearly. Downgrading the base plan to Free takes effect at the end of the paid period; X runs until that boundary |
| `optisigns_default` | All credit stays in Stripe as **account credit**, never refunded to the card. Proration rolls into the next period's invoice; only **yearly → monthly applies immediately**, and the unused part of the year becomes credit |
| `charge_immediately` | Every change is invoiced and collected immediately |
| `annual_commitment` | Upgrades are immediate; every reduction — including yearly → monthly — waits for the renewal (subscription schedule), no refund |
| `customer_friendly` | Scaling down issues a credit note and refunds to the card |
| `no_proration` | `proration_behavior=none` everywhere: quantities change immediately, money changes next period |

In addition, each action can be **overridden once** (the "One-off policy override" section
in the UI, or the `overrides` field when calling the API) to compare two behaviours side by side
without changing the global policy.

---

## 4. Scripted demos

1. **Adding screens charges immediately** — create an account with a test clock, attach a test card,
   buy Engage with 2 screens. Advance +10 days, increase to 3 screens: Stripe issues a
   `subscription_update` invoice for **$20.00** ($30 × 20/30 remaining days) and collects it right away; the
   renewal date stays the same — matching OptiSigns' production behaviour. Change
   `screensIncrease.prorationBehavior` to `create_prorations` to see the behaviour of
   rolling into the next period's invoice (this is what the public support article describes, but it is
   outdated — see [docs/optisigns-billing-model.md](docs/optisigns-billing-model.md)).
2. **Credit when removing screens** — reduce to 2 screens: the account credit increases
   (shown in the sidebar), and the next period's invoice deducts it automatically.
3a. **Upgrading the plan charges immediately** — Standard → Pro Plus mid-period: one
   `subscription_update` invoice containing the unused old portion (negative) + the remaining new portion (positive),
   collecting exactly the difference. The renewal date stays the same.
3b. **Buying an add-on charges immediately** — add AeriCast mid-period: Stripe issues a separate invoice
   for the prorated portion and collects it right away; the renewal date does not change. Switch to the
   `charge_fails` card and buy again to see `error_if_incomplete` block it outright.
3. **Real refund on downgrade** — switch the preset to `customer_friendly`, repeat
   the reduction: the app detects the credit just created, refunds it to the card and records a reversing
   entry so it is not applied twice.
4. **Switch monthly → yearly** — `billing_cycle_anchor: now`, the cycle resets, Stripe
   collects the full 12 months immediately and deducts the unused part of the month.
4b. **Switch yearly → monthly** — applied immediately by default: Stripe issues an invoice containing the unused part of the year
   (negative) + the first monthly month (positive); the **net** remainder becomes account
   credit (`−$240.74`), and the money never leaves Stripe. The `annual_commitment` preset gives the
   wait-until-year-end behaviour; `customer_friendly` gives the refund-straight-to-card behaviour.
5. **Downgrade waits until period end** — `annual_commitment` preset, downgrade the plan: the app creates a
   subscription schedule, the current plan stays until the end of the period, and the Subscription tab
   shows "Scheduled change".
6. **Advancing time** — the *Next renewal* button in the Time machine: Stripe issues a real renewal
   invoice, including any pending proration and scheduled phases.
7. **Dunning** — attach the `declined` card, advance to the renewal: the invoice goes `past_due`,
   and the `dunning.pastDueBehavior` policy decides whether to Cancel / pause / let Stripe retry.
8. **Refund** — the *Invoices & refunds* tab, click Refund on a paid invoice. Try
   lowering `maxAutoApproveCents` or `windowDays` to see the API block it according to the rules.
9. **Seasonal pause** — *Pause (seasonal)*: `pause_collection` with the behavior taken
   from the policy, corresponding to OptiSigns' OnHold flow.
10. **X Social per MODEL V6** — create an account with a test clock, buy Standard, advance
    to mid-month, then turn on **X Social: On**: the preview shows the prorated Stripe invoice
    and the quota `floor(2,000 × paid days / days in the quota cycle)`. The **X
    add-on** block in the left column shows status, quota cycle, Granted/Used/Remaining,
    paidThrough and capacity.
10b. **Provider fetch** — in the X add-on block pick Initial/Auto/Manual, enter
    *asked* and *returned*: quota is deducted by *returned*, clamped by Remaining.
10c. **Cancel → Buy X again** — *Cancel X*: the tenant is FROZEN until the end of the quota cycle, and the X
    item on Stripe is **kept, with quantity set to 0** until `AlreadyPaidUntil`; only the
    `quotaCycleEnd → xPaidThrough` portion is credited, if it exists (a Monthly X with aligned
    cycles never has it; a Yearly X bought 05/09 and cancelled 20/09 is credited **$198.25** for
    05/10/2026 → 05/09/2027). *Buy X again* (or turning X back on) before that point takes
    that same item from 0 to 1 and restores FrozenRemaining; advancing past that point means the item
    is cleaned up and buying again is a new activation.
    Full scenario: `node scripts/verify-x-v6.mjs`.

The **Activity log** tab records every action: which rule was applied, what the policy looked like
at that moment, what payload was sent to Stripe and what Stripe returned.

---

## 5. API

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/catalog` | price list + sync status |
| `POST` | `/api/catalog/sync-stripe` | create/update products & prices on Stripe |
| `POST` | `/api/catalog/reseed` | rewrite the price list from code into Mongo |
| `GET/POST` | `/api/accounts` | list / create accounts (with test clock) |
| `POST` | `/api/accounts/:id/payment-method/test` | attach a test card (`visa`, `declined`, `authentication_required`, …) |
| `POST` | `/api/accounts/:id/checkout-setup` | Checkout session mode=setup to enter a real card |
| `GET/POST` | `/api/accounts/:id/balance` | view / adjust the customer balance |
| `GET` | `/api/subscriptions/:id` | subscription + schedule state |
| `POST` | `/api/subscriptions/:id/preview` | **dry-run**: the invoice Stripe would create + rule explanation |
| `POST` | `/api/subscriptions/:id/change` | apply a change according to the policy |
| `POST` | `/api/subscriptions/:id/cancel` \| `/resume` \| `/pause` \| `/unpause` \| `/end-trial` | lifecycle |
| `POST` | `/api/subscriptions/:id/cancel-scheduled-change` | Cancel a change pending at period end, before it takes effect |
| `GET` | `/api/subscriptions/:id/renewal-preview` | next renewal invoice |
| `GET` | `/api/billing/accounts/:id/invoices` | invoices with line items, proration flagged |
| `POST` | `/api/billing/invoices/:id/pay` \| `/void` \| `/finalize` \| `/uncollectible` | invoice actions |
| `POST` | `/api/billing/accounts/:id/refund` | refund / credit note according to the policy |
| `POST` | `/api/billing/portal/configuration` | push the policy to the Customer Portal config |
| `GET/PUT` | `/api/policy` | read / edit the billing policy |
| `POST` | `/api/policy/presets/:key` | apply a preset |
| `POST` | `/api/simulator/:id/advance` | advance the test clock |
| `GET` | `/api/x-addon/:id` | X add-on: status, quota cycle, ledger, paidThrough, coverage, capacity (reconciled from paid invoices) |
| `POST` | `/api/x-addon/:id/preview/:action` | dry-run `purchase` \| `cancel` (buying again after Cancel is also `purchase`) |
| `POST` | `/api/x-addon/:id/cancel` \| `/trial` | X lifecycle per MODEL V6 — Cancel takes the item to quantity 0; there is no resume route; buying again goes through `/subscriptions/:id/change` |
| `POST` | `/api/x-addon/:id/sync-runs` | one provider fetch `{kind, requested, returned, actionId}` — deducts quota exactly-once |
| `POST` | `/api/webhooks/stripe` | webhook (raw body, with signature verification) |
| `GET` | `/api/events` | audit log |

---

## 6. Architecture

```
backend/src/
  catalog/      OptiSigns price list ↔ Stripe Product/Price (lookup_key, idempotent)
  policy/       billing policy + presets  ← all the "mechanics" live here
  accounts/     demo tenants, Stripe customer, test cards, test clock, balance
  subscriptions/classify change → build items → update / schedule / cancel
  billing/      invoices, refunds, credit notes, customer portal
  simulator/    test clock
  x-addon/      X Social MODEL V6: quota ledger per anchored quota cycle, capacity, cancel/buy again/trial
  webhooks/     receive events, sync back to Mongo, execute dunning
  events/       audit log (policy + payload + result)
```

Flow of a change:

```
desired state → validate constraints → classifyChange() → rule = policy + override
   → timing=immediate ? subscriptions.update : subscriptionSchedules.update
   → measure customer.balance before/after → apply creditHandling
   → write audit → sync to Mongo
```

## 7. Known limitations

- **No auth.** Every endpoint is open — the demo runs locally; do not expose it.
- **The X add-on only simulates the billing/quota part of MODEL V6.** It does not call the X API:
  provider fetch is a manual input (`/x-addon/:id/sync-runs`), and fan-out is a status
  flag. Global Batch Compliance, XAA `post.delete`, the 24-hour compliance lease
  and the Profile cap of 10 are not part of this demo.
- **No webhook secret** in the default configuration, so automatic dunning actions
  do not trigger on their own.
- `billing_mode` can only be set when creating a subscription (a Stripe limitation). Changing it
  in the policy only affects subscriptions created afterwards; the app warns when a
  running subscription diverges from the policy.
- `automatic_tax` and `anchorToFirstOfMonth` also only apply at creation.
- `payment_behavior = default_incomplete` requires confirming the PaymentIntent on the client;
  the app does not embed Stripe Elements, so it shows a warning with a hosted invoice link
  to complete it.
- Changing `CURRENCY` after syncing creates a new set of Prices (the old prices are archived).
- A subscription containing a Price that has been removed from the catalog is flagged with a clear warning instead of
  being silently misread.

## 8. Notes

- Use **test mode keys** only (`sk_test_…`). The app never touches real card
  data: demo cards use Stripe's shared payment method tokens.
- A test clock can only be attached **when creating the customer**, so enable that option when creating
  the account if you want to advance time.
- `billing_mode` can only be set when creating a subscription; changing it in the policy only
  affects subscriptions created afterwards.
