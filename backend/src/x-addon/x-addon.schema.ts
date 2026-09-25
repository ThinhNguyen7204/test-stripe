import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type XQuotaLedgerDocument = HydratedDocument<XQuotaLedger>;

/**
 * One quota window of one tenant: a SCIO quota month on the paid add-on, or
 * the trial's own 14 days (V6 row 50 keeps the trial's 200 posts in a ledger
 * of their own, so they can never mix with paid quota).
 *
 * `granted` only ever rises — a later paid range adds its positive delta and
 * nothing is taken back (rows 6, 46) — and `used` is never reset by a renewal
 * or an interval change. `actionIds` makes a deduction exactly-once (row 12).
 */
@Schema({ timestamps: true, collection: 'x_quota_ledgers' })
export class XQuotaLedger {
  @Prop({ required: true, index: true })
  accountId!: string;

  @Prop({ required: true })
  kind!: 'paid' | 'trial';

  @Prop({ required: true })
  windowStart!: number;

  @Prop({ required: true })
  windowEnd!: number;

  @Prop({ required: true, default: 0 })
  granted!: number;

  @Prop({ required: true, default: 0 })
  used!: number;

  @Prop({ type: [String], default: [] })
  actionIds!: string[];

  /** every positive delta, so the UI can say where the grant came from */
  @Prop({ type: [Object], default: [] })
  grants!: { at: number; delta: number; target: number; reason: string }[];
}

export const XQuotaLedgerSchema = SchemaFactory.createForClass(XQuotaLedger);
XQuotaLedgerSchema.index({ accountId: 1, kind: 1, windowStart: 1 }, { unique: true });

export type XCapacityReservationDocument = HydratedDocument<XCapacityReservation>;

/**
 * Row 17's admission control. A tenant takes a pending reservation of one full
 * month's target before it is sent to Stripe; payment commits it, failure or a
 * 15-minute timeout releases it. At most one per tenant (the unique index), so
 * a retry can never reserve twice.
 */
@Schema({ timestamps: true, collection: 'x_capacity_reservations' })
export class XCapacityReservation {
  @Prop({ required: true, unique: true })
  accountId!: string;

  @Prop({ required: true })
  status!: 'pending' | 'committed';

  @Prop({ required: true })
  units!: number;

  /** wall-clock unix seconds; only meaningful while pending */
  @Prop()
  expiresAt?: number;
}

export const XCapacityReservationSchema = SchemaFactory.createForClass(XCapacityReservation);

export type XTenantLockDocument = HydratedDocument<XTenantLock>;

/**
 * MODEL V6 row 8: buying X again and the boundary cleanup of a quantity-0 item
 * both touch the same Stripe item, so they take this lock first. One row per
 * tenant; a holder that dies leaves it to expire after `expiresAt`.
 */
@Schema({ timestamps: true, collection: 'x_tenant_locks' })
export class XTenantLock {
  @Prop({ required: true, unique: true })
  accountId!: string;

  @Prop({ required: true })
  holder!: string;

  /** wall-clock unix seconds */
  @Prop({ required: true })
  expiresAt!: number;
}

export const XTenantLockSchema = SchemaFactory.createForClass(XTenantLock);
