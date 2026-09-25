/**
 * The billing policy is the knob-board of this demo: it is the single place
 * that decides *how* Stripe is driven for every subscription change. Each
 * field maps directly onto a Stripe API parameter, so changing a value here
 * changes real Stripe behaviour, not just our own arithmetic.
 */

/** Stripe `proration_behavior` */
export type ProrationBehavior = 'create_prorations' | 'always_invoice' | 'none';

/** immediate = update the live subscription, end_of_period = subscription schedule */
export type ChangeTiming = 'immediate' | 'end_of_period';

/** Stripe `billing_cycle_anchor` on subscription update */
export type BillingCycleAnchorMode = 'unchanged' | 'now';

/** Stripe `payment_behavior` */
export type PaymentBehavior =
  | 'allow_incomplete'
  | 'default_incomplete'
  | 'error_if_incomplete'
  | 'pending_if_incomplete';

/**
 * What happens to money the customer has already paid but no longer owes.
 *
 * customer_balance         leave it where Stripe put it. With `always_invoice`
 *                          that is the account balance; with
 *                          `create_prorations` it stays a pending negative line
 *                          that quietly discounts the next invoice.
 * push_to_account_balance  always end up as visible account credit: the pending
 *                          proration is neutralised and the same amount is
 *                          written to `customer.balance` straight away.
 * refund_to_payment_method the money goes back to the card.
 * block                    refuse the change outright. Checked before anything
 *                          is sent to Stripe, so a rejected change leaves the
 *                          subscription exactly as it was.
 * none                     the credit is withdrawn again.
 */
export type CreditHandling =
  | 'customer_balance'
  | 'push_to_account_balance'
  | 'refund_to_payment_method'
  | 'block'
  | 'none';

export type ChangeRuleKey =
  | 'screensIncrease'
  | 'screensDecrease'
  | 'planUpgrade'
  | 'planDowngrade'
  | 'addOnIncrease'
  | 'addOnDecrease'
  | 'termToYearly'
  | 'termToMonthly';

export const CHANGE_RULE_KEYS: ChangeRuleKey[] = [
  'screensIncrease',
  'screensDecrease',
  'planUpgrade',
  'planDowngrade',
  'addOnIncrease',
  'addOnDecrease',
  'termToYearly',
  'termToMonthly',
];

export interface ChangeRule {
  /** apply now, or park the change on a subscription schedule until renewal */
  timing: ChangeTiming;
  /** create_prorations = credit/debit lines wait for the next invoice */
  prorationBehavior: ProrationBehavior;
  /** 'now' restarts the billing period and invoices the full new amount */
  billingCycleAnchor: BillingCycleAnchorMode;
  paymentBehavior: PaymentBehavior;
  /** only consulted when the change produces a negative (credit) amount */
  creditHandling: CreditHandling;
  notes?: string;
}

/**
 * Per-add-on overrides, keyed by the add-on's code. They layer on top of the
 * global rules, so one add-on can behave differently from the others without
 * forking the engine. (The X add-on does not use them: MODEL V6 fixes its
 * purchase, cancel and buy-again flows, see x-addon/x-addon.service.ts.)
 */
export interface AddOnRuleSet {
  add?: Partial<ChangeRule>;
  remove?: Partial<ChangeRule>;
}

export interface CancellationPolicy {
  timing: 'at_period_end' | 'immediate';
  /** Stripe `prorate` on cancel: credit the unused time */
  prorateUnusedTime: boolean;
  /** Stripe `invoice_now` on cancel: bill pending items straight away */
  invoiceImmediately: boolean;
  refundUnusedTime: CreditHandling;
  /**
   * true  -> the account lands on the Free plan and keeps up to
   *          `constraints.freePlanScreenCap` screens running.
   * false -> the account is deactivated: 0 screens until it subscribes again.
   */
  moveToFreePlan: boolean;
}

/** when a brand-new subscription should start on a trial */
export type TrialAppliesTo = 'always' | 'only_without_payment_method' | 'never';

export interface TrialPolicy {
  /**
   * `only_without_payment_method` mirrors OptiSigns: a 14-day trial with no
   * card, but someone who already gave a card is treated as a paying customer.
   * A caller can always override per request with `withTrial`.
   */
  appliesTo: TrialAppliesTo;
  days: number;
  /** refuse to start a trial unless a card is already on file */
  requirePaymentMethod: boolean;
  /** Stripe `trial_settings.end_behavior.missing_payment_method` */
  missingPaymentMethodBehavior: 'create_invoice' | 'cancel' | 'pause';
}

export interface InvoicingPolicy {
  collectionMethod: 'charge_automatically' | 'send_invoice';
  daysUntilDue: number;
  /** Stripe `billing_mode`: flexible = per-second prorations, classic = legacy */
  billingMode: 'flexible' | 'classic';
  automaticTax: boolean;
  defaultPaymentBehavior: PaymentBehavior;
  /** align every renewal to the 1st of the month (Stripe billing_cycle_anchor_config) */
  anchorToFirstOfMonth: boolean;
}

export interface RefundPolicy {
  /** OptiSigns return policy window */
  windowDays: number;
  /**
   * credit_note keeps the invoice/tax records straight (and can optionally move
   * money), refund only moves money on the PaymentIntent.
   */
  mode: 'credit_note' | 'refund';
  defaultReason: 'duplicate' | 'fraudulent' | 'order_change' | 'product_unsatisfactory';
  allowPartial: boolean;
  /** above this amount the API refuses and asks for a manual override flag */
  maxAutoApproveCents: number;
}

export interface ConstraintPolicy {
  enforceMinQuantity: boolean;
  /** an add-on can only exist on top of a paid plan with at least one screen */
  addOnsRequirePaidPlan: boolean;
  addOnCannotExceedScreens: boolean;
  freePlanScreenCap: number;
  /** allow reducing screens to 0 as a "seasonal pause" */
  allowZeroScreens: boolean;
  /**
   * X admission control, MODEL V6 row 17. Every tenant admitted to the X
   * add-on reserves one full quota month (2,000 Post Updates) before it is
   * charged; a purchase, including buying X again, is refused when
   * `CommercialCommitted + PendingReservations + 2,000 > xCommercialCeilingUnits`.
   * The gap up to `xProviderHardCapUnits` is the operational buffer that is
   * never sold. An interval change reserves nothing more.
   */
  enforceCapacityGuard: boolean;
  xCommercialCeilingUnits: number;
  xProviderHardCapUnits: number;
}

export interface DunningPolicy {
  /** what we do to the subscription when an invoice ends up past_due */
  pastDueBehavior: 'leave_past_due' | 'cancel' | 'pause';
  /** Stripe `pause_collection.behavior` used by the pause endpoint */
  pauseBehavior: 'void' | 'keep_as_draft' | 'mark_uncollectible';
}

export interface BillingPolicyShape {
  rules: Record<ChangeRuleKey, ChangeRule>;
  /** overrides for one add-on, keyed by its code */
  addOnRules: Record<string, AddOnRuleSet>;
  cancellation: CancellationPolicy;
  trial: TrialPolicy;
  invoicing: InvoicingPolicy;
  refunds: RefundPolicy;
  constraints: ConstraintPolicy;
  dunning: DunningPolicy;
}

/** Per-request escape hatch: override any rule field for a single call. */
export interface RuleOverride extends Partial<ChangeRule> {}
