import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { AccountsService } from '../accounts/accounts.service';
import { EventsService } from '../events/events.service';
import { StripeService } from '../stripe/stripe.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';

export type AdvancePreset = 'one_day' | 'one_week' | 'one_month' | 'end_of_trial' | 'next_renewal';

@Injectable()
export class SimulatorService {
  private readonly logger = new Logger(SimulatorService.name);

  constructor(
    private readonly accounts: AccountsService,
    private readonly stripe: StripeService,
    private readonly events: EventsService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  async clock(accountId: string) {
    const account = await this.accounts.get(accountId);
    if (!account.testClockId) return { enabled: false, now: Math.floor(Date.now() / 1000) };
    const clock = await this.stripe.call('testClocks.retrieve', () =>
      this.stripe.client.testHelpers.testClocks.retrieve(account.testClockId!),
    );
    return {
      enabled: true,
      id: clock.id,
      status: clock.status,
      frozenTime: clock.frozen_time,
      name: clock.name,
    };
  }

  /**
   * Fast-forwards the customer's test clock. Stripe runs the whole billing
   * engine against the new time: renewal invoices are generated, trials end,
   * scheduled phases activate and dunning starts — exactly what would happen
   * in production, only minutes later instead of a month.
   */
  async advance(accountId: string, input: { preset?: AdvancePreset; seconds?: number; to?: number }) {
    const account = await this.accounts.get(accountId);
    if (!account.testClockId) {
      throw new BadRequestException(
        'This account has no test clock. Create an account with withTestClock=true to use the time machine.',
      );
    }

    const clock = await this.stripe.client.testHelpers.testClocks.retrieve(account.testClockId);
    const now = clock.frozen_time;
    let target = input.to ?? (input.seconds ? now + input.seconds : undefined);

    if (!target && input.preset) {
      const sub = account.stripeSubscriptionId
        ? await this.stripe.client.subscriptions.retrieve(account.stripeSubscriptionId)
        : null;
      switch (input.preset) {
        case 'one_day':
          target = now + 86400;
          break;
        case 'one_week':
          target = now + 7 * 86400;
          break;
        case 'one_month':
          target = now + 31 * 86400;
          break;
        case 'end_of_trial':
          if (!sub?.trial_end) throw new BadRequestException('This subscription has no trial');
          target = sub.trial_end + 3600;
          break;
        case 'next_renewal': {
          const periodEnd = sub ? StripeService.periodEnd(sub) : null;
          if (!periodEnd) throw new BadRequestException('No active subscription period to roll forward');
          target = periodEnd + 3600;
          break;
        }
      }
    }

    if (!target) throw new BadRequestException('Provide preset, seconds or to');
    if (target <= now) throw new BadRequestException('Test clocks can only move forward');

    const { clock: settled, steps } = await this.advanceInSteps(account.testClockId, target);

    // Stripe has now done its billing work: pull the result back into Mongo.
    // (The X add-on's quota is reconciled by getState() below, from the paid
    // invoices this hop produced.)
    if (account.stripeSubscriptionId) {
      try {
        const sub = await this.stripe.client.subscriptions.retrieve(account.stripeSubscriptionId);
        await this.subscriptions.syncAccountFromSubscription(account, sub);
      } catch (err: any) {
        this.logger.warn(`Post-advance sync failed: ${err.message}`);
      }
    }

    const invoices = await this.stripe.client.invoices.list({
      customer: account.stripeCustomerId!,
      limit: 5,
    });

    await this.events.record({
      accountId: account.id,
      action: 'simulator.clock_advanced',
      summary: `Clock moved to ${new Date(target * 1000).toISOString()} (${input.preset ?? 'custom'}${steps > 1 ? `, ${steps} hops` : ''})`,
      stripeRequest: { testClock: account.testClockId, frozen_time: target, steps },
      result: {
        status: settled.status,
        steps,
        invoices: invoices.data.slice(0, 3).map((i) => ({
          id: i.id,
          number: i.number,
          total: i.total,
          status: i.status,
          billingReason: i.billing_reason,
        })),
      },
    });

    return {
      clock: { id: settled.id, status: settled.status, frozenTime: settled.frozen_time, steps },
      invoices: invoices.data.map((i) => this.stripe.summarizeInvoice(i)),
      state: await this.subscriptions.getState(accountId),
    };
  }

  /**
   * Stripe only lets a test clock jump two of the shortest subscription
   * intervals at a time — a yearly subscription that has a monthly phase queued
   * on a schedule can therefore only move two months per call. So we walk to
   * the target in hops, using the ceiling Stripe itself reports.
   */
  private async advanceInSteps(
    clockId: string,
    target: number,
    maxHops = 30,
  ): Promise<{ clock: Stripe.TestHelpers.TestClock; steps: number }> {
    let clock: Stripe.TestHelpers.TestClock = await this.stripe.client.testHelpers.testClocks.retrieve(clockId);
    let steps = 0;

    while (clock.frozen_time < target && steps < maxHops) {
      let next = target;
      try {
        clock = await this.stripe.client.testHelpers.testClocks.advance(clockId, { frozen_time: next });
      } catch (err: any) {
        const message: string = err?.raw?.message ?? err?.message ?? '';
        const ceiling = this.parseAdvanceCeiling(message, clock.frozen_time);
        if (!ceiling) throw err;
        next = Math.min(ceiling, target);
        this.logger.log(`Clock ${clockId}: hopping to ${new Date(next * 1000).toISOString()} (Stripe capped the jump)`);
        clock = await this.stripe.client.testHelpers.testClocks.advance(clockId, { frozen_time: next });
      }
      clock = await this.waitUntilReady(clockId);
      steps += 1;
    }

    if (clock.frozen_time < target) {
      this.logger.warn(`Clock ${clockId} stopped at ${clock.frozen_time}, short of ${target} after ${steps} hops`);
    }
    return { clock, steps };
  }

  /** Pulls "You can only advance it up to <epoch>" out of Stripe's error. */
  private parseAdvanceCeiling(message: string, current: number): number | null {
    const match = message.match(/advance it up to (\d{9,})/);
    if (match) {
      const ceiling = Number(match[1]);
      if (ceiling > current) return ceiling;
    }
    // Fall back to a conservative hop that is always inside the limit.
    if (/only advance/i.test(message)) return current + 25 * 86400;
    return null;
  }

  private async waitUntilReady(clockId: string, timeoutMs = 90_000): Promise<Stripe.TestHelpers.TestClock> {
    const started = Date.now();
    let clock = await this.stripe.client.testHelpers.testClocks.retrieve(clockId);
    while (clock.status === 'advancing' && Date.now() - started < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      clock = await this.stripe.client.testHelpers.testClocks.retrieve(clockId);
    }
    if (clock.status === 'internal_failure') {
      throw new BadRequestException('Stripe test clock hit an internal failure while advancing');
    }
    return clock;
  }
}
