"use client";

import { useState, useEffect, useMemo, useCallback, memo } from "react";
import { loadStripe, StripeElementsOptions } from "@stripe/stripe-js";
import { Elements, CardElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { getAuthHeaders } from "@/lib/auth-utils";
import { resolveApiBaseUrl } from "@/lib/api-base";

const stripePromise = loadStripe(
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || ""
);

interface WorkOrderPaymentCheckoutProps {
  workOrderId: string;
  amount: number; // bid or quote base (before fee)
  vendorName: string;
  customerEmail: string;
  onSuccess: () => void;
  onCancel: () => void;
}

function CheckoutForm({ 
  workOrderId, 
  amount, 
  vendorName,
  customerEmail, 
  onSuccess, 
  onCancel 
}: WorkOrderPaymentCheckoutProps) {
  const stripe = useStripe();
  const elements = useElements();
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState(customerEmail);
  const [paymentIntentClientSecret, setPaymentIntentClientSecret] = useState<string | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);

  // bail early if amount is invalid
  useEffect(() => {
    console.log('🔍 WorkOrderPaymentCheckout - Initializing:', {
      workOrderId,
      amount,
      vendorName,
      customerEmail,
      amountType: typeof amount,
      amountValue: amount,
      isValid: amount > 0
    });

    if (!amount || amount <= 0) {
      console.error('❌ Invalid amount for work order payment:', amount);
      setError(`Invalid payment amount: $${amount}. Please contact support.`);
    }
  }, [workOrderId, amount, vendorName, customerEmail]);

  const { total, fees, finalTotal } = useMemo(() => {
    const subtotal = Number(amount) || 0;
    const serviceFees = Math.round(subtotal * 0.1);
    const final = subtotal + serviceFees;
    
    console.log('💰 Amount calculation:', {
      originalAmount: amount,
      subtotal,
      serviceFees,
      finalTotal: final
    });

    if (final <= 0) {
      console.error('❌ Final total is invalid:', final);
    }

    return {
      total: subtotal,
      fees: serviceFees,
      finalTotal: final,
    };
  }, [amount]);

  const cardElementOptions = useCallback(() => ({
    hidePostalCode: true,
    style: {
      base: {
        fontSize: "16px",
        color: "#1a1a1a",
        fontFamily: "Inter, system-ui, sans-serif",
        "::placeholder": { color: "#9ca3af" },
      },
      invalid: { color: "#ef4444", iconColor: "#ef4444" },
    },
  }), []);

  useEffect(() => {
    const createAndSetPaymentIntent = async () => {
      console.log('🔄 createAndSetPaymentIntent - Starting:', {
        hasStripe: !!stripe,
        hasElements: !!elements,
        finalTotal,
        email,
        workOrderId
      });

      if (!stripe) {
        console.warn('⚠️ Stripe not loaded yet');
        return;
      }
      if (!elements) {
        console.warn('⚠️ Elements not ready yet');
        return;
      }
      if (!finalTotal || finalTotal <= 0) {
        console.error('❌ Invalid finalTotal:', finalTotal);
        setError(`Invalid payment amount: $${finalTotal}. Please contact support.`);
        return;
      }
      if (!email) {
        console.warn('⚠️ Email not provided');
        return;
      }

      setProcessing(true);
      setError(null);
      
      try {
        const API_BASE = resolveApiBaseUrl();
        const amountInCents = Math.round(finalTotal * 100);
        
        console.log('📤 Creating payment intent to platform account for work order:', {
          API_BASE,
          amountInCents,
          finalTotal,
          currency: 'usd',
          captureMethod: 'manual',
          workOrderId,
          vendorName,
          email
        });

        const response = await fetch(`${API_BASE}/payments/create-intent`, {
          method: "POST",
          headers: getAuthHeaders(),
          credentials: "include",
          body: JSON.stringify({
            amount: amountInCents, // cents, includes platform fee
            currency: "usd",
            captureMethod: 'manual', // escrow: authorize now, capture on accept
            metadata: { 
              workOrderId, 
              type: 'work_order_payment',
              vendorName,
            },
            customerEmail: email,
          }),
        });

        console.log('📥 Payment intent response status:', response.status);

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ message: "Failed to create payment intent" }));
          console.error('❌ Payment intent creation failed:', errorData);
          throw new Error(errorData.message || "Failed to create payment intent");
        }
        
        const data = await response.json();
        console.log('✅ Destination charge payment intent created successfully:', {
          hasClientSecret: !!data.clientSecret,
          hasPaymentIntentId: !!data.paymentIntentId,
          paymentIntentId: data.paymentIntentId
        });
        
        setPaymentIntentClientSecret(data.clientSecret);
        setPaymentIntentId(data.paymentIntentId);
      } catch (err: any) {
        console.error("❌ Error creating payment intent:", err);
        setError(err.message || "Failed to initialize payment. Please try again.");
      } finally {
        setProcessing(false);
      }
    };
    createAndSetPaymentIntent();
  }, [stripe, elements, finalTotal, email, workOrderId, vendorName]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    console.log('🔄 handleSubmit - Starting payment confirmation:', {
      hasStripe: !!stripe,
      hasElements: !!elements,
      hasClientSecret: !!paymentIntentClientSecret,
      hasPaymentIntentId: !!paymentIntentId,
      email
    });

    if (!stripe || !elements || !paymentIntentClientSecret || !paymentIntentId) {
      console.error('❌ Payment not initialized:', {
        stripe: !!stripe,
        elements: !!elements,
        clientSecret: !!paymentIntentClientSecret,
        paymentIntentId: !!paymentIntentId
      });
      setError("Payment not initialized. Please refresh and try again.");
      return;
    }
    if (!email || !email.includes("@")) {
      console.error('❌ Invalid email:', email);
      setError("Please enter a valid email address");
      return;
    }

    setProcessing(true);
    setError(null);

    try {
      const API_BASE = resolveApiBaseUrl();
      const cardElement = elements.getElement(CardElement);
      
      if (!cardElement) {
        console.error('❌ Card element not found');
        throw new Error("Card element not found");
      }

      console.log('💳 Confirming card payment with Stripe...');

      // confirmCardPayment authorizes; capture happens on work accept
      const { error: stripeError, paymentIntent } = await stripe.confirmCardPayment(
        paymentIntentClientSecret,
        { payment_method: { card: cardElement, billing_details: { email: email } } }
      );

      if (stripeError) {
        console.error('❌ Stripe payment error:', stripeError);
        throw new Error(stripeError.message || "Payment failed");
      }

      console.log('✅ Stripe payment confirmed:', {
        paymentIntentId: paymentIntent?.id,
        status: paymentIntent?.status,
        amount: paymentIntent?.amount
      });

      // escrow expects requires_capture; succeeded is ok for auto-capture flows
      if (paymentIntent?.status === "requires_capture" || paymentIntent?.status === "succeeded") {
        console.log("✅ Payment authorized (escrow)! Payment Intent ID:", paymentIntent.id);
        console.log("📝 Authorizing payment for work order...");

        console.log('📤 Calling authorize-payment endpoint:', {
          workOrderId,
          paymentIntentId: paymentIntent.id,
          API_BASE
        });

        const authorizeResponse = await fetch(`${API_BASE}/work-orders/${workOrderId}/authorize-payment`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            paymentIntentId: paymentIntent.id,
          }),
        });

        console.log('📥 Authorize payment response status:', authorizeResponse.status);

        if (!authorizeResponse.ok) {
          const errorData = await authorizeResponse.json().catch(() => ({ message: "Failed to authorize payment" }));
          console.error("❌ Failed to authorize payment:", errorData);
          throw new Error(errorData.message || "Failed to authorize payment for work order");
        }
        const authorizeData = await authorizeResponse.json();
        console.log("✅ Payment authorized successfully for work order:", authorizeData);
        onSuccess();
      } else {
        console.error('❌ Payment status invalid:', paymentIntent?.status);
        throw new Error(`Payment authorization failed. Status: ${paymentIntent?.status}`);
      }
    } catch (err: any) {
      console.error("❌ Payment error:", err);
      setError(err.message || "Payment failed. Please try again.");
    } finally {
      setProcessing(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
        <p className="text-sm text-blue-800">
          <strong>Escrow Payment:</strong> Your payment will be authorized (held) but not charged until you accept the completed work.
        </p>
      </div>

      <div>
        <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-2">
          Email Address
        </label>
        <input
          type="email"
          id="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          placeholder="your@email.com"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Card Details
        </label>
        <div className="px-4 py-3 border border-gray-300 rounded-lg bg-white">
          <CardElement options={cardElementOptions()} />
        </div>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      <div className="flex gap-3">
        <button
          type="button"
          onClick={onCancel}
          disabled={processing}
          className="flex-1 px-4 py-3 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={processing || !stripe || !paymentIntentClientSecret}
          className="flex-1 px-4 py-3 bg-[#D4AF37] text-white rounded-lg hover:bg-[#B8941F] transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-semibold"
        >
          {processing ? "Processing..." : `Authorize Payment $${finalTotal.toFixed(2)}`}
        </button>
      </div>
    </form>
  );
}

const WorkOrderPaymentCheckoutComponent = memo(function WorkOrderPaymentCheckout(props: WorkOrderPaymentCheckoutProps) {
  const totalAmount = useMemo(() => {
    const subtotal = Number(props.amount) || 0;
    const fees = Math.round(subtotal * 0.1);
    const total = Math.round((subtotal + fees) * 100);
    
    console.log('🔍 WorkOrderPaymentCheckout - Calculating total amount:', {
      propsAmount: props.amount,
      subtotal,
      fees,
      totalAmount: total,
      isValid: total > 0
    });

    if (total <= 0) {
      console.error('❌ Invalid total amount for Stripe Elements:', total);
    }

    return total;
  }, [props.amount]);

  const options: StripeElementsOptions = useMemo(() => {
    console.log('🔍 Stripe Elements options:', {
      mode: "payment",
      amount: totalAmount,
      currency: "usd",
      isValid: totalAmount > 0
    });

    if (totalAmount <= 0) {
      console.error('❌ Cannot create Stripe Elements with invalid amount:', totalAmount);
    }

    return {
      mode: "payment",
      amount: totalAmount,
      currency: "usd",
    };
  }, [totalAmount]);

  if (totalAmount <= 0) {
    console.error('❌ WorkOrderPaymentCheckout - Invalid amount, not rendering');
    return (
      <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
        <p className="font-semibold">Payment Error</p>
        <p>Invalid payment amount: ${props.amount}</p>
        <p className="text-sm mt-2">Please contact support to resolve this issue.</p>
      </div>
    );
  }

  return (
    <Elements stripe={stripePromise} options={options}>
      <CheckoutForm {...props} />
    </Elements>
  );
});

export default WorkOrderPaymentCheckoutComponent;

