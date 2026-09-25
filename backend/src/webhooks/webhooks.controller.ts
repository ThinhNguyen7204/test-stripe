import { BadRequestException, Body, Controller, Get, Headers, Logger, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import Stripe from 'stripe';
import { StripeService } from '../stripe/stripe.service';
import { EventsService } from '../events/events.service';
import { AccountsService } from '../accounts/accounts.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { PolicyService } from '../policy/policy.service';

@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly stripe: StripeService,
    private readonly events: EventsService,
    private readonly accounts: AccountsService,
    private readonly subscriptions: SubscriptionsService,
    private readonly policy: PolicyService,
  ) {}

  @Get('stripe')
  info() {
    return {
      endpoint: '/api/webhooks/stripe',
      signatureVerification: this.stripe.webhookSecret ? 'enabled' : 'disabled (set STRIPE_WEBHOOK_SECRET)',
      hint: 'stripe listen --forward-to localhost:3123/api/webhooks/stripe',
    };
  }

  @Post('stripe')
  async handle(@Req() req: Request, @Headers('stripe-signature') signature?: string) {
    const raw = req.body as unknown as Buffer;
    let event: Stripe.Event;

    if (this.stripe.webhookSecret) {
      if (!signature) throw new BadRequestException('Missing stripe-signature header');
      try {
        event = this.stripe.client.webhooks.constructEvent(raw, signature, this.stripe.webhookSecret);
      } catch (err: any) {
        throw new BadRequestException(`Webhook signature verification failed: ${err.message}`);
      }
    } else {
      // Demo convenience: accept unsigned payloads when no secret is configured.
      event = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : JSON.stringify(raw));
    }

    await this.process(event);
    return { received: true, type: event.type };
  }

  private async process(event: Stripe.Event) {
    const object: any = event.data?.object ?? {};
    const customerId =
      typeof object.customer === 'string' ? object.customer : object.customer?.id ?? undefined;
    const account = customerId ? await this.accounts.findByCustomerId(customerId) : null;

    let summary: string = event.type;

    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
      case 'customer.subscription.paused':
      case 'customer.subscription.resumed':
      case 'customer.subscription.trial_will_end': {
        const sub = object as Stripe.Subscription;
        await this.subscriptions.syncFromStripeSubscription(sub);
        summary = `${event.type} → status ${sub.status}`;
        break;
      }

      case 'invoice.paid':
      case 'invoice.payment_succeeded': {
        const invoice = object as Stripe.Invoice;
        summary = `Invoice ${invoice.number ?? invoice.id} paid — ${invoice.amount_paid / 100} ${invoice.currency.toUpperCase()}`;
        /*
         * MODEL V6 row 51: paid coverage — and so the X quota delta — is only
         * recorded once an invoice is paid. Reconciling replays every paid
         * invoice, so a retried delivery grants nothing twice.
         */
        if (account) {
          try {
            await this.subscriptions.getState(account.id);
          } catch (err: any) {
            this.logger.warn(`X reconcile after ${invoice.id} failed: ${err.message}`);
          }
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = object as Stripe.Invoice;
        summary = `Payment failed on ${invoice.number ?? invoice.id}`;
        const policy = await this.policy.get();
        const subId = (invoice as any).subscription ?? (invoice.parent as any)?.subscription_details?.subscription;
        if (account && subId && policy.dunning.pastDueBehavior !== 'leave_past_due') {
          try {
            if (policy.dunning.pastDueBehavior === 'cancel') {
              await this.stripe.client.subscriptions.cancel(subId, { prorate: false });
              summary += ' → subscription cancelled by dunning policy';
            } else {
              await this.stripe.client.subscriptions.update(subId, {
                pause_collection: { behavior: policy.dunning.pauseBehavior },
              });
              summary += ' → subscription paused by dunning policy';
            }
          } catch (err: any) {
            this.logger.warn(`Dunning action failed: ${err.message}`);
          }
        }
        break;
      }

      case 'invoice.created':
      case 'invoice.finalized': {
        const invoice = object as Stripe.Invoice;
        const prorations = (invoice.lines?.data ?? []).filter((l) => StripeService.isProration(l));
        summary = `${event.type}: ${invoice.number ?? invoice.id} total ${invoice.total / 100} (${prorations.length} proration line${prorations.length === 1 ? '' : 's'})`;
        break;
      }

      case 'subscription_schedule.created':
      case 'subscription_schedule.updated':
      case 'subscription_schedule.released':
      case 'subscription_schedule.completed': {
        const schedule = object as Stripe.SubscriptionSchedule;
        summary = `${event.type} — ${schedule.phases?.length ?? 0} phase(s)`;
        if (event.type === 'subscription_schedule.released' || event.type === 'subscription_schedule.completed') {
          const subId = typeof schedule.subscription === 'string' ? schedule.subscription : schedule.subscription?.id;
          if (subId) {
            const sub = await this.stripe.client.subscriptions.retrieve(subId);
            await this.subscriptions.syncFromStripeSubscription(sub);
          }
        }
        break;
      }

      case 'credit_note.created': {
        const note = object as Stripe.CreditNote;
        summary = `Credit note ${note.number} — ${note.total / 100} ${note.currency.toUpperCase()}`;
        break;
      }

      case 'charge.refunded': {
        const charge = object as Stripe.Charge;
        summary = `Refunded ${charge.amount_refunded / 100} ${charge.currency.toUpperCase()}`;
        break;
      }
    }

    await this.events.record({
      accountId: account?.id,
      action: event.type,
      source: 'webhook',
      summary,
      stripeEventId: event.id,
      result: { objectId: object.id, status: object.status },
    });
  }
}
