import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { XAddonService } from './x-addon.service';
import {
  XCapacityReservation,
  XCapacityReservationSchema,
  XQuotaLedger,
  XQuotaLedgerSchema,
  XTenantLock,
  XTenantLockSchema,
} from './x-addon.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: XQuotaLedger.name, schema: XQuotaLedgerSchema },
      { name: XCapacityReservation.name, schema: XCapacityReservationSchema },
      { name: XTenantLock.name, schema: XTenantLockSchema },
    ]),
  ],
  providers: [XAddonService],
  exports: [XAddonService],
})
export class XAddonModule {}
