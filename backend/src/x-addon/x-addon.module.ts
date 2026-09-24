import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { XAddonService } from './x-addon.service';
import {
  XCapacityReservation,
  XCapacityReservationSchema,
  XQuotaLedger,
  XQuotaLedgerSchema,
} from './x-addon.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: XQuotaLedger.name, schema: XQuotaLedgerSchema },
      { name: XCapacityReservation.name, schema: XCapacityReservationSchema },
    ]),
  ],
  providers: [XAddonService],
  exports: [XAddonService],
})
export class XAddonModule {}
