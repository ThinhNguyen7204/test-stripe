import { BillingTerm } from '../catalog/catalog.constants';
import { ChangeRule, ChangeRuleKey, RuleOverride } from '../policy/policy.types';

export interface AddOnRequest {
  code: string;
  quantity: number;
}

/** What the customer wants the subscription to look like after the change. */
export interface DesiredState {
  planCode: string;
  term: BillingTerm;
  screens: number;
  addOns: AddOnRequest[];
}

export interface ChangeClassification {
  ruleKey: ChangeRuleKey | null;
  direction: 'upgrade' | 'downgrade' | 'none';
  changes: string[];
  monthlyValueBefore: number;
  monthlyValueAfter: number;
  /** the term in force before this change, needed to value what is given up */
  currentTerm?: BillingTerm;
  /** the add-on involved, used to look up per-add-on rule overrides */
  addOnCode?: string;
}

export interface ChangeExplanation {
  ruleKey: ChangeRuleKey | null;
  rule: ChangeRule | null;
  classification: ChangeClassification;
  stripeCall: string;
  stripeParams: Record<string, any>;
  humanSummary: string[];
}

export interface ChangeRequest extends DesiredState {
  /** one-off overrides of the policy rule, for "what if" testing */
  overrides?: RuleOverride;
  /** skip the policy and force a specific rule key (demo tooling) */
  forceRuleKey?: ChangeRuleKey;
  /**
   * Explicitly start (or skip) a trial on a brand-new subscription.
   * Omit to let the billing policy decide.
   */
  withTrial?: boolean;
}
