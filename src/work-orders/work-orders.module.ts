import { Module } from '@nestjs/common';
import { WorkOrdersController } from './work-orders.controller';
import { WorkOrdersService } from './work-orders.service';
import { PrismaModule } from '../prisma/prisma.module';
import { PaymentsModule } from '../payments/payments.module';
import { MailModule } from '../mail/mail.module';
import { WorkOrdersCronService } from './work-orders.cron';

@Module({
  imports: [PrismaModule, PaymentsModule, MailModule],
  controllers: [WorkOrdersController],
  providers: [WorkOrdersService, WorkOrdersCronService],
  exports: [WorkOrdersService],
})
export class WorkOrdersModule {}
