# OptiSigns billing model (reference)

This document records how OptiSigns actually sells and bills — it is the basis
for the defaults in the demo app.

## 1. Billing unit: each screen is one licence

Every paid plan is billed **per screen / per month**. The number of screens is
exactly the `quantity` of the subscription item on Stripe. Adding screens =
increasing quantity, removing screens = decreasing quantity.

## 2. Price list (USD)

Checked directly against optisigns.com/pricing on 17/09/2026, in both Monthly
and Annual modes.

| Plan | Monthly | Annual (−10%) | Notes |
|---|---|---|---|
| Free | $0 | — | up to 3 screens, 25 basic apps, 1GB, up to 3 users, OptiSigns logo shown |
| Standard | $10.00 | $9.00 | playlists, schedules, 100+ apps, unlimited storage, up to 25 users |
| Pro Plus *(Most Popular)* | $15.00 | $13.50 | M365/Google Workspace, dashboards, OptiSync, workflows, SAML SSO, unlimited users |
| Engage | $30.00 | $27.00 | interactive kiosks, Lift & Learn, Check-In, QR scan, event-based analytics |
| Enterprise | $45.00 | $40.50 | **minimum 25 screens**, "Talk With Sales", dedicated CSM, GraphQL API, on-premise |

> **There is no "Pro" plan.** The current price list has only the 5 tiers listed
> above. Any document that mentions "Pro $12.50" contains old/incorrect
> information.

Add-ons (separate licences, attached to the base plan's subscription):

| Add-on | Unit | Monthly | Annual |
|---|---|---|---|
| Video Wall | per wall | $25.00 | $22.50 |
| Background Music | per screen | $15.00 | $13.50 |
| Wireless Presentation | per screen | $20.00 | $18.00 |
| Ads Portal | — | contact sales | — |

The annual term is exactly 10% cheaper at every tier (add-ons included); annual
prices are presented as "per screen per month, billed annually" but are
**charged once for 12 months**. The pricing page also has a currency selector
(USD/EUR/GBP/AUD/CAD).

### Scope built in the demo app

The demo app builds **Free + Standard + Pro Plus + Engage** together with all 3
add-ons. Enterprise is omitted because it is a sales channel ("Talk With Sales"),
not self-serve; adding it back only takes one entry in
`backend/src/catalog/catalog.constants.ts` (`minQuantity: 25` will be enforced
automatically).

## 3. Trial

14 days, no card required. If the trial ends without a card, the account is
deactivated and can be reactivated on the Free plan. AeriCast has its own
14-day trial with 2 licences.

## 4. Proration — the core point

### Scaling up: prorate, then **charge immediately**

This is production behaviour, **confirmed internally** (OptiSigns mentor team):
when the customer buys more — adds screens, upgrades, buys an add-on — the system
prorates for the remaining time in the period and **charges immediately at the
time of purchase**, without waiting for the next period's invoice.

In Stripe this corresponds to `proration_behavior: 'always_invoice'`. The demo
app uses exactly this configuration for all three rules `screensIncrease` /
`planUpgrade` / `addOnIncrease`, together with
`payment_behavior: 'error_if_incomplete'` so that a failing card cancels the
change rather than allowing use-now-pay-later.

### Warning: the public support article describes it differently, and describes it wrongly

The article [What if I want to increase, decrease number of screens during the
month?](https://support.optisigns.com/hc/en-us/articles/360016219114) says:

> "Our system will prorate the usage and automatically adjust your **next bill**
> with the correct amount."
>
> If you subscribed to 2 screens on Jan 10th, then on Jan 20th, add 1 more
> screen. On Feb 10th, you will get billed for:
> - $10 x 3 screens for Feb 10th - Mar 10th
> - $6.66 for 1 screen for Jan 20th - Mar 10 (prorated part)
>
> Totaled: $36.66 on Mar 10th.

**Do not use this passage as an acceptance standard.** Three problems:

1. **The charge timing differs from production** — the article says it is rolled
   into the next period's invoice; in reality it is charged immediately at
   purchase.
2. **The $6.66 figure is "30-day month" rounding** ($10 × 20/30). The cycle
   10/01 → 10/02 is **31 days** long; adding a screen on 20/01 leaves **21 days**,
   so Stripe charges $10 × 21/31 = **$6.77**, total **$36.77**. This exact
   example was rebuilt in Stripe test mode for comparison.
3. **Two editorial errors**: "On Feb 10th you will get billed" but the conclusion
   says "Totaled $36.66 on **Mar 10th**"; and the prorated line states the range
   "Jan 20th - **Mar 10**" while the 10/02 → 10/03 stretch is already on the line
   above — written that way, one month is counted twice.

### Stripe splits proration into two lines, not one

What the documentation does not say: Stripe does not "add one more screen". It
cancels the entire unused portion of the old quantity and then recharges the new
quantity for the same time span. For the example above:

```
[prorate] Unused time on 2 × Standard     -$13.55   20/01 → 10/02
[prorate] Remaining time on 3 × Standard   $20.32   20/01 → 10/02
          3 × Standard ($10.00 / month)    $30.00   10/02 → 10/03
```

The difference between the two prorated lines = $6.77, exactly one screen for 21
days.

### Scaling down: credit, not a cash refund

> "the system will automatically calculate and give you credit to the next bill
> for the unused portion of the canceled screens for the month."

The unused portion becomes credit; money is not moved back to the card. The demo
app uses `create_prorations` + `push_to_account_balance` so that the credit
appears immediately on `customer.balance` instead of sitting hidden as a pending
invoice item.

## 5. Cancel and pause

- Cancel by reducing licences to 0 or by clicking Cancel on the Subscription Plan
  page; the account can always be reactivated.
- Seasonal use case: move screens into the **OnHold** folder (they do not occupy
  a slot) and then reduce licences — equivalent to `pause_collection` on Stripe.
- The OptiSigns documentation does not state a pro-rata refund policy for
  mid-period cancellation; the default is that the remainder becomes credit, not
  cash.

## 6. Return policy

The public return policy applies to physical goods: a **30-day** window from the
purchase date, goods must be in original condition, the customer can choose full
refund / store credit / exchange, and return shipping is paid by the customer
(using the prepaid return label deducts $10). This policy does not distinguish
hardware from subscriptions and says nothing about prorated refunds for annual
plans — so in the demo, the 30-day window is used as the default for subscription
refunds and can be adjusted in the billing policy.

## Sources

- https://www.optisigns.com/pricing
- https://support.optisigns.com/hc/en-us/articles/1500000493782-Billing-How-Do-I-Change-my-Subscription-Plan
- https://support.optisigns.com/hc/en-us/articles/360016219114-What-if-I-want-to-increase-decrease-number-of-screens-during-the-month
- https://support.optisigns.com/hc/en-us/articles/17639078588691-How-to-cancel-subscription-or-pause-subscription-for-Seasonal-Use-Case
- https://support.optisigns.com/hc/en-us/articles/14502723487379-How-to-use-AeriCast-Add-on-for-Wireless-Presentation-and-Video-Conferencing
- https://www.optisigns.com/terms/return-policy
