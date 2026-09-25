# Handover context — bringing the billing mechanism to SCIO Portal

Written for whoever will integrate this mechanism into SCIO Portal. It summarises the current project,
the settled configuration, and which parts port directly / which parts must be rebuilt.

---

## 1. Project location

| | |
|---|---|
| Directory on disk | `/Users/ryanngo/Desktop/test-stripe` |
| Repo | https://github.com/quangtienngo661/test-stripe (branch `main`) |
| Backend | NestJS, port **3123** |
| Frontend | React + Vite, port **5555** |
| MongoDB | port **27099** |
| Stripe keys | `backend/.env` (**not** in the repo; template in `backend/.env.example`) |

Run: `mongod --port 27099 --dbpath ./.mongo-data`, then `npm run dev` in
`backend/` and `npm run dev` in `frontend/`. Details in
[README](../README.md) section 1.

---

## 2. What this project is, and is not

**Is:** a runnable demo where every billing rule is **configuration** rather than
code — editing the policy changes Stripe's real behaviour, not internal arithmetic.
Every number in the docs is measured from Stripe test mode.

**Is not:** a production system. There is no auth, no real metering, no
webhook secret. See section 7.

**The central idea most worth carrying over:** a single policy document in
Mongo, where each knob maps directly to a Stripe parameter. The full mapping table:
[stripe-mapping.md](stripe-mapping.md).

---

## 3. Stack

| | |
|---|---|
| NestJS | `^12.0.3` |
| Stripe SDK | `^22.6.2` → API version **`2026-08-26.dahlia`** |
| Mongoose | `^9.10.1` |
| TypeScript | `^6.0.3` (version 7 does not yet have the compiler API that the nest CLI needs) |
| React / Vite | `^19.3.0` / `^8.3.0` |

The API version matters: in `dahlia`, `current_period_*` lives on **SubscriptionItem**
rather than Subscription, and the proration flag lives at
`line.parent.subscription_item_details.proration`.

---

## 4. Settled configuration for SCIO

Choose the **`scio_portal_mvp`** preset (Billing policy tab, or
`POST /api/policy/presets/scio_portal_mvp`). Defined in
[policy.presets.ts](../backend/src/policy/policy.presets.ts).

### In-scope catalogue

| Code | Name | Monthly | Yearly | Notes |
|---|---|---|---|---|
| `standard` | Standard plan | $10.00 | $108/year | per screen |
| `x_social` | X Social | **$20.00** | **$216/year** | fixed quantity 1, 2,000 Post Updates / quota month |

### Rules (MODEL V6)

| Operation | Money (Stripe) | Quota (SCIO) |
|---|---|---|
| Buy X | prorate to the billing boundary, collect immediately, if the card fails nothing changes | reserve 2,000 first; paid → grant `floor(2,000 × paid / month)` |
| **Cancel X** | same item **quantity 1 → 0**, not deleted immediately; credit `quotaMonthEnd → xPaidThrough` only when `quotaMonthEnd < xPaidThrough`, for both monthly and yearly (with aligned cycles a monthly Cancel has nothing to credit) | FROZEN until the end of the quota month, fan-out off, FrozenRemaining kept |
| Cleanup | at `AlreadyPaidUntil = min(oldPaidThrough, quotaMonthEnd)`: delete the quantity 0 item, `proration_behavior=none`, retry for up to 24 hours | only when still FROZEN, still quantity 0, and no purchase is in progress |
| Buy X again | there is no restore button; it is a purchase — before `AlreadyPaidUntil` the same item goes 0 → 1, with no double charge | before `AlreadyPaidUntil` → restore FrozenRemaining; from then on → new activation, reusing the quantity 0 item if it still exists; past quotaMonthEnd it re-anchors to the base plan's current billing cycle |
| Change term | native together with the base plan (X ACTIVE); Stripe restarts billing | quota anchor unchanged; keep Used, only add the positive delta |
| Cancel plan | at period end, no proration | X ENDED together with the plan |

### Four hard constraints

1. A paid base plan is required before X can be bought (`addOnsRequirePaidPlan`, and the base
   plan must not be in trial)
2. X follows the base plan's interval
3. One X per tenant, commercial quantity 1 (quantity 0 is only the technical FROZEN state)
4. Capacity: `Committed + Pending + 2,000 ≤ 2,500,000` (`xCommercialCeilingUnits`)

### Out of scope

Pro Plus, Engage, adding/removing screens, Background Music, Video Wall, Wireless
Presentation, `planUpgrade`/`planDowngrade`. They remain in the system, but the MVP portal
does not touch them.

Full details: [scio-portal-mvp.md](scio-portal-mvp.md).

---

## 5. Core mechanisms to understand before porting

### Rule resolution — 3 layers

[`policy.service.ts:191`](../backend/src/policy/policy.service.ts:191)

```ts
return { ...rule, ...itemRule, ...(override ?? {}) };
//        global     per add-on family   one-off
```

The middle layer (`addOnRules`) lets an add-on behave differently **without branching
in the engine**. X Social does not use it: X's flow is hard-fixed by MODEL V6.

### X Social: two clocks

- Money: Stripe prorates natively — there is no hand-written calculation for X.
- Quota: [`quota-math.ts`](../backend/src/x-addon/quota-math.ts) — pure functions,
  replays coverage from paid invoices, quota month stepped in whole months from the tenant's
  quota anchor (`account.xAddon.quotaAnchor` = the base plan's billing anchor when X is first
  bought, kept through interval changes), true-up for the last quota month of a yearly term
  once the cycles run apart. [`x-addon.service.ts`](../backend/src/x-addon/x-addon.service.ts) — state,
  ledger, capacity, cancel / buy again / trial / quota deduction.
- The quota month starts aligned with the billing month; a base-plan interval change restarts
  Stripe's billing but not the quota cycle, so from then on the two run apart.
- Reconcile runs **on every state read** and on receiving `invoice.paid`, so a missed
  webhook only delays the grant, never loses or duplicates it.

---

## 6. Files to read, in order

1. [`policy.types.ts`](../backend/src/policy/policy.types.ts) — shape of the configuration
2. [`policy.presets.ts`](../backend/src/policy/policy.presets.ts) — settled values
3. [`subscription.util.ts:64`](../backend/src/subscriptions/subscription.util.ts:64) `classifyChange` — identifies the situation → picks the rule
4. [`subscriptions.service.ts`](../backend/src/subscriptions/subscriptions.service.ts) `change()` — entry point, branches to X when adding/removing `x_social`
5. [`x-addon/quota-math.ts`](../backend/src/x-addon/quota-math.ts) — X's quota formula
6. [`x-addon/x-addon.service.ts`](../backend/src/x-addon/x-addon.service.ts) — X lifecycle

---

## 7. Must be rebuilt in SCIO — **cannot be ported directly**

| Item | Status in the demo | What SCIO needs |
|---|---|---|
| **Real post counting** | manual input field (`POST /api/x-addon/:id/sync-runs`) | every X fetch calls the same function with the real number of X Posts returned and billed, `actionId` is the SyncRun id |
| **Compliance / fan-out** | only a `fanOut` flag | Global Batch Compliance, XAA `post.delete`, 24-hour lease outside billing |
| **Webhook** | no secret → automatic dunning does not run | configure `STRIPE_WEBHOOK_SECRET` |
| **Auth** | none, every endpoint is open | mandatory |
| **Test clock** | used to fast-forward time | not available in production; remove the `nowFor()` path or make it return real time |

---

## 8. How far it has been verified

`node scripts/verify.mjs` — **runs against real Stripe test mode**, not
mocks: plan, screens, per-unit add-ons, blocking negative invoices, the add-on-requires-plan
constraint. X Social under MODEL V6 has its own suite `node scripts/verify-x-v6.mjs` (test
clock set to the exact dates of the model's examples) and `node scripts/test-x-quota.mjs`
(quota arithmetic, no Stripe needed).

> The suite **changes the global preset** while it runs and resets to `optisigns_default` at
> the end. Do not run it while someone else is testing on the same backend.

---

## 9. Traps already hit — do not repeat them

| Trap | Consequence | How to avoid |
|---|---|---|
| Replaying coverage in the wrong order | cancelling then buying again within the same second is read as lost coverage | sort by `created` then invoice number; within one invoice negative lines first, positive lines after |
| Reading time from the machine clock | accounts with a test clock get wrong proration | every time read goes through `stripe.nowFor(testClockId)` |
| Swallowing errors when reading the subscription | a duplicate second subscription is created | only `resource_missing`/404 counts as "not there"; other errors must throw |
| With `create_prorations` the balance does not change | looks as if no credit was granted | measure by the difference in proration lines between two previews, with `proration_date` pinned |
| Confusing gross/net when refunding | once over-refunded $30 and debited twice | choose gross or net according to `prorationBehavior` |
| Test clock can only jump 2 of the shortest intervals at a time | jumping 1 year fails | split into legs (`advanceInSteps`) |

---

## 10. Related documents

- [business-rules.md](business-rules.md) — full rules, in business language
- [scio-portal-mvp.md](scio-portal-mvp.md) — detailed MVP scope
- [stripe-mapping.md](stripe-mapping.md) — each knob → Stripe parameter
- [optisigns-billing-model.md](optisigns-billing-model.md) — how OptiSigns bills
