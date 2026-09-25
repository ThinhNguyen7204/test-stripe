import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BillingPolicyDoc, BillingPolicyDocument } from './policy.schema';
import { DEFAULT_PRESET_KEY, OPTISIGNS_DEFAULT, PRESETS } from './policy.presets';
import { BillingPolicyShape, ChangeRule, ChangeRuleKey, RuleOverride } from './policy.types';

const ACTIVE_KEY = 'active';

function isPlainObject(value: any): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Recursive merge so the UI can PATCH a single nested field. */
export function deepMerge<T>(base: T, patch: any): T {
  if (!isPlainObject(patch)) return (patch === undefined ? base : patch) as T;
  const out: any = { ...(base as any) };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : value;
  }
  return out as T;
}

@Injectable()
export class PolicyService implements OnModuleInit {
  private readonly logger = new Logger(PolicyService.name);

  constructor(
    @InjectModel(BillingPolicyDoc.name) private readonly model: Model<BillingPolicyDocument>,
  ) {}

  async onModuleInit() {
    const existing = await this.model.findOne({ key: ACTIVE_KEY }).exec();
    if (!existing) {
      await this.model.create({ key: ACTIVE_KEY, basedOnPreset: DEFAULT_PRESET_KEY, policy: OPTISIGNS_DEFAULT });
      this.logger.log('Seeded billing policy with the OptiSigns default preset');
    }
  }

  async getDoc(): Promise<BillingPolicyDocument> {
    const doc = await this.model.findOne({ key: ACTIVE_KEY }).exec();
    if (doc) {
      PolicyService.normalise(doc.policy);
      return doc;
    }
    return this.model.create({ key: ACTIVE_KEY, basedOnPreset: DEFAULT_PRESET_KEY, policy: OPTISIGNS_DEFAULT });
  }

  async get(): Promise<BillingPolicyShape> {
    return PolicyService.normalise((await this.getDoc()).policy);
  }

  /**
   * Policies live in Mongo, so a document written by an older build can be
   * missing fields that newer code reads. Fill those in on the way out.
   */
  static normalise(policy: BillingPolicyShape): BillingPolicyShape {
    const trial: any = policy.trial ?? {};
    if (!trial.appliesTo) {
      trial.appliesTo = trial.enabled === false ? 'never' : 'only_without_payment_method';
    }
    delete trial.enabled;
    policy.trial = trial;

    if (policy.constraints && policy.constraints.addOnsRequirePaidPlan === undefined) {
      policy.constraints.addOnsRequirePaidPlan = true;
    }
    if (!policy.addOnRules) policy.addOnRules = {};
    /*
     * Documents written under MODEL V5: the tier-change rule and the metered
     * x_social override no longer exist (V6 row 48), and the capacity guard is
     * measured in reservations against a 2.5M commercial ceiling now.
     */
    const rules: any = policy.rules ?? {};
    delete rules.addOnTierChange;
    delete (policy.addOnRules as any).x_social;
    const constraints: any = policy.constraints ?? {};
    if (constraints.xCommercialCeilingUnits === undefined) {
      constraints.xCommercialCeilingUnits = OPTISIGNS_DEFAULT.constraints.xCommercialCeilingUnits;
    }
    if (constraints.xProviderHardCapUnits === undefined) {
      constraints.xProviderHardCapUnits = OPTISIGNS_DEFAULT.constraints.xProviderHardCapUnits;
    }
    delete constraints.capacityWarnAtUnits;
    delete constraints.capacityBlockAtUnits;
    delete constraints.trialCapacityUnits;
    return policy;
  }

  async update(patch: Partial<BillingPolicyShape>): Promise<BillingPolicyDocument> {
    const doc = await this.getDoc();
    doc.policy = deepMerge(doc.policy, patch);
    doc.basedOnPreset = 'custom';
    doc.markModified('policy');
    await doc.save();
    this.logger.log('Billing policy updated');
    return doc;
  }

  async applyPreset(key: string): Promise<BillingPolicyDocument> {
    const preset = PRESETS.find((p) => p.key === key);
    if (!preset) throw new BadRequestException(`Unknown preset "${key}"`);
    const doc = await this.getDoc();
    doc.policy = JSON.parse(JSON.stringify(preset.policy));
    doc.basedOnPreset = preset.key;
    doc.markModified('policy');
    await doc.save();
    this.logger.log(`Applied billing policy preset "${key}"`);
    return doc;
  }

  async getPortalConfigurationId(): Promise<string | null> {
    return (await this.getDoc()).portalConfigurationId ?? null;
  }

  async setPortalConfigurationId(id: string): Promise<void> {
    await this.model.updateOne({ key: ACTIVE_KEY }, { $set: { portalConfigurationId: id } }).exec();
  }

  /**
   * Flags settings that silently cannot fire. A knob that looks configured but
   * is dead reads as a working feature until someone checks the money — the
   * cancellation credit is the obvious one: it can only exist if unused time is
   * prorated in the first place.
   */
  static lint(policy: BillingPolicyShape): string[] {
    const warnings: string[] = [];
    const c = policy.cancellation;

    if (c.timing === 'immediate' && !c.prorateUnusedTime && c.refundUnusedTime !== 'none') {
      warnings.push(
        `Cancellation: refundUnusedTime="${c.refundUnusedTime}" can never happen while prorateUnusedTime is off — an immediate cancellation would cut service and give nothing back.`,
      );
    }
    if (c.timing === 'at_period_end' && c.prorateUnusedTime) {
      warnings.push(
        'Cancellation: prorateUnusedTime does nothing at period end — the customer keeps the time they already paid for.',
      );
    }

    for (const [key, rule] of Object.entries(policy.rules ?? {})) {
      if (rule.prorationBehavior === 'none' && rule.creditHandling === 'block') {
        warnings.push(
          `${key}: creditHandling="block" never triggers because proration_behavior is "none" — the change is always free, so nothing is ever owed back.`,
        );
      } else if (rule.prorationBehavior === 'none' && rule.creditHandling !== 'none') {
        warnings.push(
          `${key}: creditHandling="${rule.creditHandling}" is unreachable because proration_behavior is "none" — no credit is ever created.`,
        );
      }
      if (rule.timing === 'end_of_period' && rule.prorationBehavior !== 'none') {
        warnings.push(
          `${key}: proration_behavior="${rule.prorationBehavior}" is ignored for a scheduled change — the new phase starts clean at renewal.`,
        );
      }
      if (rule.timing === 'end_of_period' && rule.billingCycleAnchor === 'now') {
        warnings.push(`${key}: billing_cycle_anchor="now" is ignored for a scheduled change.`);
      }
      if (
        rule.prorationBehavior !== 'always_invoice' &&
        rule.billingCycleAnchor !== 'now' &&
        rule.paymentBehavior !== 'allow_incomplete'
      ) {
        warnings.push(
          `${key}: payment_behavior="${rule.paymentBehavior}" has nothing to act on — this change never raises an invoice, so no payment is attempted.`,
        );
      }
    }

    if (policy.trial.appliesTo === 'never' && policy.trial.requirePaymentMethod) {
      warnings.push('Trial: requirePaymentMethod has no effect because trials are disabled (appliesTo="never").');
    }
    return warnings;
  }

  presets() {
    return PRESETS.map(({ key, name, description }) => ({ key, name, description }));
  }

  /**
   * Effective rule, layered: global rule → per-add-on override → per-request
   * override. The middle layer lets one add-on behave differently without a
   * second engine.
   */
  async resolveRule(key: ChangeRuleKey, override?: RuleOverride, addOnCode?: string): Promise<ChangeRule> {
    const policy = await this.get();
    const rule = policy.rules?.[key] ?? OPTISIGNS_DEFAULT.rules[key];

    let itemRule: Partial<ChangeRule> = {};
    if (addOnCode) {
      const kind = key === 'addOnIncrease' ? 'add' : key === 'addOnDecrease' ? 'remove' : null;
      if (kind) itemRule = policy.addOnRules?.[addOnCode]?.[kind] ?? {};
    }

    return { ...rule, ...itemRule, ...(override ?? {}) };
  }
}
