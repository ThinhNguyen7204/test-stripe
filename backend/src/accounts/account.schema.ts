import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { BillingTerm } from '../catalog/catalog.constants';

export type AccountDocument = HydratedDocument<Account>;

export interface XAddonAccountState {
  /**
   * Where the quota cycle is stepped from: the base plan's billing_cycle_anchor
   * when X was activated, so its quota months start as the base plan's billing
   * months. Kept through a base-plan interval change — Stripe's cycle restarts,
   * this one does not, and the two run apart from then on. Reset only by a new
   * activation, when the old quota has expired anyway.
   */
  quotaAnchor?: number;
  /** when the add-on was cancelled, in the customer's clock */
  cancelledAt?: number;
  /** end of the quota month it was cancelled in — buying X again before this restores FrozenRemaining */
  frozenUntil?: number;
  cancelTerm?: BillingTerm;
  /**
   * MODEL V6 rows 49, 59: Cancel keeps the same Stripe item at quantity 0 until
   * `min(oldPaidThrough, quotaMonthEnd)`, so buying X again before then can put
   * it back to 1 without charging twice. Past it the item is cleaned up.
   */
  itemId?: string;
  oldPaidThrough?: number;
  alreadyPaidUntil?: number;
  cleanupAt?: number;
  /** cleanupAt + 24 hours: past this a cleanup that keeps failing is an alert */
  cleanupDeadline?: number;
  cleanedUpAt?: number;
  cleanupError?: string;
  cleanupAlert?: string;
  cleanupAttempts?: number;
  lastRepurchasedAt?: number;
  /** last status reported, so a change of status is logged once */
  lastStatus?: string;
  quantityAlert?: string;
  quantityAlertAt?: number;
}

@Schema({ _id: false })
export class AddOnSelection {
  @Prop({ required: true }) code!: string;
  @Prop({ required: true, default: 0 }) quantity!: number;
  /** Stripe subscription item id, so we can update/delete the exact line */
  @Prop() stripeItemId?: string;
}
export const AddOnSelectionSchema = SchemaFactory.createForClass(AddOnSelection);

@Schema({ timestamps: true, collection: 'accounts' })
export class Account {
  @Prop({ required: true, unique: true, index: true })
  email!: string;

  @Prop({ required: true })
  name!: string;

  @Prop()
  company?: string;

  @Prop({ index: true })
  stripeCustomerId?: string;

  /** Stripe test clock, so the demo can fast-forward to the next renewal */
  @Prop()
  testClockId?: string;

  @Prop()
  defaultPaymentMethodId?: string;

  @Prop()
  paymentMethodLabel?: string;

  // ---- current subscription state (mirrored from Stripe) ----
  @Prop({ default: 'free' })
  planCode!: string;

  @Prop({ default: 'monthly' })
  term!: BillingTerm;

  @Prop({ default: 0 })
  screens!: number;

  @Prop({ type: [AddOnSelectionSchema], default: [] })
  addOns!: AddOnSelection[];

  @Prop()
  stripeSubscriptionId?: string;

  @Prop()
  stripeBaseItemId?: string;

  @Prop()
  stripeScheduleId?: string;

  @Prop({ default: 'none' })
  subscriptionStatus!: string;

  @Prop()
  currentPeriodStart?: number;

  @Prop()
  currentPeriodEnd?: number;

  @Prop()
  trialEnd?: number;

  @Prop({ default: false })
  cancelAtPeriodEnd!: boolean;

  @Prop()
  pauseBehavior?: string;

  /** a scheduled change that has not taken effect yet (end_of_period rules) */
  @Prop({ type: Object })
  pendingChange?: Record<string, any>;

  /** cancelled while cancellation.moveToFreePlan was off: no screens at all */
  @Prop({ default: false })
  deactivated!: boolean;

  /**
   * The one thing about the X add-on that Stripe cannot hold (MODEL V6): that
   * the tenant cancelled it, until when the quota month it was cancelled in
   * stays frozen, and until when its quantity-0 item is kept. Everything else
   * — is the item there, at what quantity, is the time paid — is read back from
   * Stripe on each reconcile, and the quota itself lives in `x_quota_ledgers`.
   */
  @Prop({ type: Object, default: {} })
  xAddon!: XAddonAccountState;

  /** subscription items whose Stripe price is no longer in the catalog */
  @Prop({ type: [String], default: [] })
  unmappedPriceIds!: string[];
}

export const AccountSchema = SchemaFactory.createForClass(Account);
