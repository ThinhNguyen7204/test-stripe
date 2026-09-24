import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import Stripe from 'stripe';
import { AccountDocument } from '../accounts/account.schema';
import { AccountsService } from '../accounts/accounts.service';
import { BillingTerm } from '../catalog/catalog.constants';
import { CatalogService } from '../catalog/catalog.service';
import { EventsService } from '../events/events.service';
import { PolicyService } from '../policy/policy.service';
import { StripeService } from '../stripe/stripe.service';
import {
  Interval,
  X_ADDON_CODE,
  X_COMMERCIAL_CEILING,
  X_MONTHLY_TARGET,
  X_PROVIDER_HARD_CAP,
  X_RESERVATION_TTL_SECONDS,
  X_RESERVATION_UNITS,
  X_TRIAL_DAYS,
  X_TRIAL_POSTS,
  XInvoiceLine,
  coverageEnd,
  coverageFromLines,
  coveringInterval,
  grantedTarget,
  proportionalTarget,
  projectedDelta,
  quotaMonthOf,
} from './quota-math';
import {
  XCapacityReservation,
  XCapacityReservationDocument,
  XQuotaLedger,
  XQuotaLedgerDocument,
} from './x-addon.schema';

/**
 * Where the tenant's X add-on stands. Derived on every read from Stripe (is the
 * item there, is now inside paid coverage) and from the one fact Stripe cannot
 * hold: that the tenant cancelled, and until when its quota month is frozen.
 *
 * NONE             never bought, or nothing left of it
 * TRIALING         the SCIO-only trial (row 50) — no Stripe item
 * ACTIVE           item on a paid base plan and now is inside paid coverage
 * PAYMENT_PENDING  item present but the time it needs is not paid (yet)
 * FROZEN           cancelled; the quota month it was cancelled in has not ended,
 *                  so Resume reopens the same ledger (row 59)
 * CANCELED         cancelled and that quota month is over: Resume is a new
 *                  activation and the old quota has expired
 * ENDED            the base subscription it rode on is gone (row 55)
 */
export type XStatus = 'NONE' | 'TRIALING' | 'ACTIVE' | 'PAYMENT_PENDING' | 'FROZEN' | 'CANCELED' | 'ENDED';

export type SyncKind = 'initial' | 'auto' | 'manual';

/** What the add-on needs to know about the subscription it rides on. */
export interface XSubscriptionContext {
  sub: Stripe.Subscription | null;
  term: BillingTerm;
  periodEnd: number | null;
}

const LIVE_STATUSES = ['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused'];
/** a base plan that has actually been paid for — a Stripe trial is not (row 18) */
const PAID_STATUSES = ['active', 'past_due'];

@Injectable()
export class XAddonService {
  private readonly logger = new Logger(XAddonService.name);

  constructor(
    @InjectModel(XQuotaLedger.name) private readonly ledgers: Model<XQuotaLedgerDocument>,
    @InjectModel(XCapacityReservation.name) private readonly reservations: Model<XCapacityReservationDocument>,
    private readonly accounts: AccountsService,
    private readonly catalog: CatalogService,
    private readonly stripe: StripeService,
    private readonly events: EventsService,
    private readonly policy: PolicyService,
  ) {}

  // ------------------------------------------------------------ catalog bits

  private async prices(): Promise<{ monthly?: string; yearly?: string; productId?: string }> {
    const item = await this.catalog.get(X_ADDON_CODE);
    return {
      monthly: item.monthlyPrice?.priceId,
      yearly: item.yearlyPrice?.priceId,
      productId: item.stripeProductId,
    };
  }

  isXPrice(priceId: string | null | undefined, prices: { monthly?: string; yearly?: string }): boolean {
    return Boolean(priceId && (priceId === prices.monthly || priceId === prices.yearly));
  }

  xItemOf(sub: Stripe.Subscription | null, prices: { monthly?: string; yearly?: string; productId?: string }) {
    if (!sub) return null;
    return (
      (sub.items?.data ?? []).find((item) => {
        const price = typeof item.price === 'string' ? null : item.price;
        const id = typeof item.price === 'string' ? item.price : item.price?.id;
        const product = typeof price?.product === 'string' ? price.product : price?.product?.id;
        return this.isXPrice(id, prices) || (prices.productId && product === prices.productId);
      }) ?? null
    );
  }

  // -------------------------------------------------------- paid coverage

  /**
   * Every X line on every PAID invoice of the customer. Nothing here trusts a
   * local copy: coverage is replayed from Stripe on each reconcile, so a
   * retried webhook or a second read cannot grant twice (row 51).
   */
  private async paidLines(account: AccountDocument): Promise<XInvoiceLine[]> {
    if (!account.stripeCustomerId) return [];
    const prices = await this.prices();
    const lines: XInvoiceLine[] = [];
    const invoices = await this.stripe.client.invoices
      .list({ customer: account.stripeCustomerId, status: 'paid', limit: 100 })
      .autoPagingToArray({ limit: 1000 });

    for (const invoice of invoices) {
      let invoiceLines = invoice.lines?.data ?? [];
      if (invoice.lines?.has_more && invoice.id) {
        invoiceLines = await this.stripe.client.invoices
          .listLineItems(invoice.id, { limit: 100 })
          .autoPagingToArray({ limit: 1000 });
      }
      const sequence = Number(String(invoice.number ?? '').match(/(\d+)$/)?.[1] ?? 0);
      for (const line of invoiceLines) {
        const priceId = StripeService.linePriceId(line);
        const product = (line.pricing?.price_details as any)?.product ?? null;
        if (!this.isXPrice(priceId, prices) && !(prices.productId && product === prices.productId)) continue;
        if (!line.period?.start || !line.period?.end) continue;
        lines.push({
          invoiceId: invoice.id!,
          created: invoice.created,
          sequence,
          amount: line.amount,
          start: line.period.start,
          end: line.period.end,
          yearly: priceId === prices.yearly || line.period.end - line.period.start >= 360 * 86400,
        });
      }
    }
    return lines;
  }

  // ------------------------------------------------------------ ledger

  private ledgerFor(accountId: string, kind: 'paid' | 'trial', windowStart: number) {
    return this.ledgers.findOne({ accountId, kind, windowStart }).exec();
  }

  /** The trial ledger, if the tenant ever started one. */
  private trialLedger(accountId: string) {
    return this.ledgers.findOne({ accountId, kind: 'trial' }).exec();
  }

  /**
   * Opens this quota month's ledger if needed and raises `granted` to the
   * target when the target is higher. Never lowers it and never touches
   * `used` — renewals and interval changes add their positive delta only
   * (rows 6, 46, 66).
   */
  private async raiseGrant(accountId: string, q: Interval, target: number, reason: string, at: number) {
    await this.ledgers
      .updateOne(
        { accountId, kind: 'paid', windowStart: q.start },
        { $setOnInsert: { windowEnd: q.end, granted: 0, used: 0, actionIds: [], grants: [] } },
        { upsert: true },
      )
      .exec();
    const before = await this.ledgers
      .findOneAndUpdate(
        { accountId, kind: 'paid', windowStart: q.start, granted: { $lt: target } },
        { $set: { granted: target } },
        { returnDocument: 'before' },
      )
      .exec();
    if (before) {
      const delta = target - before.granted;
      await this.ledgers
        .updateOne(
          { _id: before._id },
          { $push: { grants: { at, delta, target, reason } } },
        )
        .exec();
      await this.events.record({
        accountId,
        action: 'x.quota.granted',
        summary: `Quota month ${this.day(q.start)} → ${this.day(q.end)}: +${delta} Post Updates (granted ${target}) — ${reason}`,
        result: { quotaMonth: q, delta, granted: target },
      });
    }
    return this.ledgerFor(accountId, 'paid', q.start);
  }

  // ------------------------------------------------------------ capacity

  private async capacityCeiling(): Promise<{ enforce: boolean; ceiling: number; hardCap: number }> {
    const constraints: any = (await this.policy.get()).constraints ?? {};
    return {
      enforce: constraints.enforceCapacityGuard !== false,
      ceiling: Number(constraints.xCommercialCeilingUnits ?? X_COMMERCIAL_CEILING),
      hardCap: Number(constraints.xProviderHardCapUnits ?? X_PROVIDER_HARD_CAP),
    };
  }

  async capacity(accountId?: string) {
    const now = Math.floor(Date.now() / 1000);
    const rows = await this.reservations.find().lean().exec();
    let committed = 0;
    let pending = 0;
    for (const row of rows) {
      if (row.status === 'committed') committed += row.units;
      else if ((row.expiresAt ?? 0) > now) pending += row.units;
    }
    const { enforce, ceiling, hardCap } = await this.capacityCeiling();
    const mine = accountId ? rows.find((r) => r.accountId === accountId) ?? null : null;
    return {
      committed,
      pending,
      ceiling,
      hardCap,
      buffer: hardCap - ceiling,
      enforce,
      /** would one more tenant fit? CommercialCommitted + Pending + 2,000 ≤ ceiling */
      admitsOneMore: !enforce || committed + pending + X_RESERVATION_UNITS <= ceiling,
      mine: mine
        ? { status: mine.status, units: mine.units, expiresAt: mine.status === 'pending' ? mine.expiresAt ?? null : null }
        : null,
    };
  }

  /**
   * Takes this tenant's reservation before anything is sent to Stripe. The
   * check runs AFTER the insert, against a total that includes it: two tenants
   * racing for the last slot can both be refused, but the ceiling can never be
   * oversold (row 17).
   */
  private async reserve(accountId: string): Promise<'reserved' | 'already_committed'> {
    const now = Math.floor(Date.now() / 1000);
    const existing = await this.reservations.findOne({ accountId }).exec();
    if (existing?.status === 'committed') return 'already_committed';
    await this.reservations
      .updateOne(
        { accountId },
        { $set: { status: 'pending', units: X_RESERVATION_UNITS, expiresAt: now + X_RESERVATION_TTL_SECONDS } },
        { upsert: true },
      )
      .exec();

    const cap = await this.capacity(accountId);
    if (cap.enforce && cap.committed + cap.pending > cap.ceiling) {
      await this.reservations.deleteOne({ accountId, status: 'pending' }).exec();
      const fmt = (n: number) => n.toLocaleString('en-US');
      throw new BadRequestException(
        `X capacity is full: ${fmt(cap.committed)} committed + ${fmt(cap.pending - X_RESERVATION_UNITS)} pending + ` +
          `${fmt(X_RESERVATION_UNITS)} for this tenant would pass the ${fmt(cap.ceiling)} commercial ceiling ` +
          `(${fmt(cap.hardCap)} hard cap, ${fmt(cap.hardCap - cap.ceiling)} kept as buffer). Nothing was sent to Stripe.`,
      );
    }
    return 'reserved';
  }

  private async commit(accountId: string) {
    await this.reservations
      .updateOne({ accountId }, { $set: { status: 'committed', units: X_RESERVATION_UNITS }, $unset: { expiresAt: '' } }, { upsert: true })
      .exec();
  }

  private async release(accountId: string) {
    await this.reservations.deleteOne({ accountId }).exec();
  }

  // ------------------------------------------------------------ state

  private deriveStatus(
    account: AccountDocument,
    ctx: XSubscriptionContext,
    hasItem: boolean,
    coverage: Interval[],
    now: number,
    trial: XQuotaLedgerDocument | null,
  ): XStatus {
    const x = account.xAddon ?? {};
    const baseLive = Boolean(ctx.sub && LIVE_STATUSES.includes(ctx.sub.status));
    const basePaid = Boolean(ctx.sub && PAID_STATUSES.includes(ctx.sub.status));
    if (hasItem && baseLive) {
      return basePaid && coveringInterval(coverage, now) ? 'ACTIVE' : 'PAYMENT_PENDING';
    }
    // X never outlives the base plan (row 55); a new base plan starts it from nothing
    if (!baseLive) return x.lastStatus && x.lastStatus !== 'NONE' ? 'ENDED' : 'NONE';
    if (x.cancelledAt && x.frozenUntil && now < x.frozenUntil) return 'FROZEN';
    if (trial && now < trial.windowEnd) return 'TRIALING';
    if (x.cancelledAt) return 'CANCELED';
    return 'NONE';
  }

  /**
   * Reconciles and reports the add-on. Runs on every read of the account, so a
   * missed webhook only delays a grant until the next look — it can never lose
   * or double one.
   */
  async snapshot(account: AccountDocument, ctx: XSubscriptionContext) {
    const now = await this.stripe.nowFor(account.testClockId);
    const prices = await this.prices();
    const lines = await this.paidLines(account);
    const coverage = coverageFromLines(lines);
    let xItem = this.xItemOf(ctx.sub, prices);
    const q = quotaMonthOf(now);
    const trial = await this.trialLedger(account.id);

    // V6 EASY 5: quantity is always 1. Put it back, alert, and grant nothing for the extra.
    if (xItem && (xItem.quantity ?? 1) !== 1 && ctx.sub) {
      const wrong = xItem.quantity;
      await this.stripe.call('subscriptions.update (x quantity back to 1)', () =>
        this.stripe.client.subscriptions.update(ctx.sub!.id, {
          items: [{ id: xItem!.id, quantity: 1 }],
          proration_behavior: 'none',
        }),
      );
      account.xAddon = { ...(account.xAddon ?? {}), quantityAlertAt: now, quantityAlert: `quantity ${wrong} found on ${xItem.id}, reset to 1` };
      await this.events.record({
        accountId: account.id,
        action: 'x.quantity_reconciled',
        summary: `ALERT: X add-on quantity was ${wrong} on Stripe — reset to 1 with no proration and no extra quota. Quota follows paid time, never quantity.`,
        result: { itemId: xItem.id, found: wrong },
      });
      xItem = { ...xItem, quantity: 1 } as Stripe.SubscriptionItem;
    }

    const status = this.deriveStatus(account, ctx, Boolean(xItem), coverage, now, trial);

    let ledger: XQuotaLedgerDocument | null = null;
    if (status === 'ACTIVE' || status === 'PAYMENT_PENDING') {
      const target = grantedTarget(coverage, lines, q);
      ledger = target > 0 ? await this.raiseGrant(account.id, q, target, 'paid coverage', now) : await this.ledgerFor(account.id, 'paid', q.start);
    } else if (status === 'FROZEN') {
      ledger = await this.ledgerFor(account.id, 'paid', q.start);
    }

    // commitment follows the add-on: sold while held, released once it is gone
    if (status === 'ACTIVE') {
      const mine = await this.reservations.findOne({ accountId: account.id }).exec();
      if (mine?.status !== 'committed') await this.commit(account.id);
    } else if (['NONE', 'CANCELED', 'ENDED'].includes(status)) {
      /*
       * Only a commitment is given back here. A pending reservation belongs to
       * a purchase or resume that is talking to Stripe right now — a read
       * landing in between must not free the slot under it; it expires on its
       * own after 15 minutes if that call never finishes.
       */
      await this.reservations.deleteOne({ accountId: account.id, status: 'committed' }).exec();
    }

    if ((account.xAddon?.lastStatus ?? 'NONE') !== status) {
      await this.events.record({
        accountId: account.id,
        action: 'x.status',
        summary: `X add-on ${account.xAddon?.lastStatus ?? 'NONE'} → ${status}`,
        result: { status, at: now },
      });
      account.xAddon = { ...(account.xAddon ?? {}), lastStatus: status };
      account.markModified('xAddon');
      await this.accounts.save(account);
    }

    const covering = coveringInterval(coverage, now);
    const paidThrough = covering?.end ?? null;
    const granted = ledger?.granted ?? 0;
    const used = ledger?.used ?? 0;
    const remaining = Math.max(0, granted - used);
    const trialRemaining = trial ? Math.max(0, trial.granted - trial.used) : 0;
    const trialLive = status === 'TRIALING';

    const warnings: string[] = [];
    if (status === 'ACTIVE') {
      if (granted > 0 && used >= granted) {
        warnings.push(
          `100% of this quota month's ${granted} Post Updates used — Initial, Auto and Manual sync stop until ${
            paidThrough && paidThrough < q.end ? `the renewal on ${this.day(paidThrough)} is paid` : `the next quota month on ${this.day(q.end)}`
          }. No overage is charged.`,
        );
      } else if (granted > 0 && used >= 0.8 * granted) {
        warnings.push(`80% of this quota month's ${granted} Post Updates used (${used}).`);
      }
      if (paidThrough && paidThrough < q.end) {
        warnings.push(
          `Paid through ${this.day(paidThrough)}, before this quota month ends on ${this.day(q.end)}: ${granted} of ${X_MONTHLY_TARGET} is granted for the time already paid. The rest is added when the renewal is paid — it is not lost.`,
        );
      }
    }
    if (status === 'PAYMENT_PENDING') {
      warnings.push('The X add-on is on the subscription but its time is not paid — no new posts are fetched until the invoice is paid.');
    }
    if (status === 'FROZEN') {
      warnings.push(
        `Cancelled and frozen until ${this.day(account.xAddon!.frozenUntil!)}. Resuming before then reopens this quota month with Used and Remaining as they were.`,
      );
    }

    const resume =
      (status === 'FROZEN' || status === 'CANCELED') && ctx.sub && PAID_STATUSES.includes(ctx.sub.status)
        ? this.resumePlan(now, coverage, ctx, status)
        : null;

    return {
      status,
      now,
      term: ctx.term,
      price: { monthlyCents: 2000, yearlyCents: 21600 },
      itemId: xItem?.id ?? null,
      quotaMonth: q,
      ledger: ledger
        ? {
            granted,
            used,
            remaining,
            fullMonthTarget: X_MONTHLY_TARGET,
            partial: granted < X_MONTHLY_TARGET,
            grants: ledger.grants ?? [],
          }
        : null,
      trial: trial
        ? {
            startedAt: trial.windowStart,
            endsAt: trial.windowEnd,
            granted: trial.granted,
            used: trial.used,
            remaining: trialRemaining,
            live: trialLive,
          }
        : null,
      trialAvailable:
        !trial && status === 'NONE' && Boolean(ctx.sub && PAID_STATUSES.includes(ctx.sub.status)),
      paidThrough,
      coverage,
      frozen:
        status === 'FROZEN'
          ? { since: account.xAddon?.cancelledAt ?? null, until: account.xAddon?.frozenUntil ?? null }
          : null,
      canFetchNewPosts: (status === 'ACTIVE' && remaining > 0) || (trialLive && trialRemaining > 0),
      canDisplayStoredPosts: status === 'ACTIVE' || trialLive,
      /** row 49: cancel switches the tenant's fan-out off at once */
      fanOut: status === 'ACTIVE' || trialLive,
      manualOnly: trialLive,
      resume,
      quantityAlert: account.xAddon?.quantityAlert ?? null,
      capacity: await this.capacity(account.id),
      warnings,
    };
  }

  /**
   * Where a re-added item has to start charging: never before now, and never
   * before the end of what is already paid — a monthly cancellation hands no
   * money back, so charging that stretch again would bill it twice; a yearly
   * one was credited from quotaMonthEnd, so that is exactly where the debit
   * starts again (row 59, V6 EASY 1).
   */
  private resumePlan(now: number, coverage: Interval[], ctx: XSubscriptionContext, status: XStatus) {
    const paidEnd = coverageEnd(coverage) ?? now;
    const prorationDate = Math.max(now, paidEnd);
    const periodEnd = ctx.periodEnd ?? prorationDate;
    const chargeNow = prorationDate < periodEnd;
    return {
      kind: status === 'FROZEN' ? ('same_quota_month' as const) : ('new_activation' as const),
      prorationDate,
      prorationBehavior: chargeNow ? ('always_invoice' as const) : ('none' as const),
      chargesFrom: chargeNow ? prorationDate : null,
      chargesTo: chargeNow ? periodEnd : null,
    };
  }

  // ------------------------------------------------------------ previews

  /** Buying the add-on: what Stripe would invoice now, and what quota it opens. */
  async previewPurchase(account: AccountDocument, ctx: XSubscriptionContext) {
    this.assertBasePaid(ctx);
    const snap = await this.snapshot(account, ctx);
    if (snap.status === 'FROZEN' || snap.status === 'CANCELED') return this.previewResume(account, ctx, snap);
    const priceId = await this.catalog.priceIdFor(X_ADDON_CODE, ctx.term);
    const now = snap.now;
    const params = {
      items: [{ price: priceId, quantity: 1 }],
      proration_behavior: 'always_invoice' as const,
      proration_date: now,
    };
    const invoice = await this.previewInvoice(account, ctx.sub!, params);
    const quota = await this.quotaProjection(account, snap, ctx.periodEnd ? { start: now, end: ctx.periodEnd } : null);
    return {
      mode: 'x_purchase',
      explanation: [
        `X add-on, quantity fixed at 1: ${ctx.term === 'yearly' ? '$216 / year' : '$20 / month'} on the same subscription, interval and card as the base plan (rows 4, 51).`,
        'Stripe prorates the money from now to the billing boundary and charges it now (always_invoice, error_if_incomplete) — a declined card leaves nothing changed.',
        `Quota is SCIO's, on a fixed calendar quota month ${this.day(snap.quotaMonth.start)} → ${this.day(snap.quotaMonth.end)}: ${quota.formula}.`,
        'The quota opens only after the invoice is paid.',
        `Capacity: one reservation of ${X_RESERVATION_UNITS.toLocaleString()} is taken before Stripe is called and committed on payment (${snap.capacity.committed.toLocaleString()} committed + ${snap.capacity.pending.toLocaleString()} pending of ${snap.capacity.ceiling.toLocaleString()}).`,
        ...(snap.trial?.live ? [`The running trial ends on purchase; its ${snap.trial.remaining} remaining trial posts are not carried over (row 50).`] : []),
      ],
      capacity: snap.capacity,
      invoice,
      quota,
      stripeParams: { call: 'subscriptions.update', ...params, payment_behavior: 'error_if_incomplete' },
    };
  }

  async previewCancel(account: AccountDocument, ctx: XSubscriptionContext) {
    const snap = await this.snapshot(account, ctx);
    if (!snap.itemId) throw new BadRequestException('There is no X add-on on this subscription to cancel.');
    const plan = this.cancelPlan(snap.now, ctx, snap.itemId);
    const invoice = plan.params.proration_behavior === 'always_invoice' ? await this.previewInvoice(account, ctx.sub!, plan.params) : null;
    return {
      mode: 'x_cancel',
      explanation: plan.explanation,
      invoice,
      quota: snap.ledger
        ? { quotaMonth: snap.quotaMonth, granted: snap.ledger.granted, used: snap.ledger.used, frozenUntil: snap.quotaMonth.end }
        : null,
      stripeParams: { call: 'subscriptions.update', ...plan.params },
    };
  }

  async previewResume(account: AccountDocument, ctx: XSubscriptionContext, known?: Awaited<ReturnType<XAddonService['snapshot']>>) {
    this.assertBasePaid(ctx);
    const snap = known ?? (await this.snapshot(account, ctx));
    if (!snap.resume) throw new BadRequestException(`Nothing to resume — the X add-on is ${snap.status}.`);
    const params = await this.resumeParams(snap.resume, ctx.term);
    const invoice = params.proration_behavior === 'always_invoice' ? await this.previewInvoice(account, ctx.sub!, params) : null;
    const added = snap.resume.chargesFrom && snap.resume.chargesTo ? { start: snap.resume.chargesFrom, end: snap.resume.chargesTo } : null;
    const quota = await this.quotaProjection(account, snap, added);
    return {
      mode: 'x_resume',
      explanation: [
        snap.resume.kind === 'same_quota_month'
          ? `Resume inside the quota month it was cancelled in: the same ledger reopens with Granted ${snap.ledger?.granted ?? 0} / Used ${snap.ledger?.used ?? 0} — nothing is reset or granted again (row 59).`
          : `The quota month it was cancelled in is over, so this is a new activation: the old quota has expired and this month is granted by paid coverage.`,
        snap.resume.prorationBehavior === 'none'
          ? `Time is already paid up to ${this.day(snap.resume.prorationDate)}, the end of this billing period — the item goes back with proration_behavior=none and nothing is charged twice. Stripe bills it again at renewal.`
          : `Stripe charges from ${this.day(snap.resume.prorationDate)} (proration_date) to ${this.day(snap.resume.chargesTo)}, never a stretch already paid for${snap.term === 'yearly' ? ' — the same boundary the yearly credit was issued from' : ''}.`,
        'The ledger and the fan-out unfreeze only after payment succeeds; a declined card leaves the add-on frozen.',
        'A capacity reservation is taken again before Stripe is called.',
      ],
      capacity: snap.capacity,
      invoice,
      quota,
      stripeParams: { call: 'subscriptions.update', ...params },
    };
  }

  private async quotaProjection(
    account: AccountDocument,
    snap: Awaited<ReturnType<XAddonService['snapshot']>>,
    added: Interval | null,
  ) {
    const lines = await this.paidLines(account);
    const already = snap.status === 'FROZEN' || snap.status === 'ACTIVE' ? snap.ledger?.granted ?? 0 : 0;
    const { target, delta } = projectedDelta(snap.coverage, lines, snap.quotaMonth, added, already);
    const q = snap.quotaMonth;
    const covered = added ? Math.min(added.end, q.end) - Math.max(added.start, q.start) : 0;
    return {
      quotaMonth: q,
      grantedBefore: already,
      target,
      delta,
      formula: added
        ? `floor(2,000 × ${(covered / 86400).toFixed(2)} paid days / ${((q.end - q.start) / 86400).toFixed(0)}-day quota month) = ${proportionalTarget([added], q)}` +
          (already ? ` — ${already} already granted this month, so +${delta}` : '')
        : `no new paid time — the grant stays ${already}`,
    };
  }

  private async previewInvoice(account: AccountDocument, sub: Stripe.Subscription, params: any) {
    try {
      const invoice = await this.stripe.client.invoices.createPreview({
        customer: account.stripeCustomerId!,
        subscription: sub.id,
        subscription_details: {
          items: params.items,
          proration_behavior: params.proration_behavior,
          ...(params.proration_date ? { proration_date: params.proration_date } : {}),
        },
      });
      return this.stripe.summarizeInvoice(invoice);
    } catch (err: any) {
      this.logger.warn(`X preview unavailable: ${err?.raw?.message ?? err.message}`);
      return null;
    }
  }

  // ------------------------------------------------------------ mutations

  private assertBasePaid(ctx: XSubscriptionContext) {
    if (!ctx.sub || !PAID_STATUSES.includes(ctx.sub.status)) {
      throw new BadRequestException(
        `The X add-on rides on a paid base plan (row 18), and this subscription is ${ctx.sub?.status ?? 'missing'}.` +
          (ctx.sub?.status === 'trialing' ? ' End the base trial first.' : ''),
      );
    }
    if (ctx.sub.schedule) {
      throw new BadRequestException(
        'A scheduled change is in charge of this subscription. Call it off first, then change the X add-on.',
      );
    }
  }

  /** First purchase (or re-activation after the frozen month): reserve → charge → commit → grant. */
  async purchase(account: AccountDocument, ctx: XSubscriptionContext): Promise<Stripe.Subscription> {
    this.assertBasePaid(ctx);
    const snap = await this.snapshot(account, ctx);
    if (snap.status === 'ACTIVE' || snap.status === 'PAYMENT_PENDING') {
      throw new BadRequestException('The X add-on is already on this subscription — one per tenant, quantity 1 (row 4).');
    }
    if (snap.status === 'FROZEN' || snap.status === 'CANCELED') return this.resume(account, ctx);

    const priceId = await this.catalog.priceIdFor(X_ADDON_CODE, ctx.term);
    const params: Stripe.SubscriptionUpdateParams = {
      items: [{ price: priceId, quantity: 1 }],
      proration_behavior: 'always_invoice',
      proration_date: snap.now,
      payment_behavior: 'error_if_incomplete',
      expand: ['latest_invoice'],
    };
    await this.reserve(account.id);
    let updated: Stripe.Subscription;
    try {
      updated = await this.stripe.call('subscriptions.update (add X)', () =>
        this.stripe.client.subscriptions.update(ctx.sub!.id, params),
      );
    } catch (err) {
      await this.release(account.id);
      await this.events.record({
        accountId: account.id,
        action: 'x.purchase_failed',
        summary: `X add-on not bought — ${(err as any)?.response?.message ?? (err as Error).message}. Reservation released, nothing granted.`,
        stripeRequest: params as any,
      });
      throw err;
    }

    const invoice = typeof updated.latest_invoice === 'string' ? null : updated.latest_invoice;
    if (invoice?.status === 'paid') await this.commit(account.id);
    if (snap.trial?.live) await this.endTrial(account, snap.now, 'the paid add-on was bought');

    await this.events.record({
      accountId: account.id,
      action: 'x.purchased',
      summary: `X add-on bought on the ${ctx.term} term — invoice ${invoice?.number ?? invoice?.id ?? '—'} ${invoice?.status ?? ''} ${((invoice?.amount_paid ?? 0) / 100).toFixed(2)}`,
      stripeRequest: params as any,
      result: { invoice: invoice ? this.stripe.summarizeInvoice(invoice) : null },
    });
    return updated;
  }

  private cancelPlan(now: number, ctx: XSubscriptionContext, itemId: string) {
    const q = quotaMonthOf(now);
    const periodEnd = ctx.periodEnd ?? q.end;
    const yearlyCredit = ctx.term === 'yearly' && q.end < periodEnd;
    const params: Stripe.SubscriptionUpdateParams = yearlyCredit
      ? { items: [{ id: itemId, deleted: true }], proration_behavior: 'always_invoice', proration_date: q.end }
      : { items: [{ id: itemId, deleted: true }], proration_behavior: 'none' };
    return {
      q,
      params,
      explanation: [
        'Cancel takes effect now (row 49): the X item is deleted from the subscription, the tenant is FROZEN and its fan-out switched off. The base plan is untouched.',
        yearlyCredit
          ? `Yearly: proration_date = quotaMonthEnd ${this.day(q.end)}, so Stripe credits the unused coverage ${this.day(q.end)} → ${this.day(periodEnd)} to the customer balance. The quota month in progress stays paid.`
          : ctx.term === 'yearly'
            ? 'Yearly, but the paid year ends inside this quota month — there is no coverage after quotaMonthEnd to credit.'
            : 'Monthly: proration_behavior=none — no automatic refund.',
        `Granted, Used and Remaining are kept FROZEN until ${this.day(q.end)}; resuming before then continues with them, after it they expire.`,
        'The capacity reservation is released.',
      ],
    };
  }

  async cancel(account: AccountDocument, ctx: XSubscriptionContext): Promise<Stripe.Subscription> {
    if (!ctx.sub) throw new BadRequestException('No subscription.');
    if (ctx.sub.schedule) {
      throw new BadRequestException('A scheduled change is in charge of this subscription. Call it off first, then cancel the X add-on.');
    }
    const prices = await this.prices();
    const item = this.xItemOf(ctx.sub, prices);
    if (!item) throw new BadRequestException('There is no X add-on on this subscription to cancel.');
    const now = await this.stripe.nowFor(account.testClockId);
    const plan = this.cancelPlan(now, ctx, item.id);
    const balanceBefore = await this.balance(account);

    const updated = await this.stripe.call('subscriptions.update (cancel X)', () =>
      this.stripe.client.subscriptions.update(ctx.sub!.id, { ...plan.params, expand: ['latest_invoice'] }),
    );
    const credit = Math.max(0, balanceBefore - (await this.balance(account)));

    account.xAddon = {
      ...(account.xAddon ?? {}),
      cancelledAt: now,
      frozenUntil: plan.q.end,
      cancelTerm: ctx.term,
    };
    account.markModified('xAddon');
    await this.accounts.save(account);
    await this.release(account.id);

    await this.events.record({
      accountId: account.id,
      action: 'x.cancelled',
      summary: `X add-on cancelled — FROZEN until ${this.day(plan.q.end)}, fan-out off. ${
        credit > 0 ? `Yearly credit ${(credit / 100).toFixed(2)} to the customer balance.` : 'No refund.'
      }`,
      stripeRequest: plan.params as any,
      result: { creditCents: credit, frozenUntil: plan.q.end },
    });
    return updated;
  }

  private async resumeParams(
    plan: NonNullable<ReturnType<XAddonService['resumePlan']>>,
    term: BillingTerm,
  ): Promise<Stripe.SubscriptionUpdateParams> {
    const priceId = await this.catalog.priceIdFor(X_ADDON_CODE, term);
    return plan.prorationBehavior === 'none'
      ? { items: [{ price: priceId, quantity: 1 }], proration_behavior: 'none' }
      : {
          items: [{ price: priceId, quantity: 1 }],
          proration_behavior: 'always_invoice',
          proration_date: plan.prorationDate,
          payment_behavior: 'error_if_incomplete',
        };
  }

  async resume(account: AccountDocument, ctx: XSubscriptionContext): Promise<Stripe.Subscription> {
    this.assertBasePaid(ctx);
    const snap = await this.snapshot(account, ctx);
    if (!snap.resume) throw new BadRequestException(`Nothing to resume — the X add-on is ${snap.status}.`);
    const params = { ...(await this.resumeParams(snap.resume, ctx.term)), expand: ['latest_invoice'] };

    await this.reserve(account.id);
    let updated: Stripe.Subscription;
    try {
      updated = await this.stripe.call('subscriptions.update (resume X)', () =>
        this.stripe.client.subscriptions.update(ctx.sub!.id, params),
      );
    } catch (err) {
      await this.release(account.id);
      await this.events.record({
        accountId: account.id,
        action: 'x.resume_failed',
        summary: `Resume refused — ${(err as any)?.response?.message ?? (err as Error).message}. Still ${snap.status}; nothing unfrozen.`,
        stripeRequest: params as any,
      });
      throw err;
    }

    const invoice = typeof updated.latest_invoice === 'string' ? null : updated.latest_invoice;
    const paid = params.proration_behavior === 'none' || invoice?.status === 'paid';
    if (paid) await this.commit(account.id);
    account.xAddon = {
      ...(account.xAddon ?? {}),
      cancelledAt: undefined,
      frozenUntil: undefined,
      cancelTerm: undefined,
      lastResumedAt: snap.now,
    };
    account.markModified('xAddon');
    await this.accounts.save(account);

    await this.events.record({
      accountId: account.id,
      action: 'x.resumed',
      summary: `X add-on resumed (${snap.resume.kind === 'same_quota_month' ? 'same quota month — ledger reopened as it was' : 'new activation'}) — ${
        params.proration_behavior === 'none'
          ? 'already paid, nothing charged'
          : `charged from ${this.day(snap.resume.prorationDate)}: ${invoice?.number ?? invoice?.id} ${((invoice?.total ?? 0) / 100).toFixed(2)}`
      }`,
      stripeRequest: params as any,
      result: { invoice: invoice ? this.stripe.summarizeInvoice(invoice) : null, plan: snap.resume },
    });
    return updated;
  }

  /** Row 50: 14 days, 200 posts, once per account, Manual Refresh only, no Stripe item. */
  async startTrial(account: AccountDocument, ctx: XSubscriptionContext) {
    const snap = await this.snapshot(account, ctx);
    if (snap.trial) throw new BadRequestException('The X trial runs once per account, and this one has already had it.');
    if (snap.status !== 'NONE') throw new BadRequestException(`A trial is only for a tenant without the add-on — it is ${snap.status}.`);
    if (!ctx.sub || !PAID_STATUSES.includes(ctx.sub.status)) {
      throw new BadRequestException('The X trial needs an active base plan underneath it.');
    }
    const now = snap.now;
    const end = now + X_TRIAL_DAYS * 86400;
    await this.ledgers.create({
      accountId: account.id,
      kind: 'trial',
      windowStart: now,
      windowEnd: end,
      granted: X_TRIAL_POSTS,
      used: 0,
      actionIds: [],
      grants: [{ at: now, delta: X_TRIAL_POSTS, target: X_TRIAL_POSTS, reason: 'trial' }],
    });
    await this.events.record({
      accountId: account.id,
      action: 'x.trial_started',
      summary: `X trial: ${X_TRIAL_POSTS} Post Updates until ${this.day(end)}, Manual Refresh only, no Stripe item, no rollover.`,
      result: { endsAt: end },
    });
  }

  private async endTrial(account: AccountDocument, now: number, reason: string) {
    await this.ledgers.updateOne({ accountId: account.id, kind: 'trial', windowEnd: { $gt: now } }, { $set: { windowEnd: now } }).exec();
    await this.events.record({
      accountId: account.id,
      action: 'x.trial_ended',
      summary: `X trial ended — ${reason}. Remaining trial posts expire and are not carried over.`,
    });
  }

  /**
   * One provider fetch. The quota is spent by what X actually RETURNED and
   * billed, clamped to what is left, exactly once per actionId (rows 11, 12,
   * EASY 2). A fetch the guards refuse is not attempted at all.
   */
  async recordSyncRun(
    account: AccountDocument,
    ctx: XSubscriptionContext,
    input: { kind?: SyncKind; returned?: number; requested?: number; actionId?: string },
  ) {
    const kind: SyncKind = input.kind ?? 'manual';
    if (!['initial', 'auto', 'manual'].includes(kind)) throw new BadRequestException(`Unknown sync kind "${kind}"`);
    const returned = Math.max(0, Math.floor(Number(input.returned ?? 0)));
    const requested = Math.max(returned, Math.floor(Number(input.requested ?? returned)));
    const actionId = String(input.actionId ?? `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

    const snap = await this.snapshot(account, ctx);
    const trialLive = snap.status === 'TRIALING';
    if (!(snap.status === 'ACTIVE' || trialLive)) {
      throw new ConflictException(`No provider fetch: the X add-on is ${snap.status}. Nothing was charged.`);
    }
    if (trialLive && kind !== 'manual') {
      throw new ConflictException('The X trial is Manual Refresh only — no Initial or Auto Sync (row 50).');
    }
    const kindOfLedger = trialLive ? 'trial' : 'paid';
    const window = trialLive ? snap.trial!.startedAt : snap.quotaMonth.start;
    const remaining = trialLive ? snap.trial!.remaining : snap.ledger?.remaining ?? 0;
    if (remaining <= 0) {
      throw new ConflictException(
        `Quota exhausted (0 remaining) — the fetch is not attempted. ${snap.warnings[0] ?? ''}`.trim(),
      );
    }

    const before = await this.ledgers
      .findOneAndUpdate(
        { accountId: account.id, kind: kindOfLedger, windowStart: window, actionIds: { $ne: actionId } },
        [
          {
            $set: {
              used: { $min: ['$granted', { $add: ['$used', returned] }] },
              actionIds: { $concatArrays: ['$actionIds', [actionId]] },
            },
          },
        ],
        { returnDocument: 'before', updatePipeline: true } as any,
      )
      .lean<XQuotaLedger>()
      .exec();

    if (!before) {
      const ledger = await this.ledgerFor(account.id, kindOfLedger, window);
      if (ledger?.actionIds.includes(actionId)) {
        return { duplicate: true, actionId, charged: 0, remaining: Math.max(0, ledger.granted - ledger.used) };
      }
      throw new ConflictException('No quota ledger is open for this window — nothing was charged.');
    }
    const charged = Math.min(returned, Math.max(0, before.granted - before.used));
    const after = Math.max(0, before.granted - before.used - charged);
    await this.events.record({
      accountId: account.id,
      action: 'x.sync_run',
      summary: `${kind} sync: asked ${requested}, X returned and billed ${returned} → −${charged} Post Updates${charged < returned ? ` (clamped to what was left)` : ''}, ${after} left`,
      result: { kind, requested, returned, charged, remaining: after, actionId, ledger: kindOfLedger },
    });
    return { duplicate: false, actionId, kind, requested, returned, charged, remaining: after, clamped: charged < returned };
  }

  // ------------------------------------------------------------ helpers

  private async balance(account: AccountDocument): Promise<number> {
    const customer = await this.stripe.client.customers.retrieve(account.stripeCustomerId!);
    return (customer as any).balance ?? 0;
  }

  private day(t: number | null | undefined) {
    return t ? new Date(t * 1000).toISOString().slice(0, 10) : '—';
  }
}
