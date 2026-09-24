import { BillingPolicyShape, ChangeRule } from './policy.types';

const rule = (r: ChangeRule): ChangeRule => r;

/**
 * Preset #1 — how OptiSigns actually behaves today.
 *
 * "Our system will prorate the usage and automatically adjust your next bill
 *  with the correct amount." -> create_prorations, never an immediate charge.
 * "If you decrease the number of subscriptions the system will give you credit
 *  to the next bill for the unused portion." -> credit sits on the customer
 *  balance and is consumed by the next invoice, no cash refund.
 */
export const OPTISIGNS_DEFAULT: BillingPolicyShape = {
  rules: {
    screensIncrease: rule({
      timing: 'immediate',
      prorationBehavior: 'always_invoice',
      billingCycleAnchor: 'unchanged',
      paymentBehavior: 'error_if_incomplete',
      creditHandling: 'customer_balance',
      notes:
        'Adding screens is paid for on the spot: Stripe invoices the new screens for the rest of the period and the change is rejected if the card declines. The renewal date is untouched. (OptiSigns itself defers this to the next bill — switch to create_prorations to match them.)',
    }),
    screensDecrease: rule({
      timing: 'immediate',
      prorationBehavior: 'create_prorations',
      billingCycleAnchor: 'unchanged',
      paymentBehavior: 'allow_incomplete',
      creditHandling: 'push_to_account_balance',
      notes: 'Unused time on removed screens becomes visible Stripe account credit, spent by the next invoice.',
    }),
    planUpgrade: rule({
      timing: 'immediate',
      prorationBehavior: 'always_invoice',
      billingCycleAnchor: 'unchanged',
      paymentBehavior: 'error_if_incomplete',
      creditHandling: 'customer_balance',
      notes:
        'Upgrading is paid for on the spot: Stripe invoices the remaining time on the new tier minus the unused time on the old one, and the upgrade is rejected if the card declines. The renewal date is untouched.',
    }),
    planDowngrade: rule({
      timing: 'immediate',
      prorationBehavior: 'create_prorations',
      billingCycleAnchor: 'unchanged',
      paymentBehavior: 'allow_incomplete',
      creditHandling: 'push_to_account_balance',
      notes: 'Downgrade takes effect now and the difference becomes Stripe account credit.',
    }),
    addOnIncrease: rule({
      timing: 'immediate',
      prorationBehavior: 'always_invoice',
      billingCycleAnchor: 'unchanged',
      paymentBehavior: 'error_if_incomplete',
      creditHandling: 'customer_balance',
      notes:
        'Buying an add-on is paid for on the spot: Stripe invoices the prorated amount immediately and the change is rejected if the card declines. The renewal date is untouched.',
    }),
    addOnDecrease: rule({
      timing: 'immediate',
      prorationBehavior: 'create_prorations',
      billingCycleAnchor: 'unchanged',
      paymentBehavior: 'allow_incomplete',
      creditHandling: 'push_to_account_balance',
      notes: 'Removing an add-on hands back visible Stripe account credit.',
    }),
    termToYearly: rule({
      timing: 'immediate',
      prorationBehavior: 'always_invoice',
      billingCycleAnchor: 'now',
      paymentBehavior: 'error_if_incomplete',
      creditHandling: 'customer_balance',
      notes: 'Switching to annual restarts the cycle and charges the 12 months up front, minus unused monthly time.',
    }),
    termToMonthly: rule({
      timing: 'immediate',
      prorationBehavior: 'always_invoice',
      billingCycleAnchor: 'now',
      paymentBehavior: 'error_if_incomplete',
      creditHandling: 'push_to_account_balance',
      notes:
        'Dropping to monthly takes effect today: the cycle restarts, the first monthly period is invoiced and the unused part of the paid year becomes Stripe account credit. No money leaves Stripe.',
    }),
  },
  addOnRules: {},
  cancellation: {
    timing: 'at_period_end',
    prorateUnusedTime: false,
    invoiceImmediately: false,
    refundUnusedTime: 'push_to_account_balance',
    moveToFreePlan: true,
  },
  trial: {
    appliesTo: 'only_without_payment_method',
    days: 14,
    requirePaymentMethod: false,
    missingPaymentMethodBehavior: 'cancel',
  },
  invoicing: {
    collectionMethod: 'charge_automatically',
    daysUntilDue: 7,
    billingMode: 'flexible',
    automaticTax: false,
    defaultPaymentBehavior: 'error_if_incomplete',
    anchorToFirstOfMonth: false,
  },
  refunds: {
    windowDays: 30,
    mode: 'credit_note',
    defaultReason: 'order_change',
    allowPartial: true,
    maxAutoApproveCents: 50000,
  },
  constraints: {
    enforceMinQuantity: true,
    addOnsRequirePaidPlan: true,
    addOnCannotExceedScreens: true,
    freePlanScreenCap: 3,
    allowZeroScreens: true,
    // MODEL V6 row 17: sell at most 2.5M of X's 3M; the 500k between is buffer.
    enforceCapacityGuard: true,
    xCommercialCeilingUnits: 2_500_000,
    xProviderHardCapUnits: 3_000_000,
  },
  dunning: {
    pastDueBehavior: 'leave_past_due',
    pauseBehavior: 'void',
  },
};

/** Preset #2 — every change is invoiced and charged on the spot. */
export const CHARGE_IMMEDIATELY: BillingPolicyShape = {
  ...OPTISIGNS_DEFAULT,
  trial: { ...OPTISIGNS_DEFAULT.trial, appliesTo: 'never' },
  rules: Object.fromEntries(
    Object.entries(OPTISIGNS_DEFAULT.rules).map(([key, value]) => [
      key,
      {
        ...value,
        timing: 'immediate',
        prorationBehavior: 'always_invoice',
        paymentBehavior: 'error_if_incomplete',
        notes: 'Change is invoiced and charged immediately.',
      },
    ]),
  ) as BillingPolicyShape['rules'],
  cancellation: {
    timing: 'immediate',
    prorateUnusedTime: true,
    invoiceImmediately: true,
    refundUnusedTime: 'customer_balance',
    moveToFreePlan: true,
  },
};

/** Preset #3 — hard annual commitment: nothing shrinks before renewal. */
export const ANNUAL_COMMITMENT: BillingPolicyShape = {
  ...OPTISIGNS_DEFAULT,
  rules: {
    ...OPTISIGNS_DEFAULT.rules,
    screensDecrease: {
      timing: 'end_of_period',
      prorationBehavior: 'none',
      billingCycleAnchor: 'unchanged',
      paymentBehavior: 'allow_incomplete',
      creditHandling: 'none',
      notes: 'Committed screens are kept until renewal.',
    },
    planDowngrade: {
      timing: 'end_of_period',
      prorationBehavior: 'none',
      billingCycleAnchor: 'unchanged',
      paymentBehavior: 'allow_incomplete',
      creditHandling: 'none',
      notes: 'Downgrade is scheduled for the renewal date.',
    },
    addOnDecrease: {
      timing: 'end_of_period',
      prorationBehavior: 'none',
      billingCycleAnchor: 'unchanged',
      paymentBehavior: 'allow_incomplete',
      creditHandling: 'none',
    },
    termToMonthly: {
      timing: 'end_of_period',
      prorationBehavior: 'none',
      billingCycleAnchor: 'unchanged',
      paymentBehavior: 'allow_incomplete',
      creditHandling: 'none',
      notes: 'The paid year runs to the end before the subscription reverts to monthly — no refund.',
    },
    planUpgrade: {
      timing: 'immediate',
      prorationBehavior: 'always_invoice',
      billingCycleAnchor: 'unchanged',
      paymentBehavior: 'error_if_incomplete',
      creditHandling: 'customer_balance',
      notes: 'Upgrades are welcome any time and billed on the spot.',
    },
  },
  cancellation: {
    timing: 'at_period_end',
    prorateUnusedTime: false,
    invoiceImmediately: false,
    refundUnusedTime: 'none',
    moveToFreePlan: true,
  },
  refunds: { ...OPTISIGNS_DEFAULT.refunds, windowDays: 0, allowPartial: false },
};

/** Preset #4 — money goes back to the card whenever the customer shrinks. */
export const CUSTOMER_FRIENDLY: BillingPolicyShape = {
  ...OPTISIGNS_DEFAULT,
  rules: {
    ...OPTISIGNS_DEFAULT.rules,
    screensDecrease: {
      ...OPTISIGNS_DEFAULT.rules.screensDecrease,
      prorationBehavior: 'always_invoice',
      creditHandling: 'refund_to_payment_method',
      notes: 'Removing screens issues a credit note and refunds the unused time to the card.',
    },
    planDowngrade: {
      ...OPTISIGNS_DEFAULT.rules.planDowngrade,
      prorationBehavior: 'always_invoice',
      creditHandling: 'refund_to_payment_method',
    },
    addOnDecrease: {
      ...OPTISIGNS_DEFAULT.rules.addOnDecrease,
      prorationBehavior: 'always_invoice',
      creditHandling: 'refund_to_payment_method',
    },
    termToMonthly: {
      timing: 'immediate',
      prorationBehavior: 'always_invoice',
      billingCycleAnchor: 'now',
      paymentBehavior: 'error_if_incomplete',
      creditHandling: 'refund_to_payment_method',
      notes: 'Annual customers can drop to monthly at any time and get the rest of the year back.',
    },
  },
  cancellation: {
    timing: 'immediate',
    prorateUnusedTime: true,
    invoiceImmediately: true,
    refundUnusedTime: 'refund_to_payment_method',
    moveToFreePlan: true,
  },
  refunds: { ...OPTISIGNS_DEFAULT.refunds, windowDays: 90, maxAutoApproveCents: 200000 },
};

/** Preset #5 — no prorations at all: changes land clean at the next renewal. */
export const NO_PRORATION: BillingPolicyShape = {
  ...OPTISIGNS_DEFAULT,
  rules: Object.fromEntries(
    Object.entries(OPTISIGNS_DEFAULT.rules).map(([key, value]) => [
      key,
      {
        ...value,
        prorationBehavior: 'none',
        billingCycleAnchor: 'unchanged',
        creditHandling: 'none',
        notes: 'Quantity changes now, money only changes at the next renewal.',
      },
    ]),
  ) as BillingPolicyShape['rules'],
};

/**
 * The subset the SCIO Portal migration sells: one Standard plan of a single
 * screen, plus X Social at either tier, on the monthly or the annual term.
 *
 * It is the default policy with the two boundaries the portal leans on written
 * out rather than left implicit: giving a tier up mid-cycle hands back the
 * unspent allowance, while cancelling hands back nothing and simply runs to the
 * end of the period.
 */
export const SCIO_PORTAL_MVP: BillingPolicyShape = {
  ...OPTISIGNS_DEFAULT,
  /*
   * Row 67: dropping the base plan to Free is a scheduled downgrade that lands
   * at the end of the base period already paid, never at the click. The X
   * add-on keeps running to that boundary and ends with it.
   */
  cancellation: {
    ...OPTISIGNS_DEFAULT.cancellation,
    timing: 'at_period_end',
    prorateUnusedTime: false,
    invoiceImmediately: false,
    refundUnusedTime: 'none',
  },
  constraints: {
    ...OPTISIGNS_DEFAULT.constraints,
    addOnsRequirePaidPlan: true,
  },
  addOnRules: {},
};

export interface PresetDef {
  key: string;
  name: string;
  description: string;
  policy: BillingPolicyShape;
}

export const PRESETS: PresetDef[] = [
  {
    key: 'scio_portal_mvp',
    name: 'SCIO Portal (MVP)',
    description:
      'The migration subset: Standard plan plus the one X Social add-on ($20/mo or $216/yr, quantity 1). Money is prorated natively by Stripe; quota is SCIO\'s, granted by paid time on a fixed calendar quota month. Cancelling X freezes it at once (monthly: no refund; yearly: credit from quotaMonthEnd). Dropping the base plan to Free lands at the end of the paid base period.',
    policy: SCIO_PORTAL_MVP,
  },
  {
    key: 'optisigns_default',
    name: 'OptiSigns default',
    description:
      'Anything the customer buys (screens, tier, add-ons) is charged on the spot; anything they give up becomes visible Stripe account credit, never a card refund.',
    policy: OPTISIGNS_DEFAULT,
  },
  {
    key: 'charge_immediately',
    name: 'Charge immediately',
    description: 'Every change generates an invoice right away (always_invoice + error_if_incomplete).',
    policy: CHARGE_IMMEDIATELY,
  },
  {
    key: 'annual_commitment',
    name: 'Annual commitment',
    description:
      'Upgrades are instant; every reduction — including yearly → monthly — waits for the renewal date via a subscription schedule, with no refund.',
    policy: ANNUAL_COMMITMENT,
  },
  {
    key: 'customer_friendly',
    name: 'Customer friendly refunds',
    description: 'Reductions issue credit notes that refund unused time back to the payment method.',
    policy: CUSTOMER_FRIENDLY,
  },
  {
    key: 'no_proration',
    name: 'No proration',
    description: 'proration_behavior=none everywhere: quantity changes now, money changes at renewal.',
    policy: NO_PRORATION,
  },
];

export const DEFAULT_PRESET_KEY = 'optisigns_default';
