import { Controller, Get, Post } from '@nestjs/common';
import { CatalogService } from './catalog.service';
import { ANNUAL_DISCOUNT_PERCENT } from './catalog.constants';
import { StripeService } from '../stripe/stripe.service';

@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService, private readonly stripe: StripeService) {}

  @Get()
  async list() {
    const [plans, addons] = await Promise.all([this.catalog.plans(), this.catalog.addons()]);
    return {
      plans,
      addons,
      annualDiscountPercent: ANNUAL_DISCOUNT_PERCENT,
      currency: this.stripe.currency,
      stripeConfigured: this.stripe.configured,
      stripeSynced: plans.some((p) => p.monthlyPrice?.priceId) || addons.some((a) => a.monthlyPrice?.priceId),
    };
  }

  @Post('sync-stripe')
  async sync() {
    return this.catalog.syncToStripe();
  }

  @Post('reseed')
  async reseed() {
    await this.catalog.seedLocal();
    return { ok: true };
  }
}
