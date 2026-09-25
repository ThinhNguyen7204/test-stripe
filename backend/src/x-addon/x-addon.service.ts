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
  XTenantLock,
  XTenantLockDocument,
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
 * FROZEN           cancelled; the quota month it was cancelled in has not ended.
 *                  The Stripe item is kept at quantity 0 until AlreadyPaidUntil,
 *                  and buying X again before then puts it back to 1 (row 59)
 * CANCELED         cancelled and that quota month is over: buying X again is a
 *                  new activation and the old quota has expired
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
    @InjectModel(XTenantLock.name) private readonly locks: Model<XTenantLockDocument>,
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

  /**
   * V6 EASY 5: the commercial quantity is 1. Quantity 0 is not a second
   * package — it is the technical FROZEN sentinel a Cancel leaves on the same
   * item until AlreadyPaidUntil, so buying X again can reuse it (rows 49, 51).
   */
  static quantityOf(item: Stripe.SubscriptionItem | null | undefined): number {
    return item ? item.quantity ?? 1 : 0;
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

  // -------------------------------------------------------- quota cycle

  /**
   * The base plan's billing cycle anchor: where a quota cycle starts when X is
   * activated on it, so the first quota months ARE the base plan's billing
   * months. Falls back to the current period start, then to now.
   */
  static baseAnchorOf(sub: Stripe.Subscription | null, now: number): number {
    return sub?.billing_cycle_anchor ?? (sub ? StripeService.periodStart(sub) : null) ?? now;
  }

  /**
   * The anchor in force: MODEL V6's xQuotaAnchorAt. It is recorded once, when X
   * is first charged, on the base plan's billing cycle, and it never moves again
   * — not on an interval change, a renewal, a Cancel or buying X again (rows 46,
   * 59, 60; operator, 2026-09-25). Only a tenant that has never bought X has no
   * anchor, and follows the base plan's current cycle until it does.
   */
  private quotaAnchorFor(account: AccountDocument, ctx: XSubscriptionContext, _status: XStatus, now: number): number {
    return account.xAddon?.quotaAnchor ?? XAddonService.baseAnchorOf(ctx.sub, now);
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
        // A quantity-0 line — the Cancel receipt's "remaining time on 0 × X", or a
        // renewal raised before the boundary cleanup ran — pays for nothing.
        if ((line as any).quantity === 0) continue;
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

  /**
   * Row 8: buying X again and the boundary cleanup both touch the same Stripe
   * item, so each holds this lock while it does. The upsert only matches an
   * expired row; a live one makes it insert a duplicate, which is "busy".
   */
  private async lock(accountId: string, holder: string, ttlSeconds = 120): Promise<string | null> {
    const wall = Math.floor(Date.now() / 1000);
    const token = `${holder}:${wall}:${Math.random().toString(36).slice(2, 10)}`;
    try {
      await this.locks
        .updateOne({ accountId, expiresAt: { $lte: wall } }, { $set: { holder: token, expiresAt: wall + ttlSeconds } }, { upsert: true })
        .exec();
      return token;
    } catch (err: any) {
      if (err?.code === 11000) return null;
      throw err;
    }
  }

  private async unlock(accountId: string, token: string) {
    await this.locks.deleteOne({ accountId, holder: token }).exec();
  }

  /**
   * Rows 49, 7, 8: once AlreadyPaidUntil has passed, the quantity-0 item has
   * nothing left to protect, so it is deleted with proration_behavior=none —
   * no money moves — and later renewals carry no X line. Runs only while the
   * item is still at 0, the tenant is still cancelled and no purchase holds
   * the tenant; a failure is retried on the next reconcile and becomes an
   * alert 24 hours after the boundary.
   */
  private async cleanup(account: AccountDocument, ctx: XSubscriptionContext, item: Stripe.SubscriptionItem, now: number): Promise<boolean> {
    const x = account.xAddon ?? {};
    const wall = Math.floor(Date.now() / 1000);
    const pending = await this.reservations.findOne({ accountId: account.id, status: 'pending' }).exec();
    if (pending && (pending.expiresAt ?? 0) > wall) return false;
    const token = await this.lock(account.id, 'cleanup', 60);
    if (!token) return false;
    const attempt = (x.cleanupAttempts ?? 0) + 1;
    try {
      const fresh = await this.stripe.client.subscriptions.retrieve(ctx.sub!.id);
      const current = fresh.items.data.find((i) => i.id === item.id);
      if (current && (XAddonService.quantityOf(current) !== 0 || !x.cancelledAt)) return false;
      if (current) {
        const constraints: any = (await this.policy.get()).constraints ?? {};
        if (constraints.xCleanupPaused) throw new Error('cleanup paused by policy (xCleanupPaused test switch)');
        await this.stripe.client.subscriptions.update(
          ctx.sub!.id,
          { items: [{ id: item.id, deleted: true }], proration_behavior: 'none' },
          { idempotencyKey: `x-cleanup-${item.id}-${attempt}` },
        );
      }
      account.xAddon = { ...x, cleanedUpAt: now, cleanupError: undefined, cleanupAttempts: attempt };
      account.markModified('xAddon');
      await this.accounts.save(account);
      await this.events.record({
        accountId: account.id,
        action: 'x.cleanup',
        summary: `Quantity-0 X item ${item.id} deleted with proration_behavior=none at AlreadyPaidUntil ${this.day(x.alreadyPaidUntil)} — no money moved; later renewals carry no X line.`,
        stripeRequest: { items: [{ id: item.id, deleted: true }], proration_behavior: 'none' } as any,
      });
      return true;
    } catch (err: any) {
      const message = err?.raw?.message ?? err?.message ?? 'unknown error';
      const overdue = now >= (x.cleanupDeadline ?? Number.MAX_SAFE_INTEGER);
      const alert = overdue ? `cleanup of ${item.id} still failing 24 hours after ${this.day(x.alreadyPaidUntil)}: ${message}` : x.cleanupAlert;
      const changed = x.cleanupError !== message || alert !== x.cleanupAlert;
      account.xAddon = { ...x, cleanupError: message, cleanupAlert: alert, cleanupAttempts: attempt };
      account.markModified('xAddon');
      await this.accounts.save(account);
      if (changed) {
        await this.events.record({
          accountId: account.id,
          action: overdue ? 'x.cleanup_overdue' : 'x.cleanup_failed',
          summary: overdue
            ? `ALERT: ${alert}. The item stays at quantity 0 — nothing is charged or granted — until a retry succeeds.`
            : `Cleanup of quantity-0 X item ${item.id} failed (${message}); retried on the next reconcile until ${this.day(x.cleanupDeadline)}.`,
        });
      }
      return false;
    } finally {
      await this.unlock(account.id, token);
    }
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
    const trial = await this.trialLedger(account.id);

    /*
     * V6 EASY 5: quantity 1 must match ACTIVE and quantity 0 must match a
     * Cancel (FROZEN, with a cleanup date). Anything else is put back, alerted
     * on, and grants nothing — quota follows paid time, never quantity.
     */
    if (xItem && ctx.sub) {
      const qty = XAddonService.quantityOf(xItem);
      const cancelled = Boolean(account.xAddon?.cancelledAt);
      if (qty === 1 && cancelled) {
        // Stripe already holds the bought-again item: the purchase finished on
        // Stripe's side before SCIO recorded it. Stripe is the money's truth.
        account.xAddon = this.clearCancel(account.xAddon, now, xItem.id);
        account.markModified('xAddon');
        await this.accounts.save(account);
      } else if (qty > 1) {
        const back = cancelled ? 0 : 1;
        await this.stripe.call(`subscriptions.update (x quantity back to ${back})`, () =>
          this.stripe.client.subscriptions.update(ctx.sub!.id, {
            items: [{ id: xItem!.id, quantity: back }],
            proration_behavior: 'none',
          }),
        );
        account.xAddon = { ...(account.xAddon ?? {}), quantityAlertAt: now, quantityAlert: `quantity ${qty} found on ${xItem.id}, reset to ${back}` };
        await this.events.record({
          accountId: account.id,
          action: 'x.quantity_reconciled',
          summary: `ALERT: X add-on quantity was ${qty} on Stripe — reset to ${back} with no proration and no extra quota. The commercial quantity is 1; 0 is only the FROZEN sentinel.`,
          result: { itemId: xItem.id, found: qty, reset: back },
        });
        xItem = { ...xItem, quantity: back } as Stripe.SubscriptionItem;
      } else if (qty === 0 && !cancelled && account.xAddon?.quantityAlert !== `quantity 0 on ${xItem.id} without a Cancel`) {
        account.xAddon = { ...(account.xAddon ?? {}), quantityAlertAt: now, quantityAlert: `quantity 0 on ${xItem.id} without a Cancel` };
        account.markModified('xAddon');
        await this.accounts.save(account);
        await this.events.record({
          accountId: account.id,
          action: 'x.quantity_reconciled',
          summary: `ALERT: X item ${xItem.id} is at quantity 0 but SCIO recorded no Cancel — entitlement locked, nothing granted.`,
          result: { itemId: xItem.id, found: 0 },
        });
      }
    }

    // rows 49, 8: past AlreadyPaidUntil the quantity-0 item is cleaned up
    const parkedNow = xItem && XAddonService.quantityOf(xItem) === 0 ? xItem : null;
    const cleanupDue = account.xAddon?.alreadyPaidUntil;
    if (parkedNow && ctx.sub && account.xAddon?.cancelledAt && cleanupDue && now >= cleanupDue) {
      if (await this.cleanup(account, ctx, parkedNow, now)) xItem = null;
    }
    const liveItem = xItem && XAddonService.quantityOf(xItem) >= 1 ? xItem : null;
    const parkedItem = xItem && XAddonService.quantityOf(xItem) === 0 ? xItem : null;

    const status = this.deriveStatus(account, ctx, Boolean(liveItem), coverage, now, trial);

    const quotaAnchor = this.quotaAnchorFor(account, ctx, status, now);
    const q = quotaMonthOf(now, quotaAnchor);
    // an add-on that went live before its anchor was recorded is pinned to the base cycle once
    if ((status === 'ACTIVE' || status === 'PAYMENT_PENDING') && !account.xAddon?.quotaAnchor) {
      account.xAddon = { ...(account.xAddon ?? {}), quotaAnchor };
      account.markModified('xAddon');
      await this.accounts.save(account);
    }

    let ledger: XQuotaLedgerDocument | null = null;
    if (status === 'ACTIVE' || status === 'PAYMENT_PENDING') {
      const target = grantedTarget(coverage, lines, q, quotaAnchor);
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
       * a purchase that is talking to Stripe right now — a read
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
        `Cancelled and frozen until ${this.day(account.xAddon!.frozenUntil!)}. There is no separate restore: buying X again before then restores FrozenRemaining, which still expires on ${this.day(account.xAddon!.frozenUntil!)}.`,
      );
    }
    if (account.xAddon?.cleanupAlert && parkedItem) warnings.push(`Alert: ${account.xAddon.cleanupAlert}.`);

    const repurchase =
      (status === 'FROZEN' || status === 'CANCELED') && ctx.sub && PAID_STATUSES.includes(ctx.sub.status)
        ? this.repurchasePlan(now, coverage, ctx, account, parkedItem)
        : null;

    return {
      status,
      now,
      term: ctx.term,
      price: { monthlyCents: 2000, yearlyCents: 21600 },
      itemId: liveItem?.id ?? null,
      /** rows 49, 51: the same item, kept at quantity 0 after a Cancel until AlreadyPaidUntil */
      parkedItem: parkedItem
        ? {
            id: parkedItem.id,
            quantity: 0,
            alreadyPaidUntil: account.xAddon?.alreadyPaidUntil ?? null,
            cleanupAt: account.xAddon?.cleanupAt ?? null,
            cleanupDeadline: account.xAddon?.cleanupDeadline ?? null,
            cleanupError: account.xAddon?.cleanupError ?? null,
          }
        : null,
      cleanedUpAt: account.xAddon?.cleanedUpAt ?? null,
      quotaMonth: q,
      quotaAnchor,
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
          ? { since: account.xAddon?.cancelledAt ?? null, until: account.xAddon?.frozenUntil ?? null, alreadyPaidUntil: account.xAddon?.alreadyPaidUntil ?? null }
          : null,
      canFetchNewPosts: (status === 'ACTIVE' && remaining > 0) || (trialLive && trialRemaining > 0),
      canDisplayStoredPosts: status === 'ACTIVE' || trialLive,
      /** row 49: cancel switches the tenant's fan-out off at once */
      fanOut: status === 'ACTIVE' || trialLive,
      manualOnly: trialLive,
      /** what buying X again would do — there is no separate restore action (row 59) */
      repurchase,
      quantityAlert: account.xAddon?.quantityAlert ?? null,
      capacity: await this.capacity(account.id),
      warnings,
    };
  }

  /**
   * Buying X again after a Cancel (row 59, rows 7-8, V6 EASY 1).
   *
   * `AlreadyPaidUntil = min(oldPaidThrough, quotaMonthEnd)`, stored at Cancel.
   * Before it, and while the quantity-0 item still exists, that same item goes
   * back 0 → 1 with `proration_date = AlreadyPaidUntil`: FrozenRemaining is
   * restored, nothing already paid is charged twice, and where Cancel credited
   * the coverage after the boundary Stripe debits exactly that back. From
   * AlreadyPaidUntil on it is a new activation, normally prorated from now —
   * on the quantity-0 item if the cleanup has not run yet, on a new item if it
   * has.
   *
   * Where AlreadyPaidUntil is the end of the billing period itself there is no
   * stretch left to prorate, so the item goes back with proration_behavior=none
   * and Stripe bills it at renewal — the same money as a zero-length proration.
   */
  private repurchasePlan(
    now: number,
    coverage: Interval[],
    ctx: XSubscriptionContext,
    account: AccountDocument,
    parkedItem: Stripe.SubscriptionItem | null,
  ) {
    // older cancellations recorded no AlreadyPaidUntil: paid coverage encodes it
    const alreadyPaidUntil = account.xAddon?.alreadyPaidUntil ?? coverageEnd(coverage) ?? now;
    const beforeBoundary = now < alreadyPaidUntil;
    const prorationDate = beforeBoundary ? alreadyPaidUntil : now;
    const periodEnd = ctx.periodEnd ?? prorationDate;
    const chargeNow = prorationDate < periodEnd;
    return {
      kind: beforeBoundary ? ('restores_frozen_remaining' as const) : ('new_activation' as const),
      alreadyPaidUntil,
      /** rows 59, 8: the same Stripe item goes 0 → 1 while it still exists */
      reusesItemId: parkedItem?.id ?? null,
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
    if (snap.status === 'FROZEN' || snap.status === 'CANCELED') return this.previewRepurchase(account, ctx, snap);
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
        `Quota is SCIO's, and its month follows the base plan's billing cycle: ${this.day(snap.quotaMonth.start)} → ${this.day(snap.quotaMonth.end)}, the billing month X is bought in. ${quota.formula}.`,
        'That quota cycle stays put from here on: if the base plan later changes interval, Stripe restarts the billing cycle but the quota month keeps this anchor, and the two run apart.',
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
    const plan = this.cancelPlan(snap.quotaMonth, ctx, snap.itemId, snap.paidThrough);
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

  private async previewRepurchase(account: AccountDocument, ctx: XSubscriptionContext, snap: Awaited<ReturnType<XAddonService['snapshot']>>) {
    const plan = snap.repurchase!;
    const params = await this.repurchaseParams(plan, ctx.term);
    const invoice = params.proration_behavior === 'always_invoice' ? await this.previewInvoice(account, ctx.sub!, params) : null;
    const added = plan.chargesFrom && plan.chargesTo ? { start: plan.chargesFrom, end: plan.chargesTo } : null;
    const quota = await this.quotaProjection(account, snap, added);
    return {
      mode: 'x_repurchase',
      explanation: [
        plan.kind === 'restores_frozen_remaining'
          ? `Buying X again before AlreadyPaidUntil ${this.day(plan.alreadyPaidUntil)} = min(oldPaidThrough, quotaMonthEnd): FrozenRemaining is restored — Granted ${snap.ledger?.granted ?? 0} / Used ${snap.ledger?.used ?? 0} — and still expires on ${this.day(snap.quotaMonth.end)}. Nothing is reset or granted again (row 59).`
          : `AlreadyPaidUntil ${this.day(plan.alreadyPaidUntil)} has passed, so buying X again is a new activation, normally prorated from now and granted by the new paid coverage (row 59).`,
        plan.reusesItemId
          ? `The same Stripe item ${plan.reusesItemId} goes from quantity 0 back to 1 (row 8).`
          : 'The quantity-0 item has already been cleaned up, so a new X item is added.',
        plan.prorationBehavior === 'none'
          ? `Already paid until ${this.day(plan.prorationDate)}, the end of this billing period — the item goes back with proration_behavior=none and nothing is charged twice. Stripe bills it again at renewal.`
          : `Stripe charges from ${this.day(plan.prorationDate)} (proration_date) to ${this.day(plan.chargesTo)}${
              plan.kind === 'restores_frozen_remaining' ? ' — never the stretch up to AlreadyPaidUntil, and exactly the future coverage Cancel credited, if it did' : ''
            }.`,
        'FrozenRemaining and the fan-out open only after payment succeeds; a declined card leaves the add-on frozen.',
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
    const { target, delta } = projectedDelta(snap.coverage, lines, snap.quotaMonth, added, already, snap.quotaAnchor);
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
    if (snap.status === 'FROZEN' || snap.status === 'CANCELED') return this.repurchase(account, ctx, snap);

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
    // the quota cycle starts on the base plan's billing cycle and keeps this anchor from now on
    account.xAddon = { ...(account.xAddon ?? {}), quotaAnchor: account.xAddon?.quotaAnchor ?? XAddonService.baseAnchorOf(updated, snap.now) };
    account.markModified('xAddon');
    await this.accounts.save(account);

    await this.events.record({
      accountId: account.id,
      action: 'x.purchased',
      summary: `X add-on bought on the ${ctx.term} term — invoice ${invoice?.number ?? invoice?.id ?? '—'} ${invoice?.status ?? ''} ${((invoice?.amount_paid ?? 0) / 100).toFixed(2)}`,
      stripeRequest: params as any,
      result: { invoice: invoice ? this.stripe.summarizeInvoice(invoice) : null },
    });
    return updated;
  }

  /**
   * Row 49 / row 7, identical for Monthly and Yearly: the same X item goes from
   * quantity 1 to 0 — it is not deleted. Credit only the paid coverage SCIO has
   * not yet turned into quota — `quotaMonthEnd → xPaidThrough` — and only where
   * that stretch exists. The quota month in progress funded GrantedTarget and
   * is never credited. The item is kept at 0 until
   * `AlreadyPaidUntil = min(oldPaidThrough, quotaMonthEnd)`, then cleaned up.
   */
  private cancelPlan(q: Interval, ctx: XSubscriptionContext, itemId: string, paidThrough: number | null) {
    const xPaidThrough = Math.min(paidThrough ?? ctx.periodEnd ?? q.end, ctx.periodEnd ?? Number.MAX_SAFE_INTEGER);
    const credit = q.end < xPaidThrough;
    const alreadyPaidUntil = Math.min(xPaidThrough, q.end);
    const params: Stripe.SubscriptionUpdateParams = credit
      ? { items: [{ id: itemId, quantity: 0 }], proration_behavior: 'always_invoice', proration_date: q.end }
      : { items: [{ id: itemId, quantity: 0 }], proration_behavior: 'none' };
    return {
      q,
      xPaidThrough,
      alreadyPaidUntil,
      params,
      explanation: [
        'Cancel takes effect now (row 49): the tenant is FROZEN and its fan-out switched off, and the same X item goes from quantity 1 to 0 — it is not deleted yet. The base plan is untouched.',
        credit
          ? `quotaMonthEnd ${this.day(q.end)} is before xPaidThrough ${this.day(xPaidThrough)}: proration_date = quotaMonthEnd, so Stripe credits ${this.day(q.end)} → ${this.day(xPaidThrough)} to the customer balance. The quota month in progress funded GrantedTarget and is not credited.`
          : `quotaMonthEnd ${this.day(q.end)} is not before xPaidThrough ${this.day(xPaidThrough)}: there is no future paid coverage SCIO has not granted, so quantity goes 1 → 0 with proration_behavior=none and no credit.`,
        `AlreadyPaidUntil = min(oldPaidThrough, quotaMonthEnd) = ${this.day(alreadyPaidUntil)}. Until then the quantity-0 item stays, so buying X again puts it back to 1 without charging twice; at ${this.day(alreadyPaidUntil)} it is deleted with proration_behavior=none, retried for up to 24 hours.`,
        `FrozenRemaining is kept until ${this.day(q.end)}. There is no separate restore: buying X again restores it, and after ${this.day(q.end)} it has expired.`,
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
    if (!item || XAddonService.quantityOf(item) === 0) throw new BadRequestException('There is no active X add-on on this subscription to cancel.');
    const snap = await this.snapshot(account, ctx);
    const now = snap.now;
    const plan = this.cancelPlan(snap.quotaMonth, ctx, item.id, snap.paidThrough);
    const balanceBefore = await this.balance(account);

    const updated = await this.stripe.call('subscriptions.update (cancel X: quantity 1 → 0)', () =>
      this.stripe.client.subscriptions.update(ctx.sub!.id, { ...plan.params, expand: ['latest_invoice'] }),
    );
    const credit = Math.max(0, balanceBefore - (await this.balance(account)));

    account.xAddon = {
      ...(account.xAddon ?? {}),
      cancelledAt: now,
      frozenUntil: plan.q.end,
      cancelTerm: ctx.term,
      itemId: item.id,
      oldPaidThrough: plan.xPaidThrough,
      alreadyPaidUntil: plan.alreadyPaidUntil,
      cleanupAt: plan.alreadyPaidUntil,
      cleanupDeadline: plan.alreadyPaidUntil + 86400,
      cleanedUpAt: undefined,
      cleanupError: undefined,
      cleanupAlert: undefined,
      cleanupAttempts: 0,
    };
    account.markModified('xAddon');
    await this.accounts.save(account);
    await this.release(account.id);

    await this.events.record({
      accountId: account.id,
      action: 'x.cancelled',
      summary: `X add-on cancelled — FROZEN until ${this.day(plan.q.end)}, fan-out off, item ${item.id} at quantity 0 until ${this.day(plan.alreadyPaidUntil)}. ${
        credit > 0 ? `Credit ${(credit / 100).toFixed(2)} for ${this.day(plan.q.end)} onwards to the customer balance.` : 'No credit — no future paid coverage.'
      }`,
      stripeRequest: plan.params as any,
      result: { creditCents: credit, frozenUntil: plan.q.end, alreadyPaidUntil: plan.alreadyPaidUntil },
    });
    return updated;
  }

  private async repurchaseParams(
    plan: NonNullable<ReturnType<XAddonService['repurchasePlan']>>,
    term: BillingTerm,
  ): Promise<Stripe.SubscriptionUpdateParams> {
    const priceId = await this.catalog.priceIdFor(X_ADDON_CODE, term);
    const item = plan.reusesItemId ? { id: plan.reusesItemId, price: priceId, quantity: 1 } : { price: priceId, quantity: 1 };
    return plan.prorationBehavior === 'none'
      ? { items: [item], proration_behavior: 'none' }
      : {
          items: [item],
          proration_behavior: 'always_invoice',
          proration_date: plan.prorationDate,
          payment_behavior: 'error_if_incomplete',
        };
  }

  /** Buying X again after a Cancel — reached through purchase(), never on its own (row 59). */
  private async repurchase(
    account: AccountDocument,
    ctx: XSubscriptionContext,
    snap: Awaited<ReturnType<XAddonService['snapshot']>>,
  ): Promise<Stripe.Subscription> {
    if (!snap.repurchase) throw new BadRequestException(`X cannot be bought again from ${snap.status}.`);
    // row 8: never race the boundary cleanup for the same item. A cleanup holds
    // the lock for one Stripe call, so wait for it rather than refuse the sale.
    let token: string | null = null;
    for (let waited = 0; !token && waited < 15000; waited += 250) {
      token = await this.lock(account.id, 'repurchase');
      if (!token) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!token) {
      throw new ConflictException('The quantity-0 X item is being cleaned up right now. Nothing was charged — try again in a moment.');
    }
    try {
      return await this.repurchaseLocked(account, ctx, snap);
    } finally {
      await this.unlock(account.id, token);
    }
  }

  private async repurchaseLocked(
    account: AccountDocument,
    ctx: XSubscriptionContext,
    snap: Awaited<ReturnType<XAddonService['snapshot']>>,
  ): Promise<Stripe.Subscription> {
    // re-read under the lock: the cleanup may have deleted the item since the snapshot
    const fresh = await this.stripe.client.subscriptions.retrieve(ctx.sub!.id);
    const parked = this.xItemOf(fresh, await this.prices());
    const still = parked && XAddonService.quantityOf(parked) === 0 ? parked : null;
    const lines = await this.paidLines(account);
    const plan = this.repurchasePlan(snap.now, coverageFromLines(lines), ctx, account, still);
    const params = { ...(await this.repurchaseParams(plan, ctx.term)), expand: ['latest_invoice'] };

    await this.reserve(account.id);
    let updated: Stripe.Subscription;
    try {
      updated = await this.stripe.call(`subscriptions.update (buy X again${plan.reusesItemId ? ': quantity 0 → 1' : ''})`, () =>
        this.stripe.client.subscriptions.update(ctx.sub!.id, params),
      );
    } catch (err) {
      await this.release(account.id);
      await this.events.record({
        accountId: account.id,
        action: 'x.repurchase_failed',
        summary: `Buying X again refused — ${(err as any)?.response?.message ?? (err as Error).message}. Still ${snap.status}; nothing restored.`,
        stripeRequest: params as any,
      });
      throw err;
    }

    const invoice = typeof updated.latest_invoice === 'string' ? null : updated.latest_invoice;
    const paid = params.proration_behavior === 'none' || invoice?.status === 'paid';
    if (paid) await this.commit(account.id);
    const item = this.xItemOf(updated, await this.prices());
    const cleared = this.clearCancel(account.xAddon, snap.now, item?.id);
    // xQuotaAnchorAt stays where the first charge put it, whether FROZEN or past its frozen month (row 59)
    account.xAddon = cleared;
    account.markModified('xAddon');
    await this.accounts.save(account);

    await this.events.record({
      accountId: account.id,
      action: 'x.repurchased',
      summary: `X bought again (${plan.kind === 'restores_frozen_remaining' ? 'before AlreadyPaidUntil — FrozenRemaining restored' : 'new activation'}, ${plan.reusesItemId ? `same item ${plan.reusesItemId} 0 → 1` : 'new item'}) — ${
        params.proration_behavior === 'none'
          ? 'already paid, nothing charged'
          : `charged from ${this.day(plan.prorationDate)}: ${invoice?.number ?? invoice?.id} ${((invoice?.total ?? 0) / 100).toFixed(2)}`
      }`,
      stripeRequest: params as any,
      result: { invoice: invoice ? this.stripe.summarizeInvoice(invoice) : null, plan },
    });
    return updated;
  }

  /** Everything a Cancel recorded goes once X is bought again. */
  private clearCancel(x: AccountDocument['xAddon'] | undefined, now: number, itemId?: string) {
    return {
      ...(x ?? {}),
      cancelledAt: undefined,
      frozenUntil: undefined,
      cancelTerm: undefined,
      oldPaidThrough: undefined,
      alreadyPaidUntil: undefined,
      cleanupAt: undefined,
      cleanupDeadline: undefined,
      cleanupError: undefined,
      cleanupAlert: undefined,
      cleanupAttempts: undefined,
      itemId: itemId ?? x?.itemId,
      lastRepurchasedAt: now,
    };
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
