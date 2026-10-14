import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StripePaymentService } from '../payments/stripe-payment.service';
import { MailService } from '../mail/mail.service';

@Injectable()
export class WorkOrdersService {
  constructor(
    private prisma: PrismaService,
    private readonly stripePaymentService: StripePaymentService,
    private readonly mailService: MailService,
  ) {}

  private async sendNotificationEmailToUser(
    userId: string,
    title: string,
    message: string,
  ): Promise<void> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true },
      });
      if (user?.email) {
        await this.mailService.sendNotificationEmail(user.email, title, message);
      }
    } catch {
      // non-blocking
    }
  }

  // create work order after quote is accepted
  async createWorkOrderFromQuote(
    quoteRequestId: string,
    organizerId: string,
    paymentIntentId?: string,
  ) {
    console.log('🔨 Creating work order from quote:', {
      quoteRequestId,
      organizerId,
    });

    const quoteRequest = await this.prisma.quoteRequest.findUnique({
      where: { id: quoteRequestId },
      include: { vendor: true },
    });

    if (!quoteRequest) {
      console.error('❌ Quote request not found:', quoteRequestId);
      throw new HttpException('Quote request not found', HttpStatus.NOT_FOUND);
    }

    console.log('📋 Quote request found:', {
      id: quoteRequest.id,
      status: quoteRequest.status,
      vendorId: quoteRequest.vendorId,
      userId: quoteRequest.userId,
    });

    if (quoteRequest.status !== 'ACCEPTED') {
      console.error('❌ Quote request not accepted:', quoteRequest.status);
      throw new HttpException(
        'Quote request must be accepted first',
        HttpStatus.BAD_REQUEST,
      );
    }

    // final price + escrow must be ready
    if (!quoteRequest.finalPriceConfirmed) {
      console.error('❌ Final price not confirmed:', quoteRequest.id);
      throw new HttpException(
        'Vendor must confirm final price before work order can be created',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!quoteRequest.finalPrice) {
      console.error('❌ Final price not set:', quoteRequest.id);
      throw new HttpException(
        'Final price must be set before work order can be created',
        HttpStatus.BAD_REQUEST,
      );
    }

    // lock escrow if it was missed earlier
    if (!quoteRequest.escrowLockedAt) {
      console.log('⚠️ Escrow not locked, setting escrowLockedAt now...');
      await this.prisma.quoteRequest.update({
        where: { id: quoteRequestId },
        data: { escrowLockedAt: new Date() },
      });
    }

    // skip if work order already exists
    const existing = await this.prisma.workOrder.findUnique({
      where: { quoteRequestId },
    });

    if (existing) {
      console.log('✅ Work order already exists:', existing.id);
      return existing;
    }

    // bump vendor bid count
    await this.prisma.vendor.update({
      where: { id: quoteRequest.vendorId },
      data: {
        totalBids: { increment: 1 },
      },
    });

    // verify Stripe payment before creating the work order
    let paymentStatus: 'PENDING' | 'COMPLETED' = 'PENDING';
    if (paymentIntentId) {
      try {
        const paymentIntent =
          await this.stripePaymentService.getPaymentStatus(paymentIntentId);
        if (paymentIntent.status === 'succeeded') {
          paymentStatus = 'COMPLETED';
          console.log(
            '✅ Payment verified with Stripe, setting status to COMPLETED (funds with platform, vendor will be paid after acceptance)',
          );
        } else if (paymentIntent.status === 'requires_capture') {
          // authorized hold — stays PENDING until work is accepted
          paymentStatus = 'PENDING';
          console.log(
            '✅ Payment authorized but not captured yet (requires_capture). Keeping status as PENDING for backward compatibility.',
          );
        } else {
          console.error('❌ Payment not in valid state:', paymentIntent.status);
          throw new HttpException(
            `Payment verification failed. Payment must be authorized (requires_capture) or succeeded. Current status: ${paymentIntent.status}. Only real Stripe payments are accepted.`,
            HttpStatus.BAD_REQUEST,
          );
        }
      } catch (error: any) {
        console.error('❌ Failed to verify payment with Stripe:', error);
        throw new HttpException(
          `Payment verification failed. Only real Stripe payments are accepted. Error: ${error.message || 'Unknown error'}`,
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    console.log('🔨 Creating new work order...');
    const workOrder = await this.prisma.workOrder.create({
      data: {
        quoteRequestId,
        vendorId: quoteRequest.vendorId,
        organizerId,
        status: 'IN_PROGRESS',
        paymentIntentId: paymentIntentId || null,
        paymentStatus,
      },
      include: {
        vendor: {
          select: {
            id: true,
            businessName: true,
            userId: true,
          },
        },
        quoteRequest: {
          select: {
            id: true,
            fullName: true,
            eventType: true,
            eventDate: true,
          },
        },
      },
    });

    console.log('✅ Work order created successfully:', {
      id: workOrder.id,
      quoteRequestId: workOrder.quoteRequestId,
      vendorId: workOrder.vendorId,
      organizerId: workOrder.organizerId,
      status: workOrder.status,
    });

    return workOrder;
  }

  // create work order after bid is accepted
  async createWorkOrderFromBid(
    serviceBidId: string,
    organizerId: string,
    paymentIntentId?: string,
  ) {
    console.log('🔨 Creating work order from bid:', {
      serviceBidId,
      organizerId,
      hasPaymentIntent: !!paymentIntentId,
    });

    const serviceBid = await this.prisma.serviceBid.findUnique({
      where: { id: serviceBidId },
      include: {
        vendor: true,
        eventService: {
          include: {
            event: {
              select: {
                organizerId: true,
                id: true,
              },
            },
          },
        },
      },
    });

    if (!serviceBid) {
      console.error('❌ Service bid not found:', serviceBidId);
      throw new HttpException('Service bid not found', HttpStatus.NOT_FOUND);
    }

    console.log('📋 Service bid found:', {
      id: serviceBid.id,
      status: serviceBid.status,
      vendorId: serviceBid.vendorId,
      eventId: serviceBid.eventService.event.id,
      eventServiceId: serviceBid.eventServiceId,
    });

    if (serviceBid.status !== 'ACCEPTED') {
      console.error('❌ Service bid not accepted:', serviceBid.status);
      throw new HttpException(
        'Service bid must be accepted first',
        HttpStatus.BAD_REQUEST,
      );
    }

    // skip if work order already exists
    const existing = await this.prisma.workOrder.findUnique({
      where: { serviceBidId },
    });

    if (existing) {
      console.log('✅ Work order already exists:', existing.id);
      return existing;
    }

    // bump vendor bid count
    await this.prisma.vendor.update({
      where: { id: serviceBid.vendorId },
      data: {
        totalBids: { increment: 1 },
      },
    });

    // verify Stripe payment before creating the work order
    let paymentStatus: 'PENDING' | 'COMPLETED' = 'PENDING';
    if (paymentIntentId) {
      try {
        const paymentIntent =
          await this.stripePaymentService.getPaymentStatus(paymentIntentId);
        if (paymentIntent.status === 'succeeded') {
          paymentStatus = 'COMPLETED';
          console.log(
            '✅ Payment verified with Stripe, setting status to COMPLETED (funds with platform, vendor will be paid after acceptance)',
          );
        } else if (paymentIntent.status === 'requires_capture') {
          // authorized hold — stays PENDING until work is accepted
          paymentStatus = 'PENDING';
          console.log(
            '✅ Payment authorized but not captured yet (requires_capture). Keeping status as PENDING for backward compatibility.',
          );
        } else {
          console.error('❌ Payment not in valid state:', paymentIntent.status);
          throw new HttpException(
            `Payment verification failed. Payment must be authorized (requires_capture) or succeeded. Current status: ${paymentIntent.status}. Only real Stripe payments are accepted.`,
            HttpStatus.BAD_REQUEST,
          );
        }
      } catch (error: any) {
        console.error('❌ Failed to verify payment with Stripe:', error);
        throw new HttpException(
          `Payment verification failed. Only real Stripe payments are accepted. Error: ${error.message || 'Unknown error'}`,
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    console.log('🔨 Creating new work order...');
    const workOrder = await this.prisma.workOrder.create({
      data: {
        serviceBidId,
        vendorId: serviceBid.vendorId,
        organizerId,
        status: 'IN_PROGRESS',
        paymentIntentId: paymentIntentId || null,
        paymentStatus: paymentStatus,
      },
      include: {
        vendor: {
          select: {
            id: true,
            businessName: true,
            userId: true,
          },
        },
        serviceBid: {
          select: {
            id: true,
            bidAmount: true,
            currency: true,
            eventService: {
              select: {
                id: true,
                title: true,
                eventId: true,
                event: {
                  select: {
                    id: true,
                    title: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    console.log('✅ Work order created successfully:', {
      id: workOrder.id,
      serviceBidId: workOrder.serviceBidId,
      vendorId: workOrder.vendorId,
      organizerId: workOrder.organizerId,
      status: workOrder.status,
      eventId:
        workOrder.serviceBid?.eventService?.eventId ||
        workOrder.serviceBid?.eventService?.event?.id,
    });

    return workOrder;
  }

  async getWorkOrder(id: string, userId: string) {
    const workOrder = await this.prisma.workOrder.findUnique({
      where: { id },
      include: {
        vendor: {
          select: {
            id: true,
            businessName: true,
            userId: true,
          },
        },
        organizer: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        quoteRequest: {
          select: {
            id: true,
            fullName: true,
            eventType: true,
            eventDate: true,
            quotePrice: true,
          },
        },
        serviceBid: {
          select: {
            id: true,
            bidAmount: true,
            currency: true,
            eventService: {
              select: {
                title: true,
                event: {
                  select: {
                    title: true,
                  },
                },
              },
            },
          },
        },
        review: true,
      },
    });

    if (!workOrder) {
      throw new HttpException('Work order not found', HttpStatus.NOT_FOUND);
    }

    // only vendor or organizer may view
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new HttpException('User not found', HttpStatus.NOT_FOUND);
    }

    const vendor = await this.prisma.vendor.findUnique({ where: { userId } });
    const isVendor = vendor && vendor.id === workOrder.vendorId;
    const isOrganizer = workOrder.organizerId === userId;

    if (!isVendor && !isOrganizer) {
      throw new HttpException('Access denied', HttpStatus.FORBIDDEN);
    }

    return workOrder;
  }

  // organizer can see submitted work only after payment is captured
  canViewWork(workOrder: any, userId: string): boolean {
    if (workOrder.vendor?.userId === userId) {
      return true;
    }

    if (workOrder.organizerId === userId) {
      if (!workOrder.paymentIntentId) {
        return true;
      }
      return workOrder.paymentStatus === 'COMPLETED';
    }

    return false;
  }

  async submitWork(
    workOrderId: string,
    vendorId: string,
    message: string,
    attachments: string[] = [],
    chatType: 'QUOTE_REQUEST' | 'EVENT_CHAT',
    chatId: string,
  ) {
    try {
      console.log('📤 Submitting work:', {
        workOrderId,
        vendorId,
        chatType,
        chatId,
        messageLength: message.length,
        attachmentsCount: attachments.length,
      });

      const workOrder = await this.prisma.workOrder.findUnique({
        where: { id: workOrderId },
        select: {
          id: true,
          vendorId: true,
          organizerId: true,
          status: true,
          serviceBidId: true,
          quoteRequestId: true,
        },
      });

      if (!workOrder) {
        console.error('❌ Work order not found:', workOrderId);
        throw new HttpException('Work order not found', HttpStatus.NOT_FOUND);
      }

      if (workOrder.vendorId !== vendorId) {
        console.error('❌ Access denied - vendor mismatch:', {
          workOrderVendorId: workOrder.vendorId,
          providedVendorId: vendorId,
        });
        throw new HttpException('Access denied', HttpStatus.FORBIDDEN);
      }

      // quote jobs: escrow + final price must be locked first
      if (workOrder.quoteRequestId) {
        const quoteRequest = await this.prisma.quoteRequest.findUnique({
          where: { id: workOrder.quoteRequestId },
          select: { escrowLockedAt: true, finalPriceConfirmed: true },
        });

        if (!quoteRequest) {
          console.error(
            '❌ Quote request not found:',
            workOrder.quoteRequestId,
          );
          throw new HttpException(
            'Quote request not found',
            HttpStatus.NOT_FOUND,
          );
        }

        if (!quoteRequest.escrowLockedAt) {
          console.error(
            '❌ Escrow not locked. Cannot submit work until buyer approves and locks escrow.',
          );
          throw new HttpException(
            'Escrow must be locked before you can submit work. Please wait for the buyer to approve and start escrow.',
            HttpStatus.BAD_REQUEST,
          );
        }

        if (!quoteRequest.finalPriceConfirmed) {
          console.error('❌ Final price not confirmed. Cannot submit work.');
          throw new HttpException(
            'Final price must be confirmed before work can be submitted.',
            HttpStatus.BAD_REQUEST,
          );
        }
      }

      if (
        workOrder.status !== 'IN_PROGRESS' &&
        workOrder.status !== 'REVISION_REQUESTED'
      ) {
        console.error('❌ Invalid work order status:', workOrder.status);
        throw new HttpException(
          'Work can only be submitted when status is IN_PROGRESS or REVISION_REQUESTED',
          HttpStatus.BAD_REQUEST,
        );
      }

      // chat messages need the vendor's user id as sender
      const vendor = await this.prisma.vendor.findUnique({
        where: { id: vendorId },
        select: { userId: true },
      });

      if (!vendor) {
        console.error('❌ Vendor not found:', vendorId);
        throw new HttpException('Vendor not found', HttpStatus.NOT_FOUND);
      }

      const vendorUserId = vendor.userId;
      if (!vendorUserId) {
        console.error('❌ Vendor user ID not found for vendor:', vendorId);
        throw new HttpException(
          'Vendor user ID not found',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      console.log('✅ Vendor user ID found:', vendorUserId);

      // post the submission into the matching chat thread
      if (chatType === 'QUOTE_REQUEST') {
        console.log('💬 Creating quote message for quote request:', chatId);
        console.log('💬 Work order quoteRequestId:', workOrder.quoteRequestId);

        let actualQuoteRequestId = workOrder.quoteRequestId || chatId;

        // prefer the work order's quote id if chatId disagrees
        if (workOrder.quoteRequestId && workOrder.quoteRequestId !== chatId) {
          console.warn('⚠️ ChatId mismatch, using workOrder.quoteRequestId:', {
            workOrderQuoteRequestId: workOrder.quoteRequestId,
            providedChatId: chatId,
          });
          actualQuoteRequestId = workOrder.quoteRequestId;
        }

        // backfill quoteRequestId onto the work order when missing
        if (!workOrder.quoteRequestId && chatId) {
          console.log('📝 Updating work order with quoteRequestId:', chatId);
          try {
            await this.prisma.workOrder.update({
              where: { id: workOrderId },
              data: { quoteRequestId: chatId },
            });
            actualQuoteRequestId = chatId;
            console.log('✅ Work order updated with quoteRequestId');
          } catch (updateError) {
            console.error(
              '❌ Failed to update work order quoteRequestId:',
              updateError,
            );
            actualQuoteRequestId = chatId;
          }
        }

        const quoteRequest = await this.prisma.quoteRequest.findUnique({
          where: { id: actualQuoteRequestId },
        });

        if (!quoteRequest) {
          console.error('❌ Quote request not found:', actualQuoteRequestId);
          throw new HttpException(
            'Quote request not found',
            HttpStatus.NOT_FOUND,
          );
        }

        if (quoteRequest.vendorId !== vendorId) {
          console.error('❌ Quote request vendor mismatch:', {
            quoteRequestVendorId: quoteRequest.vendorId,
            providedVendorId: vendorId,
          });
          throw new HttpException(
            'Quote request does not belong to this vendor',
            HttpStatus.FORBIDDEN,
          );
        }

        const finalChatId = actualQuoteRequestId;
        const messageText = (message && message.trim()) || 'Work submitted';
        const attachmentsArray = Array.isArray(attachments)
          ? attachments.filter((a) => a && a.trim())
          : [];

        console.log('📝 Creating quote message with:', {
          quoteRequestId: finalChatId,
          senderId: vendorUserId,
          messageLength: messageText.length,
          attachmentsCount: attachmentsArray.length,
        });

        try {
          const quoteMessage = await this.prisma.quoteMessage.create({
            data: {
              quoteRequestId: finalChatId,
              senderId: vendorUserId,
              senderType: 'VENDOR',
              message: messageText,
              attachments: attachmentsArray,
              messageType: 'WORK_SUBMISSION' as any,
            },
          });
          console.log(
            '✅ Quote message created successfully:',
            quoteMessage.id,
          );
        } catch (error: any) {
          console.error('❌ Error creating quote message:', error);
          console.error('❌ Error message:', error?.message);
          console.error('❌ Error code:', error?.code);
          console.error('❌ Error meta:', error?.meta);
          if (error?.meta) {
            console.error(
              '❌ Error meta details:',
              JSON.stringify(error.meta, null, 2),
            );
          }
          throw new HttpException(
            `Failed to create quote message: ${error?.message || 'Unknown error'}`,
            HttpStatus.INTERNAL_SERVER_ERROR,
          );
        }
      } else if (chatType === 'EVENT_CHAT') {
        console.log('💬 Creating event chat message for service bid');
        const serviceBid = await this.prisma.serviceBid.findUnique({
          where: { id: workOrder.serviceBidId! },
          include: {
            eventService: {
              select: {
                eventId: true,
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
          console.error('❌ Service bid not found:', workOrder.serviceBidId);
          throw new HttpException(
            'Service bid not found',
            HttpStatus.NOT_FOUND,
          );
        }

        const messageText = (message && message.trim()) || 'Work submitted';
        const attachmentsArray = Array.isArray(attachments)
          ? attachments.filter((a) => a && a.trim())
          : [];

        console.log('📝 Creating event chat message with:', {
          eventId: serviceBid.eventService.eventId,
          vendorId,
          userId: serviceBid.eventService.event.organizerId,
          senderId: vendorUserId,
          messageLength: messageText.length,
          attachmentsCount: attachmentsArray.length,
        });

        try {
          const eventMessage = await this.prisma.eventChatMessage.create({
            data: {
              eventId: serviceBid.eventService.eventId,
              vendorId,
              userId: serviceBid.eventService.event.organizerId,
              senderId: vendorUserId,
              senderType: 'VENDOR',
              message: messageText,
              attachments: attachmentsArray,
              messageType: 'WORK_SUBMISSION' as any,
            },
          });
          console.log(
            '✅ Event chat message created successfully:',
            eventMessage.id,
          );
        } catch (error: any) {
          console.error('❌ Error creating event chat message:', error);
          console.error('❌ Error message:', error?.message);
          console.error('❌ Error code:', error?.code);
          console.error('❌ Error meta:', error?.meta);
          if (error?.meta) {
            console.error(
              '❌ Error meta details:',
              JSON.stringify(error.meta, null, 2),
            );
          }
          throw new HttpException(
            `Failed to create event chat message: ${error?.message || 'Unknown error'}`,
            HttpStatus.INTERNAL_SERVER_ERROR,
          );
        }
      } else {
        console.error('❌ Invalid chat type:', chatType);
        throw new HttpException('Invalid chat type', HttpStatus.BAD_REQUEST);
      }

      console.log('📝 Updating work order status to SUBMITTED');
      let updated;
      try {
        updated = await this.prisma.workOrder.update({
          where: { id: workOrderId },
          data: {
            status: 'SUBMITTED',
            submittedAt: new Date(),
          },
        });
        console.log('✅ Work order status updated successfully');
      } catch (error: any) {
        console.error('❌ Error updating work order:', error);
        throw new HttpException(
          `Failed to update work order: ${error?.message || 'Unknown error'}`,
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      // notify organizer (include deep-links for bid/quote pages)
      console.log(
        '🔔 Creating notification for organizer:',
        workOrder.organizerId,
      );
      const notificationMetadata: Record<string, unknown> = {
        workOrderId: workOrder.id,
        type: 'WORK_SUBMITTED',
      };
      if (workOrder.serviceBidId) {
        const bid = await this.prisma.serviceBid.findUnique({
          where: { id: workOrder.serviceBidId },
          select: {
            eventServiceId: true,
            eventService: { select: { eventId: true } },
          },
        });
        if (bid?.eventService) {
          notificationMetadata.eventServiceId = bid.eventServiceId;
          notificationMetadata.eventId = bid.eventService.eventId;
        }
      }
      if (workOrder.quoteRequestId) {
        notificationMetadata.quoteRequestId = workOrder.quoteRequestId;
      }
      const workSubmittedTitle = 'Work Submitted';
      const workSubmittedMessage =
        'Vendor has submitted work for your order. Please review and accept or request revisions. If you do nothing within 7 days, the work will be auto-accepted and the vendor will be paid automatically.';
      try {
        await this.prisma.notification.create({
          data: {
            userId: workOrder.organizerId,
            title: workSubmittedTitle,
            message: workSubmittedMessage,
            type: 'VENDOR_PROPOSAL',
            metadata: notificationMetadata as any,
          },
        });
        console.log('✅ Notification created successfully');
        this.sendNotificationEmailToUser(workOrder.organizerId, workSubmittedTitle, workSubmittedMessage);
      } catch (error: any) {
        // don't fail submit if notification fails
        console.error(
          '⚠️ Failed to create notification (non-critical):',
          error,
        );
      }

      console.log('✅ Work submitted successfully');
      return updated;
    } catch (error: any) {
      console.error('❌ Error in submitWork:', error);
      console.error('❌ Error stack:', error?.stack);
      console.error(
        '❌ Full error object:',
        JSON.stringify(error, Object.getOwnPropertyNames(error)),
      );

      if (error instanceof HttpException) {
        throw error;
      }

      const errorMessage = error?.message || 'Unknown error';
      const errorCode = error?.code || 'UNKNOWN';
      const errorMeta = error?.meta ? JSON.stringify(error.meta) : 'No meta';

      console.error('❌ Detailed error info:', {
        errorMessage,
        errorCode,
        errorMeta,
      });

      throw new HttpException(
        `Failed to submit work: ${errorMessage} (Code: ${errorCode})`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // capture payment, pay vendor, leave review
  async acceptWork(
    workOrderId: string,
    organizerId: string,
    rating: number,
    review?: string,
  ) {
    if (rating < 1 || rating > 5) {
      throw new HttpException(
        'Rating must be between 1 and 5',
        HttpStatus.BAD_REQUEST,
      );
    }

    const workOrder = await this.prisma.workOrder.findUnique({
      where: { id: workOrderId },
      include: {
        vendor: {
          select: {
            id: true,
            userId: true,
            businessName: true,
            stripeAccountId: true,
            stripeConnectEnabled: true,
          },
        },
        serviceBid: {
          select: {
            bidAmount: true,
          },
        },
        quoteRequest: {
          select: {
            finalPrice: true,
            counterOfferPrice: true,
            quotePrice: true,
          },
        },
      },
    });

    if (!workOrder) {
      throw new HttpException('Work order not found', HttpStatus.NOT_FOUND);
    }

    if (workOrder.organizerId !== organizerId) {
      throw new HttpException('Access denied', HttpStatus.FORBIDDEN);
    }

    if (workOrder.status !== 'SUBMITTED') {
      throw new HttpException(
        'Work must be submitted before acceptance',
        HttpStatus.BAD_REQUEST,
      );
    }

    // capture held payment, or confirm it already succeeded
    let paymentCaptured = false;
    let paymentIntentForAmounts:
      | import('stripe').Stripe.PaymentIntent
      | null = null;

    if (workOrder.paymentIntentId) {
      try {
        const paymentIntent = await this.stripePaymentService.getPaymentStatus(
          workOrder.paymentIntentId,
        );

        if (paymentIntent.status === 'requires_capture') {
          console.log(
            '💰 Capturing legacy escrow payment:',
            workOrder.paymentIntentId,
          );
          const capturedPayment =
            await this.stripePaymentService.capturePayment(
              workOrder.paymentIntentId,
            );

          if (capturedPayment.status !== 'succeeded') {
            throw new Error(
              `Payment capture failed. Status: ${capturedPayment.status}`,
            );
          }

          console.log(
            '✅ Payment captured successfully:',
            capturedPayment.status,
          );
          paymentCaptured = true;
          paymentIntentForAmounts = capturedPayment;
        } else if (paymentIntent.status === 'succeeded') {
          console.log(
            'ℹ️ Payment already captured (up-front payment). Status:',
            paymentIntent.status,
          );
          paymentCaptured = true;
          paymentIntentForAmounts = paymentIntent;
        } else {
          throw new Error(
            `Payment not in valid state for capture. Status: ${paymentIntent.status}`,
          );
        }
      } catch (error: any) {
        console.error('❌ Failed to capture/verify payment:', error);
        throw new HttpException(
          `Payment capture failed. Work cannot be approved until payment is successfully captured through Stripe. Error: ${error.message || 'Unknown error'}`,
          HttpStatus.BAD_REQUEST,
        );
      }
    } else {
      console.log(
        'ℹ️ No payment intent ID - work order without card payment (legacy).',
      );
    }

    // peel base + ~10% fee out of the captured total
    let baseAmount: number | null = null;
    let platformFee: number | null = null;
    let totalAmount: number | null = null;

    if (workOrder.paymentIntentId && paymentCaptured && paymentIntentForAmounts) {
      try {
        totalAmount = paymentIntentForAmounts.amount / 100;
        baseAmount = Math.round((totalAmount / 1.1) * 100) / 100;
        platformFee =
          Math.round(totalAmount * 100) - Math.round(baseAmount * 100);
        platformFee = platformFee / 100;
      } catch (error) {
        console.error(
          '❌ Failed to derive amounts from payment intent:',
          error,
        );
      }
    }

    // review + complete + fee row in one transaction
    const result = await this.prisma.$transaction(async (tx) => {
      const reviewRecord = await tx.review.create({
        data: {
          reviewerId: organizerId,
          vendorId: workOrder.vendorId,
          rating,
          comment: review,
          type: 'VENDOR',
          workOrderId: workOrder.id,
        },
      });

      const updated = await tx.workOrder.update({
        where: { id: workOrderId },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          paymentStatus:
            workOrder.paymentIntentId && paymentCaptured
              ? 'COMPLETED'
              : workOrder.paymentStatus,
        },
        include: {
          review: true,
        },
      });

      if (
        workOrder.paymentIntentId &&
        paymentCaptured &&
        baseAmount &&
        platformFee &&
        totalAmount
      ) {
        try {
          await tx.platformFee.create({
            data: {
              sourceType: 'WORK_ORDER',
              sourceId: workOrder.id,
              subtotal: baseAmount,
              feeAmount: platformFee,
              totalAmount: totalAmount,
              currency: 'USD',
              paymentIntentId: workOrder.paymentIntentId,
              status: 'AVAILABLE',
              metadata: {
                vendorId: workOrder.vendorId,
                organizerId: workOrder.organizerId,
                workOrderId: workOrder.id,
              },
            },
          });
          console.log('✅ Platform fee recorded for work order:', workOrder.id);
        } catch (feeError: any) {
          // fee log failure shouldn't roll back the accept
          console.error('❌ Failed to record platform fee:', feeError);
        }
      }

      // refresh vendor rating / completed job count
      const allReviews = await tx.review.findMany({
        where: {
          vendorId: workOrder.vendorId,
          type: 'VENDOR',
        },
      });

      const averageRating =
        allReviews.length > 0
          ? allReviews.reduce((sum, r) => sum + r.rating, 0) / allReviews.length
          : 0;

      const completedJobs = await tx.workOrder.count({
        where: {
          vendorId: workOrder.vendorId,
          status: 'COMPLETED',
        },
      });

      const vendor = await tx.vendor.findUnique({
        where: { id: workOrder.vendorId },
      });

      const winRate =
        vendor && vendor.totalBids > 0
          ? (completedJobs / vendor.totalBids) * 100
          : 0;

      await tx.vendor.update({
        where: { id: workOrder.vendorId },
        data: {
          averageRating,
          totalReviews: allReviews.length,
          completedJobs,
        },
      });

      return updated;
    });

    // transfer vendor share to their Connect account
    if (
      workOrder.paymentIntentId &&
      paymentCaptured &&
      paymentIntentForAmounts &&
      baseAmount &&
      workOrder.vendor?.stripeAccountId &&
      workOrder.vendor?.stripeConnectEnabled
    ) {
      try {
        const amountInCents = Math.round(baseAmount * 100);
        const latestChargeId =
          typeof paymentIntentForAmounts.latest_charge === 'string'
            ? (paymentIntentForAmounts.latest_charge as string)
            : null;

        console.log('💸 Transferring vendor share after work acceptance:', {
          workOrderId: workOrder.id,
          vendorId: workOrder.vendorId,
          amountInCents,
          chargeId: latestChargeId,
        });

        await this.stripePaymentService.transferToConnectAccount({
          amount: amountInCents,
          currency: paymentIntentForAmounts.currency || 'usd',
          destination: workOrder.vendor.stripeAccountId,
          metadata: {
            workOrderId: workOrder.id,
            vendorId: workOrder.vendorId,
            type: 'work_order_payout',
          },
          sourceTransaction: latestChargeId,
        });

        console.log(
          '✅ Vendor transfer created successfully for work order:',
          workOrder.id,
        );
      } catch (transferError) {
        console.error(
          '❌ Failed to transfer funds to vendor after work acceptance:',
          transferError,
        );
        // payment already captured — transfer can be retried later
      }
    }

    // notify vendor of acceptance (and payout, if any)
    const paymentMessage =
      workOrder.paymentIntentId && result.paymentStatus === 'COMPLETED'
        ? `Your work has been accepted and payment has been captured! 💰 You received a ${rating}-star rating.`
        : `Your work has been accepted! You received a ${rating}-star rating.`;
    const workAcceptedTitle =
      workOrder.paymentIntentId && result.paymentStatus === 'COMPLETED'
        ? 'Payment Received! 🎉💰'
        : 'Work Accepted! 🎉';

    await this.prisma.notification.create({
      data: {
        userId: workOrder.vendor.userId,
        title: workAcceptedTitle,
        message: paymentMessage,
        type: 'VENDOR_PROPOSAL',
        metadata: {
          workOrderId: workOrder.id,
          rating,
          type: 'WORK_ACCEPTED',
          paymentStatus: result.paymentStatus,
          paymentIntentId: workOrder.paymentIntentId || null,
        },
      },
    });
    this.sendNotificationEmailToUser(workOrder.vendor.userId, workAcceptedTitle, paymentMessage);

    return result;
  }

  // attach a late payment intent (when it wasn't set at accept time)
  async authorizePaymentForWorkOrder(
    workOrderId: string,
    organizerId: string,
    paymentIntentId: string,
  ) {
    console.log('🔍 authorizePaymentForWorkOrder - Starting:', {
      workOrderId,
      organizerId,
      paymentIntentId,
    });

    const workOrder = await this.prisma.workOrder.findUnique({
      where: { id: workOrderId },
      include: {
        vendor: {
          select: {
            id: true,
            userId: true,
            businessName: true,
          },
        },
        serviceBid: {
          select: {
            id: true,
            bidAmount: true,
            currency: true,
          },
        },
        quoteRequest: {
          select: {
            id: true,
            quotePrice: true,
          },
        },
      },
    });

    if (!workOrder) {
      console.error('❌ Work order not found:', workOrderId);
      throw new HttpException('Work order not found', HttpStatus.NOT_FOUND);
    }

    console.log('📋 Work order found:', {
      id: workOrder.id,
      organizerId: workOrder.organizerId,
      vendorId: workOrder.vendorId,
      hasServiceBid: !!workOrder.serviceBid,
      hasQuoteRequest: !!workOrder.quoteRequest,
      serviceBidAmount: workOrder.serviceBid?.bidAmount,
      quotePrice: workOrder.quoteRequest?.quotePrice,
      existingPaymentIntentId: workOrder.paymentIntentId,
    });

    if (workOrder.organizerId !== organizerId) {
      console.error('❌ Access denied - organizer mismatch:', {
        workOrderOrganizerId: workOrder.organizerId,
        providedOrganizerId: organizerId,
      });
      throw new HttpException('Access denied', HttpStatus.FORBIDDEN);
    }

    if (workOrder.paymentIntentId) {
      console.warn(
        '⚠️ Work order already has payment authorized:',
        workOrder.paymentIntentId,
      );
      throw new HttpException(
        'Work order already has payment authorized',
        HttpStatus.BAD_REQUEST,
      );
    }

    console.log('🔍 Verifying payment intent status with Stripe...');
    // only real Stripe payments — no fake/fallback intents
    const paymentIntent =
      await this.stripePaymentService.getPaymentStatus(paymentIntentId);

    console.log('📊 Payment intent status from Stripe:', {
      id: paymentIntent.id,
      status: paymentIntent.status,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      captureMethod: paymentIntent.capture_method,
    });

    if (
      paymentIntent.status !== 'requires_capture' &&
      paymentIntent.status !== 'succeeded'
    ) {
      console.error(
        '❌ Payment verification failed - invalid status:',
        paymentIntent.status,
      );
      throw new HttpException(
        `Payment verification failed. Payment must be authorized (requires_capture) or succeeded. Current status: ${paymentIntent.status}. Only real Stripe payments are accepted.`,
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!paymentIntentId.startsWith('pi_')) {
      console.error('❌ Invalid payment intent ID format:', paymentIntentId);
      throw new HttpException(
        'Invalid payment intent ID. Only real Stripe payment intents are accepted.',
        HttpStatus.BAD_REQUEST,
      );
    }

    // expected amount = bid/quote base + 10% fee (cents)
    let baseAmount: number | null = null;
    if (workOrder.serviceBid) {
      baseAmount = Number(workOrder.serviceBid.bidAmount) * 100;
    } else if (workOrder.quoteRequest?.quotePrice) {
      baseAmount = Number(workOrder.quoteRequest.quotePrice) * 100;
    }

    let expectedAmount: number | null = null;
    if (baseAmount) {
      const serviceFee = Math.round(baseAmount * 0.1);
      expectedAmount = baseAmount + serviceFee;

      console.log('💰 Amount calculation:', {
        baseAmount,
        serviceFee,
        expectedAmountWithFee: expectedAmount,
        paymentIntentAmount: paymentIntent.amount,
      });
    }

    console.log('💰 Amount verification:', {
      baseAmount,
      expectedAmountWithFee: expectedAmount,
      paymentIntentAmount: paymentIntent.amount,
      matches: expectedAmount
        ? Math.abs(paymentIntent.amount - expectedAmount) <= 1
        : 'N/A',
    });

    // allow 1¢ rounding slack
    if (expectedAmount && Math.abs(paymentIntent.amount - expectedAmount) > 1) {
      console.error(
        `❌ Payment amount mismatch. Expected (with 10% fee): ${expectedAmount}, Got: ${paymentIntent.amount}`,
      );
      throw new HttpException(
        `Payment amount mismatch. Expected: $${(expectedAmount / 100).toFixed(2)} (base: $${(baseAmount! / 100).toFixed(2)} + 10% fee), Got: $${(paymentIntent.amount / 100).toFixed(2)}. Only payments matching the exact amount are accepted.`,
        HttpStatus.BAD_REQUEST,
      );
    }

    console.log('💾 Updating work order with payment intent...');
    const updated = await this.prisma.workOrder.update({
      where: { id: workOrderId },
      data: {
        paymentIntentId,
        paymentStatus: 'PENDING', // held until work is accepted
      },
      include: {
        vendor: {
          select: {
            userId: true,
            businessName: true,
          },
        },
      },
    });

    console.log('✅ Payment authorized for work order:', {
      workOrderId,
      paymentIntentId,
      paymentStatus: updated.paymentStatus,
    });

    try {
      const amount = workOrder.serviceBid
        ? Number(workOrder.serviceBid.bidAmount)
        : workOrder.quoteRequest
          ? Number(workOrder.quoteRequest.quotePrice)
          : 0;

      console.log(
        '📧 Creating vendor notification for payment authorization:',
        {
          vendorUserId: workOrder.vendor.userId,
          amount,
          workOrderId: updated.id,
        },
      );

      const paymentAuthTitle = 'Payment Authorized! 💰';
      const paymentAuthMessage = `Payment of $${amount.toFixed(2)} has been authorized (held in escrow) for your work order. The client will release payment when they approve your work.`;
      await this.prisma.notification.create({
        data: {
          userId: workOrder.vendor.userId,
          title: paymentAuthTitle,
          message: paymentAuthMessage,
          type: 'VENDOR_PROPOSAL',
          metadata: {
            workOrderId: updated.id,
            paymentIntentId,
            amount,
            type: 'PAYMENT_AUTHORIZED',
          },
        },
      });
      this.sendNotificationEmailToUser(workOrder.vendor.userId, paymentAuthTitle, paymentAuthMessage);

      console.log('✅ Vendor notification created for payment authorization');
    } catch (notificationError) {
      console.error(
        '❌ Failed to create vendor notification:',
        notificationError,
      );
      // auth succeeded; notify failure is non-blocking
    }

    return updated;
  }

  async requestRevision(
    workOrderId: string,
    organizerId: string,
    revisionNotes?: string,
  ) {
    const workOrder = await this.prisma.workOrder.findUnique({
      where: { id: workOrderId },
      include: {
        vendor: true,
      },
    });

    if (!workOrder) {
      throw new HttpException('Work order not found', HttpStatus.NOT_FOUND);
    }

    if (workOrder.organizerId !== organizerId) {
      throw new HttpException('Access denied', HttpStatus.FORBIDDEN);
    }

    if (workOrder.status !== 'SUBMITTED') {
      throw new HttpException(
        'Work must be submitted before requesting revision',
        HttpStatus.BAD_REQUEST,
      );
    }

    const updated = await this.prisma.workOrder.update({
      where: { id: workOrderId },
      data: {
        status: 'REVISION_REQUESTED',
        revisionCount: { increment: 1 },
        revisionNotes,
        paymentStatus: workOrder.paymentIntentId
          ? 'PENDING'
          : workOrder.paymentStatus,
        // reset any prior refund state
        refundStatus: 'NONE' as any,
        refundRequestedAt: null,
        refundResolvedAt: null,
      },
    });

    const revisionTitle = 'Revision Requested';
    const revisionMessage = revisionNotes
      ? `Organizer has requested revisions: ${revisionNotes}`
      : 'Organizer has requested revisions to your work submission.';
    await this.prisma.notification.create({
      data: {
        userId: workOrder.vendor.userId,
        title: revisionTitle,
        message: revisionMessage,
        type: 'VENDOR_PROPOSAL',
        metadata: {
          workOrderId: workOrder.id,
          revisionNotes,
          type: 'REVISION_REQUESTED',
        },
      },
    });
    this.sendNotificationEmailToUser(workOrder.vendor.userId, revisionTitle, revisionMessage);

    return updated;
  }

  // refund only after ≥1 revision cycle
  async requestRefund(workOrderId: string, organizerId: string) {
    const workOrder = await this.prisma.workOrder.findUnique({
      where: { id: workOrderId },
      include: {
        vendor: true,
        organizer: true,
      },
    });

    if (!workOrder) {
      throw new HttpException('Work order not found', HttpStatus.NOT_FOUND);
    }

    if (workOrder.organizerId !== organizerId) {
      throw new HttpException('Access denied', HttpStatus.FORBIDDEN);
    }

    if (workOrder.status !== 'SUBMITTED') {
      throw new HttpException(
        'Refund can only be requested after work has been submitted for review',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (workOrder.revisionCount <= 0) {
      throw new HttpException(
        'Refund can only be requested after at least one revision has been requested',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (workOrder.refundStatus && workOrder.refundStatus !== 'NONE') {
      throw new HttpException(
        'Refund has already been requested for this work order',
        HttpStatus.BAD_REQUEST,
      );
    }

    const updated = await this.prisma.workOrder.update({
      where: { id: workOrderId },
      data: {
        refundStatus: 'REQUESTED' as any,
        refundRequestedAt: new Date(),
      },
    });

    console.log('✅ Refund requested successfully:', {
      workOrderId: updated.id,
      refundStatus: updated.refundStatus,
      refundRequestedAt: updated.refundRequestedAt,
      organizerId: updated.organizerId,
    });

    // intentionally no dual notify on refund request

    return updated;
  }

  async submitRefundProof(
    workOrderId: string,
    organizerId: string,
    message: string,
    attachments: string[] = [],
  ) {
    const workOrder = await this.prisma.workOrder.findUnique({
      where: { id: workOrderId },
      include: {
        vendor: true,
        quoteRequest: true,
        serviceBid: {
          include: {
            eventService: {
              select: {
                eventId: true,
                event: {
                  select: {
                    organizerId: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!workOrder) {
      throw new HttpException('Work order not found', HttpStatus.NOT_FOUND);
    }

    if (workOrder.organizerId !== organizerId) {
      throw new HttpException('Access denied', HttpStatus.FORBIDDEN);
    }

    if (!workOrder.refundStatus || workOrder.refundStatus === 'NONE') {
      throw new HttpException(
        'Refund must be requested before submitting proofs',
        HttpStatus.BAD_REQUEST,
      );
    }

    const proofMessage =
      (message && message.trim()) || 'Additional refund proof provided';
    const attachmentsArray = Array.isArray(attachments)
      ? attachments.filter((a) => a && a.trim())
      : [];

    // drop proofs into the matching chat (admin still sees NORMAL messages)
    if (workOrder.quoteRequestId) {
      await this.prisma.quoteMessage.create({
        data: {
          quoteRequestId: workOrder.quoteRequestId,
          senderId: organizerId,
          senderType: 'USER',
          message: proofMessage,
          attachments: attachmentsArray,
          messageType: 'NORMAL' as any,
        },
      });
    } else if (workOrder.serviceBidId && workOrder.serviceBid?.eventService) {
      await this.prisma.eventChatMessage.create({
        data: {
          eventId: workOrder.serviceBid.eventService.eventId,
          vendorId: workOrder.vendorId,
          userId: organizerId,
          senderId: organizerId,
          senderType: 'USER',
          message: proofMessage,
          attachments: attachmentsArray,
          messageType: 'NORMAL' as any,
        },
      });
    }

    return { success: true };
  }

  async getVendorWorkOrders(vendorId: string) {
    return this.prisma.workOrder.findMany({
      where: { vendorId },
      include: {
        organizer: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        quoteRequest: {
          select: {
            id: true,
            fullName: true,
            eventType: true,
            eventDate: true,
            quotePrice: true,
            finalPrice: true,
            counterOfferPrice: true,
          },
        },
        serviceBid: {
          select: {
            id: true,
            bidAmount: true,
            currency: true,
            eventService: {
              select: {
                id: true,
                title: true,
                eventId: true,
                event: {
                  select: {
                    id: true,
                    title: true,
                  },
                },
              },
            },
          },
        },
        review: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getOrganizerWorkOrders(organizerId: string) {
    return this.prisma.workOrder.findMany({
      where: { organizerId },
      include: {
        vendor: {
          select: {
            id: true,
            businessName: true,
            userId: true,
          },
        },
        quoteRequest: {
          select: {
            id: true,
            fullName: true,
            eventType: true,
            eventDate: true,
            quotePrice: true,
          },
        },
        serviceBid: {
          select: {
            id: true,
            bidAmount: true,
            currency: true,
            eventService: {
              select: {
                id: true,
                title: true,
                eventId: true,
                event: {
                  select: {
                    id: true,
                    title: true,
                  },
                },
              },
            },
          },
        },
        review: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getWorkOrderByQuoteRequest(quoteRequestId: string) {
    return this.prisma.workOrder.findUnique({
      where: { quoteRequestId },
      include: {
        vendor: {
          select: {
            id: true,
            businessName: true,
            userId: true,
          },
        },
        organizer: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });
  }

  async getWorkOrderByServiceBid(serviceBidId: string) {
    return this.prisma.workOrder.findUnique({
      where: { serviceBidId },
      include: {
        vendor: {
          select: {
            id: true,
            businessName: true,
            userId: true,
          },
        },
        organizer: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
        serviceBid: {
          include: {
            eventService: {
              include: {
                event: {
                  select: {
                    id: true,
                    title: true,
                    organizerId: true,
                  },
                },
              },
            },
          },
        },
      },
    });
  }
}
