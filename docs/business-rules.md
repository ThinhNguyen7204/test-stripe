# Billing rules — business edition

This document describes the **actual behaviour** of the system under the
configuration currently running, written for people who do not read code. Every
figure in here was measured in Stripe test mode, not calculated by hand.

The appendix at the end of the file maps each rule to its corresponding
configuration field, and states clearly what is adjusted in the app and what has
to be done in the Stripe dashboard.

---

> ## 📌 SCIO Portal scope (MVP)
>
> When migrating to **SCIO Portal**, only the **Standard plan** and **one X
> add-on under MODEL V6** ($20/month or $216/year, quantity fixed at 1) are
> carried over, running on both **monthly and annual** cycles. X's money is
> prorated natively by Stripe like any other item; quota is managed by SCIO on a
> quota cycle anchored to the base plan's billing anchor at first purchase
> (section 10).
>
> Each section below states clearly which part is **inside** the MVP scope and
> which part is **outside**. Detailed version: **[scio-portal-mvp.md](scio-portal-mvp.md)**.
>
> | In MVP | Outside MVP |
> |---|---|
> | Standard plan | Pro Plus, Engage |
> | X Social (one add-on, quantity 1) | Background Music, Video Wall, Wireless Presentation |
> | Monthly ⇄ annual cycle | Adding / removing screens |
> | Buy, Cancel, Buy X again, X trial | Upgrading / downgrading at plan level |

---

## 1. Overarching principle

> **When the customer buys more, they pay immediately. When the customer reduces,
> the money stays in the account as credit and does not flow back to the card.**

Two consequences:

- There is no amount "recorded as owed, to be paid later" — with one exception:
  removing screens.
- No money leaves Stripe in the self-service flow. A refund to the card must be a
  manual action by Customer Support.

---

## 2. Customer buys more

> **MVP:** only one path remains — **buying X**. Adding screens and upgrading the
> plan are not in the portal. The principle *charge immediately, a failing card
> cancels the operation, the renewal date does not change* applies unchanged to
> X: Stripe prorates from the purchase time to the billing boundary. X's quota
> alone is calculated on SCIO's quota cycle, which starts out equal to the
> billing month (section 10).

Applies to **adding screens**, **upgrading to a higher plan**, **buying an add-on**.

- Calculated on the **number of days remaining in the period**, not a full month.
- A separate invoice is issued and **the card is charged immediately** when the
  customer clicks buy.
- **The renewal date does not change.**
- **A failing card cancels the operation** — the customer may not use something
  that has not been paid for.
- On an upgrade, the unused part of the old plan is refunded first and then the
  new plan is charged, so the customer pays exactly the difference.

| Measured scenario | Charged immediately |
|---|---|
| Engage, 2 → 3 screens, 20/30 days remaining | **$20.00** |
| Standard → Pro Plus, 4 screens, 20/30 days remaining | **$13.33** (refund $26.67 + charge $40.00) |
| Buy 2 AeriCast licences, 20/30 days remaining | **$26.67** |

---

## 3. Customer reduces — **not allowed mid-period**

> **MVP:** this blocking rule does not touch X: **Cancel X** is a separate
> MODEL V6 flow (section 10) — the tenant is frozen immediately, the same item
> goes from quantity 1 to 0 and is cleaned up at `AlreadyPaidUntil`, and only the
> paid portion lying after quotaCycleEnd is credited, if any. Plan-level downgrades
> and removing screens do not exist in the MVP. The block is kept for a later
> phase when the portal opens up more tiers.

Applies to **removing screens**, **downgrading**, **dropping an add-on**.

> Current policy: the system **rejects** any change that would require the
> company to pay money back to the customer mid-period. A customer who has paid
> for the whole period uses the whole period.

How it works:

- Before calling Stripe, the system **previews** the invoice that the change
  would create.
- If the amount is **negative** — meaning money must be paid back to the
  customer — the operation is **rejected**, with a message stating the amount.
- Because the check runs on the preview, **nothing is changed** on rejection:
  plan, screen count, add-ons, invoice count and credit balance all stay intact.
- **There is never a negative invoice** in the history.

| Measured operation (15/30 days used) | Result |
|---|---|
| Remove screens 4 → 2 | ❌ rejected — *"would leave 15.00 USD owed back"* |
| Downgrade Pro Plus → Standard | ❌ rejected — *"would leave 10.00 USD owed back"* |
| Drop 2 add-ons to 0 | ❌ rejected — *"would leave 15.00 USD owed back"* |
| Upgrade Pro Plus → Engage | ✅ charged immediately $30.00 |

### So how does a customer reduce

There is currently **no self-service path**. Three options:

1. **Wait until the renewal date** and change it then — at that point there is no
   unused portion left, so no payback arises.
2. **Customer Support intervenes** — using the *One-off policy override* section
   on the Subscription screen, setting `create_prorations` +
   `push_to_account_balance` for that one time only. The change is applied and
   the customer receives credit; it applies only to that exact click and does
   not affect the general policy.
3. **Change the policy** for the corresponding rule to `end_of_period` — the
   change is then scheduled and takes effect exactly on the renewal date, and
   nobody has to pay anything back.

> **Business consideration:** blocking completely means a customer in financial
> difficulty cannot reduce their spending themselves and has to contact support.
> In return, the company never has to pay money back mid-period and the books
> contain no negative invoices.

## 4. Changing the billing cycle

> **MVP: in scope.** When X is ACTIVE, **both the plan and X switch together**,
> and Stripe prorates both natively; SCIO keeps Used and only adds a positive
> delta if the paid time increases. Stripe restarts billing from today, but the
> quota cycle **keeps its anchor**, so from then on the two cycles run apart.
> When X is FROZEN, only the base plan changes.

**Monthly → Annual** (the customer wants a 10% saving)
- The cycle is **recalculated from today**; the new renewal date is today + 1 year.
- The full year is charged immediately, **minus the unused part of the month**.
- Measured: Engage 1 screen, used for only 1 day → charged **$294.00** ($324 − $30).

**Annual → Monthly** (the customer wants to reduce commitment)
- Takes effect **immediately**, without waiting for the year to end.
- The unused part of the year becomes **credit**, and the first month of the
  monthly plan is charged in the same operation.
- The credit usually covers the next several months.
- Measured: Pro Plus 2 screens, annual plan $324, switched after 2 months →
  credit **$240.74**, refunded to card **$0.00**, next month's invoice **$0.00**.

---

## 5. Cancel

> **MVP: in scope.** **Cancelling the plan** (dropping to Free) takes effect at
> the end of the paid period; X runs until that point and then ends together
> with the plan. **Cancelling X alone** is different — it takes effect
> **immediately**, see section 10.

- Cancel **at the end of the paid period** — the customer uses up everything
  they bought, so **there is nothing to refund**.
- After cancelling, the account **drops to the Free plan**, keeping up to 3
  screens, and is not locked out entirely.
- A change of mind before the expiry date can be undone.
- There is an option to cancel immediately. If it is enabled, **"recalculate the
  unused portion" must be enabled with it**, otherwise the customer both loses
  the service and gets nothing back — the Billing policy page warns if this
  state occurs.

---

## 6. Trial

> **MVP: in scope.** The plan trial described below **has been built**.
>
> **X add-on trial — built** (MODEL V6 row 50): 14 days, 200 Post Updates in a
> separate ledger, once per account, Manual Refresh only, no Stripe item. See
> section 10.

- **14 days**, only for customers **without a card attached**. Anyone who has
  attached a card is charged from the start.
- During the trial every change takes effect immediately but **nothing is charged**.
- Trial ends without a card → **the subscription is cancelled**.
- The trial can be **ended early**: the system settles immediately and issues the
  first period's invoice.
- The operator can force the trial on/off for each individual creation,
  independent of the general rules.

---

## 7. Failed payments

- **When buying more:** blocked outright; no use-now-pay-later.
- **On renewal:** the invoice becomes past due, Stripe retries automatically on
  the schedule configured in the dashboard, and the subscription stays as it is.
  The app shows a warning on the account screen.
- **When scaling down:** not blocked, because no charge is needed.
- **Seasonal pause:** stops issuing invoices without losing the configuration,
  and can be resumed at any time.

---

## 8. Refunds to the card (manual Customer Support action)

This is the **only** path by which money leaves Stripe.

- Only **paid** invoices can be refunded.
- A **credit note** is issued — it both adjusts the invoice so the books/tax are
  correct and moves the money back to the card.
- **30-day window** from the invoice date; past that it is rejected, and
  exceeding it requires ticking the override box.
- **Auto-approval ceiling $500**; above that a manual override is required.
- Partial refunds are allowed.
- No refund beyond the amount actually remaining — the system deducts any
  previously refunded amount as well.

---

## 9. Constraints the system does not allow to be violated

> **MVP:** the most important constraint is that **a paid subscription is
> required to buy an add-on**. While the base plan is on trial, X cannot be
> bought yet either.

- **An add-on must have a paid plan underneath it** — at least 1 screen. Without
  a subscription no add-on can be bought, including X.
- The **Free plan allows at most 3 screens** and **may not use add-ons**.
- Per-screen add-ons (Background Music, AeriCast) **may not exceed the number of
  screens**.
- Each plan has its own minimum number of screens.
- **Reducing to 0 screens** is allowed for a seasonal pause.

---

## 10. X Social — MODEL V6

> **MVP: this is the core of the portal.** The full version with measured
> figures: **[scio-portal-mvp.md](scio-portal-mvp.md)**. Code: `backend/src/x-addon/`.

A single add-on per tenant, **quantity fixed at 1**, **$20/month or
$216/year**, 2,000 Post Updates for each fully paid quota cycle. There is no
longer a Standard/Pro tier and no longer a quantity (V6 row 48). **Quantity 0**
is only a technical state after Cancel: the same item is kept at 0 until
`AlreadyPaidUntil` so that buying again is not double-charged, and is then
cleaned up — it is not a second commercial plan (V6 row 51, EASY 5).

### Two clocks

- **Money belongs to Stripe**: X is an ordinary item, on the same subscription /
  card / interval as the base plan, **prorated natively**. There is no longer
  any manual calculation based on allowance.
- **Quota belongs to SCIO**: the quota cycle is stepped in whole months from a
  per-tenant **quota anchor** (`account.xAddon.quotaAnchor`) — the base plan's
  billing anchor at the moment X is first bought, so at first the quota cycle **is**
  the billing month (billed on the 10th → 10/09 → 10/10). The day is clamped like
  Stripe's (31/01 → 28/02 → 31/03). A base-plan interval change restarts billing
  but never moves the anchor, so from then on the two cycles run apart. Nothing
  else moves it either — a FROZEN cycle, a renewal or buying X again after
  quotaCycleEnd all keep the anchor of the first charge (MODEL V6 row 46, `xQuotaAnchorAt`).
  `Granted = floor(2,000 × paid time in the month / length of the month)`, read
  back from the X lines on **paid** invoices, taking the union of the intervals —
  no double grant when changing interval, it only increases and never decreases,
  Used is not reset, no rollover.

### Lifecycle

| | Stripe | SCIO |
|---|---|---|
| Buy | prorate to the billing boundary, charge immediately; failing card → nothing happens | reservation of 2,000 before calling Stripe; paid → commit + grant |
| Renewal | charge the new period | with aligned cycles, open the next quota cycle at 2,000 with Used 0; once the cycles run apart, add the missing delta to the same ledger |
| Cancel X | same item quantity 1 → 0, not deleted immediately; if `quotaCycleEnd < xPaidThrough` then credit `quotaCycleEnd → xPaidThrough` to the balance, otherwise no credit — the same for monthly and annual. With aligned cycles a monthly Cancel never has anything to credit; a credit arises only on annual, or after an interval change | FROZEN until the end of the quota cycle, fan-out turned off, reservation released, FrozenRemaining kept |
| Cleanup | at `AlreadyPaidUntil = min(oldPaidThrough, quotaCycleEnd)` delete the quantity-0 item with no-proration; retry for up to 24 hours then alert | only if still FROZEN, still quantity 0, and no purchase in progress |
| Buy X again | there is no restore button; it is a purchase — before `AlreadyPaidUntil` the same item goes 0 → 1 with `proration_date = AlreadyPaidUntil`, no double charge, the credited portion is debited back; from then on it prorates normally from the purchase time | before `AlreadyPaidUntil` → restore FrozenRemaining; from then on → new activation, on the anchor of the first charge |
| Change interval | native together with the base plan (only when X is ACTIVE); Stripe restarts billing | quota anchor unchanged; keep Used, positive delta if any |
| Base plan to Free / ended | end of the base plan's period | X ENDED together with the base plan |
| Payment fail | no new coverage | past paidThrough, fetching stops; once paid, the delta is added |

### Quota deduction

Based on the number of X Posts **actually returned and billed**, clamped by
Remaining, exactly-once per `actionId`. Initial / Auto / Manual share one
balance. When quota runs out, the provider is not called and no overage is
charged.

### Simulation in the demo

The **X add-on** block in the left column: status, quota cycle, Granted / Used /
Remaining, paidThrough, capacity, the *Cancel X* / *Buy X again* / *Start 14-day
trial* buttons, and the **Provider fetch** box (choose Initial/Auto/Manual, enter
*asked* and *returned*) which plays the role of the X API. API:
`/api/x-addon/:id` and `/api/x-addon/:id/sync-runs`.

Capacity is adjusted in the **Billing policy** tab → Constraints
(`xCommercialCeilingUnits`, `xProviderHardCapUnits`).

---

## Appendix A — Mapping to configuration fields

Adjusted in the **Billing policy** tab in the app. Every change is saved
immediately and the preset label switches to `custom`.

| Rule | timing | proration | anchor | payment | credit |
|---|---|---|---|---|---|
| Add screens | immediate | `always_invoice` | unchanged | `error_if_incomplete` | — |
| Upgrade | immediate | `always_invoice` | unchanged | `error_if_incomplete` | — |
| Buy add-on | immediate | `always_invoice` | unchanged | `error_if_incomplete` | — |
| Remove screens | immediate | `always_invoice` | unchanged | `error_if_incomplete` | **`block`** |
| Downgrade | immediate | `always_invoice` | unchanged | `error_if_incomplete` | **`block`** |
| Drop add-on | immediate | `always_invoice` | unchanged | `error_if_incomplete` | **`block`** |
| Monthly → Annual | immediate | `always_invoice` | **now** | `error_if_incomplete` | — |
| Annual → Monthly | immediate | `always_invoice` | **now** | `error_if_incomplete` | `push_to_account_balance` |

Besides the general rules, there is also a **per-add-on override** layer
(`addOnRules`, keyed by the add-on's code). X Social does **not** use this layer:
its buy, cancel and buy-again behaviour is settled by MODEL V6 and hard-coded in
`backend/src/x-addon/x-addon.service.ts`.

**Four ways to handle a change that produces an amount owed back to the customer:**

| Value | Behaviour | Negative invoice? |
|---|---|---|
| `block` | **in use** — rejects the operation, changes nothing | no |
| `push_to_account_balance` | allows the change, credit appears immediately on the account balance | depends on proration |
| `customer_balance` | allows the change, credit sits hidden as a pending adjustment | depends on proration |
| `refund_to_payment_method` | allows the change, real refund to the card | possibly |

A negative invoice is only produced when `proration_behavior = always_invoice`
**and** the amount comes out negative. With `block` that case is blocked
beforehand, so it never happens. With `create_prorations` Stripe does not settle
the books, so there is no invoice either.

| Other group | Current value |
|---|---|
| Cancel | end of period · no proration · to the Free plan (nothing to pay back) |
| Trial | 14 days · only without a card · trial ends without a card → cancel |
| Invoice | automatic card collection · per-second proration engine · no automatic tax |
| Refund | credit note · 30-day window · auto-approval ceiling $500 · partial refunds allowed |
| Constraint | enforce minimum quantity · **add-on requires a paid plan** · add-on ≤ screens · Free ≤ 3 screens · allow 0 |
| Allowance | X Social: 2,000 Post Updates per fully paid quota cycle (MODEL V6 row 4) — editable at runtime |
| Failed payment | let Stripe retry automatically · pause in `void` mode |

---

## Appendix B — Where to adjust

### Only adjustable in this app

The items below are **parameters of each individual API call**; Stripe has no
screen to set defaults for them:

- Whether to prorate, and after prorating whether to charge immediately or hold
  it (`proration_behavior`)
- Apply immediately or wait until the end of the period
- Whether to reset the billing cycle (`billing_cycle_anchor`)
- Whether a failing card blocks or lets it through (`payment_behavior`)
- Where credit goes: balance / refund to card / clawback
- All trial rules, the refund window, the auto-approval ceiling, and every plan
  constraint

### Must be done in the Stripe dashboard

| Task | Location in the dashboard |
|---|---|
| Retry schedule for failed payments, and what to do after the final retry | Settings → Billing → Subscriptions and emails |
| Emails to customers: receipts, failed-payment notices, renewal reminders | Settings → Billing → Subscriptions and emails |
| Invoice appearance: logo, colours, numbering, memo, footer | Settings → Billing → Invoices |
| Tax registration for automatic tax calculation | Settings → Tax |
| Accepted payment method types | Settings → Payment methods |
| Card updater, revenue recovery | Settings → Billing → Revenue recovery |

### Both places, the app overrides

| Task | Notes |
|---|---|
| **Customer Portal** | The dashboard has a default configuration, but the app creates its own configuration from the billing policy and uses that one. Click *Sync portal config* in the app to push it across. |
| **Products and price list** | Editable in the dashboard, but the app is the source of truth — running sync overwrites names/descriptions and creates a new Price if the price differs. Do not edit prices directly in the dashboard. |

### In code, no UI

| Task | File |
|---|---|
| Base price list: plans, prices, add-ons, quantity constraints | `backend/src/catalog/catalog.constants.ts` |
| Default values and the 5 presets | `backend/src/policy/policy.presets.ts` |
| List of options shown in dropdowns | `backend/src/policy/policy.fields.ts` |
| Rules for detecting invalid configurations | `backend/src/policy/policy.service.ts` |

The running configuration is stored in MongoDB, collection `billing_policies`, a
single document. Editing in the UI writes straight to it, with no redeploy needed.
