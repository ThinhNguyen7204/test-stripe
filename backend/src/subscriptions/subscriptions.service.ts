import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import Stripe from 'stripe';
import { AccountDocument } from '../accounts/account.schema';
import { AccountsService } from '../accounts/accounts.service';
import { BillingService } from '../billing/billing.service';
import { CatalogService } from '../catalog/catalog.service';
import { CatalogItemDocument } from '../catalog/catalog.schema';
import { BillingTerm } from '../catalog/catalog.constants';
import { EventsService } from '../events/events.service';
import { PolicyService } from '../policy/policy.service';
import { ChangeRule, ChangeRuleKey } from '../policy/policy.types';
import { StripeService } from '../stripe/stripe.service';
import { X_ADDON_CODE } from '../x-addon/quota-math';
import { SyncKind, XAddonService, XSubscriptionContext } from '../x-addon/x-addon.service';
import { ChangeRequest, DesiredState } from './subscription.types';
import {
  FREE,
  classifyChange,
  normaliseAddOns,
  perUnitMonthlyCents,
  readSubscriptionState,
  validateDesiredState,
} from './subscription.util';

interface CatalogMaps {
  plans: Map<string, CatalogItemDocument>;
  addOnItems: Map<string, CatalogItemDocument>;
  byPriceId: Map<string, { code: string; kind: string; term: BillingTerm }>;
}

const ACTIVE_STATUSES = ['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused'];

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    private readonly accounts: AccountsService,
    private readonly catalog: CatalogService,
    private readonly policy: PolicyService,
    private readonly stripe: StripeService,
    private readonly events: EventsService,
    private readonly billing: BillingService,
    private readonly xAddon: XAddonService,
  ) {}

  // ------------------------------------------------------------- catalog map

  private async catalogMaps(): Promise<CatalogMaps> {
    const items = await this.catalog.list();
    const plans = new Map<string, CatalogItemDocument>();
    const addOnItems = new Map<string, CatalogItemDocument>();
    const byPriceId = new Map<string, { code: string; kind: string; term: BillingTerm }>();

    for (const item of items) {
      if (item.kind === 'plan') plans.set(item.code, item);
      else addOnItems.set(item.code, item);
      if (item.monthlyPrice?.priceId) {
        byPriceId.set(item.monthlyPrice.priceId, { code: item.code, kind: item.kind, term: 'monthly' });
      }
      if (item.yearlyPrice?.priceId) {
        byPriceId.set(item.yearlyPrice.priceId, { code: item.code, kind: item.kind, term: 'yearly' });
      }
    }
    return { plans, addOnItems, byPriceId };
  }

  /**
   * Reads the live subscription.
   *
   * Returning null here means "this account has no subscription", and callers
   * act on that by creating one. So a read that merely *failed* — a timeout, a
   * rate limit, a 5xx — must never come back as null: that would silently bill
   * the customer for a second subscription. Only a subscription Stripe says is
   * gone counts as absent.
   */
  private async loadSubscription(account: AccountDocument): Promise<Stripe.Subscription | null> {
    if (!account.stripeSubscriptionId) return null;
    try {
      return await this.stripe.client.subscriptions.retrieve(account.stripeSubscriptionId, {
        expand: ['schedule', 'latest_invoice'],
      });
    } catch (err: any) {
      const code = err?.raw?.code ?? err?.code;
      const status = err?.raw?.statusCode ?? err?.statusCode;
      if (code === 'resource_missing' || status === 404) {
        this.logger.warn(`Subscription ${account.stripeSubscriptionId} no longer exists in Stripe`);
        return null;
      }
      this.logger.error(`Could not read subscription ${account.stripeSubscriptionId}: ${err.message}`);
      throw new ServiceUnavailableException(
        `Stripe did not answer for subscription ${account.stripeSubscriptionId} (${err.message}). Nothing was changed — retry in a moment.`,
      );
    }
  }

  private currentStateOf(account: AccountDocument, sub: Stripe.Subscription | null, maps: CatalogMaps): DesiredState {
    if (sub && ACTIVE_STATUSES.includes(sub.status)) {
      const state = readSubscriptionState(sub, maps.byPriceId);
      return { planCode: state.planCode, term: state.term, screens: state.screens, addOns: state.addOns };
    }
    return { planCode: FREE, term: account.term ?? 'monthly', screens: 0, addOns: [] };
  }

  // -------------------------------------------------------------- item build

  /** A cancelled X add-on's item, kept at quantity 0 until AlreadyPaidUntil (MODEL V6 rows 49, 51). */
  private parkedXItem(sub: Stripe.Subscription | null, maps: CatalogMaps): Stripe.SubscriptionItem | null {
    return (
      sub?.items?.data.find(
        (i) => i.quantity === 0 && maps.byPriceId.get(typeof i.price === 'string' ? i.price : i.price?.id)?.code === X_ADDON_CODE,
      ) ?? null
    );
  }

  private async buildItems(
    desired: DesiredState,
    sub: Stripe.Subscription | null,
    maps: CatalogMaps,
    opts: { omitParkedX?: boolean } = {},
  ): Promise<Stripe.SubscriptionUpdateParams.Item[]> {
    const existing = sub ? readSubscriptionState(sub, maps.byPriceId) : null;
    const items: Stripe.SubscriptionUpdateParams.Item[] = [];

    const basePriceId = await this.catalog.priceIdFor(desired.planCode, desired.term);
    items.push(
      existing?.baseItemId
        ? { id: existing.baseItemId, price: basePriceId, quantity: desired.screens }
        : { price: basePriceId, quantity: desired.screens },
    );

    const desiredMap = new Map(desired.addOns.map((a) => [a.code, a.quantity]));
    const existingIds = existing?.addOnItemIds ?? {};
    const codes = new Set<string>([...desiredMap.keys(), ...Object.keys(existingIds)]);

    for (const code of codes) {
      const quantity = desiredMap.get(code) ?? 0;
      const itemId = existingIds[code];
      const existingQuantity = sub?.items?.data.find((i) => i.id === itemId)?.quantity;
      if (quantity > 0) {
        const priceId = await this.catalog.priceIdFor(code, desired.term);
        items.push(itemId ? { id: itemId, price: priceId, quantity } : { price: priceId, quantity });
      } else if (itemId && code === X_ADDON_CODE && existingQuantity === 0 && opts.omitParkedX) {
        // already moved to the new price on its own, with no proration — see moveParkedX()
        continue;
      } else if (itemId && code === X_ADDON_CODE && existingQuantity === 0) {
        /*
         * MODEL V6 rows 60, 64, CASE 9: a cancelled X add-on keeps its item at
         * quantity 0 until AlreadyPaidUntil. It follows the new interval's price
         * but stays at 0 — stated explicitly, because a price change otherwise
         * resets quantity — so it is neither charged, credited nor switched back
         * on. Deleting it here would take away what buying X again reuses.
         */
        const priceId = await this.catalog.priceIdFor(code, desired.term);
        items.push({ id: itemId, price: priceId, quantity: 0 });
      } else if (itemId) {
        items.push({ id: itemId, deleted: true });
      }
    }

    return items;
  }

  /**
   * MODEL V6 rows 60, 64, CASE 9: while FROZEN, an interval change moves the
   * quantity-0 X item to the new price with no proration, and X is neither
   * charged nor credited.
   *
   * It has to be its own request. Measured on Stripe test mode: after a Cancel
   * set the item 1 → 0 with a future proration_date (quotaMonthEnd), Stripe
   * still counts it at quantity 1 up to that date, so any change that restarts
   * the billing period — even one that leaves the X item out — credits X for
   * now → quotaMonthEnd, a stretch that funded this quota month. Moving the X
   * item first with proration_behavior=none clears that, and the base plan's
   * change that follows carries no X line at all.
   */
  private async moveParkedX(account: AccountDocument, sub: Stripe.Subscription, maps: CatalogMaps, term: BillingTerm) {
    const parked = this.parkedXItem(sub, maps);
    if (!parked) return null;
    const price = await this.catalog.priceIdFor(X_ADDON_CODE, term);
    const before = typeof parked.price === 'string' ? parked.price : parked.price.id;
    if (before === price) return null;
    const params: Stripe.SubscriptionUpdateParams = { items: [{ id: parked.id, price, quantity: 0 }], proration_behavior: 'none' };
    await this.stripe.call('subscriptions.update (frozen X: new interval price, quantity 0, no proration)', () =>
      this.stripe.client.subscriptions.update(sub.id, params),
    );
    await this.events.record({
      accountId: account.id,
      action: 'x.frozen_interval_moved',
      summary: `Frozen X item ${parked.id} moved to the ${term} price at quantity 0 with proration_behavior=none — X is neither charged nor credited (MODEL V6 rows 60, 64).`,
      stripeRequest: params as any,
    });
    return { itemId: parked.id, previousPrice: before };
  }

  // ------------------------------------------------------------------- X

  private xContext(sub: Stripe.Subscription | null, term: BillingTerm): XSubscriptionContext {
    return { sub, term, periodEnd: sub ? StripeService.periodEnd(sub) : null };
  }

  /** Whether this change takes the X add-on on or gives it up. */
  private xMove(current: DesiredState, desired: DesiredState): 'add' | 'remove' | null {
    const had = current.addOns.some((a) => a.code === X_ADDON_CODE);
    const wants = desired.addOns.some((a) => a.code === X_ADDON_CODE);
    if (had === wants) return null;
    return wants ? 'add' : 'remove';
  }

  /** Anything besides the X add-on that the change would also move. */
  private movesMoreThanX(current: DesiredState, desired: DesiredState): boolean {
    const others = (state: DesiredState) =>
      JSON.stringify({
        planCode: state.planCode,
        term: state.term,
        screens: state.screens,
        addOns: state.addOns.filter((a) => a.code !== X_ADDON_CODE),
      });
    return others(current) !== others(desired);
  }

  /*
   * MODEL V6 fixes how the X add-on is bought, cancelled and bought again (rows 49,
   * 51, 59): each has its own proration boundary, a capacity reservation and a
   * paid gate. Folding one of them into an unrelated change would put the X
   * item under that change's proration rule instead, so they travel alone.
   */
  private assertXAlone(current: DesiredState, desired: DesiredState) {
    if (this.movesMoreThanX(current, desired)) {
      throw new BadRequestException(
        'Add or cancel the X add-on on its own: it has its own proration boundary, capacity reservation and paid gate (MODEL V6 rows 49, 51, 59). Apply the other changes first, then the X add-on.',
      );
    }
  }

  private async liveContext(account: AccountDocument) {
    const maps = await this.catalogMaps();
    const loaded = await this.loadSubscription(account);
    const sub = loaded && ACTIVE_STATUSES.includes(loaded.status) ? loaded : null;
    const current = this.currentStateOf(account, sub, maps);
    return { maps, sub, current, ctx: this.xContext(sub, current.term) };
  }

  async cancelX(accountId: string) {
    const account = await this.accounts.get(accountId);
    const { maps, ctx } = await this.liveContext(account);
    const updated = await this.xAddon.cancel(account, ctx);
    await this.syncAccountFromSubscription(account, updated, maps);
    return { applied: 'x_cancel', state: await this.getState(accountId) };
  }

  async previewX(accountId: string, action: 'purchase' | 'cancel') {
    const account = await this.accounts.get(accountId);
    const { ctx } = await this.liveContext(account);
    if (action === 'cancel') return this.xAddon.previewCancel(account, ctx);
    return this.xAddon.previewPurchase(account, ctx);
  }

  async startXTrial(accountId: string) {
    const account = await this.accounts.get(accountId);
    const { ctx } = await this.liveContext(account);
    await this.xAddon.startTrial(account, ctx);
    return this.getState(accountId);
  }

  async recordXSyncRun(
    accountId: string,
    body: { kind?: SyncKind; returned?: number; requested?: number; actionId?: string },
  ) {
    const account = await this.accounts.get(accountId);
    const { ctx } = await this.liveContext(account);
    const run = await this.xAddon.recordSyncRun(account, ctx, body ?? {});
    return { run, state: await this.getState(accountId) };
  }

  async xSnapshot(accountId: string) {
    const account = await this.accounts.get(accountId);
    const loaded = await this.loadSubscription(account);
    const maps = await this.catalogMaps();
    const current = this.currentStateOf(account, loaded, maps);
    return this.xAddon.snapshot(account, this.xContext(loaded, current.term));
  }

  // ------------------------------------------------------------------ state

  async getState(accountId: string) {
    const account = await this.accounts.get(accountId);
    const maps = await this.catalogMaps();
    const sub = await this.loadSubscription(account);
    const policy = await this.policy.get();

    let schedule: Stripe.SubscriptionSchedule | null = null;
    if (sub?.schedule) {
      schedule = typeof sub.schedule === 'string'
        ? await this.stripe.client.subscriptionSchedules.retrieve(sub.schedule)
        : sub.schedule;
    }

    const state = this.currentStateOf(account, sub, maps);
    const mrr = await this.monthlyValueOf(state, maps);

    /*
     * Things the operator should know about but that are not errors: settings
     * Stripe only honours at creation time, prices that vanished from the
     * catalog, and subscriptions parked waiting for a payment confirmation.
     */
    const warnings: string[] = [];
    if (sub) {
      const subBillingMode = (sub as any).billing_mode?.type;
      if (subBillingMode && subBillingMode !== policy.invoicing.billingMode) {
        warnings.push(
          `This subscription runs on billing_mode="${subBillingMode}" while the policy says "${policy.invoicing.billingMode}". Stripe fixes billing_mode at creation time — only new subscriptions pick up the change.`,
        );
      }
      if (sub.status === 'incomplete') {
        warnings.push(
          'The first payment has not been confirmed yet (payment_behavior=default_incomplete). Open the hosted invoice to complete it, or set payment_behavior to error_if_incomplete in the policy.',
        );
      }
      if (sub.status === 'past_due' || sub.status === 'unpaid') {
        warnings.push(`Collection failed — the subscription is ${sub.status}. Check the dunning policy and the invoice list.`);
      }
      if (sub.status === 'trialing' && sub.trial_end) {
        warnings.push(
          `On trial until ${new Date(sub.trial_end * 1000).toDateString()} — changes apply immediately but nothing is collected before that date.`,
        );
      }
      if ((account.unmappedPriceIds?.length ?? 0) > 0) {
        warnings.push(
          `${account.unmappedPriceIds.length} subscription item(s) use a Stripe price that is no longer in the catalog (${account.unmappedPriceIds.join(', ')}) — screens and plan may read low. Re-sync the catalog or move the subscription onto a current plan.`,
        );
      }
    }
    if (!account.defaultPaymentMethodId && policy.invoicing.collectionMethod === 'charge_automatically') {
      warnings.push('No payment method on file — invoices cannot be collected automatically.');
    }

    /*
     * The X add-on is reconciled on every read: its paid coverage is replayed
     * from Stripe's paid invoices, so a webhook that never arrived only delays
     * a grant until the next look.
     */
    const xAddon = await this.xAddon.snapshot(account, this.xContext(sub, state.term));

    return {
      account,
      warnings,
      current: state,
      xAddon,
      monthlyValueCents: mrr,
      stripe: sub
        ? {
            id: sub.id,
            status: sub.status,
            currentPeriodStart: StripeService.periodStart(sub),
            currentPeriodEnd: StripeService.periodEnd(sub),
            cancelAtPeriodEnd: sub.cancel_at_period_end,
            cancelAt: sub.cancel_at,
            trialEnd: sub.trial_end,
            collectionMethod: sub.collection_method,
            billingMode: (sub as any).billing_mode?.type,
            pauseCollection: sub.pause_collection,
            defaultPaymentMethod: sub.default_payment_method,
            latestInvoice: typeof sub.latest_invoice === 'string' ? sub.latest_invoice : sub.latest_invoice?.id,
            hostedInvoiceUrl:
              typeof sub.latest_invoice === 'string' ? null : sub.latest_invoice?.hosted_invoice_url ?? null,
            items: (sub.items?.data ?? []).map((item) => ({
              id: item.id,
              priceId: typeof item.price === 'string' ? item.price : item.price?.id,
              quantity: item.quantity,
              unitAmount: typeof item.price === 'string' ? null : item.price?.unit_amount,
              interval: typeof item.price === 'string' ? null : item.price?.recurring?.interval,
              currentPeriodStart: item.current_period_start,
              currentPeriodEnd: item.current_period_end,
            })),
          }
        : null,
      schedule: schedule
        ? {
            id: schedule.id,
            status: schedule.status,
            endBehavior: schedule.end_behavior,
            phases: schedule.phases.map((phase) => ({
              startDate: phase.start_date,
              endDate: phase.end_date,
              items: phase.items.map((i) => ({
                price: typeof i.price === 'string' ? i.price : i.price?.id,
                quantity: i.quantity,
              })),
            })),
          }
        : null,
      pendingChange: account.pendingChange ?? null,
      policy,
    };
  }

  private async monthlyValueOf(state: DesiredState, maps: CatalogMaps): Promise<number> {
    const plan = maps.plans.get(state.planCode);
    if (!plan) return 0;
    let total = perUnitMonthlyCents(plan, state.term) * state.screens;
    for (const addOn of state.addOns) {
      const def = maps.addOnItems.get(addOn.code);
      if (def) total += perUnitMonthlyCents(def, state.term) * addOn.quantity;
    }
    return total;
  }

  // ---------------------------------------------------------------- preview

  /**
   * Dry-run: asks Stripe to compute the exact invoice the change would produce,
   * and explains which policy rule drove the parameters. Nothing is mutated.
   */
  async preview(accountId: string, req: ChangeRequest) {
    const account = await this.accounts.get(accountId);
    const maps = await this.catalogMaps();
    const policy = await this.policy.get();
    const loaded = await this.loadSubscription(account);
    const sub = loaded && ACTIVE_STATUSES.includes(loaded.status) ? loaded : null;
    const current = this.currentStateOf(account, sub, maps);

    const desired: DesiredState = {
      planCode: req.planCode,
      term: req.term,
      screens: Math.max(0, Math.floor(Number(req.screens) || 0)),
      addOns: normaliseAddOns(req.addOns),
    };
    const plan = maps.plans.get(desired.planCode);
    if (!plan) throw new BadRequestException(`Unknown plan "${desired.planCode}"`);
    // Moving to Free is a cancellation, so add-ons/screens left over from the
    // paid plan are dropped rather than rejected by the paid-plan rules.
    if (desired.planCode === FREE) {
      desired.addOns = [];
      desired.screens = Math.min(desired.screens, policy.constraints.freePlanScreenCap);
    }
    validateDesiredState({ desired, plan, addOnItems: maps.addOnItems, constraints: policy.constraints });
    const classification = classifyChange({ current, desired, plans: maps.plans, addOnItems: maps.addOnItems });
    const ruleKey = req.forceRuleKey ?? classification.ruleKey;
    const rule = ruleKey
      ? await this.policy.resolveRule(ruleKey, req.overrides, classification.addOnCode ?? undefined)
      : null;

    /*
     * Taking the X add-on on or giving it up runs MODEL V6's own flows, so the
     * preview is theirs too: the Stripe invoice for exactly those parameters,
     * plus the quota it opens or freezes and the capacity it reserves.
     */
    const xMove = desired.planCode === FREE ? null : this.xMove(current, desired);
    if (xMove && !sub) {
      throw new BadRequestException('Start the base plan first — the X add-on is added to an existing paid subscription (MODEL V6 row 51).');
    }
    if (xMove && sub) {
      this.assertXAlone(current, desired);
      const ctx = this.xContext(sub, current.term);
      const x = xMove === 'add' ? await this.xAddon.previewPurchase(account, ctx) : await this.xAddon.previewCancel(account, ctx);
      return { current, desired, classification, ruleKey: null, rule: null, ...x };
    }

    if (desired.planCode === FREE) {
      return {
        current,
        desired,
        classification,
        ruleKey: null,
        rule: null,
        mode: 'cancel',
        explanation: [
          'Moving to the Free plan cancels the Stripe subscription.',
          `Cancellation timing: ${policy.cancellation.timing}`,
          `Unused time: ${policy.cancellation.prorateUnusedTime ? 'prorated' : 'not prorated'} → ${policy.cancellation.refundUnusedTime}`,
        ],
        invoice: null,
        stripeParams: null,
      };
    }

    const parkedX = this.parkedXItem(sub, maps);
    const moveParkedX = Boolean(sub && parkedX && current.term !== desired.term);
    const items = await this.buildItems(desired, sub, maps, { omitParkedX: moveParkedX });
    const prorationDate = await this.stripe.nowFor(account.testClockId);

    // A scheduled change does not touch the current invoice at all.
    if (sub && rule?.timing === 'end_of_period') {
      /*
       * preview_mode='recurring' asks Stripe for a *typical* renewal invoice at
       * the new configuration instead of the next invoice on the current
       * period. Without it the preview shows the right money against the wrong
       * dates, which reads as a bug to anyone checking the numbers.
       */
      const previewParams: Stripe.InvoiceCreatePreviewParams = {
        customer: account.stripeCustomerId!,
        subscription: sub.id,
        preview_mode: 'recurring',
        subscription_details: {
          /*
           * Items here are a *patch* on the live subscription, exactly as they
           * are on an update. Dropping the item id turns a reprice into "add a
           * second item at the same price", which Stripe refuses outright; and
           * filtering the removals out leaves the very line the customer asked
           * to drop sitting in the renewal they are being shown. Both have to
           * travel as they are.
           */
          items: items.map((i) =>
            i.deleted
              ? { id: i.id as string, deleted: true as const }
              : {
                  ...(i.id ? { id: i.id } : {}),
                  price: i.price as string,
                  quantity: i.quantity,
                },
          ),
          proration_behavior: 'none',
          billing_cycle_anchor: 'unchanged',
        },
      };
      let renewal: Stripe.Invoice | null = null;
      let unavailable: string | null = null;
      try {
        renewal = await this.stripe.client.invoices.createPreview(previewParams);
      } catch (err: any) {
        unavailable = err?.raw?.message ?? err?.message ?? 'Stripe could not price the renewal';
      }

      const effectiveAt = StripeService.periodEnd(sub);
      const explanation = this.explain(rule!, ruleKey!, classification, true);
      explanation.push(
        `Effective ${effectiveAt ? new Date(effectiveAt * 1000).toDateString() : 'at the next renewal'} — the invoice below is one full period at the new configuration.`,
      );
      if (unavailable) explanation.push(unavailable);

      return {
        current,
        desired,
        classification,
        ruleKey,
        rule,
        mode: 'schedule',
        effectiveAt,
        explanation,
        invoice: renewal ? this.stripe.summarizeInvoice(renewal) : null,
        previewUnavailable: unavailable,
        stripeParams: { call: 'subscriptionSchedules.update', items, preview: previewParams },
      };
    }

    // For a subscription that does not exist yet, the trial decides whether the
    // first invoice is real money or $0 — so the preview has to include it.
    const trial = sub ? null : this.decideTrial(policy, account, req.withTrial);
    const trialEnd =
      trial?.apply && !trial.error ? prorationDate + policy.trial.days * 86400 : undefined;

    const previewParams: Stripe.InvoiceCreatePreviewParams = {
      customer: account.stripeCustomerId!,
      ...(sub ? { subscription: sub.id } : {}),
      subscription_details: {
        items: sub
          ? (items as any)
          : items.map((i) => ({ price: i.price as string, quantity: i.quantity })),
        ...(trialEnd ? { trial_end: trialEnd } : {}),
        proration_behavior: rule?.prorationBehavior ?? policy.rules.screensIncrease.prorationBehavior,
        ...(rule?.billingCycleAnchor === 'now'
          ? { billing_cycle_anchor: 'now' as const }
          : sub && rule?.prorationBehavior !== 'none'
            ? { proration_date: prorationDate }
            : {}),
      },
    };

    /*
     * Stripe refuses to price an upcoming invoice that will never exist: a
     * trial with no payment method and end_behavior=cancel simply ends. That is
     * a normal state for a trialing account, not an error, so the preview
     * degrades to an explanation instead of a 400.
     */
    const trialWillCancel =
      sub?.status === 'trialing' &&
      !account.defaultPaymentMethodId &&
      policy.trial.missingPaymentMethodBehavior === 'cancel';

    let invoice: Stripe.Invoice | null = null;
    let previewUnavailable: string | null = null;
    if (trialWillCancel) {
      previewUnavailable =
        'No invoice to preview: this trial ends without a payment method, and the policy says trials end by cancelling (trial.missingPaymentMethodBehavior=cancel). Attach a card to see the first real invoice.';
    } else {
      try {
        invoice = await this.stripe.client.invoices.createPreview(previewParams);
      } catch (err: any) {
        previewUnavailable = err?.raw?.message ?? err?.message ?? 'Stripe could not price this change';
      }
    }

    const explanation = rule
      ? this.explain(rule, ruleKey!, classification, false)
      : ['New subscription — first invoice below.'];

    if (trial) {
      if (trial.error) {
        explanation.push(`Trial not possible: ${trial.error}`);
      } else if (trial.apply) {
        explanation.push(
          `Trial: ${policy.trial.days} days (${trial.reason}) → nothing is charged today; first real invoice on ${new Date(trialEnd! * 1000).toDateString()}.`,
        );
      } else {
        explanation.push(`No trial (${trial.reason}) → the first invoice is charged immediately.`);
      }
    }
    if (sub?.status === 'trialing') {
      explanation.push(
        `This subscription is still on trial until ${new Date((sub.trial_end ?? 0) * 1000).toDateString()} — the change applies now but nothing is collected before then.`,
      );
    }

    if (previewUnavailable) explanation.push(previewUnavailable);
    if (sub && current.term !== desired.term && desired.addOns.some((a) => a.code === X_ADDON_CODE)) {
      explanation.push(
        'The X add-on follows the base interval (MODEL V6 rows 60, 64): Stripe prorates it natively with the base plan. SCIO keeps the quota month and Used as they are and only adds a positive delta if the paid coverage grows — the same stretch of time is never granted twice.',
        'The quota cycle does not move with it: it keeps the anchor X was bought on, while billing restarts on the new interval. From this change on, quota months and billing periods run on separate cycles.',
      );
    }
    let summary = invoice ? this.stripe.summarizeInvoice(invoice) : null;
    if (moveParkedX && parkedX) {
      explanation.push(
        `The X add-on is cancelled (FROZEN): its item ${parkedX.id} moves to the ${desired.term} price but stays at quantity 0 (MODEL V6 rows 60, 64, CASE 9) — not charged, not credited and not switched back on. Buying X again is the only way back.`,
        'That move is its own request, sent first with proration_behavior=none; the base plan change follows and carries no X line. Stripe cannot preview the two together, so any X line it prices here is left out of the invoice below.',
      );
      if (summary) {
        const xPrices = [...maps.byPriceId.entries()].filter(([, v]) => v.code === X_ADDON_CODE).map(([id]) => id);
        const dropped = summary.lines.filter((l) => l.priceId && xPrices.includes(l.priceId));
        const cut = dropped.reduce((s, l) => s + l.amount, 0);
        summary = {
          ...summary,
          lines: summary.lines.filter((l) => !dropped.includes(l)),
          subtotal: summary.subtotal - cut,
          total: summary.total - cut,
          amountDue: Math.max(0, summary.amountDue - cut),
          prorationTotal: summary.prorationTotal - dropped.filter((l) => l.proration).reduce((s, l) => s + l.amount, 0),
          recurringTotal: summary.recurringTotal - dropped.filter((l) => !l.proration).reduce((s, l) => s + l.amount, 0),
        };
      }
    }

    return {
      current,
      desired,
      classification,
      ruleKey,
      rule,
      mode: sub ? 'update' : 'create',
      trial: trial ? { willApply: trial.apply, reason: trial.reason, days: policy.trial.days, error: trial.error ?? null } : null,
      explanation,
      invoice: summary,
      previewUnavailable,
      stripeParams: previewParams,
    };
  }

  private explain(rule: ChangeRule, ruleKey: ChangeRuleKey, classification: any, scheduled: boolean): string[] {
    const out: string[] = [];
    out.push(`Policy rule: ${ruleKey}`);
    out.push(`Changes: ${classification.changes.join(', ') || 'none'}`);
    if (scheduled) {
      out.push('timing=end_of_period → the change is parked on a Stripe subscription schedule and applies at renewal.');
      out.push('No proration is created now; the invoice below is what the renewal will look like.');
    } else {
      out.push(`timing=immediate → subscriptions.update runs now.`);
      switch (rule.prorationBehavior) {
        case 'create_prorations':
          out.push('proration_behavior=create_prorations → proration lines are stored and swept into the next invoice.');
          break;
        case 'always_invoice':
          out.push('proration_behavior=always_invoice → Stripe invoices the proration immediately.');
          break;
        case 'none':
          out.push('proration_behavior=none → no money moves until the next renewal.');
          break;
      }
      if (rule.billingCycleAnchor === 'now') {
        out.push('billing_cycle_anchor=now → the billing period restarts today and a full new period is invoiced.');
      }
      out.push(`payment_behavior=${rule.paymentBehavior}`);
    }
    if (classification.direction === 'downgrade') {
      out.push(`Credit handling: ${rule.creditHandling}`);
    }
    if (rule.notes) out.push(rule.notes);
    return out;
  }

  // ----------------------------------------------------------------- change

  /** Applies a change (or creates the subscription) under the active policy. */
  async change(accountId: string, req: ChangeRequest) {
    const account = await this.accounts.get(accountId);
    const maps = await this.catalogMaps();
    const policy = await this.policy.get();
    const loaded = await this.loadSubscription(account);
    const sub = loaded && ACTIVE_STATUSES.includes(loaded.status) ? loaded : null;
    const current = this.currentStateOf(account, sub, maps);

    const desired: DesiredState = {
      planCode: req.planCode,
      term: req.term,
      screens: Math.max(0, Math.floor(Number(req.screens) || 0)),
      addOns: normaliseAddOns(req.addOns),
    };
    const plan = maps.plans.get(desired.planCode);
    if (!plan) throw new BadRequestException(`Unknown plan "${desired.planCode}"`);
    if (desired.planCode === FREE) {
      // Same as in preview(): dropping to Free cancels the subscription, it is
      // not a paid configuration that has to satisfy the paid-plan rules.
      return this.cancel(accountId, { reason: 'Downgrade to the Free plan' });
    }
    validateDesiredState({ desired, plan, addOnItems: maps.addOnItems, constraints: policy.constraints });

    const xMove = this.xMove(current, desired);
    if (xMove && !sub) {
      throw new BadRequestException('Start the base plan first — the X add-on is added to an existing paid subscription (MODEL V6 row 51).');
    }
    if (xMove && sub) {
      this.assertXAlone(current, desired);
      const ctx = this.xContext(sub, current.term);
      const updated = xMove === 'add' ? await this.xAddon.purchase(account, ctx) : await this.xAddon.cancel(account, ctx);
      await this.syncAccountFromSubscription(account, updated, maps);
      return { applied: xMove === 'add' ? 'x_purchase' : 'x_cancel', state: await this.getState(accountId) };
    }

    const classification = classifyChange({ current, desired, plans: maps.plans, addOnItems: maps.addOnItems });
    if (!classification.ruleKey && sub) {
      return { noop: true, message: 'Nothing to change', classification, state: await this.getState(accountId) };
    }

    const ruleKey = (req.forceRuleKey ?? classification.ruleKey ?? 'screensIncrease') as ChangeRuleKey;
    const rule = await this.policy.resolveRule(ruleKey, req.overrides, classification.addOnCode ?? undefined);

    if (!sub) {
      return this.createSubscription(account, desired, maps, { withTrial: req.withTrial });
    }

    if (rule.timing === 'end_of_period') {
      return this.scheduleChange(account, sub, desired, maps, rule, ruleKey, classification);
    }
    return this.applyImmediateChange(account, sub, desired, maps, rule, ruleKey, classification);
  }

  // ------------------------------------------------------- create / update

  /**
   * Decides whether a *new* subscription starts on a trial. Returns instead of
   * throwing so `preview` can explain the outcome without blowing up.
   */
  private decideTrial(
    policy: Awaited<ReturnType<PolicyService['get']>>,
    account: AccountDocument,
    explicit?: boolean,
  ): { apply: boolean; reason: string; error?: string } {
    const hasPaymentMethod = Boolean(account.defaultPaymentMethodId);
    const { appliesTo, requirePaymentMethod, days } = policy.trial;

    if (explicit === false) return { apply: false, reason: 'caller opted out of the trial' };

    if (explicit === true) {
      if (appliesTo === 'never') {
        return { apply: false, reason: 'trial requested', error: 'Trials are disabled by the billing policy (trial.appliesTo=never)' };
      }
      if (requirePaymentMethod && !hasPaymentMethod) {
        return {
          apply: false,
          reason: 'trial requested',
          error: 'The billing policy requires a payment method before a trial can start (trial.requirePaymentMethod=true)',
        };
      }
      return { apply: true, reason: `caller opted in — ${days}-day trial` };
    }

    switch (appliesTo) {
      case 'never':
        return { apply: false, reason: 'policy: trial.appliesTo=never' };
      case 'always':
        if (requirePaymentMethod && !hasPaymentMethod) {
          return {
            apply: false,
            reason: 'policy: trial.appliesTo=always',
            error: 'The billing policy requires a payment method before a trial can start (trial.requirePaymentMethod=true)',
          };
        }
        return { apply: true, reason: `policy: every new subscription gets ${days} trial days` };
      case 'only_without_payment_method':
      default:
        if (hasPaymentMethod) {
          return { apply: false, reason: 'policy: a card is on file, so billing starts immediately' };
        }
        if (requirePaymentMethod) {
          return {
            apply: false,
            reason: 'policy: trial.appliesTo=only_without_payment_method',
            error: 'The billing policy requires a payment method before a trial can start (trial.requirePaymentMethod=true)',
          };
        }
        return { apply: true, reason: `policy: no card on file → ${days}-day trial` };
    }
  }

  private async createSubscription(
    account: AccountDocument,
    desired: DesiredState,
    maps: CatalogMaps,
    opts: { withTrial?: boolean } = {},
  ) {
    const policy = await this.policy.get();
    const items = await this.buildItems(desired, null, maps);

    const trial = this.decideTrial(policy, account, opts.withTrial);
    if (trial.error) throw new BadRequestException(trial.error);
    const withTrial = trial.apply;

    if (!withTrial && !account.defaultPaymentMethodId && policy.invoicing.collectionMethod === 'charge_automatically') {
      throw new BadRequestException(
        'No payment method on file. Attach a test card, switch collection_method to send_invoice, or start the subscription with a trial.',
      );
    }

    const params: Stripe.SubscriptionCreateParams = {
      customer: account.stripeCustomerId!,
      items: items.map((i) => ({ price: i.price as string, quantity: i.quantity })),
      collection_method: policy.invoicing.collectionMethod,
      payment_behavior: policy.invoicing.defaultPaymentBehavior,
      proration_behavior: 'create_prorations',
      automatic_tax: { enabled: policy.invoicing.automaticTax },
      billing_mode: { type: policy.invoicing.billingMode },
      metadata: { accountId: account.id, planCode: desired.planCode, term: desired.term },
      expand: ['latest_invoice', 'pending_setup_intent'],
    };
    if (policy.invoicing.collectionMethod === 'send_invoice') params.days_until_due = policy.invoicing.daysUntilDue;
    if (account.defaultPaymentMethodId) params.default_payment_method = account.defaultPaymentMethodId;
    if (withTrial) {
      params.trial_period_days = policy.trial.days;
      params.trial_settings = {
        end_behavior: { missing_payment_method: policy.trial.missingPaymentMethodBehavior },
      };
    }
    if (policy.invoicing.anchorToFirstOfMonth) {
      params.billing_cycle_anchor_config = { day_of_month: 1 };
    }

    const sub = await this.stripe.call('subscriptions.create', () =>
      this.stripe.client.subscriptions.create(params),
    );

    await this.events.record({
      accountId: account.id,
      action: 'subscription.created',
      ruleKey: 'create',
      summary: `${desired.planCode} · ${desired.screens} screens · ${desired.term}${withTrial ? ` · ${policy.trial.days}-day trial (${trial.reason})` : ` · billed immediately (${trial.reason})`}`,
      policyApplied: { trial: policy.trial, invoicing: policy.invoicing },
      stripeRequest: params as any,
      result: { subscriptionId: sub.id, status: sub.status, trialApplied: withTrial, trialReason: trial.reason },
    });

    await this.syncAccountFromSubscription(account, sub, maps);

    // default_incomplete leaves the subscription unpaid until the customer
    // confirms; surface the hosted invoice so the demo is not silently stuck.
    const latest = sub.latest_invoice && typeof sub.latest_invoice !== 'string' ? sub.latest_invoice : null;
    const needsConfirmation = sub.status === 'incomplete';

    return {
      created: true,
      trial: { applied: withTrial, reason: trial.reason, endsAt: sub.trial_end },
      needsConfirmation,
      hostedInvoiceUrl: needsConfirmation ? latest?.hosted_invoice_url ?? null : null,
      state: await this.getState(account.id),
    };
  }

  private async applyImmediateChange(
    account: AccountDocument,
    sub: Stripe.Subscription,
    desired: DesiredState,
    maps: CatalogMaps,
    rule: ChangeRule,
    ruleKey: ChangeRuleKey,
    classification: any,
  ) {
    // A schedule would fight with a direct update, so release it first.
    if (sub.schedule) {
      const scheduleId = typeof sub.schedule === 'string' ? sub.schedule : sub.schedule.id;
      try {
        await this.stripe.client.subscriptionSchedules.release(scheduleId);
        account.stripeScheduleId = undefined;
        account.pendingChange = undefined;
      } catch (err: any) {
        this.logger.warn(`Could not release schedule ${scheduleId}: ${err.message}`);
      }
    }

    // MODEL V6 rows 60, 64: a frozen X item moves first, on its own, with no proration
    const moved = readSubscriptionState(sub, maps.byPriceId).term !== desired.term
      ? await this.moveParkedX(account, sub, maps, desired.term)
      : null;
    const balanceBefore = await this.customerBalance(account);
    const items = await this.buildItems(desired, sub, maps, { omitParkedX: Boolean(moved) });
    const prorationDate = await this.stripe.nowFor(account.testClockId);

    /*
     * How much credit does this change hand back to the customer?
     *
     * With `create_prorations` Stripe does not touch the customer balance at
     * all — the credit is a pending negative line item that waits for the next
     * invoice. So we measure it the only reliable way: ask Stripe to price the
     * upcoming invoice before and after the change and compare the proration
     * lines. `proration_date` is pinned so the preview and the real update
     * compute the identical prorations.
     */
    const prorationsBefore = await this.prorationTotal(account, sub.id, null, null, prorationDate);
    const prorationsAfter = await this.prorationTotal(account, sub.id, items, rule, prorationDate);
    const creditFromProrations = Math.max(0, prorationsBefore - prorationsAfter);

    /*
     * creditHandling='block' means the business never wants to owe the customer
     * money for a mid-cycle change. The check has to happen here, before the
     * subscription is touched, so a refusal leaves everything exactly as it was
     * — checking after the update would mean unwinding a change Stripe has
     * already made.
     */
    if (rule.creditHandling === 'block') {
      const projected = await this.projectedInvoice(account, sub.id, items, rule, prorationDate);
      if (projected !== null && projected < 0) {
        throw new BadRequestException(
          `This change would leave ${(Math.abs(projected) / 100).toFixed(2)} ${this.stripe.currency.toUpperCase()} owed back to the customer, and the "${ruleKey}" rule is set to block that. Nothing was changed — make the change at the renewal date instead, or set creditHandling to something other than "block".`,
        );
      }
    }

    const params: Stripe.SubscriptionUpdateParams = {
      items,
      proration_behavior: rule.prorationBehavior,
      payment_behavior: rule.paymentBehavior,
      metadata: { accountId: account.id, planCode: desired.planCode, term: desired.term },
      expand: ['latest_invoice'],
    };
    if (rule.billingCycleAnchor === 'now') {
      // Stripe rejects proration_date together with a cycle restart: the anchor
      // move *is* the proration point.
      params.billing_cycle_anchor = 'now';
    } else if (rule.prorationBehavior !== 'none') {
      params.proration_date = prorationDate;
    }

    let updated: Stripe.Subscription;
    try {
      updated = await this.stripe.call('subscriptions.update', () =>
        this.stripe.client.subscriptions.update(sub.id, params),
      );
    } catch (err) {
      // put the frozen X item back on the old price, so a refused change leaves nothing half-done
      if (moved) {
        await this.stripe.client.subscriptions
          .update(sub.id, { items: [{ id: moved.itemId, price: moved.previousPrice, quantity: 0 }], proration_behavior: 'none' })
          .catch((e) => this.logger.error(`Could not move frozen X item ${moved.itemId} back: ${e.message}`));
      }
      throw err;
    }

    const balanceAfter = await this.customerBalance(account);
    // Stripe balances are negative when the customer is in credit.
    const creditOnBalance = Math.max(0, balanceBefore - balanceAfter);

    /*
     * How much is genuinely owed back depends on whether the change was
     * invoiced:
     *
     *  always_invoice -> Stripe already settled the change. The invoice also
     *      billed the new period, so the *gross* proration credit is more than
     *      the customer is owed; what is really left over is the movement on
     *      the customer balance.
     *  create_prorations -> nothing was invoiced, the credit is a pending
     *      negative line item and the balance has not moved at all.
     */
    const creditCreated =
      rule.prorationBehavior === 'create_prorations' ? creditFromProrations : creditOnBalance;

    let refundResult: any = null;
    if (creditCreated > 0 && rule.creditHandling === 'refund_to_payment_method') {
      /*
       * convertCreditToRefund moves the money and debits the customer balance
       * by exactly what it refunded, which neutralises the credit in both
       * shapes it can take (balance credit, or a pending proration credit that
       * would otherwise discount the next invoice). Nothing else to offset
       * here — an extra debit would charge the customer twice.
       */
      refundResult = await this.billing.convertCreditToRefund(
        account,
        creditCreated,
        `${ruleKey} refund per billing policy`,
      );
    }
    if (creditCreated > 0 && rule.creditHandling === 'push_to_account_balance') {
      /*
       * The requirement is that the customer can see the money on their
       * account, not that it quietly discounts a future invoice.
       *
       * With `always_invoice` Stripe has already moved the leftover onto
       * `customer.balance`, so there is nothing to do. With `create_prorations`
       * the credit is only a pending negative line item: neutralise it with a
       * matching positive item so the next invoice is not discounted twice,
       * then write the same amount to the account balance.
       */
      if (rule.prorationBehavior !== 'always_invoice') {
        await this.stripe.call('invoiceItems.create', () =>
          this.stripe.client.invoiceItems.create({
            customer: account.stripeCustomerId!,
            subscription: sub.id,
            amount: creditCreated,
            currency: this.stripe.currency,
            description: `Proration credit moved to the account balance (${ruleKey})`,
          }),
        );
        await this.stripe.call('customers.createBalanceTransaction', () =>
          this.stripe.client.customers.createBalanceTransaction(account.stripeCustomerId!, {
            amount: -creditCreated,
            currency: this.stripe.currency,
            description: `Account credit from ${ruleKey}`,
          }),
        );
      }
    }
    if (creditCreated > 0 && rule.creditHandling === 'none') {
      // Policy says no credit at all: cancel it out with an equal debit.
      await this.stripe.call('customers.createBalanceTransaction', () =>
        this.stripe.client.customers.createBalanceTransaction(account.stripeCustomerId!, {
          amount: creditCreated,
          currency: this.stripe.currency,
          description: `Credit withdrawn — policy ${ruleKey}.creditHandling=none`,
        }),
      );
    }

    const latestInvoice =
      updated.latest_invoice && typeof updated.latest_invoice !== 'string'
        ? this.stripe.summarizeInvoice(updated.latest_invoice)
        : null;

    await this.events.record({
      accountId: account.id,
      action: 'subscription.changed',
      ruleKey,
      summary: classification.changes.join(', ') || 'no-op',
      policyApplied: rule as any,
      stripeRequest: { call: 'subscriptions.update', id: sub.id, params } as any,
      result: {
        status: updated.status,
        creditCreatedCents: creditCreated,
        creditFromProrationsCents: creditFromProrations,
        creditOnBalanceCents: creditOnBalance,
        prorationTotalBeforeCents: prorationsBefore,
        prorationTotalAfterCents: prorationsAfter,
        creditHandling: rule.creditHandling,
        accountBalanceAfter: await this.customerBalance(account),
        refund: refundResult,
        latestInvoice,
      },
    });

    await this.syncAccountFromSubscription(account, updated, maps);

    return {
      applied: 'immediate',
      ruleKey,
      rule,
      classification,
      creditCreatedCents: creditCreated,
      creditFromProrationsCents: creditFromProrations,
      creditOnBalanceCents: creditOnBalance,
      refund: refundResult,
      latestInvoice,
      state: await this.getState(account.id),
    };
  }

  /**
   * Parks the change on a Stripe subscription schedule: the current phase runs
   * untouched to the end of the paid period, then the new configuration starts.
   */
  private async scheduleChange(
    account: AccountDocument,
    sub: Stripe.Subscription,
    desired: DesiredState,
    maps: CatalogMaps,
    rule: ChangeRule,
    ruleKey: ChangeRuleKey,
    classification: any,
  ) {
    let scheduleId = typeof sub.schedule === 'string' ? sub.schedule : sub.schedule?.id;
    if (!scheduleId) {
      const created = await this.stripe.call('subscriptionSchedules.create', () =>
        this.stripe.client.subscriptionSchedules.create({ from_subscription: sub.id }),
      );
      scheduleId = created.id;
    }

    const schedule = await this.stripe.call('subscriptionSchedules.retrieve', () =>
      this.stripe.client.subscriptionSchedules.retrieve(scheduleId!),
    );

    /*
     * Only phases that have already started are kept. Anything still in the
     * future is a change that was scheduled earlier and has not taken effect
     * yet — replacing it means "schedule again" retargets the next renewal
     * instead of queueing behind the previous decision.
     */
    const now = await this.stripe.nowFor(account.testClockId);
    const startedPhases = schedule.phases.filter((phase) => phase.start_date <= now);
    const droppedPhases = schedule.phases.length - startedPhases.length;

    const existingPhases = startedPhases.map((phase) => ({
      items: phase.items.map((item) => ({
        price: typeof item.price === 'string' ? item.price : item.price?.id,
        quantity: item.quantity,
      })),
      start_date: phase.start_date,
      end_date: phase.end_date,
      proration_behavior: 'none' as const,
    }));

    const nextItems = await this.buildItems(desired, null, maps);
    const newPhase = {
      items: nextItems.map((i) => ({ price: i.price as string, quantity: i.quantity })),
      // one full billing interval of the new configuration, then `release`
      // hands control back to the plain subscription.
      duration: { interval: desired.term === 'yearly' ? ('year' as const) : ('month' as const), interval_count: 1 },
      proration_behavior: 'none' as const,
    };

    if (existingPhases.length === 0) {
      // Every phase looked "future": keep the schedule's own first phase so the
      // update still has an anchor, rather than sending an unanchored list.
      const first = schedule.phases[0];
      existingPhases.push({
        items: first.items.map((item) => ({
          price: typeof item.price === 'string' ? item.price : item.price?.id,
          quantity: item.quantity,
        })),
        start_date: first.start_date,
        end_date: first.end_date,
        proration_behavior: 'none' as const,
      });
    }

    const params: Stripe.SubscriptionScheduleUpdateParams = {
      end_behavior: 'release',
      phases: [...existingPhases, newPhase] as any,
    };

    const updated = await this.stripe.call('subscriptionSchedules.update', () =>
      this.stripe.client.subscriptionSchedules.update(scheduleId!, params),
    );

    account.stripeScheduleId = updated.id;
    account.pendingChange = {
      ruleKey,
      effectiveAt: existingPhases[existingPhases.length - 1]?.end_date ?? StripeService.periodEnd(sub),
      desired,
      changes: classification.changes,
    };
    await this.accounts.save(account);

    await this.events.record({
      accountId: account.id,
      action: 'subscription.change_scheduled',
      ruleKey,
      summary: `${classification.changes.join(', ')} — effective at the end of the current period${droppedPhases > 0 ? ` (replaced ${droppedPhases} previously scheduled phase)` : ''}`,
      policyApplied: rule as any,
      stripeRequest: { call: 'subscriptionSchedules.update', id: scheduleId, params } as any,
      result: { scheduleId: updated.id, phases: updated.phases.length, replacedPendingPhases: droppedPhases },
    });

    return {
      applied: 'scheduled',
      ruleKey,
      rule,
      classification,
      scheduleId: updated.id,
      effectiveAt: account.pendingChange.effectiveAt,
      state: await this.getState(account.id),
    };
  }

  // ----------------------------------------------------------------- cancel

  async cancel(
    accountId: string,
    opts: {
      timing?: 'at_period_end' | 'immediate';
      prorateUnusedTime?: boolean;
      invoiceImmediately?: boolean;
      refundUnusedTime?: 'customer_balance' | 'refund_to_payment_method' | 'none';
      reason?: string;
    } = {},
  ) {
    const account = await this.accounts.get(accountId);
    const policy = await this.policy.get();
    const maps = await this.catalogMaps();
    const sub = await this.loadSubscription(account);

    if (!sub || !ACTIVE_STATUSES.includes(sub.status)) {
      account.planCode = FREE;
      account.screens = 0;
      account.addOns = [];
      account.subscriptionStatus = sub?.status ?? 'none';
      await this.accounts.save(account);
      return { cancelled: false, message: 'No active subscription', state: await this.getState(accountId) };
    }

    const settings = {
      timing: opts.timing ?? policy.cancellation.timing,
      prorateUnusedTime: opts.prorateUnusedTime ?? policy.cancellation.prorateUnusedTime,
      invoiceImmediately: opts.invoiceImmediately ?? policy.cancellation.invoiceImmediately,
      refundUnusedTime: opts.refundUnusedTime ?? policy.cancellation.refundUnusedTime,
    };

    if (settings.timing === 'at_period_end') {
      const params: Stripe.SubscriptionUpdateParams = {
        cancel_at_period_end: true,
        cancellation_details: { comment: opts.reason ?? 'Cancelled from the OptiSigns billing demo' },
      };
      const updated = await this.stripe.call('subscriptions.update', () =>
        this.stripe.client.subscriptions.update(sub.id, params),
      );
      account.cancelAtPeriodEnd = true;
      await this.accounts.save(account);

      await this.events.record({
        accountId: account.id,
        action: 'subscription.cancel_scheduled',
        summary: `Will end on ${new Date((StripeService.periodEnd(updated) ?? 0) * 1000).toISOString().slice(0, 10)}`,
        policyApplied: settings as any,
        stripeRequest: { call: 'subscriptions.update', id: sub.id, params } as any,
        result: { cancelAt: updated.cancel_at, status: updated.status },
      });

      return { cancelled: 'at_period_end', settings, state: await this.getState(accountId) };
    }

    const screensBeforeCancel = account.screens ?? 0;
    const balanceBefore = await this.customerBalance(account);
    const params: Stripe.SubscriptionCancelParams = {
      prorate: settings.prorateUnusedTime,
      invoice_now: settings.invoiceImmediately,
      cancellation_details: { comment: opts.reason ?? 'Cancelled immediately from the OptiSigns billing demo' },
    };
    const cancelled = await this.stripe.call('subscriptions.cancel', () =>
      this.stripe.client.subscriptions.cancel(sub.id, params),
    );
    const balanceAfter = await this.customerBalance(account);
    const creditCreated = Math.max(0, balanceBefore - balanceAfter);

    let refundResult: any = null;
    if (creditCreated > 0 && settings.refundUnusedTime === 'refund_to_payment_method') {
      refundResult = await this.billing.convertCreditToRefund(account, creditCreated, 'cancellation refund');
    }
    if (creditCreated > 0 && settings.refundUnusedTime === 'none') {
      await this.stripe.call('customers.createBalanceTransaction', () =>
        this.stripe.client.customers.createBalanceTransaction(account.stripeCustomerId!, {
          amount: creditCreated,
          currency: this.stripe.currency,
          description: 'Credit withdrawn — cancellation policy refundUnusedTime=none',
        }),
      );
    }

    account.subscriptionStatus = cancelled.status;
    account.cancelAtPeriodEnd = false;
    account.planCode = FREE;
    /*
     * moveToFreePlan=true  -> the account keeps running on the Free plan, up to
     *                         constraints.freePlanScreenCap screens.
     * moveToFreePlan=false -> the account is deactivated: no screens until it
     *                         subscribes again (OptiSigns' trial-expiry flow).
     */
    account.screens = policy.cancellation.moveToFreePlan
      ? Math.min(screensBeforeCancel, policy.constraints.freePlanScreenCap)
      : 0;
    account.deactivated = !policy.cancellation.moveToFreePlan;
    account.addOns = [];
    account.stripeScheduleId = undefined;
    account.pendingChange = undefined;
    await this.accounts.save(account);

    await this.events.record({
      accountId: account.id,
      action: 'subscription.cancelled',
      summary: `Immediate cancellation · credit ${creditCreated / 100} · ${settings.refundUnusedTime} · ${policy.cancellation.moveToFreePlan ? `moved to Free with ${account.screens} screen(s)` : 'account deactivated'}`,
      policyApplied: settings as any,
      stripeRequest: { call: 'subscriptions.cancel', id: sub.id, params } as any,
      result: { status: cancelled.status, creditCreatedCents: creditCreated, refund: refundResult },
    });

    return {
      cancelled: 'immediate',
      settings,
      creditCreatedCents: creditCreated,
      refund: refundResult,
      state: await this.getState(accountId),
    };
  }

  /**
   * Ends a running trial immediately. Stripe closes the trial, starts the first
   * real billing period and invoices it straight away.
   */
  async endTrial(accountId: string) {
    const account = await this.accounts.get(accountId);
    const policy = await this.policy.get();
    const sub = await this.loadSubscription(account);
    if (!sub || sub.status !== 'trialing') {
      throw new BadRequestException('This subscription is not on a trial');
    }
    if (!account.defaultPaymentMethodId && policy.invoicing.collectionMethod === 'charge_automatically') {
      throw new BadRequestException('Attach a payment method before ending the trial, otherwise the first invoice cannot be collected.');
    }

    const params: Stripe.SubscriptionUpdateParams = {
      trial_end: 'now',
      proration_behavior: 'create_prorations',
      expand: ['latest_invoice'],
    };
    const updated = await this.stripe.call('subscriptions.update', () =>
      this.stripe.client.subscriptions.update(sub.id, params),
    );

    const latestInvoice =
      updated.latest_invoice && typeof updated.latest_invoice !== 'string'
        ? this.stripe.summarizeInvoice(updated.latest_invoice)
        : null;

    await this.events.record({
      accountId: account.id,
      action: 'subscription.trial_ended',
      summary: `Trial ended early — status ${updated.status}${latestInvoice ? `, invoice ${latestInvoice.number} ${latestInvoice.total / 100}` : ''}`,
      stripeRequest: { call: 'subscriptions.update', id: sub.id, params } as any,
      result: { status: updated.status, latestInvoice },
    });

    await this.syncAccountFromSubscription(account, updated);
    return { endedTrial: true, latestInvoice, state: await this.getState(accountId) };
  }

  /** Undo a pending cancellation. */
  /**
   * Calls off a change that was parked for the renewal, before it lands.
   *
   * MODEL V5 row 49 gives the customer a way back: a cancellation runs to the
   * boundary of the period already paid for "and can be resumed before that
   * boundary". Releasing the schedule drops the future phase and hands the
   * plain subscription back untouched — the configuration in force right now is
   * the one that was already being paid for, so nothing is charged or refunded.
   *
   * Re-selecting the add-on cannot do this job: while the drop is still parked,
   * the live subscription *already* holds the add-on, so the request reads as
   * "no change at all" and the schedule survives.
   */
  async cancelScheduledChange(accountId: string) {
    const account = await this.accounts.get(accountId);
    const sub = await this.loadSubscription(account);
    const scheduleId =
      account.stripeScheduleId ??
      (sub ? (typeof sub.schedule === 'string' ? sub.schedule : sub.schedule?.id) : undefined);

    if (!scheduleId) {
      throw new BadRequestException('There is no scheduled change on this subscription to call off.');
    }

    const released = await this.stripe.call('subscriptionSchedules.release', () =>
      this.stripe.client.subscriptionSchedules.release(scheduleId),
    );

    const pending = account.pendingChange;
    account.stripeScheduleId = undefined;
    account.pendingChange = undefined;
    await this.accounts.save(account);

    await this.events.record({
      accountId: account.id,
      action: 'subscription.scheduled_change_cancelled',
      ruleKey: (pending?.ruleKey as ChangeRuleKey) ?? undefined,
      summary: pending?.changes?.length
        ? `Called off before it landed: ${pending.changes.join(', ')}`
        : 'Scheduled change called off',
      result: { scheduleId, status: released.status },
    });

    const refreshed = await this.loadSubscription(account);
    if (refreshed) await this.syncAccountFromSubscription(account, refreshed);
    return this.getState(accountId);
  }

  async resume(accountId: string) {
    const account = await this.accounts.get(accountId);
    if (!account.stripeSubscriptionId) throw new BadRequestException('No subscription to resume');
    /*
     * While a schedule is in charge Stripe refuses to have the cancellation
     * flag set directly, and its own message points at the schedule rather than
     * at what the operator should do. Say it plainly instead.
     */
    if (account.stripeScheduleId) {
      throw new BadRequestException(
        'A scheduled change is in charge of this subscription, so the cancellation flag cannot be cleared directly. ' +
          'Call off the scheduled change first, then resume.',
      );
    }
    const updated = await this.stripe.call('subscriptions.update', () =>
      this.stripe.client.subscriptions.update(account.stripeSubscriptionId!, { cancel_at_period_end: false }),
    );
    account.cancelAtPeriodEnd = false;
    await this.accounts.save(account);
    await this.events.record({
      accountId: account.id,
      action: 'subscription.cancel_reverted',
      summary: 'cancel_at_period_end = false',
      result: { status: updated.status },
    });
    return this.getState(accountId);
  }

  /** Seasonal pause: stop invoicing without losing the configuration. */
  async pause(accountId: string, resumesAt?: number) {
    const account = await this.accounts.get(accountId);
    const policy = await this.policy.get();
    if (!account.stripeSubscriptionId) throw new BadRequestException('No subscription to pause');
    const params: Stripe.SubscriptionUpdateParams = {
      pause_collection: { behavior: policy.dunning.pauseBehavior, resumes_at: resumesAt },
    };
    const updated = await this.stripe.call('subscriptions.update', () =>
      this.stripe.client.subscriptions.update(account.stripeSubscriptionId!, params),
    );
    account.pauseBehavior = policy.dunning.pauseBehavior;
    await this.accounts.save(account);
    await this.events.record({
      accountId: account.id,
      action: 'subscription.paused',
      summary: `pause_collection.behavior=${policy.dunning.pauseBehavior}`,
      policyApplied: policy.dunning as any,
      stripeRequest: params as any,
      result: { status: updated.status, pauseCollection: updated.pause_collection },
    });
    return this.getState(accountId);
  }

  async unpause(accountId: string) {
    const account = await this.accounts.get(accountId);
    if (!account.stripeSubscriptionId) throw new BadRequestException('No subscription to resume');
    const updated = await this.stripe.call('subscriptions.update', () =>
      this.stripe.client.subscriptions.update(account.stripeSubscriptionId!, { pause_collection: '' }),
    );
    account.pauseBehavior = undefined;
    await this.accounts.save(account);
    await this.events.record({
      accountId: account.id,
      action: 'subscription.unpaused',
      summary: 'pause_collection cleared',
      result: { status: updated.status },
    });
    return this.getState(accountId);
  }

  /** What the next renewal invoice looks like if nothing else changes. */
  async previewRenewal(accountId: string) {
    const account = await this.accounts.get(accountId);
    if (!account.stripeSubscriptionId) return null;
    if (!ACTIVE_STATUSES.includes(account.subscriptionStatus)) return null;
    try {
      const invoice = await this.stripe.client.invoices.createPreview({
        customer: account.stripeCustomerId!,
        subscription: account.stripeSubscriptionId!,
      });
      return this.stripe.summarizeInvoice(invoice);
    } catch (err: any) {
      // e.g. a trial that will cancel instead of renewing — nothing to show.
      this.logger.warn(`Renewal preview unavailable: ${err.message}`);
      return null;
    }
  }

  // ------------------------------------------------------------------- sync

  /**
   * Sum of the proration lines on the upcoming invoice. Passing `items` prices
   * the invoice *as if* the change had been made, so the difference between the
   * two calls is exactly what this change adds or credits.
   */
  /**
   * The total of the invoice this change would raise, or null when it cannot be
   * priced. Negative means the customer would be owed money.
   */
  private async projectedInvoice(
    account: AccountDocument,
    subscriptionId: string,
    items: Stripe.SubscriptionUpdateParams.Item[],
    rule: ChangeRule,
    prorationDate: number,
  ): Promise<number | null> {
    try {
      const invoice = await this.stripe.client.invoices.createPreview({
        customer: account.stripeCustomerId!,
        subscription: subscriptionId,
        subscription_details: {
          items: items as any,
          proration_behavior: rule.prorationBehavior,
          ...(rule.billingCycleAnchor === 'now'
            ? { billing_cycle_anchor: 'now' as const }
            : rule.prorationBehavior === 'none'
              ? {}
              : { proration_date: prorationDate }),
        },
      });
      return invoice.total;
    } catch (err: any) {
      this.logger.warn(`Could not project the invoice for a block check: ${err.message}`);
      return null;
    }
  }

  private async prorationTotal(
    account: AccountDocument,
    subscriptionId: string,
    items: Stripe.SubscriptionUpdateParams.Item[] | null,
    rule: ChangeRule | null,
    prorationDate: number,
  ): Promise<number> {
    try {
      const invoice = await this.stripe.client.invoices.createPreview({
        customer: account.stripeCustomerId!,
        subscription: subscriptionId,
        ...(items && rule
          ? {
              subscription_details: {
                items: items as any,
                proration_behavior: rule.prorationBehavior,
                ...(rule.billingCycleAnchor === 'now'
                  ? { billing_cycle_anchor: 'now' as const }
                  : rule.prorationBehavior === 'none'
                    ? {}
                    : { proration_date: prorationDate }),
              },
            }
          : {}),
      });
      return (invoice.lines?.data ?? [])
        .filter((line) => StripeService.isProration(line))
        .reduce((sum, line) => sum + line.amount, 0);
    } catch (err: any) {
      this.logger.warn(`Proration preview failed (${err.message}) — falling back to balance tracking`);
      return 0;
    }
  }

  private async customerBalance(account: AccountDocument): Promise<number> {
    const customer = await this.stripe.call('customers.retrieve', () =>
      this.stripe.client.customers.retrieve(account.stripeCustomerId!),
    );
    return (customer as any).balance ?? 0;
  }

  /** Mirrors the Stripe subscription into Mongo. */
  async syncAccountFromSubscription(
    account: AccountDocument,
    sub: Stripe.Subscription,
    maps?: CatalogMaps,
  ): Promise<AccountDocument> {
    const resolved = maps ?? (await this.catalogMaps());
    const state = readSubscriptionState(sub, resolved.byPriceId);

    account.stripeSubscriptionId = sub.id;
    account.stripeBaseItemId = state.baseItemId;
    if (ACTIVE_STATUSES.includes(sub.status)) account.deactivated = false;
    if (state.unmappedPriceIds.length > 0) {
      this.logger.warn(
        `Subscription ${sub.id} has ${state.unmappedPriceIds.length} item(s) with prices that are not in the catalog: ${state.unmappedPriceIds.join(', ')}`,
      );
    }
    account.unmappedPriceIds = state.unmappedPriceIds;
    account.subscriptionStatus = sub.status;
    account.planCode = ACTIVE_STATUSES.includes(sub.status) ? state.planCode : FREE;
    account.term = state.term;
    account.screens = ACTIVE_STATUSES.includes(sub.status) ? state.screens : 0;
    account.addOns = state.addOns.map((a) => ({
      code: a.code,
      quantity: a.quantity,
      stripeItemId: state.addOnItemIds[a.code],
    }));
    account.currentPeriodStart = StripeService.periodStart(sub) ?? undefined;
    account.currentPeriodEnd = StripeService.periodEnd(sub) ?? undefined;
    account.trialEnd = sub.trial_end ?? undefined;
    account.cancelAtPeriodEnd = sub.cancel_at_period_end;
    account.stripeScheduleId = (typeof sub.schedule === 'string' ? sub.schedule : sub.schedule?.id) ?? undefined;
    if (!account.stripeScheduleId) account.pendingChange = undefined;
    account.pauseBehavior = sub.pause_collection?.behavior;

    await this.accounts.save(account);
    return account;
  }

  /** Entry point used by webhooks. */
  async syncFromStripeSubscription(sub: Stripe.Subscription): Promise<void> {
    const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
    if (!customerId) return;
    const account = await this.accounts.findByCustomerId(customerId);
    if (!account) return;
    await this.syncAccountFromSubscription(account, sub);
  }
}
