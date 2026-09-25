import { CHANGE_RULE_KEYS } from './policy.types';

/** Drives the generic policy editor in the React app. */
export const POLICY_FIELD_OPTIONS = {
  timing: [
    { value: 'immediate', label: 'Immediate (update the live subscription)' },
    { value: 'end_of_period', label: 'End of period (subscription schedule)' },
  ],
  prorationBehavior: [
    { value: 'create_prorations', label: 'create_prorations — proration lines wait for the next invoice' },
    { value: 'always_invoice', label: 'always_invoice — invoice the proration right now' },
    { value: 'none', label: 'none — no proration at all' },
  ],
  billingCycleAnchor: [
    { value: 'unchanged', label: 'unchanged — keep the renewal date' },
    { value: 'now', label: 'now — restart the billing period' },
  ],
  paymentBehavior: [
    { value: 'allow_incomplete', label: 'allow_incomplete — keep the sub even if payment fails' },
    { value: 'default_incomplete', label: 'default_incomplete — wait for confirmation (SCA)' },
    { value: 'error_if_incomplete', label: 'error_if_incomplete — reject the change if payment fails' },
    { value: 'pending_if_incomplete', label: 'pending_if_incomplete — park the update until paid' },
  ],
  creditHandling: [
    { value: 'customer_balance', label: 'customer_balance — leave it where Stripe put it' },
    { value: 'push_to_account_balance', label: 'push_to_account_balance — always visible as account credit' },
    { value: 'refund_to_payment_method', label: 'refund_to_payment_method — money goes back to the card' },
    { value: 'block', label: 'block — refuse any change that would owe the customer money' },
    { value: 'none', label: 'none — no credit is given' },
  ],
  cancellationTiming: [
    { value: 'at_period_end', label: 'at_period_end — keep service until the paid period ends' },
    { value: 'immediate', label: 'immediate — stop service now' },
  ],
  refundMode: [
    { value: 'credit_note', label: 'credit_note — adjusts the invoice (and can move money)' },
    { value: 'refund', label: 'refund — only moves money on the PaymentIntent' },
  ],
  refundReason: [
    { value: 'order_change', label: 'order_change' },
    { value: 'duplicate', label: 'duplicate' },
    { value: 'fraudulent', label: 'fraudulent' },
    { value: 'product_unsatisfactory', label: 'product_unsatisfactory' },
  ],
  collectionMethod: [
    { value: 'charge_automatically', label: 'charge_automatically — card on file' },
    { value: 'send_invoice', label: 'send_invoice — invoice with due date' },
  ],
  billingMode: [
    { value: 'flexible', label: 'flexible — per-second prorations (current Stripe default)' },
    { value: 'classic', label: 'classic — legacy proration engine' },
  ],
  trialAppliesTo: [
    { value: 'only_without_payment_method', label: 'only_without_payment_method — trial when no card is on file (OptiSigns)' },
    { value: 'always', label: 'always — every new subscription starts on trial' },
    { value: 'never', label: 'never — always bill from day one' },
  ],
  trialEndBehavior: [
    { value: 'create_invoice', label: 'create_invoice — bill and let dunning handle it' },
    { value: 'cancel', label: 'cancel — end the subscription' },
    { value: 'pause', label: 'pause — pause collection' },
  ],
  pastDueBehavior: [
    { value: 'leave_past_due', label: 'leave_past_due — Stripe retries per your dunning settings' },
    { value: 'cancel', label: 'cancel — cancel the subscription' },
    { value: 'pause', label: 'pause — pause collection' },
  ],
  pauseBehavior: [
    { value: 'void', label: 'void — no invoices are created while paused' },
    { value: 'keep_as_draft', label: 'keep_as_draft — invoices pile up as drafts' },
    { value: 'mark_uncollectible', label: 'mark_uncollectible — invoices are written off' },
  ],
};

export const CONSTRAINT_LABELS: Record<string, string> = {
  enforceMinQuantity: 'Enforce each plan’s minimum screens',
  addOnsRequirePaidPlan: 'Add-ons need a paid plan underneath',
  addOnCannotExceedScreens: 'Per-screen add-ons cannot exceed the screen count',
  freePlanScreenCap: 'Free plan screen cap',
  allowZeroScreens: 'Allow reducing to zero screens',
};

export const CHANGE_RULE_LABELS: Record<string, string> = {
  screensIncrease: 'Add screens (quantity ↑)',
  screensDecrease: 'Remove screens (quantity ↓)',
  planUpgrade: 'Upgrade plan tier',
  planDowngrade: 'Downgrade plan tier',
  addOnIncrease: 'Add / increase an add-on',
  addOnDecrease: 'Remove / decrease an add-on',
  termToYearly: 'Switch monthly → yearly',
  termToMonthly: 'Switch yearly → monthly',
};

export const POLICY_FIELDS = {
  ruleKeys: CHANGE_RULE_KEYS,
  ruleLabels: CHANGE_RULE_LABELS,
  options: POLICY_FIELD_OPTIONS,
  constraintLabels: CONSTRAINT_LABELS,
};
