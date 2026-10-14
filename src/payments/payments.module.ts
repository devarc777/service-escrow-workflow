import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { StripePaymentService } from './stripe-payment.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [PaymentsController],
  providers: [StripePaymentService],
  exports: [StripePaymentService],
})
export class PaymentsModule {}
