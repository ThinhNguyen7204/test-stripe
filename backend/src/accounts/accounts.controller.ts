import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccountsService, TEST_PAYMENT_METHODS } from './accounts.service';

@Controller('accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService, private readonly config: ConfigService) {}

  @Get('test-cards')
  testCards() {
    return Object.entries(TEST_PAYMENT_METHODS).map(([key, value]) => ({ key, ...value }));
  }

  @Get()
  list() {
    return this.accounts.list();
  }

  @Post()
  create(
    @Body()
    body: { email: string; name: string; company?: string; withTestClock?: boolean; clockStart?: number },
  ) {
    return this.accounts.create(body);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.accounts.get(id);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.accounts.remove(id);
    return { ok: true };
  }

  @Post(':id/payment-method/test')
  attachTest(@Param('id') id: string, @Body() body: { kind: keyof typeof TEST_PAYMENT_METHODS }) {
    return this.accounts.attachTestPaymentMethod(id, body.kind ?? 'visa');
  }

  @Get(':id/payment-methods')
  paymentMethods(@Param('id') id: string) {
    return this.accounts.paymentMethods(id);
  }

  @Post(':id/payment-method/default')
  setDefault(@Param('id') id: string, @Body() body: { paymentMethodId: string }) {
    return this.accounts.setDefaultPaymentMethod(id, body.paymentMethodId);
  }

  @Post(':id/checkout-setup')
  checkoutSetup(@Param('id') id: string, @Body() body: { returnUrl?: string }) {
    const fallback = this.config.get<string>('frontendUrl') ?? 'http://localhost:5555';
    return this.accounts.createSetupCheckoutSession(id, body?.returnUrl ?? fallback);
  }

  @Get(':id/balance')
  balance(@Param('id') id: string) {
    return this.accounts.balance(id);
  }

  @Post(':id/balance')
  adjustBalance(@Param('id') id: string, @Body() body: { amountCents: number; description?: string }) {
    return this.accounts.adjustBalance(id, body.amountCents, body.description ?? 'Manual adjustment');
  }
}
