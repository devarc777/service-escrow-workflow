import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { WorkOrdersService } from './work-orders.service';

@Injectable()
export class WorkOrdersCronService {
  private readonly logger = new Logger(WorkOrdersCronService.name);

  // fall back to 7 days if env is missing or invalid
  private readonly autoCompleteDays: number = (() => {
    const raw = process.env.WORK_ORDER_AUTO_COMPLETE_DAYS;
    const n = raw ? Number(raw) : 7;
    return Number.isFinite(n) && n > 0 ? n : 7;
  })();

  constructor(
    private readonly prisma: PrismaService,
    private readonly workOrdersService: WorkOrdersService,
  ) {}

  // auto-accept submitted work the organizer never reviewed
  @Cron('0 3 * * *')
  async autoCompleteStaleSubmissions() {
    if (!this.autoCompleteDays || this.autoCompleteDays <= 0) {
      return;
    }

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.autoCompleteDays);

    try {
      const candidates = await this.prisma.workOrder.findMany({
        where: {
          status: 'SUBMITTED' as any,
          refundStatus: 'NONE' as any,
          submittedAt: {
            lte: cutoff,
          },
          paymentIntentId: {
            not: null,
          },
        },
        select: {
          id: true,
          organizerId: true,
        },
        take: 100,
      });

      if (!candidates.length) {
        return;
      }

      this.logger.log(
        `Auto-completing ${candidates.length} work orders with no organizer action for ${this.autoCompleteDays} days...`,
      );

      for (const wo of candidates) {
        try {
          await this.workOrdersService.acceptWork(
            wo.id,
            wo.organizerId,
            5,
            `Auto-accepted after ${this.autoCompleteDays} days without response from the organizer.`,
          );
        } catch (err: any) {
          this.logger.error(
            `Failed to auto-complete work order ${wo.id}: ${
              err?.message || err
            }`,
          );
        }
      }
    } catch (err: any) {
      this.logger.error(
        `Error while scanning for stale submitted work orders: ${
          err?.message || err
        }`,
      );
    }
  }
}
