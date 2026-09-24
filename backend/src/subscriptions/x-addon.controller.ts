import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';
import { SyncKind } from '../x-addon/x-addon.service';

/**
 * The X add-on's own lifecycle (MODEL V6). Buying it and cancelling it also
 * work through /subscriptions/:id/change by adding or dropping `x_social`;
 * these routes are the direct handles, plus what only the add-on has — resume,
 * the trial, and the quota a provider fetch spends.
 */
@Controller('x-addon')
export class XAddonController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Get(':accountId')
  state(@Param('accountId') accountId: string) {
    return this.subscriptions.xSnapshot(accountId);
  }

  @Post(':accountId/preview/:action')
  preview(@Param('accountId') accountId: string, @Param('action') action: 'purchase' | 'cancel' | 'resume') {
    return this.subscriptions.previewX(accountId, action);
  }

  @Post(':accountId/cancel')
  cancel(@Param('accountId') accountId: string) {
    return this.subscriptions.cancelX(accountId);
  }

  @Post(':accountId/resume')
  resume(@Param('accountId') accountId: string) {
    return this.subscriptions.resumeX(accountId);
  }

  @Post(':accountId/trial')
  trial(@Param('accountId') accountId: string) {
    return this.subscriptions.startXTrial(accountId);
  }

  /** One provider fetch: spends the Posts X actually returned and billed. */
  @Post(':accountId/sync-runs')
  syncRun(
    @Param('accountId') accountId: string,
    @Body() body: { kind?: SyncKind; returned?: number; requested?: number; actionId?: string },
  ) {
    return this.subscriptions.recordXSyncRun(accountId, body);
  }
}
