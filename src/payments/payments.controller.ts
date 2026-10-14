import {
  Controller,
  Post,
  Body,
  Get,
  Param,
  Headers,
  Req,
  UseGuards,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { StripePaymentService } from './stripe-payment.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import Stripe from 'stripe';

@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly stripePaymentService: StripePaymentService,
    private readonly prisma: PrismaService,
  ) {}

  // vendor jobs → platform; event tickets may use Connect destination charges
  @Post('create-intent')
  @UseGuards(JwtAuthGuard)
  async createPaymentIntent(
    @Body()
    body: {
      amount: number;
      currency?: string;
      metadata?: Record<string, string>;
      customerEmail?: string;
      captureMethod?: 'automatic' | 'manual';
      destinationAccountId?: string;
      useDestinationCharge?: boolean;
    },
    @Req() req: any,
  ) {
    try {
      console.log('📥 POST /payments/create-intent - Request received:', {
        amount: body.amount,
        captureMethod: body.captureMethod,
        metadata: body.metadata,
        userId: req.user?.id,
      });

      if (!body.amount || body.amount <= 0) {
        console.error('❌ Invalid amount:', body.amount);
        throw new HttpException(
          'Amount is required and must be greater than 0',
          HttpStatus.BAD_REQUEST,
        );
      }

      // amount is already cents; Stripe floor is $0.50
      const amountInCents = Math.round(body.amount);

      if (amountInCents < 50) {
        console.error(
          '❌ Amount too small:',
          amountInCents,
          'cents (minimum is 50 cents = $0.50)',
        );
        throw new HttpException(
          'Amount must be at least $0.50 USD',
          HttpStatus.BAD_REQUEST,
        );
      }

      // vendor job if metadata has work-order / quote / bid signals
      const isVendorPayment =
        body.metadata?.type === 'work_order_payment' ||
        body.metadata?.type === 'service_bid_acceptance' ||
        body.metadata?.type === 'quote_acceptance' ||
        !!body.metadata?.workOrderId ||
        !!body.metadata?.quoteId ||
        !!body.metadata?.quoteRequestId ||
        !!body.metadata?.bidId;

      const isOrganizerPayment =
        body.metadata?.eventId && !isVendorPayment;

      if (isVendorPayment) {
        // charge platform now; transfer to vendor after work acceptance
        console.log(
          '💰 Creating platform payment intent for vendor job (separate later transfer to vendor).',
        );

        const result = await this.stripePaymentService.createPaymentIntent({
          amount: amountInCents,
          currency: body.currency || 'usd',
          metadata: {
            ...body.metadata,
            userId: req.user?.id || '',
            settlementType: 'SEPARATE_CHARGE_AND_TRANSFER',
          },
          customerEmail: body.customerEmail,
          captureMethod: 'automatic',
        });

        console.log('✅ Vendor platform payment intent created:', {
          hasClientSecret: !!result.clientSecret,
          hasPaymentIntentId: !!result.paymentIntentId,
          paymentIntentId: result.paymentIntentId,
        });

        return {
          clientSecret: result.clientSecret,
          paymentIntentId: result.paymentIntentId,
        };
      } else if (isOrganizerPayment) {
        console.log('💰 Creating destination charge for organizer payment');

        let organizerStripeAccountId: string | null = null;

        if (body.metadata?.eventId) {
          const event = await this.prisma.event.findUnique({
            where: { id: body.metadata.eventId },
            include: {
              organizer: {
                select: {
                  stripeAccountId: true,
                  stripeConnectEnabled: true,
                },
              },
            },
          });
          if (
            event?.organizer?.stripeAccountId &&
            event.organizer.stripeConnectEnabled
          ) {
            organizerStripeAccountId = event.organizer.stripeAccountId;
          }
        }

        if (!organizerStripeAccountId) {
          console.warn(
            '⚠️ Organizer does not have Stripe Connect account. Falling back to platform payment.',
          );
          const result = await this.stripePaymentService.createPaymentIntent({
            amount: amountInCents,
            currency: body.currency || 'usd',
            metadata: {
              ...body.metadata,
              userId: req.user?.id || '',
            },
            customerEmail: body.customerEmail,
            captureMethod: body.captureMethod || 'automatic',
          });
          return {
            clientSecret: result.clientSecret,
            paymentIntentId: result.paymentIntentId,
          };
        }

        // amount already includes ~10% platform fee
        const subtotalInCents = Math.round(amountInCents / 1.1);
        const platformFeeInCents = amountInCents - subtotalInCents;

        console.log('💰 Destination charge calculation for organizer:', {
          totalAmount: amountInCents,
          subtotal: subtotalInCents,
          platformFee: platformFeeInCents,
          organizerAccountId: organizerStripeAccountId,
        });

        const result =
          await this.stripePaymentService.createDestinationChargeIntent({
            amount: amountInCents,
            applicationFeeAmount: platformFeeInCents,
            destination: organizerStripeAccountId,
            currency: body.currency || 'usd',
            metadata: {
              ...body.metadata,
              userId: req.user?.id || '',
              type: 'event_booking',
            },
            customerEmail: body.customerEmail,
            captureMethod: body.captureMethod || 'automatic',
          });

        console.log('✅ Destination charge created successfully for organizer:', {
          hasClientSecret: !!result.clientSecret,
          hasPaymentIntentId: !!result.paymentIntentId,
          paymentIntentId: result.paymentIntentId,
        });

        return {
          clientSecret: result.clientSecret,
          paymentIntentId: result.paymentIntentId,
        };
      } else {
        console.log('💰 Creating payment intent to platform account:', {
          amountInCents,
          currency: body.currency || 'usd',
          captureMethod: body.captureMethod || 'automatic',
          metadata: {
            ...body.metadata,
            userId: req.user?.id || '',
          },
        });

        const result = await this.stripePaymentService.createPaymentIntent({
          amount: amountInCents,
          currency: body.currency || 'usd',
          metadata: {
            ...body.metadata,
            userId: req.user?.id || '',
          },
          customerEmail: body.customerEmail,
          captureMethod: body.captureMethod || 'automatic',
        });

        console.log('✅ Payment intent created successfully:', {
          hasClientSecret: !!result.clientSecret,
          hasPaymentIntentId: !!result.paymentIntentId,
          paymentIntentId: result.paymentIntentId,
        });

        return {
          clientSecret: result.clientSecret,
          paymentIntentId: result.paymentIntentId,
        };
      }
    } catch (error: any) {
      console.error('❌ Error creating payment intent:', error);
      throw new HttpException(
        error.message || 'Failed to create payment intent',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('confirm')
  @UseGuards(JwtAuthGuard)
  async confirmPayment(@Body() body: { paymentIntentId: string }) {
    try {
      if (!body.paymentIntentId) {
        throw new HttpException(
          'paymentIntentId is required',
          HttpStatus.BAD_REQUEST,
        );
      }

      const paymentIntent = await this.stripePaymentService.confirmPayment(
        body.paymentIntentId,
      );
      return {
        status: paymentIntent.status,
        paymentIntentId: paymentIntent.id,
      };
    } catch (error: any) {
      console.error('Error confirming payment:', error);
      throw new HttpException(
        error.message || 'Failed to confirm payment',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('status/:paymentIntentId')
  @UseGuards(JwtAuthGuard)
  async getPaymentStatus(@Param('paymentIntentId') paymentIntentId: string) {
    try {
      const paymentIntent =
        await this.stripePaymentService.getPaymentStatus(paymentIntentId);
      return {
        status: paymentIntent.status,
        amount: paymentIntent.amount,
        currency: paymentIntent.currency,
        paymentIntentId: paymentIntent.id,
      };
    } catch (error: any) {
      console.error('Error getting payment status:', error);
      throw new HttpException(
        error.message || 'Failed to get payment status',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // Stripe webhook — verify signature when STRIPE_WEBHOOK_SECRET is set
  @Post('webhook')
  async handleWebhook(
    @Headers('stripe-signature') signature: string,
    @Req() req: any,
  ) {
    try {
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!webhookSecret) {
        console.warn(
          '⚠️ STRIPE_WEBHOOK_SECRET is not set. Webhook verification skipped.',
        );
        if (process.env.NODE_ENV === 'production') {
          throw new HttpException(
            'Webhook secret not configured',
            HttpStatus.INTERNAL_SERVER_ERROR,
          );
        }
      }

      let event: Stripe.Event;

      if (webhookSecret) {
        event = this.stripePaymentService['stripe'].webhooks.constructEvent(
          req.body,
          signature,
          webhookSecret,
        );
      } else {
        event = req.body;
      }

      await this.stripePaymentService.handleWebhook(event);

      return { received: true };
    } catch (error: any) {
      console.error('Error handling webhook:', error);
      throw new HttpException(
        error.message || 'Webhook handling failed',
        HttpStatus.BAD_REQUEST,
      );
    }
  }
}
