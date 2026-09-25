# SCIO Portal — MVP scope

The detailed version for the migration to SCIO Portal. The system's full rules live in
[business-rules.md](business-rules.md); this file only covers **which parts are carried over**
and how those parts work.

> **Scope settled (MODEL V6):** the portal sells the **Standard plan** and **one X add-on**
> ($20/month or $216/year, **fixed quantity 1**, at most one per tenant), running
> **both monthly and yearly**. Money is managed by **Stripe** and prorated natively; quota is managed by
> **SCIO** on a **quota month stepped from a per-tenant anchor** (the base plan's billing
> anchor at first purchase). Source: sheet *Suggestion* → tab **MODEL V6**.

> **Operator decision, 2026-09-25.** Anchoring the quota month to the base plan's billing anchor
> departs from the example in MODEL V6 row 46, which reads the quota month as the calendar month
> (the 1st at 00:00 UTC). Row 47's second example (129 + 266) and row 59's credit example are
> therefore **not reproduced**; section 8 shows what the same inputs measure under the anchored rule.

Every "measured" number below comes from `node scripts/verify-x-v6.mjs` run against
Stripe test mode with the test clock set to the exact dates of the MODEL V6 examples.

---

## 1. Catalogue

| Item | Monthly | Yearly | Quota |
|---|---|---|---|
| **Standard plan** | $10.00 / screen | $108 / screen / year | — |
| **X Social** | **$20.00** | **$216.00** ($20 × 12 × 90%) | **2,000 Post Updates** per fully paid quota month |

There is no longer X Social Standard / Pro, and no more increasing or decreasing quantity (V6 row 48).
The commercial quantity is only 1 (EASY 5). Quantity 0 is valid only as the technical
FROZEN state after Cancel, within the old paid window. Reconcile checks: quantity 1 must
match ACTIVE, quantity 0 must match FROZEN + a cleanup date; on a mismatch it locks the
entitlement, logs a warning, corrects it (quantity > 1 back to 1, or 0 if cancelled) and
grants no additional quota.

---

## 2. Two clocks

| | Stripe | SCIO |
|---|---|---|
| What it manages | money, invoices, credit, proration, billing anchor | quota month, Granted / Used / Remaining |
| Anchor | the subscription's billing day (can be the 05th, 20th…); an interval change restarts it (`billing_cycle_anchor=now`) | the tenant's **quota anchor** (`account.xAddon.quotaAnchor`) = the base plan's `billing_cycle_anchor` when X is first bought; stepped in whole months, day clamped like Stripe (31/01 → 28/02 → 31/03) |
| Source of truth | invoice preview / paid invoices | quota ledger (`x_quota_ledgers`) |

The quota month therefore **starts aligned with the billing month** (billed on the 10th → quota month
10/09 → 10/10). A base-plan interval change restarts Stripe's billing but **never moves the quota
anchor**, so from then on the two cycles run apart (section 9). A FROZEN tenant keeps its anchor;
buying X again after quotaMonthEnd (CANCELED) is a new activation and re-anchors to the base plan's
**current** billing cycle.

```
GrantedTarget(Q) = floor(2,000 × PAID seconds within Q / number of seconds in Q)
Remaining        = max(0, Granted − Used)
```

- "Paid" is read back from **the X lines on `paid` invoices**, taking the **union** of the
  intervals. A time interval paid twice (monthly then switched to yearly) is counted only
  once — never granted twice.
- Granted **only increases**: renewal, payment retry, and interval change only add a positive
  delta, **never reset Used**.
- Past each quota boundary there is a new ledger; the unused part of the old month is **lost**, no rollover.
- With aligned cycles a paid yearly term is **12 whole quota months of 2,000 = 24,000**.
- Discounts / coupons do not reduce quota: quota follows the **time** paid, not
  the amount paid (row 54).

---

## 3. Hard constraints

1. **A paid base plan is required.** While the base plan is on a Stripe trial, X cannot
   be bought. X is added to an **existing subscription**, not bundled in when creating a new
   subscription (row 51).
2. **X follows the base plan's interval.** There is no monthly plan + yearly X state.
3. **Buying / cancelling / buying X again happen on their own**, not combined with other changes — each operation
   has its own proration point, reservation and payment gate.
4. **Capacity** (row 17): before calling Stripe, the tenant holds a 2,000 reservation
   (TTL 15 minutes). Only sell when `Committed + Pending + 2,000 ≤ 2,500,000`; on paid it
   commits, on fail / expiry it releases. The 500,000 up to the 3,000,000 hard cap is an unsold
   buffer. Changing interval does not reserve more.

---

## 4. Buying X

Stripe prorates from the purchase time to the billing boundary and **collects immediately** (`always_invoice`,
`error_if_incomplete`). If the card fails, Stripe refuses: no item, no quota,
the reservation is released. Quota only opens **after the invoice is paid**.

**Measured** — base plan anchored on the 01st, X bought on 15/09:

| | |
|---|---|
| Stripe collects | **$10.67** ($20 × 16/30) |
| Quota month 01/09 → 01/10 | floor(2,000 × 16/30) = **1,066** |
| On 01/10, renewal paid | new ledger **2,000**, Used = 0 |

---

## 5. The quota month follows the billing anchor

**Measured** — bought on 10/09 (billing anchored on the 10th):

| Point in time | Quota |
|---|---|
| 10/09 | bought at the start of the billing month: quota month **10/09 → 10/10**, the whole **2,000** |
| 02/10 (before renewal) | still the same quota month, still **2,000** — no calendar split at 01/10, no "paid through" warning |
| 10/10 renewal paid | the next quota month 10/10 → 10/11 opens at **2,000**, Used 0 |
| 10/11 renewal **fails** | the quota month 10/11 → 10/12 has no paid time → **0** granted (row 53); PAYMENT_PENDING, no fetch |
| invoice gets paid on retry | ACTIVE, the month granted **2,000**, Used 0 (EASY 4) |

---

## 6. Quota deduction

- Deduct by the number of X Posts **actually returned and billed**: ask for 50, X returns 12 → deduct **12**
  (row 12). X returns 0 → deduct 0 (EASY 2).
- Exactly-once per `actionId`; every deduction is **clamped** by Remaining.
- Initial / Auto / Manual and Profile Source creation use **one shared balance**; there is
  no longer AutoPool / ManualBalance / Daily Hard Cap.
- When Remaining = 0, the **provider is not called**, and no overage is charged. Warnings at 80%
  and 100%.

---

## 7. Cancelling X — takes effect immediately

The tenant is **FROZEN** and fan-out is turned off **immediately**; the base plan does not change. On Stripe **the same X
item is kept, quantity 1 → 0** — not deleted immediately (row 49, row 51).
**FrozenRemaining** (Granted / Used / Remaining) is kept until the end of the quota month.
The capacity reservation is released.

**Money — one rule for both Monthly and Yearly** (row 49, row 7): only credit the
coverage that is **paid but for which SCIO has not yet granted quota**, i.e. `quotaMonthEnd → xPaidThrough`,
and only when that interval exists. The running quota month has already "funded" GrantedTarget, so it is
**never credited**. With the quota month equal to the billing month, a **Monthly** Cancel never has
future coverage to credit (`quotaMonthEnd = xPaidThrough`); a credit arises only on Yearly, or after an
interval change has moved billing away from the quota cycle.

| Condition | Stripe |
|---|---|
| `quotaMonthEnd < xPaidThrough` | quantity 1 → 0, `proration_date = quotaMonthEnd`, `always_invoice` → credit `quotaMonthEnd → xPaidThrough` to the **customer balance** |
| `quotaMonthEnd ≥ xPaidThrough` | quantity 1 → 0, `proration_behavior = none` — no future coverage, **no credit** |

**How long the quantity 0 item is kept:** `AlreadyPaidUntil = min(oldPaidThrough, quotaMonthEnd)`.
At that point the backend runs **cleanup**: deletes the item with `proration_behavior = none` (no
money moves anywhere), runs right at that point and retries for up to **24 hours**, and alerts once overdue. Cleanup
only runs when the item is still quantity 0, the tenant is still FROZEN, and no purchase is holding
the tenant's lock — buying again and cleanup never modify the same item at the same time (row 8).

**Measured:**

| Case | Result |
|---|---|
| Monthly, billing anchored on the 1st, cancelled 10/09 | paid until 01/10 = quotaMonthEnd → **no credit**; item quantity 0 until 01/10 |
| Monthly, billing 20/09 → 20/10, cancelled 25/09 | quotaMonthEnd 20/10 = xPaidThrough → **no credit** ($0.00); the quota month 20/09 → 20/10 stays granted (2,000) and FROZEN; item quantity 0 until 20/10 |
| Yearly bought 05/09/2026 (quota month 05/09 → 05/10 = **2,000**), cancelled 20/09 | credit **$198.25** for 05/10/2026 → 05/09/2027; item quantity 0 until 05/10 |
| Cleanup blocked (test switch `xCleanupPaused`) | item stays quantity 0, retried on every reconcile; more than 24 hours past the point → alert `x.cleanup_overdue` |

**The `$0` line.** The Cancel receipt has a `$0` line "remaining time on 0 × X". When
`AlreadyPaidUntil` coincides exactly with the renewal date (every Monthly Cancel while the cycles are aligned,
since `AlreadyPaidUntil = xPaidThrough`), Stripe renews **before** cleanup gets to run, so that renewal
also has a `$0` X line. The **next** renewal after cleanup has no X line at all. A
quantity 0 line is never counted as paid coverage.

---

## 8. Buying X again after Cancel

**There is no separate restore button** (row 59). To use it again, the user **buys X again** — turns X
back on or uses the *Buy X again* button — and the backend handles it as a purchase (reservation first).
FrozenRemaining only reopens **after payment succeeds**; if the card fails it stays FROZEN.

- **Before `AlreadyPaidUntil`** (the quantity 0 item is still there): **same item 0 → 1** with
  `proration_date = AlreadyPaidUntil`. Restores FrozenRemaining, and the portal states that it **still
  expires at quotaMonthEnd**; the already-paid interval is not charged again; the coverage credited at
  cancel is debited back by Stripe from exactly that point. If that point is the end of the billing period itself, then
  there is no interval left to prorate — `proration_behavior = none`, Stripe collects at renewal.
- **From `AlreadyPaidUntil` onwards:** new activation, Stripe prorates normally from the purchase
  time to the end of the period; reuses the quantity 0 item if cleanup has not run, otherwise creates a new
  item. That month's quota is granted according to paid coverage.

| Case (measured) | Result |
|---|---|
| Monthly anchored on the 1st, cancelled 10/09, bought again 15/09 | same item 0 → 1, `proration_behavior=none`, **no invoice**; restores **2,000 / Used 300** |
| Row 59 example 1 — billing 20/09 → 20/10 (= the quota month), cancelled 25/09 (**no credit**), bought again **27/09** | same item 0 → 1, already paid until 20/10 → `proration_behavior=none`, **no invoice**; FrozenRemaining **2,000 / Used 40** in use again until 20/10 |
| Anchored on the 5th, bought 30/08, cancelled 02/09, bought again 04/09 | `AlreadyPaidUntil` = 05/09 = period end → same item, nothing charged now, no invoice, restores **387 / Used 50**; on 05/09 X renews and is charged normally (invoice **$30.00**) and the next quota month 05/09 → 05/10 opens at **2,000**, Used 0 |
| Yearly bought 05/09, cancelled 20/09, bought again 25/09 | same item, invoice **$198.25** from 05/10, paid from the balance (**$0.00** due, no card charge); the quota month 05/09 → 05/10 still 2,000, coverage one continuous year 05/09/2026 → 05/09/2027 |
| Row 59 example 2 — billing on the 20th, cancelled 25/09, bought again **25/10** | item already cleaned up at `AlreadyPaidUntil` 20/10 → new item, charged **$16.77** for 25/10 → 20/11; the new activation follows the base cycle: quota month 20/10 → 20/11 granted floor(2,000 × 26/31) = **1,677** |
| Billing on the 20th, cancelled 25/09, cleanup has not been able to run, bought again 21/10 02:00 | new activation on the **same quantity 0 item**, charged **$19.30** (21/10 02:00 → 20/11), the quota month 20/10 → 20/11 granted **1,930** |
| Monthly anchored on the 1st, cancelled 20/09, bought again **05/10** concurrently with three state reads | exactly **one** X item with quantity 1, charged **$17.42** once (05/10 → 01/11), October granted **1,741** |

**Row 47 example 2 under the anchored rule:** bought 30/08 with billing anchored on the 5th → one
quota month 05/08 → 05/09, floor(2,000 × 6/31) = **387**. 01/09 is no boundary: on 02/09 it is still
the same quota month at 387, not split into the sheet's 129 + 266 (not reproduced, see the note at the top).

---

## 9. Changing interval

- **X ACTIVE:** Monthly ⇄ Yearly takes effect immediately after payment, Stripe prorates
  natively **both the base plan and X**. SCIO keeps the quota month and Used, and only increases Granted if
  the union coverage increases. Stripe restarts billing (`billing_cycle_anchor = now`), but the
  quota month **keeps its anchor**. Measured: bought 15/09 on a base plan billed on the 15th (quota month
  15/09 → 15/10, **2,000**), switched to yearly on 20/09 → X prorated by Stripe (**−$16.67** for the unused monthly time, **$216.00** for the year),
  billing restarted on 20/09, but the quota month is still 15/09 → 15/10, still **2,000** (no second
  grant), Used 100 kept, paid coverage now runs to 20/09/2027.
- **The two cycles run apart from then on.** Measured: billing is one yearly period 20/09/2026 →
  20/09/2027, while the quota months stay monthly on the 15th — 15/10 → 15/11 is paid by the year and
  opens as a fresh **2,000**, Used 0.
- **X FROZEN, quantity 0 item still there:** the item switches to the new interval's price
  but **keeps `quantity = 0` — passed explicitly**, because changing the price without stating quantity makes
  Stripe reset the quantity. X is not charged / credited, stays frozen, and does not auto-activate
  (row 64, CASE 9). **This move is its own request, sent first with `proration_behavior = none`.**
  Measured: after a Cancel with a future `proration_date`, Stripe still counts the item at quantity 1
  up to that date, so a single request that also restarts the base plan's period — even one that
  leaves X out — credits X for now → quotaMonthEnd (**−$4.73** on a $216 year), time that funded the
  current quota month. Moved on its own first, the base plan's change carries no X line. Measured end
  to end (anchor 15/09): yearly cancelled 22/09, switched to monthly 23/09 → quantity 0 item on the
  monthly price, X **$0.00**; bought again 24/09 on the same item, charged from quotaMonthEnd 15/10 to
  23/10 at $20/month = **$5.33**; the frozen quota month 15/09 → 15/10 comes back unchanged at
  **2,000 / Used 100**, on the original anchor.
- **X FROZEN, item already cleaned up:** only the base plan changes, no X is added. Buying X again
  afterwards uses the base plan's current interval (and, once past quotaMonthEnd, re-anchors to its
  current billing cycle).

---

## 10. Base plan downgraded to Free / ending

Downgrading the base plan to Free is a **scheduled downgrade** at the end of the base plan's paid period, with no
proration (row 67). X keeps running until that boundary; the last quota month is granted by the paid
coverage up to the boundary (measured: plan anchored on the 10th, downgrade scheduled for 10/10 → the
quota month 10/09 → 10/10 is paid in full, **2,000**), and at the boundary X becomes **ENDED** together
with the base plan and the capacity is released (row 55).

---

## 11. Trials

- **Plan trial** — 14 days for customers without a card attached (unchanged).
- **X trial** (row 50) — **14 days / 200 Post Updates** in a separate trial
  ledger, **once per account**, **Manual Refresh only**, no Stripe item,
  no rollover. Buying X ends the trial, and the trial balance is **not** carried over.

---

## 12. What is **outside** this billing demo

| | Reason |
|---|---|
| Global Batch Compliance, XAA `post.delete`, 24-hour compliance lease | the sync/compliance part, not billing — the demo only keeps the fan-out flag |
| Profile cap 10 / tenant, canonical Source | lives in the X App layer, not in billing |
| Calling the real X API | the provider fetch is a manual `returned` input field |
| Pro Plus, Engage, adding / removing screens, per-unit add-ons | still in the system, not sold by the MVP portal |
