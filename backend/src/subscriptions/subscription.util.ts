import { BadRequestException } from '@nestjs/common';
import Stripe from 'stripe';
import { CatalogItemDocument } from '../catalog/catalog.schema';
import { BillingTerm } from '../catalog/catalog.constants';
import { ChangeRuleKey } from '../policy/policy.types';
import { ConstraintPolicy } from '../policy/policy.types';
import { AddOnRequest, ChangeClassification, DesiredState } from './subscription.types';
import { X_ADDON_CODE } from '../x-addon/quota-math';

export const FREE = 'free';

export function perUnitMonthlyCents(item: CatalogItemDocument, term: BillingTerm): number {
  return term === 'yearly' ? item.annualMonthlyCents : item.monthlyCents;
}

/** Normalised monthly contract value — used to decide upgrade vs downgrade. */
export function monthlyValue(
  plan: CatalogItemDocument,
  screens: number,
  addOns: AddOnRequest[],
  addOnItems: Map<string, CatalogItemDocument>,
  term: BillingTerm,
): number {
  let total = perUnitMonthlyCents(plan, term) * screens;
  for (const addOn of addOns) {
    const def = addOnItems.get(addOn.code);
    if (def) total += perUnitMonthlyCents(def, term) * addOn.quantity;
  }
  return total;
}

export function addOnMonthlyValue(
  addOns: AddOnRequest[],
  addOnItems: Map<string, CatalogItemDocument>,
  term: BillingTerm,
): number {
  return addOns.reduce((sum, a) => {
    const def = addOnItems.get(a.code);
    return def ? sum + perUnitMonthlyCents(def, term) * a.quantity : sum;
  }, 0);
}

export function normaliseAddOns(addOns: AddOnRequest[] | undefined): AddOnRequest[] {
  const merged = new Map<string, number>();
  for (const a of addOns ?? []) {
    if (!a?.code) continue;
    merged.set(a.code, Math.max(0, Math.floor(Number(a.quantity) || 0)));
  }
  return [...merged.entries()]
    .filter(([, quantity]) => quantity > 0)
    .map(([code, quantity]) => ({ code, quantity }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * Decides which policy rule governs this change. Only one rule can apply, so
 * the dimensions are ranked: term beats plan, plan beats screens, screens beat
 * add-ons — the same order OptiSigns' own update wizard walks through.
 */
export function classifyChange(args: {
  current: DesiredState;
  desired: DesiredState;
  plans: Map<string, CatalogItemDocument>;
  addOnItems: Map<string, CatalogItemDocument>;
}): ChangeClassification {
  const { current, desired, plans, addOnItems } = args;
  const currentPlan = plans.get(current.planCode);
  const desiredPlan = plans.get(desired.planCode);
  if (!desiredPlan) throw new BadRequestException(`Unknown plan "${desired.planCode}"`);

  const changes: string[] = [];
  const monthlyValueBefore = currentPlan
    ? monthlyValue(currentPlan, current.screens, current.addOns, addOnItems, current.term)
    : 0;
  const monthlyValueAfter = monthlyValue(desiredPlan, desired.screens, desired.addOns, addOnItems, desired.term);

  if (current.term !== desired.term) changes.push(`term ${current.term} → ${desired.term}`);
  if (current.planCode !== desired.planCode) changes.push(`plan ${current.planCode} → ${desired.planCode}`);
  if (current.screens !== desired.screens) changes.push(`screens ${current.screens} → ${desired.screens}`);

  const currentAddOns = new Map(current.addOns.map((a) => [a.code, a.quantity]));
  const desiredAddOns = new Map(desired.addOns.map((a) => [a.code, a.quantity]));
  for (const code of new Set([...currentAddOns.keys(), ...desiredAddOns.keys()])) {
    const before = currentAddOns.get(code) ?? 0;
    const after = desiredAddOns.get(code) ?? 0;
    if (before !== after) changes.push(`add-on ${code} ${before} → ${after}`);
  }

  let ruleKey: ChangeRuleKey | null = null;
  if (current.term !== desired.term) {
    ruleKey = desired.term === 'yearly' ? 'termToYearly' : 'termToMonthly';
  } else if (current.planCode !== desired.planCode) {
    const currentRank = currentPlan?.tierRank ?? 0;
    ruleKey = desiredPlan.tierRank >= currentRank ? 'planUpgrade' : 'planDowngrade';
  } else if (current.screens !== desired.screens) {
    ruleKey = desired.screens > current.screens ? 'screensIncrease' : 'screensDecrease';
  } else if (changes.length > 0) {
    const before = addOnMonthlyValue(current.addOns, addOnItems, current.term);
    const after = addOnMonthlyValue(desired.addOns, addOnItems, desired.term);
    ruleKey = after >= before ? 'addOnIncrease' : 'addOnDecrease';
  }

  const direction =
    monthlyValueAfter === monthlyValueBefore ? 'none' : monthlyValueAfter > monthlyValueBefore ? 'upgrade' : 'downgrade';

  return {
    ruleKey,
    direction,
    changes,
    currentTerm: current.term,
    monthlyValueBefore,
    monthlyValueAfter,
    /** the add-on this change concerns, for per-add-on rule overrides */
    addOnCode:
      ruleKey === 'addOnIncrease' || ruleKey === 'addOnDecrease'
        ? [...new Set([...currentAddOns.keys(), ...desiredAddOns.keys()])].find(
            (c) => (currentAddOns.get(c) ?? 0) !== (desiredAddOns.get(c) ?? 0),
          )
        : undefined,
  };
}

/** Business rules that Stripe cannot enforce for us. */
export function validateDesiredState(args: {
  desired: DesiredState;
  plan: CatalogItemDocument;
  addOnItems: Map<string, CatalogItemDocument>;
  constraints: ConstraintPolicy;
}): void {
  const { desired, plan, addOnItems, constraints } = args;

  if (desired.screens < 0) throw new BadRequestException('Screen count cannot be negative');
  if (desired.screens === 0 && !constraints.allowZeroScreens && plan.code !== FREE) {
    throw new BadRequestException('Reducing to 0 screens is disabled by the current billing policy');
  }
  if (plan.code === FREE) {
    if (desired.screens > constraints.freePlanScreenCap) {
      throw new BadRequestException(
        `The Free plan is limited to ${constraints.freePlanScreenCap} screens — pick a paid plan to go further`,
      );
    }
    if (desired.addOns.length > 0) {
      throw new BadRequestException('Add-ons require a paid plan');
    }
    return;
  }
  if (constraints.enforceMinQuantity && desired.screens > 0 && desired.screens < plan.minQuantity) {
    throw new BadRequestException(`${plan.name} requires at least ${plan.minQuantity} screens`);
  }
  if (plan.maxQuantity && desired.screens > plan.maxQuantity) {
    throw new BadRequestException(`${plan.name} allows at most ${plan.maxQuantity} screens`);
  }
  /*
   * An add-on is something bolted onto a subscription, so there has to be a
   * subscription for it to sit on. Without this a customer could hold a $30
   * add-on with no plan and no screens.
   */
  if (constraints.addOnsRequirePaidPlan && desired.addOns.length > 0 && desired.screens < 1) {
    throw new BadRequestException(
      'Add-ons sit on top of a paid plan: pick a plan with at least one screen before adding one.',
    );
  }

  for (const addOn of desired.addOns) {
    const def = addOnItems.get(addOn.code);
    if (!def) throw new BadRequestException(`Unknown add-on "${addOn.code}"`);

    // MODEL V6 row 4 / EASY 5: one X add-on per tenant, quantity exactly 1.
    if (addOn.code === X_ADDON_CODE && addOn.quantity !== 1) {
      throw new BadRequestException(
        `The X add-on is sold one per account with quantity fixed at 1 — ${addOn.quantity} was requested. There is no quantity 2 or 3 in MODEL V6.`,
      );
    }
    if (def.maxQuantity && addOn.quantity > def.maxQuantity) {
      throw new BadRequestException(`${def.name} allows at most ${def.maxQuantity}`);
    }
    // per-account add-ons are not tied to the screen count
    if (
      constraints.addOnCannotExceedScreens &&
      def.boundToScreens &&
      !def.perAccount &&
      addOn.quantity > desired.screens
    ) {
      throw new BadRequestException(
        `${def.name} is licensed per screen: ${addOn.quantity} requested for ${desired.screens} screens`,
      );
    }
  }
}

/** Reads a Stripe subscription back into our DesiredState shape. */
export function readSubscriptionState(
  sub: Stripe.Subscription,
  byPriceId: Map<string, { code: string; kind: string; term: BillingTerm }>,
): DesiredState & { baseItemId?: string; addOnItemIds: Record<string, string>; unmappedPriceIds: string[] } {
  let planCode = FREE;
  let term: BillingTerm = 'monthly';
  let screens = 0;
  let baseItemId: string | undefined;
  const addOns: AddOnRequest[] = [];
  const addOnItemIds: Record<string, string> = {};
  const unmappedPriceIds: string[] = [];

  for (const item of sub.items?.data ?? []) {
    const priceId = typeof item.price === 'string' ? item.price : item.price?.id;
    const mapped = priceId ? byPriceId.get(priceId) : undefined;
    if (!mapped) {
      // e.g. a price from a plan that has since been retired from the catalog
      if (priceId) unmappedPriceIds.push(priceId);
      continue;
    }
    if (mapped.kind === 'plan') {
      planCode = mapped.code;
      term = mapped.term;
      screens = item.quantity ?? 0;
      baseItemId = item.id;
    } else {
      addOns.push({ code: mapped.code, quantity: item.quantity ?? 0 });
      addOnItemIds[mapped.code] = item.id;
    }
  }

  return { planCode, term, screens, addOns: normaliseAddOns(addOns), baseItemId, addOnItemIds, unmappedPriceIds };
}
