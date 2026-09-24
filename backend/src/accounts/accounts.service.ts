import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { StripeService } from '../stripe/stripe.service';
import { EventsService } from '../events/events.service';
import { Account, AccountDocument } from './account.schema';

/** Stripe's shared test payment methods — no card data ever touches this app. */
export const TEST_PAYMENT_METHODS: Record<string, { id: string; label: string }> = {
  visa: { id: 'pm_card_visa', label: 'Visa •••• 4242 — every charge succeeds' },
  mastercard: { id: 'pm_card_mastercard', label: 'Mastercard •••• 4444 — every charge succeeds' },
  /*
   * Stripe validates a card when it is attached, so the classic "declined"
   * cards can never be saved to a customer at all. For dunning you need the one
   * card that attaches cleanly and then fails whenever it is charged.
   */
  charge_fails: {
    id: 'pm_card_chargeCustomerFail',
    label: 'Visa — saves fine, then every charge fails (dunning demo)',
  },
  needs_3ds: {
    id: 'pm_card_authenticationRequired',
    label: 'Visa •••• 3155 — saves fine, charges need 3D Secure',
  },
  declined_on_save: {
    id: 'pm_card_chargeDeclined',
    label: 'Visa •••• 0002 — refused the moment it is saved',
  },
  no_funds_on_save: {
    id: 'pm_card_chargeDeclinedInsufficientFunds',
    label: 'Visa •••• 9995 — refused on save, insufficient funds',
  },
};

@Injectable()
export class AccountsService {
  private readonly logger = new Logger(AccountsService.name);

  constructor(
    @InjectModel(Account.name) private readonly model: Model<AccountDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly stripe: StripeService,
    private readonly events: EventsService,
  ) {}

  async list(): Promise<AccountDocument[]> {
    return this.model.find().sort({ createdAt: -1 }).exec();
  }

  async get(id: string): Promise<AccountDocument> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException(`Account ${id} not found`);
    const account = await this.model.findById(id).exec();
    if (!account) throw new NotFoundException(`Account ${id} not found`);
    return account;
  }

  async findByCustomerId(customerId: string): Promise<AccountDocument | null> {
    return this.model.findOne({ stripeCustomerId: customerId }).exec();
  }

  async findBySubscriptionId(subscriptionId: string): Promise<AccountDocument | null> {
    return this.model.findOne({ stripeSubscriptionId: subscriptionId }).exec();
  }

  /**
   * Creates the local account plus its Stripe customer. `withTestClock` binds
   * the customer to a Stripe test clock, which is what makes the "advance time"
   * simulator work — it can only be set at customer creation time.
   */
  async create(input: {
    email: string;
    name: string;
    company?: string;
    withTestClock?: boolean;
    clockStart?: number;
  }): Promise<AccountDocument> {
    const existing = await this.model.findOne({ email: input.email }).exec();
    if (existing) throw new BadRequestException(`Account with email ${input.email} already exists`);

    let testClockId: string | undefined;
    if (input.withTestClock) {
      const clock = await this.stripe.call('testClocks.create', () =>
        this.stripe.client.testHelpers.testClocks.create({
          frozen_time: input.clockStart ?? Math.floor(Date.now() / 1000),
          name: `Demo clock — ${input.email}`,
        }),
      );
      testClockId = clock.id;
    }

    const customer = await this.stripe.call('customers.create', () =>
      this.stripe.client.customers.create({
        email: input.email,
        name: input.name,
        description: input.company ? `OptiSigns demo — ${input.company}` : 'OptiSigns billing demo',
        test_clock: testClockId,
        metadata: { demo: 'optisigns-billing', company: input.company ?? '' },
      }),
    );

    const account = await this.model.create({
      email: input.email,
      name: input.name,
      company: input.company,
      stripeCustomerId: customer.id,
      testClockId,
      planCode: 'free',
      screens: 0,
      subscriptionStatus: 'none',
    });

    await this.events.record({
      accountId: account.id,
      action: 'account.created',
      summary: `Stripe customer ${customer.id}${testClockId ? ` on test clock ${testClockId}` : ''}`,
      stripeRequest: { email: input.email, test_clock: testClockId },
      result: { customerId: customer.id, testClockId },
    });

    return account;
  }

  async remove(id: string): Promise<void> {
    const account = await this.get(id);
    if (account.stripeCustomerId) {
      try {
        await this.stripe.client.customers.del(account.stripeCustomerId);
      } catch (err: any) {
        this.logger.warn(`Could not delete Stripe customer: ${err.message}`);
      }
    }
    /*
     * Deleting the customer leaves its test clock behind, and clocks pile up
     * fast when every demo account gets one. Deleting the clock also removes
     * anything still attached to it.
     */
    if (account.testClockId) {
      try {
        await this.stripe.client.testHelpers.testClocks.del(account.testClockId);
      } catch (err: any) {
        this.logger.warn(`Could not delete test clock ${account.testClockId}: ${err.message}`);
      }
    }
    /*
     * A deleted tenant holds no X capacity any more: leaving its reservation
     * behind would count against the commercial ceiling forever (MODEL V6
     * row 17). Its quota ledgers go with it.
     */
    await this.connection.collection('x_capacity_reservations').deleteMany({ accountId: account.id });
    await this.connection.collection('x_quota_ledgers').deleteMany({ accountId: account.id });
    await this.model.deleteOne({ _id: account._id }).exec();
  }

  /**
   * Attaches one of Stripe's shared test payment methods and makes it the
   * customer's invoice default. Real card data is never handled here.
   */
  async attachTestPaymentMethod(id: string, kind: keyof typeof TEST_PAYMENT_METHODS): Promise<AccountDocument> {
    const account = await this.get(id);
    const pm = TEST_PAYMENT_METHODS[kind];
    if (!pm) throw new BadRequestException(`Unknown test card "${kind}"`);

    const attached = await this.stripe.call('paymentMethods.attach', () =>
      this.stripe.client.paymentMethods.attach(pm.id, { customer: account.stripeCustomerId! }),
    );
    await this.stripe.call('customers.update', () =>
      this.stripe.client.customers.update(account.stripeCustomerId!, {
        invoice_settings: { default_payment_method: attached.id },
      }),
    );
    /*
     * A running subscription keeps whatever payment method it was created with,
     * so without this it would quietly keep charging the old card while the UI
     * claims the new one is in use.
     */
    if (account.stripeSubscriptionId) {
      try {
        await this.stripe.client.subscriptions.update(account.stripeSubscriptionId, {
          default_payment_method: attached.id,
        });
      } catch (err: any) {
        this.logger.warn(`Could not move subscription onto ${attached.id}: ${err.message}`);
      }
    }

    account.defaultPaymentMethodId = attached.id;
    account.paymentMethodLabel = pm.label;
    await account.save();

    await this.events.record({
      accountId: account.id,
      action: 'payment_method.attached',
      summary: pm.label,
      stripeRequest: { paymentMethod: pm.id, customer: account.stripeCustomerId },
      result: { paymentMethodId: attached.id },
    });

    return account;
  }

  /** Realistic alternative: collect a card through Stripe Checkout in setup mode. */
  async createSetupCheckoutSession(id: string, returnUrl: string) {
    const account = await this.get(id);
    const session = await this.stripe.call('checkout.sessions.create', () =>
      this.stripe.client.checkout.sessions.create({
        mode: 'setup',
        customer: account.stripeCustomerId,
        currency: this.stripe.currency,
        success_url: `${returnUrl}?setup=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${returnUrl}?setup=cancelled`,
      }),
    );
    return { url: session.url, id: session.id };
  }

  async paymentMethods(id: string) {
    const account = await this.get(id);
    const list = await this.stripe.call('paymentMethods.list', () =>
      this.stripe.client.paymentMethods.list({ customer: account.stripeCustomerId!, type: 'card' }),
    );
    return list.data.map((pm) => ({
      id: pm.id,
      brand: pm.card?.brand,
      last4: pm.card?.last4,
      expMonth: pm.card?.exp_month,
      expYear: pm.card?.exp_year,
      isDefault: pm.id === account.defaultPaymentMethodId,
    }));
  }

  async setDefaultPaymentMethod(id: string, paymentMethodId: string): Promise<AccountDocument> {
    const account = await this.get(id);
    await this.stripe.call('customers.update', () =>
      this.stripe.client.customers.update(account.stripeCustomerId!, {
        invoice_settings: { default_payment_method: paymentMethodId },
      }),
    );
    if (account.stripeSubscriptionId) {
      await this.stripe.call('subscriptions.update', () =>
        this.stripe.client.subscriptions.update(account.stripeSubscriptionId!, {
          default_payment_method: paymentMethodId,
        }),
      );
    }
    account.defaultPaymentMethodId = paymentMethodId;
    await account.save();
    return account;
  }

  /** Stripe customer balance: negative = credit the customer can spend. */
  async balance(id: string) {
    const account = await this.get(id);
    const customer = await this.stripe.call('customers.retrieve', () =>
      this.stripe.client.customers.retrieve(account.stripeCustomerId!),
    );
    const transactions = await this.stripe.call('customers.listBalanceTransactions', () =>
      this.stripe.client.customers.listBalanceTransactions(account.stripeCustomerId!, { limit: 20 }),
    );
    return {
      balance: (customer as any).balance ?? 0,
      currency: this.stripe.currency,
      transactions: transactions.data.map((t) => ({
        id: t.id,
        amount: t.amount,
        type: t.type,
        description: t.description,
        created: t.created,
        endingBalance: t.ending_balance,
        invoice: t.invoice,
      })),
    };
  }

  /** Manual credit/debit, e.g. a goodwill credit from support. */
  async adjustBalance(id: string, amountCents: number, description: string) {
    const account = await this.get(id);
    const tx = await this.stripe.call('customers.createBalanceTransaction', () =>
      this.stripe.client.customers.createBalanceTransaction(account.stripeCustomerId!, {
        amount: amountCents,
        currency: this.stripe.currency,
        description,
      }),
    );
    await this.events.record({
      accountId: account.id,
      action: 'customer.balance_adjusted',
      summary: `${amountCents < 0 ? 'Credited' : 'Debited'} ${Math.abs(amountCents) / 100} ${this.stripe.currency.toUpperCase()} — ${description}`,
      stripeRequest: { amount: amountCents, description },
      result: { id: tx.id, endingBalance: tx.ending_balance },
    });
    return tx;
  }

  save(account: AccountDocument) {
    return account.save();
  }
}
