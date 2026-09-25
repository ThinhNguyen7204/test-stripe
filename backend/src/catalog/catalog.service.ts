import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { StripeService } from '../stripe/stripe.service';
import {
  BillingTerm,
  CATALOG,
  CatalogItemDef,
  FREE_PLAN_CODE,
  lookupKey,
  stripeUnitAmount,
} from './catalog.constants';
import { CatalogItem, CatalogItemDocument } from './catalog.schema';

@Injectable()
export class CatalogService implements OnModuleInit {
  private readonly logger = new Logger(CatalogService.name);

  constructor(
    @InjectModel(CatalogItem.name) private readonly model: Model<CatalogItemDocument>,
    private readonly stripe: StripeService,
  ) {}

  async onModuleInit() {
    await this.seedLocal();
  }

  /**
   * Writes the OptiSigns price book into Mongo (no Stripe calls).
   */
  async seedLocal(): Promise<void> {
    for (const def of CATALOG) {
      const structural = {
        kind: def.kind,
        name: def.name,
        description: def.description,
        unitLabel: def.unitLabel,
        tierRank: def.tierRank,
        monthlyCents: def.monthlyCents,
        annualMonthlyCents: def.annualMonthlyCents,
        minQuantity: def.minQuantity,
        maxQuantity: def.maxQuantity,
        boundToScreens: Boolean(def.boundToScreens),
        perAccount: Boolean(def.perAccount),
        quotaAllowance: def.quotaAllowance,
        quotaLabel: def.quotaLabel,
        features: def.features,
      };

      /*
       * A structural field that the price book no longer sets has to be removed,
       * not skipped. `$set: { x: undefined }` is dropped before it reaches Mongo,
       * so without this an optional field keeps whatever value it was seeded with
       * years ago — lifting a quantity ceiling in code would leave the old ceiling
       * enforcing itself out of the database.
       */
      const set: Record<string, unknown> = {};
      const unset: Record<string, ''> = {};
      for (const [key, value] of Object.entries(structural)) {
        if (value === undefined) unset[key] = '';
        else set[key] = value;
      }

      await this.model.updateOne(
        { code: def.code },
        {
          $set: set,
          ...(Object.keys(unset).length ? { $unset: unset } : {}),
        },
        { upsert: true },
      );
    }
    await this.pruneStaleItems();
    this.logger.log(`Catalog ready: ${CATALOG.length} items`);
  }

  /**
   * Removes items that are no longer in the price book (e.g. a tier OptiSigns
   * has retired) and archives whatever they left behind in Stripe, so the
   * dashboard does not accumulate dead products.
   */
  private async pruneStaleItems(): Promise<void> {
    const keep = CATALOG.map((item) => item.code);
    const stale = await this.model.find({ code: { $nin: keep } }).lean<CatalogItemDocument[]>().exec();
    if (stale.length === 0) return;

    for (const item of stale) {
      if (this.stripe.configured) {
        for (const priceId of [item.monthlyPrice?.priceId, item.yearlyPrice?.priceId]) {
          if (!priceId) continue;
          try {
            await this.stripe.client.prices.update(priceId, { active: false });
          } catch (err: any) {
            this.logger.warn(`Could not archive price ${priceId}: ${err.message}`);
          }
        }
        if (item.stripeProductId) {
          try {
            await this.stripe.client.products.update(item.stripeProductId, { active: false });
          } catch (err: any) {
            this.logger.warn(`Could not archive product ${item.stripeProductId}: ${err.message}`);
          }
        }
      }
      await this.model.deleteOne({ code: item.code }).exec();
      this.logger.log(`Retired catalog item "${item.code}" (archived in Stripe)`);
    }
  }

  async list(): Promise<CatalogItemDocument[]> {
    return this.model.find().sort({ kind: 1, tierRank: 1, name: 1 }).lean<CatalogItemDocument[]>().exec();
  }

  async plans(): Promise<CatalogItemDocument[]> {
    return this.model.find({ kind: 'plan' }).sort({ tierRank: 1 }).lean<CatalogItemDocument[]>().exec();
  }

  async addons(): Promise<CatalogItemDocument[]> {
    return this.model.find({ kind: 'addon' }).sort({ name: 1 }).lean<CatalogItemDocument[]>().exec();
  }

  async get(code: string): Promise<CatalogItemDocument> {
    const item = await this.model.findOne({ code }).lean<CatalogItemDocument>().exec();
    if (!item) throw new BadRequestException(`Unknown catalog item "${code}"`);
    return item;
  }

  async priceIdFor(code: string, term: BillingTerm): Promise<string> {
    const item = await this.get(code);
    const ref = term === 'yearly' ? item.yearlyPrice : item.monthlyPrice;
    if (!ref?.priceId) {
      throw new BadRequestException(
        `No Stripe price for "${code}" (${term}). Run POST /api/catalog/sync-stripe first.`,
      );
    }
    return ref.priceId;
  }

  /** Reverse lookup used when reading an existing Stripe subscription back. */
  async byPriceId(priceId: string): Promise<{ item: CatalogItemDocument; term: BillingTerm } | null> {
    const item = await this.model
      .findOne({ $or: [{ 'monthlyPrice.priceId': priceId }, { 'yearlyPrice.priceId': priceId }] })
      .lean<CatalogItemDocument>()
      .exec();
    if (!item) return null;
    return { item, term: item.yearlyPrice?.priceId === priceId ? 'yearly' : 'monthly' };
  }

  /**
   * Idempotently creates the Stripe Products and Prices for the whole catalog.
   * Prices are matched by `lookup_key`, so re-running is safe and never
   * duplicates objects. The Free plan is intentionally skipped: it exists only
   * as an application state, not as a Stripe subscription.
   */
  async syncToStripe(): Promise<{ synced: string[]; skipped: string[] }> {
    const synced: string[] = [];
    const skipped: string[] = [];

    for (const def of CATALOG) {
      if (def.code === FREE_PLAN_CODE) {
        skipped.push(def.code);
        continue;
      }
      const doc = await this.get(def.code);
      const productId = await this.ensureProduct(def, doc.stripeProductId);
      const monthly = await this.ensurePrice(def, 'monthly', productId);
      const yearly = await this.ensurePrice(def, 'yearly', productId);

      await this.model.updateOne(
        { code: def.code },
        {
          $set: {
            stripeProductId: productId,
            monthlyPrice: { priceId: monthly.id, unitAmount: monthly.unit_amount, interval: 'month' },
            yearlyPrice: { priceId: yearly.id, unitAmount: yearly.unit_amount, interval: 'year' },
          },
        },
      );
      synced.push(def.code);
    }

    this.logger.log(`Stripe catalog sync complete: ${synced.join(', ')}`);
    return { synced, skipped };
  }

  private async ensureProduct(def: CatalogItemDef, knownId?: string): Promise<string> {
    if (knownId) {
      try {
        const existing = await this.stripe.client.products.retrieve(knownId);
        if (!(existing as any).deleted) {
          // keep the Stripe product in step with the local price book
          if (existing.name !== `OptiSigns ${def.name}` || existing.description !== def.description || !existing.active) {
            await this.stripe.client.products.update(existing.id, {
              name: `OptiSigns ${def.name}`,
              description: def.description,
              active: true,
              metadata: { demo_code: def.code, demo_kind: def.kind, unit_label: def.unitLabel },
            });
          }
          return existing.id;
        }
      } catch {
        /* fall through and recreate */
      }
    }
    const product = await this.stripe.call('products.create', () =>
      this.stripe.client.products.create({
        name: `OptiSigns ${def.name}`,
        description: def.description,
        metadata: { demo_code: def.code, demo_kind: def.kind, unit_label: def.unitLabel },
      }),
    );
    return product.id;
  }

  private async ensurePrice(def: CatalogItemDef, term: BillingTerm, productId: string) {
    const key = lookupKey(def.code, term);
    const found = await this.stripe.call('prices.list', () =>
      this.stripe.client.prices.list({ lookup_keys: [key], limit: 1, active: true }),
    );
    const amount = stripeUnitAmount(def, term);
    const existing = found.data[0];
    if (
      existing &&
      existing.unit_amount === amount &&
      existing.currency === this.stripe.currency &&
      (existing.product as string) === productId
    ) {
      return existing;
    }
    if (existing) {
      // Price amounts are immutable: archive the stale one and transfer the key.
      await this.stripe.call('prices.update', () =>
        this.stripe.client.prices.update(existing.id, { active: false, lookup_key: `${key}_archived_${Date.now()}` }),
      );
    }
    return this.stripe.call('prices.create', () =>
      this.stripe.client.prices.create({
        product: productId,
        currency: this.stripe.currency,
        unit_amount: amount,
        recurring: { interval: term === 'yearly' ? 'year' : 'month' },
        lookup_key: key,
        transfer_lookup_key: true,
        nickname: `${def.name} — ${term}`,
        metadata: {
          demo_code: def.code,
          demo_term: term,
          per_unit_per_month: String(term === 'yearly' ? def.annualMonthlyCents : def.monthlyCents),
          unit_label: def.unitLabel,
        },
      }),
    );
  }
}
