import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Req,
  UseGuards,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { WorkOrdersService } from './work-orders.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';

@Controller('work-orders')
@UseGuards(JwtAuthGuard)
export class WorkOrdersController {
  constructor(
    private readonly workOrdersService: WorkOrdersService,
    private readonly prisma: PrismaService,
  ) {}

  @Get(':id')
  async getWorkOrder(@Req() req: any, @Param('id') id: string) {
    return this.workOrdersService.getWorkOrder(id, req.user.id);
  }

  @Post(':id/submit')
  async submitWork(
    @Req() req: any,
    @Param('id') id: string,
    @Body()
    body: {
      message?: string;
      attachments?: string[];
      chatType: 'QUOTE_REQUEST' | 'EVENT_CHAT';
      chatId: string;
    },
  ) {
    try {
      console.log('📤 Controller: Submit work request:', {
        workOrderId: id,
        chatType: body.chatType,
        chatId: body.chatId,
      });

      if (!body.chatType) {
        throw new HttpException(
          'Missing required field: chatType',
          HttpStatus.BAD_REQUEST,
        );
      }
      if (!body.chatId || body.chatId.trim() === '') {
        throw new HttpException(
          'Missing required field: chatId',
          HttpStatus.BAD_REQUEST,
        );
      }

      const vendor = await this.prisma.vendor.findUnique({
        where: { userId: req.user.id },
      });

      if (!vendor) {
        console.error('❌ Vendor not found for user:', req.user.id);
        throw new HttpException('Vendor not found', HttpStatus.NOT_FOUND);
      }

      console.log('✅ Vendor found:', vendor.id);

      return await this.workOrdersService.submitWork(
        id,
        vendor.id,
        body.message || '',
        body.attachments || [],
        body.chatType,
        body.chatId,
      );
    } catch (error: any) {
      console.error('❌ Controller error in submitWork:', error);
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Failed to submit work: ${error?.message || 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post(':id/accept')
  async acceptWork(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { rating: number; review?: string },
  ) {
    return this.workOrdersService.acceptWork(
      id,
      req.user.id,
      body.rating,
      body.review,
    );
  }

  @Post(':id/authorize-payment')
  async authorizePayment(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { paymentIntentId: string },
  ) {
    if (!body.paymentIntentId) {
      throw new HttpException(
        'Payment intent ID is required',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.workOrdersService.authorizePaymentForWorkOrder(
      id,
      req.user.id,
      body.paymentIntentId,
    );
  }

  @Post(':id/request-revision')
  async requestRevision(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { revisionNotes?: string },
  ) {
    return this.workOrdersService.requestRevision(
      id,
      req.user.id,
      body.revisionNotes,
    );
  }

  @Post(':id/request-refund')
  async requestRefund(@Req() req: any, @Param('id') id: string) {
    return this.workOrdersService.requestRefund(id, req.user.id);
  }

  // attach extra proof files/notes to a refund request
  @Post(':id/refund-proof')
  async submitRefundProof(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { message: string; attachments?: string[] },
  ) {
    return this.workOrdersService.submitRefundProof(
      id,
      req.user.id,
      body.message || '',
      body.attachments || [],
    );
  }

  @Get('vendor/my-orders')
  async getMyWorkOrders(@Req() req: any) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { userId: req.user.id },
    });

    if (!vendor) {
      throw new HttpException('Vendor not found', HttpStatus.NOT_FOUND);
    }

    return this.workOrdersService.getVendorWorkOrders(vendor.id);
  }

  @Get('organizer/my-orders')
  async getOrganizerWorkOrders(@Req() req: any) {
    return this.workOrdersService.getOrganizerWorkOrders(req.user.id);
  }

  // fallback if work order wasn't created when the bid was accepted
  @Post('create-from-bid/:serviceBidId')
  async createWorkOrderFromBid(
    @Req() req: any,
    @Param('serviceBidId') serviceBidId: string,
  ) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { userId: req.user.id },
    });

    if (!vendor) {
      throw new HttpException('Vendor not found', HttpStatus.NOT_FOUND);
    }

    const serviceBid = await this.prisma.serviceBid.findUnique({
      where: { id: serviceBidId },
      include: {
        eventService: {
          include: {
            event: {
              select: {
                organizerId: true,
              },
            },
          },
        },
      },
    });

    if (!serviceBid) {
      throw new HttpException('Service bid not found', HttpStatus.NOT_FOUND);
    }

    if (serviceBid.vendorId !== vendor.id) {
      throw new HttpException('Access denied', HttpStatus.FORBIDDEN);
    }

    if (serviceBid.status !== 'ACCEPTED') {
      throw new HttpException(
        'Service bid must be accepted first',
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.workOrdersService.createWorkOrderFromBid(
      serviceBidId,
      serviceBid.eventService.event.organizerId,
    );
  }

  // fallback if work order wasn't created when the quote was accepted
  @Post('create-from-quote/:quoteRequestId')
  async createWorkOrderFromQuote(
    @Req() req: any,
    @Param('quoteRequestId') quoteRequestId: string,
  ) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { userId: req.user.id },
    });

    if (!vendor) {
      throw new HttpException('Vendor not found', HttpStatus.NOT_FOUND);
    }

    const quoteRequest = await this.prisma.quoteRequest.findUnique({
      where: { id: quoteRequestId },
    });

    if (!quoteRequest) {
      throw new HttpException('Quote request not found', HttpStatus.NOT_FOUND);
    }

    if (quoteRequest.vendorId !== vendor.id) {
      throw new HttpException('Access denied', HttpStatus.FORBIDDEN);
    }

    if (quoteRequest.status !== 'ACCEPTED') {
      throw new HttpException(
        'Quote request must be accepted first',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!quoteRequest.userId) {
      throw new HttpException(
        'Quote request must have a valid user ID',
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.workOrdersService.createWorkOrderFromQuote(
      quoteRequestId,
      quoteRequest.userId,
    );
  }
}
