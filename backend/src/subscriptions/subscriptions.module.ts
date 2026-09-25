import { Module } from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';
import { SubscriptionsController } from './subscriptions.controller';
import { BillingModule } from '../billing/billing.module';
import { XAddonModule } from '../x-addon/x-addon.module';
import { XAddonController } from './x-addon.controller';

@Module({
  imports: [BillingModule, XAddonModule],
  providers: [SubscriptionsService],
  controllers: [SubscriptionsController, XAddonController],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
