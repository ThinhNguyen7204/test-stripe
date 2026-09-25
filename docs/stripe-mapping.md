# Billing policy → Stripe parameters

The app's entire "mechanism" lives in a single document in MongoDB
(`billing_policies`, key = `active`). Each field maps directly to a Stripe
parameter. Editing the policy = changing Stripe's real behaviour, not changing the
app's internal arithmetic.

## 1. Change rules

The app classifies every change into exactly **one** rule, in priority order:
`term → plan → screens → add-ons` (see `subscription.util.ts:classifyChange`).

| Rule key | When |
|---|---|
| `screensIncrease` / `screensDecrease` | screen count changes |
| `planUpgrade` / `planDowngrade` | tier changes (compared by `tierRank`) |
| `addOnIncrease` / `addOnDecrease` | add-on changes |
| `termToYearly` / `termToMonthly` | term changes |

By default **all three "buy more" rules** — `screensIncrease`, `planUpgrade`,
`addOnIncrease` — use `always_invoice` + `error_if_incomplete`: when the customer
buys more they **pay immediately**, and if the card fails the change is cancelled.

Symmetrically, **all three "reduce" rules** — `screensDecrease`, `planDowngrade`,
`addOnDecrease` — use `create_prorations` + `push_to_account_balance`: the unused
portion becomes visible account credit, and no money leaves Stripe.

Example of adding a screen (Engage, 2 → 3 screens, 20/30 days remaining): invoice
`subscription_update` **$20.00** = $30 × 20/30 for the third screen, collected
immediately, renewal date unchanged, next period's invoice is clean with nothing pending.

Example of a mid-period upgrade (Standard → Pro Plus, 4 screens, 20/30 days remaining):
Stripe issues one `subscription_update` invoice containing `−$26.67` refunding the unused
Standard portion and `+$40.00` for the remaining Pro Plus portion → **collects $13.33**, i.e.
exactly the difference for the remaining days. Renewal date unchanged, nothing left pending
into the next period. If the card fails the plan stays as is, and the customer does not get the higher tier.

Buying an
add-on **collects payment immediately** (the prorated portion for the remaining days of the period), nothing is left pending
for the next invoice, and if the card is declined the change is cancelled — the customer does not get
to use the add-on for free. The renewal date stays the same because `billing_cycle_anchor` is still
`unchanged`.

Note: `always_invoice` sweeps **every** pending proration on the subscription, so
if the customer previously added screens under `create_prorations`, that amount is
also collected at the same time.

Each rule has 5 knobs:

| Field | Stripe parameter | Meaning |
|---|---|---|
| `timing` | `subscriptions.update` vs `subscriptionSchedules.update` | apply immediately, or wait until period end |
| `prorationBehavior` | `proration_behavior` | `create_prorations` (roll into the next invoice) / `always_invoice` (issue an invoice immediately) / `none` |
| `billingCycleAnchor` | `billing_cycle_anchor` | `unchanged` keeps the renewal date, `now` resets the cycle and charges a full new period |
| `paymentBehavior` | `payment_behavior` | `error_if_incomplete` blocks the change if the card fails, `default_incomplete` waits for 3DS, ... |
| `creditHandling` | (app logic) | where generated credit goes: left on the **customer balance**, **refunded to the card**, or **clawed back** |

### Where the credit lives — and how the app measures it

This is the easiest place to get wrong. Depending on `proration_behavior`, the customer's credit lives in two
completely different places:

- `create_prorations` → the credit is a **negative pending invoice item** pending on the
  subscription, waiting for the next period's invoice to sweep it in. `customer.balance` **does not change**.
- `always_invoice` → Stripe issues an invoice immediately; if the net is negative, the remainder lands in the
  **customer balance** (negative `ending_balance`).

So measuring credit by comparing `customer.balance` before/after is **not enough** — with
the default preset (create_prorations) it always comes out 0. The app measures with Stripe itself: it previews
the upcoming invoice twice — once as is, once "assuming the change was made" — then
takes the difference of the sums of the proration lines:

```
prorationsBefore = Σ(proration lines of the current upcoming invoice)
prorationsAfter  = Σ(proration lines when previewing with the new items)
credit           = max(0, prorationsBefore − prorationsAfter)
```

`proration_date` is pinned for both the preview and the real update so that both sides compute
exactly the same number.

**Gross or net — only the right number avoids over-refunding.** The number used for the refund depends
on `proration_behavior`:

| proration_behavior | Where the credit lives | Which number the app uses |
|---|---|---|
| `create_prorations` | negative pending invoice item, balance unchanged | difference of proration line sums (**gross**) |
| `always_invoice` | Stripe has settled the invoice — which includes both the new period being charged and every pending proration | change in **customer balance** (**net**) |

Taking the `max` of the two signals is wrong: with `always_invoice`, the gross credit is $270.74 while
the invoice also charges $30.00 for the new period, so only $240.74 is actually left over. Refunding
$270.74 gives the customer a month for free — and if an offsetting entry is added on top,
the customer ends up **owing** money.

Once the credit amount is known:

- `customer_balance` → leave it where Stripe put it. With `always_invoice` that is the
  account balance; with `create_prorations` it is only a negative line pending on the
  next invoice, **`customer.balance` stays 0**.
- `push_to_account_balance` → always ends up as visible account credit. If a proration
  is still pending, the app creates a positive invoice item for exactly that amount so the next invoice is not
  reduced twice, then writes a negative `customer.balance`.
  The amount the customer pays does not change, only where it is displayed.
- `refund_to_payment_method` → `refunds.create` on the PaymentIntent of the most recent
  paid invoices (refunding at most the refundable remainder), then writes a
  **positive** balance transaction exactly equal to the refunded amount. This reversing entry is
  mandatory: once the money is back on the card, the negative pending proration must not also be deducted from the
  next period's invoice.
- `none` → write a positive balance transaction to wipe the credit.

## 2. How `timing: end_of_period` works

The app creates (or reuses) a **subscription schedule** from the current subscription,
keeps the running phases unchanged and appends a new phase with the desired configuration,
`proration_behavior: 'none'`, `end_behavior: 'release'`. The subscription stays unchanged
until the end of the paid period, then automatically moves to the new phase.

When an `immediate` change happens while a schedule exists, the app **releases**
the schedule first so the two mechanisms do not fight each other.

## 2b. Worked example: yearly → monthly

This is the most contentious change, so it deserves its own section.

**Default (`termToMonthly`: immediate / always_invoice / anchor now / push_to_account_balance)**

1. `classifyChange` sees the term changed → ruleKey `termToMonthly` (term has the highest
   priority, above plan/screens/add-on).
2. `subscriptions.update` with `billing_cycle_anchor: 'now'` → the cycle restarts
   today, Stripe issues a `subscription_update` invoice containing: the **unused**
   portion of the year (negative) plus the **first monthly month** (positive).
3. The negative remainder after offsetting lands in `customer.balance` — **money does not leave
   Stripe**, there is no refund to the card.
4. Subsequent monthly invoices consume that credit automatically until it runs out.

Measured numbers (Pro Plus, 2 screens, changed after 2/12 months):

| | |
|---|---|
| Collected for the year | $324.00 (2 × $13.50 × 12) |
| **Gross** credit for the unused year | $270.74 |
| First monthly month charged | $30.00 |
| **Net** credit → account balance | **−$240.74** |
| Refund to card | **$0.00** |
| Next monthly invoice | $0.00 (`starting_balance` deducts automatically) |

To send the money back to the real card, change that rule's `creditHandling` to
`refund_to_payment_method` — the `customer_friendly` preset already sets it that way.

**Preset `annual_commitment` (end_of_period / none / no refund)**

Same action, but it does not touch the running subscription: the app creates a subscription
schedule, appends a monthly phase (`duration: 1 month`, `end_behavior: release`),
`pendingChange.effectiveAt` = the end date of the yearly period. Nothing extra is charged, not a cent is
refunded, the invoice count stays the same. On that date Stripe activates the monthly phase and issues
a $30.00 invoice.

**Note on preview.** For an `end_of_period` change, the app previews with
`preview_mode: 'recurring'` to get a full period at the new configuration. Stripe still prices
it based on the current period, so **the dates on each line are Stripe's reference frame,
not the real effective date** — the UI hides those dates and only shows
`effectiveAt` taken from `current_period_end`.

**Note on test clocks.** Once a monthly phase is in the schedule, Stripe only
allows advancing at most 2 months at a time (limited by the shortest interval on the clock). So
`simulator.advance` automatically splits into multiple legs, uses exactly the ceiling Stripe reports
back, and records the number of legs in the audit log.

## 2c. Ineffective knobs

`GET /api/policy` also returns `warnings[]`, and the Billing policy tab shows them in the
"Settings that cannot fire" block. These are not errors — just combinations where a field
looks enabled but is never reached:

- `cancellation.refundUnusedTime` other than `none` while `prorateUnusedTime` is off
  and `timing = immediate` → immediate cancel cuts the service **without returning anything**.
- `prorateUnusedTime` on while `timing = at_period_end` → there is no unused
  time to prorate.
- a rule with `prorationBehavior = none` but `creditHandling` other than `none` → no
  credit is created to be handled.
- a rule with `timing = end_of_period` but `prorationBehavior` /
  `billingCycleAnchor` set → the new phase starts clean at renewal, those two fields are ignored.
- `trial.requirePaymentMethod` on while `appliesTo = never`.

All 5 built-in presets produce 0 warnings.

## 2d. X Social (MODEL V6): native money, separate quota

X is an ordinary item on the subscription, so **Stripe charges for time like
any item** — there is no longer a branch that builds money lines by hand from the allowance. MODEL V6 only hard-fixes
the parameters of three operations (code: `backend/src/x-addon/x-addon.service.ts`):

| Operation | `subscriptions.update` |
|---|---|
| Buy | `items: [{price, quantity: 1}]`, `proration_behavior: always_invoice`, `proration_date: now`, `payment_behavior: error_if_incomplete` |
| Cancel, `quotaCycleEnd < xPaidThrough` (monthly or yearly) | `items: [{id, quantity: 0}]`, `proration_behavior: always_invoice`, **`proration_date: quotaCycleEnd`** — credit `quotaCycleEnd → xPaidThrough`; item **kept** |
| Cancel, `quotaCycleEnd ≥ xPaidThrough` | `items: [{id, quantity: 0}]`, `proration_behavior: none` — no future coverage to credit |
| Cleanup at `AlreadyPaidUntil` | `items: [{id, deleted: true}]`, `proration_behavior: none`, idempotency key `x-cleanup-<item>-<attempt>` — only when the item is still quantity 0, the tenant is still FROZEN, and no purchase holds the tenant lock |
| Buy X again before `AlreadyPaidUntil` | **same item** `items: [{id, price, quantity: 1}]`, `proration_date = AlreadyPaidUntil`, `always_invoice`; if that point is the period end then `proration_behavior: none` (no interval left to prorate) |
| Buy X again from `AlreadyPaidUntil` onwards | `proration_date: now`, `always_invoice` — on the quantity 0 item if cleanup has not run, otherwise `items: [{price, quantity: 1}]` as in Buy |
| Change interval | X ACTIVE: the X item changes price together with the base plan under rule `termToYearly` / `termToMonthly`. X FROZEN with the item still present: a **separate request first**, `items: [{id, price, quantity: 0}]` with `proration_behavior: none` — `quantity: 0` stated because a price change otherwise resets it — then the base plan's change without the X item. One combined request credits X for now → quotaCycleEnd (measured −$4.73), because Stripe still counts the item at quantity 1 up to the Cancel's future `proration_date` |

Measured in test mode (yearly X $216 bought 05/09/2026, cancelled 20/09):

- Stripe **accepts a future `proration_date`** on an item, as long as it lies within
  the current period: the cancel invoice credits `−$198.25` for the period `2026-10-05 →
  2027-09-05` (from quotaCycleEnd, the end of the quota cycle 05/09 → 05/10), automatically `paid`,
  written to the customer balance. The quantity change 1 → 0
  still takes effect **immediately**; the invoice also has a `$0` line "remaining time on 0 × X".
- Buying X again with the same `proration_date` on the same item (0 → 1) re-debits exactly that
  period: the invoice is `$198.25`, paid from the balance so `amount_due = $0.00`.
- **A quantity 0 line buys nothing**: SCIO ignores every X line with `quantity = 0` when
  computing paid coverage, so the `$0` line on the Cancel receipt or on a renewal never
  grants quota.
- **Renewal coinciding exactly with `AlreadyPaidUntil`** (every monthly Cancel while the quota
  month equals the billing month: no credit, `AlreadyPaidUntil = xPaidThrough`): Stripe renews
  **before** cleanup gets to run, so that renewal invoice carries a `$0` X line. Cleanup runs right after,
  and the next period's renewal **has no X line at all** (the `$0` line measured in scenarios C and N,
  the renewal without an X line in scenario N).

**Quota is not read from Stripe but derived from Stripe**: SCIO replays the X lines on
every `status = paid` invoice in creation order (within the same invoice, negative lines
first, positive lines after), takes the union of the periods as *paid coverage*, then
`Granted = floor(2,000 × coverage ∩ quota cycle / quota cycle)`, where the quota cycle is stepped
in whole months from the tenant's quota anchor (`account.xAddon.quotaAnchor`) — the base plan's
`billing_cycle_anchor` when X is first bought. An interval change sends `billing_cycle_anchor: now`
for the money but leaves that anchor alone, so the quota cycle and the billing cycle can run apart.
Stripe owns the money clock; SCIO owns the quota clock. The replay is therefore
idempotent: an `invoice.paid` webhook arriving twice, or reading state every time the page opens,
all yield the same result.

## 3. Cancellation

| Field | Stripe |
|---|---|
| `timing: at_period_end` | `subscriptions.update({ cancel_at_period_end: true })` |
| `timing: immediate` | `subscriptions.cancel({ prorate, invoice_now })` |
| `prorateUnusedTime` | `prorate` |
| `invoiceImmediately` | `invoice_now` |
| `refundUnusedTime` | same as `creditHandling` above |
| `moveToFreePlan` | internal state: back to the Free plan (3 screens) |

## 4. Trial

| Field | Stripe / effect |
|---|---|
| `appliesTo` | decides whether to attach `trial_period_days`: `only_without_payment_method` (default, same as OptiSigns), `always`, `never` |
| `days` | `trial_period_days` |
| `requirePaymentMethod` | refuses to start a trial if there is no card yet (400 error with the reason) |
| `missingPaymentMethodBehavior` | `trial_settings.end_behavior.missing_payment_method` |

Each `change` request also accepts `withTrial: true/false` to override the policy for that
single request; the UI shows it as the checkbox "Start this subscription with a trial".
`POST /api/subscriptions/:id/end-trial` sends `trial_end: 'now'` to end the trial
immediately and issue the first period's invoice.

Note a Stripe behaviour: if the subscription is `trialing`, **has no card yet**,
and `missing_payment_method = cancel`, Stripe **refuses** to preview the upcoming invoice
(because there will be no invoice — the subscription is cancelled when the trial ends). The app catches this case and returns
an explanation instead of an error.

## 5. Invoicing

| Field | Stripe |
|---|---|
| `collectionMethod` | `collection_method` |
| `daysUntilDue` | `days_until_due` (only with `send_invoice`) |
| `billingMode` | `billing_mode.type` — `flexible` (new default, prorates by the second) or `classic` |
| `automaticTax` | `automatic_tax.enabled` |
| `defaultPaymentBehavior` | `payment_behavior` when creating the subscription |
| `anchorToFirstOfMonth` | `billing_cycle_anchor_config.day_of_month = 1` |

`billing_mode` can only be set when creating the subscription and cannot be changed afterwards.

## 6. Refunds

| Field | Effect |
|---|---|
| `windowDays` | past the window the API refuses, unless `force: true` is sent |
| `mode: credit_note` | `creditNotes.create({ invoice, amount, refund_amount })` — both adjusts the invoice (correct for tax/accounting) and refunds the money |
| `mode: refund` | `refunds.create({ payment_intent, amount })` — only moves money, the invoice stays unchanged |
| `allowPartial` | require a full refund or allow a partial one |
| `maxAutoApproveCents` | auto-approval ceiling; above it `force: true` is required |

## 7. Dunning

`invoice.payment_failed` arrives via webhook. Depending on `pastDueBehavior`, the app lets Stripe
retry with Smart Retries (`leave_past_due`), or calls `subscriptions.cancel`, or
sets `pause_collection` with `pauseBehavior` (`void` / `keep_as_draft` /
`mark_uncollectible`).

## 8. Customer Portal

`POST /api/billing/portal/configuration` builds a
`billingPortal.configurations` from the current policy: `subscription_update.
proration_behavior` is taken from the `screensIncrease` rule, `subscription_cancel.mode`
is taken from `cancellation.timing`. That way a customer acting on their own in Stripe's portal
is still subject to the same rules as acting through the app.

## 9. Time: always ask the test clock, never the machine clock

An account attached to a test clock lives in simulated time. Using `Date.now()` for it
breaks silently in three places: `proration_date` is computed from the wrong point (prorating a whole
month instead of the remainder), the refund window never expires, and a subscription
schedule phase is misread as "future". So every point in time
goes through `StripeService.nowFor(testClockId)`.

## 10. Test clock

Customers are created with a `test_clock`. `POST /api/simulator/:id/advance` calls
`testHelpers.testClocks.advance` then waits until `status = ready`. Stripe runs
the whole engine for real: issues renewal invoices, sweeps outstanding prorations, activates
scheduled phases, starts dunning if the card fails.

## 10b. A failed read must not be treated as "does not exist"

`change()` decides to create a new subscription based on reading the current subscription
returning `null`. So a **failed** read (timeout, rate limit, 5xx) that gets
swallowed into `null` makes the app silently create a second subscription — the customer is charged
twice, leaving only a WARN line behind.

Rule: only `resource_missing` / HTTP 404 means "gone"; every other error throws
`ServiceUnavailableException` with the message *nothing was changed — retry in a
moment*. The Stripe client also enables `maxNetworkRetries: 3` and `timeout: 40000` so that transient
network errors are retried automatically.

## 11. What changed in the Stripe API (version 2026-08-26.dahlia)

- `current_period_start/end` is **no longer** on the Subscription object — it lives on
  each subscription item (`StripeService.periodEnd`).
- Invoice preview uses `invoices.createPreview({ subscription_details })`,
  no longer `invoices.retrieveUpcoming`.
- Line items no longer have a top-level `proration` flag; it lives at
  `line.parent.subscription_item_details.proration`.
- An invoice's PaymentIntent is obtained via `invoice.payments` (requires `expand`).
- Subscription schedule phases **no longer** have `iterations`; replaced by
  `duration: { interval, interval_count }` (or `end_date`).
- `proration_date` must not be sent together with `billing_cycle_anchor: 'now'` —
  Stripe returns a 400 error; moving the anchor is itself the proration point.
