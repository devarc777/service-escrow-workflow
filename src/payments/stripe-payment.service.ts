import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import Stripe from 'stripe';

@Injectable()
export class StripePaymentService {
  private stripe: Stripe;

  constructor(private prisma: PrismaService) {
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';
    if (!stripeSecretKey) {
      console.warn(
        '⚠️ STRIPE_SECRET_KEY is not set. Payment functionality will not work.',
      );
    }
    this.stripe = new Stripe(stripeSecretKey);
  }

  // manual capture = authorize/hold (escrow)
  async createPaymentIntent(params: {
    amount: number;
    currency?: string;
    metadata?: Record<string, string>;
    customerEmail?: string;
    captureMethod?: 'automatic' | 'manual';
  }): Promise<{ clientSecret: string; paymentIntentId: string }> {
    try {
      console.log('🔧 StripePaymentService.createPaymentIntent - Starting:', {
        amount: params.amount,
        currency: params.currency,
        captureMethod: params.captureMethod,
        hasMetadata: !!params.metadata,
        customerEmail: params.customerEmail,
      });

      if (!params.amount || params.amount <= 0) {
        console.error('❌ Invalid amount:', params.amount);
        throw new Error('Amount must be greater than 0');
      }

      const paymentIntentParams: Stripe.PaymentIntentCreateParams = {
        amount: params.amount,
        currency: params.currency || 'usd',
        metadata: params.metadata || {},
        receipt_email: params.customerEmail,
        automatic_payment_methods: {
          enabled: true,
        },
      };

      if (params.captureMethod === 'manual') {
        paymentIntentParams.capture_method = 'manual';
        console.log('🔒 Using manual capture (escrow mode)');
      }

      console.log('📤 Calling Stripe API to create payment intent...');
      const paymentIntent =
        await this.stripe.paymentIntents.create(paymentIntentParams);

      console.log('✅ Stripe payment intent created:', {
        id: paymentIntent.id,
        status: paymentIntent.status,
        amount: paymentIntent.amount,
        currency: paymentIntent.currency,
        captureMethod: paymentIntent.capture_method,
        hasClientSecret: !!paymentIntent.client_secret,
      });

      return {
        clientSecret: paymentIntent.client_secret || '',
        paymentIntentId: paymentIntent.id,
      };
    } catch (error: any) {
      console.error('❌ Error creating payment intent:', error);
      console.error('Error details:', {
        message: error.message,
        type: error.type,
        code: error.code,
      });
      throw error;
    }
  }

  // destination charge: funds + application fee to a Connect account
  async createDestinationChargeIntent(params: {
    amount: number;
    applicationFeeAmount: number;
    destination: string;
    currency?: string;
    metadata?: Record<string, string>;
    customerEmail?: string;
    captureMethod?: 'automatic' | 'manual';
  }): Promise<{ clientSecret: string; paymentIntentId: string }> {
    try {
      console.log('🔧 Creating destination charge payment intent:', {
        amount: params.amount,
        applicationFeeAmount: params.applicationFeeAmount,
        destination: params.destination,
        captureMethod: params.captureMethod,
      });

      if (!params.amount || params.amount <= 0) {
        throw new Error('Amount must be greater than 0');
      }

      if (!params.destination) {
        throw new Error('Destination account ID is required');
      }

      const paymentIntentParams: Stripe.PaymentIntentCreateParams = {
        amount: params.amount,
        currency: params.currency || 'usd',
        application_fee_amount: params.applicationFeeAmount,
        on_behalf_of: params.destination,
        transfer_data: {
          destination: params.destination,
        },
        metadata: params.metadata || {},
        receipt_email: params.customerEmail,
        automatic_payment_methods: {
          enabled: true,
        },
      };

      if (params.captureMethod === 'manual') {
        paymentIntentParams.capture_method = 'manual';
        console.log('🔒 Using manual capture (escrow mode)');
      }

      console.log('📤 Calling Stripe API to create destination charge...');
      const paymentIntent =
        await this.stripe.paymentIntents.create(paymentIntentParams);

      console.log('✅ Destination charge created:', {
        id: paymentIntent.id,
        status: paymentIntent.status,
        amount: paymentIntent.amount,
        applicationFeeAmount: paymentIntent.application_fee_amount,
        destination: paymentIntent.transfer_data?.destination,
      });

      return {
        clientSecret: paymentIntent.client_secret || '',
        paymentIntentId: paymentIntent.id,
      };
    } catch (error: any) {
      console.error('❌ Error creating destination charge:', error);
      throw error;
    }
  }

  async confirmPayment(paymentIntentId: string): Promise<Stripe.PaymentIntent> {
    try {
      const paymentIntent =
        await this.stripe.paymentIntents.retrieve(paymentIntentId);

      if (paymentIntent.status === 'succeeded') {
        return paymentIntent;
      }

      const confirmed =
        await this.stripe.paymentIntents.confirm(paymentIntentId);
      return confirmed;
    } catch (error) {
      console.error('Error confirming payment:', error);
      throw error;
    }
  }

  async getPaymentStatus(
    paymentIntentId: string,
  ): Promise<Stripe.PaymentIntent> {
    try {
      console.log('🔍 Retrieving payment intent from Stripe:', paymentIntentId);

      if (!paymentIntentId || typeof paymentIntentId !== 'string') {
        throw new Error('Invalid payment intent ID provided');
      }

      if (!paymentIntentId.startsWith('pi_')) {
        throw new Error(
          `Invalid payment intent ID format. Expected format: pi_xxxxx, got: ${paymentIntentId.substring(0, 10)}...`,
        );
      }

      const paymentIntent =
        await this.stripe.paymentIntents.retrieve(paymentIntentId);

      console.log('✅ Payment intent retrieved successfully:', {
        id: paymentIntent.id,
        status: paymentIntent.status,
        amount: paymentIntent.amount,
        currency: paymentIntent.currency,
      });

      return paymentIntent;
    } catch (error: any) {
      console.error('❌ Error retrieving payment status:', {
        paymentIntentId,
        error: error.message,
        type: error.type,
        code: error.code,
        statusCode: error.statusCode,
      });

      if (error.type === 'StripeInvalidRequestError') {
        if (error.code === 'resource_missing') {
          throw new Error(
            `Payment intent not found: ${paymentIntentId}. The payment may not have been created properly.`,
          );
        }
        throw new Error(`Invalid payment intent: ${error.message}`);
      }

      throw error;
    }
  }

  // capture a held PaymentIntent (requires_capture)
  async capturePayment(paymentIntentId: string): Promise<Stripe.PaymentIntent> {
    try {
      const paymentIntent =
        await this.stripe.paymentIntents.retrieve(paymentIntentId);

      if (paymentIntent.status === 'succeeded') {
        console.log('✅ Payment already captured:', paymentIntentId);
        return paymentIntent;
      }

      if (paymentIntent.status !== 'requires_capture') {
        throw new Error(
          `Cannot capture payment. Payment intent status is ${paymentIntent.status}. Expected: requires_capture`,
        );
      }

      const capturedPayment =
        await this.stripe.paymentIntents.capture(paymentIntentId);

      if (capturedPayment.status !== 'succeeded') {
        throw new Error(
          `Payment capture failed. Status: ${capturedPayment.status}. Expected: succeeded`,
        );
      }

      console.log('✅ Payment captured successfully:', paymentIntentId);
      return capturedPayment;
    } catch (error: any) {
      console.error('❌ Error capturing payment:', error);
      throw new Error(
        error.message || `Failed to capture payment: ${paymentIntentId}`,
      );
    }
  }

  // cancel an authorized hold instead of capturing
  async cancelPaymentIntent(
    paymentIntentId: string,
  ): Promise<Stripe.PaymentIntent> {
    try {
      console.log('🔍 Canceling payment intent in Stripe:', paymentIntentId);
      const canceledIntent =
        await this.stripe.paymentIntents.cancel(paymentIntentId);

      console.log('✅ Payment intent canceled:', {
        id: canceledIntent.id,
        status: canceledIntent.status,
        amount: canceledIntent.amount,
        currency: canceledIntent.currency,
      });

      return canceledIntent;
    } catch (error: any) {
      console.error('❌ Error canceling payment intent:', {
        paymentIntentId,
        error: error.message,
        type: error.type,
        code: error.code,
        statusCode: error.statusCode,
      });
      throw new Error(
        error.message || `Failed to cancel payment intent: ${paymentIntentId}`,
      );
    }
  }

  async refundPayment(
    paymentIntentId: string,
    amount?: number,
  ): Promise<Stripe.Refund> {
    try {
      const refundParams: Stripe.RefundCreateParams = {
        payment_intent: paymentIntentId,
      };

      if (amount) {
        refundParams.amount = amount;
      }

      return await this.stripe.refunds.create(refundParams);
    } catch (error) {
      console.error('Error refunding payment:', error);
      throw error;
    }
  }

  async handleWebhook(event: Stripe.Event): Promise<void> {
    try {
      switch (event.type) {
        case 'payment_intent.succeeded':
          await this.handlePaymentSuccess(event.data.object);
          break;
        case 'payment_intent.payment_failed':
          await this.handlePaymentFailure(event.data.object);
          break;
        case 'payment_intent.canceled':
          await this.handlePaymentCanceled(event.data.object);
          break;
        case 'payout.paid':
        case 'payout.failed':
        case 'payout.canceled':
          await this.handlePayoutUpdate(event.data.object, event.type);
          break;
        default:
          console.log(`Unhandled webhook event type: ${event.type}`);
      }
    } catch (error) {
      console.error('Error handling webhook:', error);
      throw error;
    }
  }

  private async handlePayoutUpdate(
    payout: Stripe.Payout,
    eventType: string,
  ): Promise<void> {
    try {
      const payoutRecord = await this.prisma.payout.findFirst({
        where: {
          stripePayoutId: payout.id,
        },
        include: {
          vendor: {
            select: {
              stripeAccountId: true,
            },
          },
          organizer: {
            select: {
              stripeAccountId: true,
            },
          },
        },
      });

      if (!payoutRecord) {
        console.log('Payout record not found for Stripe payout:', payout.id);
        return;
      }

      let status: 'PENDING' | 'PROCESSING' | 'PAID' | 'FAILED' | 'CANCELED' =
        'PENDING';
      if (eventType === 'payout.paid') {
        status = 'PAID';
      } else if (eventType === 'payout.failed') {
        status = 'FAILED';
      } else if (eventType === 'payout.canceled') {
        status = 'CANCELED';
      }

      await this.prisma.payout.update({
        where: { id: payoutRecord.id },
        data: {
          status,
          paidAt:
            status === 'PAID' && payout.arrival_date
              ? new Date(payout.arrival_date * 1000)
              : null,
          failureCode: payout.failure_code || null,
          failureMessage: payout.failure_message || null,
        },
      });

      const payoutType = payoutRecord.vendorId ? 'vendor' : 'organizer';
      console.log(
        `✅ ${payoutType} payout ${payout.id} status updated to ${status}`,
      );
    } catch (error) {
      console.error('Error handling payout update:', error);
    }
  }

  private async handlePaymentSuccess(
    paymentIntent: Stripe.PaymentIntent,
  ): Promise<void> {
    const bookingId = paymentIntent.metadata?.bookingId;
    const workOrderId = paymentIntent.metadata?.workOrderId;
    const paymentType = paymentIntent.metadata?.type;

    // work-order payments: mark COMPLETED when Stripe says succeeded
    if (paymentType === 'work_order_payment' && workOrderId) {
      try {
        const workOrder = await this.prisma.workOrder.findFirst({
          where: { paymentIntentId: paymentIntent.id },
        });

        if (workOrder) {
          if (workOrder.paymentStatus !== 'COMPLETED') {
            await this.prisma.workOrder.update({
              where: { id: workOrder.id },
              data: {
                paymentStatus: 'COMPLETED',
              },
            });
            console.log(`✅ Payment succeeded for work order ${workOrder.id}`);
          } else {
            console.log(
              `ℹ️ Work order ${workOrder.id} already has COMPLETED payment status`,
            );
          }
        } else {
          console.log(
            `⚠️ Work order not found for payment intent ${paymentIntent.id}`,
          );
        }
      } catch (error) {
        console.error(
          'Error updating work order after payment success:',
          error,
        );
      }
      return;
    }

    // legacy event-ticket bookings
    if (bookingId) {
      try {
        await this.prisma.booking.update({
          where: { id: bookingId },
          data: {
            paymentStatus: 'COMPLETED',
            paymentId: paymentIntent.id,
            paymentMethod: paymentIntent.payment_method_types[0] || 'card',
            status: 'CONFIRMED',
            confirmedAt: new Date(),
          },
        });

        console.log(`✅ Payment succeeded for booking ${bookingId}`);
      } catch (error) {
        console.error('Error updating booking after payment success:', error);
      }
      return;
    }

    console.log('No bookingId or workOrderId in payment intent metadata');
  }

  private async handlePaymentFailure(
    paymentIntent: Stripe.PaymentIntent,
  ): Promise<void> {
    const bookingId = paymentIntent.metadata?.bookingId;
    if (!bookingId) {
      return;
    }

    try {
      await this.prisma.booking.update({
        where: { id: bookingId },
        data: {
          paymentStatus: 'FAILED',
          paymentId: paymentIntent.id,
        },
      });

      console.log(`❌ Payment failed for booking ${bookingId}`);
    } catch (error) {
      console.error('Error updating booking after payment failure:', error);
    }
  }

  private async handlePaymentCanceled(
    paymentIntent: Stripe.PaymentIntent,
  ): Promise<void> {
    const bookingId = paymentIntent.metadata?.bookingId;
    if (!bookingId) {
      return;
    }

    try {
      await this.prisma.booking.update({
        where: { id: bookingId },
        data: {
          paymentStatus: 'FAILED',
          paymentId: paymentIntent.id,
          status: 'CANCELLED',
        },
      });

      console.log(`🚫 Payment canceled for booking ${bookingId}`);
    } catch (error) {
      console.error(
        'Error updating booking after payment cancellation:',
        error,
      );
    }
  }

  async createConnectAccount(params: {
    email: string;
    country?: string;
    businessType?: 'individual' | 'company';
    businessName?: string;
  }): Promise<Stripe.Account> {
    try {
      console.log('🔧 Creating Stripe Connect Express account:', params);

      const accountParams: Stripe.AccountCreateParams = {
        type: 'express',
        country: params.country || 'US',
        email: params.email,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
      };

      if (params.businessType) {
        accountParams.business_type = params.businessType;
      }

      if (params.businessName) {
        accountParams.business_profile = {
          name: params.businessName,
        };
      }

      const account = await this.stripe.accounts.create(accountParams);
      console.log('✅ Stripe Connect account created:', account.id);
      return account;
    } catch (error: any) {
      console.error('❌ Error creating Stripe Connect account:', error);
      throw error;
    }
  }

  async createAccountLink(
    accountId: string,
    refreshUrl: string,
    returnUrl: string,
  ): Promise<Stripe.AccountLink> {
    try {
      console.log('🔗 Creating account link for:', accountId);

      const accountLink = await this.stripe.accountLinks.create({
        account: accountId,
        refresh_url: refreshUrl,
        return_url: returnUrl,
        type: 'account_onboarding',
      });

      console.log('✅ Account link created:', accountLink.url);
      return accountLink;
    } catch (error: any) {
      console.error('❌ Error creating account link:', error);
      throw error;
    }
  }

  async getAccountStatus(accountId: string): Promise<Stripe.Account> {
    try {
      const account = await this.stripe.accounts.retrieve(accountId);
      return account;
    } catch (error: any) {
      console.error('❌ Error retrieving account status:', error);
      throw error;
    }
  }

  // skip if we already transferred for this work order
  async findConnectTransferForWorkOrder(params: {
    destination: string;
    workOrderId: string;
  }): Promise<Stripe.Transfer | null> {
    try {
      const transfers = await this.stripe.transfers.list({
        destination: params.destination,
        limit: 100,
      });
      for (const t of transfers.data) {
        const wid = t.metadata?.workOrderId;
        const typ = t.metadata?.type;
        if (
          wid === params.workOrderId &&
          (typ === 'work_order_payout' ||
            typ === 'refund_rejected_vendor_payout')
        ) {
          return t;
        }
      }
    } catch (error: any) {
      console.error(
        '❌ Error listing transfers for work order deduplication:',
        error,
      );
    }
    return null;
  }

  // platform balance → vendor Connect account
  async transferToConnectAccount(params: {
    amount: number;
    currency?: string;
    destination: string;
    metadata?: Record<string, string>;
    sourceTransaction?: string | null;
  }): Promise<Stripe.Transfer> {
    try {
      console.log('💸 Transferring to Connect account:', {
        amount: params.amount,
        destination: params.destination,
      });

      const transferParams: Stripe.TransferCreateParams = {
        amount: params.amount,
        currency: params.currency || 'usd',
        destination: params.destination,
        metadata: params.metadata || {},
      };

      // ties the transfer to the original charge in Stripe's UI
      if (params.sourceTransaction) {
        (transferParams as any).source_transaction = params.sourceTransaction;
      }

      const transfer = await this.stripe.transfers.create(transferParams);

      console.log('✅ Transfer created:', transfer.id);
      return transfer;
    } catch (error: any) {
      console.error('❌ Error transferring to Connect account:', error);
      throw error;
    }
  }

  // Connect balance → vendor's bank account
  async createPayout(params: {
    amount: number;
    currency?: string;
    accountId: string;
    metadata?: Record<string, string>;
  }): Promise<Stripe.Payout> {
    try {
      console.log('💰 Creating payout:', {
        amount: params.amount,
        accountId: params.accountId,
      });

      const payout = await this.stripe.payouts.create(
        {
          amount: params.amount,
          currency: params.currency || 'usd',
          metadata: params.metadata || {},
        },
        {
          stripeAccount: params.accountId,
        },
      );

      console.log('✅ Payout created:', payout.id);
      return payout;
    } catch (error: any) {
      console.error('❌ Error creating payout:', error);
      throw error;
    }
  }

  async getPayoutStatus(
    payoutId: string,
    accountId: string,
  ): Promise<Stripe.Payout> {
    try {
      const payout = await this.stripe.payouts.retrieve(payoutId, {
        stripeAccount: accountId,
      });
      return payout;
    } catch (error: any) {
      console.error('❌ Error retrieving payout status:', error);
      throw error;
    }
  }

  async getBalance(): Promise<Stripe.Balance> {
    try {
      const balance = await this.stripe.balance.retrieve();
      return balance;
    } catch (error: any) {
      console.error('❌ Error retrieving balance:', error);
      throw error;
    }
  }

  async getConnectAccountBalance(accountId: string): Promise<Stripe.Balance> {
    try {
      const balance = await this.stripe.balance.retrieve({
        stripeAccount: accountId,
      });
      return balance;
    } catch (error: any) {
      console.error('❌ Error retrieving Connect account balance:', error);
      throw error;
    }
  }

  async createPlatformPayout(params: {
    amount: number;
    currency?: string;
    metadata?: Record<string, string>;
  }): Promise<Stripe.Payout> {
    try {
      console.log('💰 Creating platform payout:', {
        amount: params.amount,
        currency: params.currency || 'usd',
      });

      const payout = await this.stripe.payouts.create({
        amount: params.amount,
        currency: params.currency || 'usd',
        metadata: params.metadata || {},
      });

      console.log('✅ Platform payout created:', {
        id: payout.id,
        status: payout.status,
        amount: payout.amount,
        arrivalDate: payout.arrival_date,
      });
      return payout;
    } catch (error: any) {
      console.error('❌ Error creating platform payout:', {
        message: error.message,
        type: error.type,
        code: error.code,
        statusCode: error.statusCode,
        decline_code: error.decline_code,
        param: error.param,
      });
      throw error;
    }
  }
}
