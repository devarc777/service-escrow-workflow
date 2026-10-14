"use client";

import { useState, useEffect, useMemo, useCallback, memo } from "react";
import { loadStripe, StripeElementsOptions } from "@stripe/stripe-js";
import { Elements, CardElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { useRouter } from "next/navigation";
import { getAuthHeaders } from "@/lib/auth-utils";
import { resolveApiBaseUrl } from "@/lib/api-base";

const stripePromise = loadStripe(
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || ""
);

interface QuoteAcceptanceCheckoutProps {
  quoteId: string;
  quoteAmount: number;
  vendorName: string;
  customerEmail: string;
  onSuccess: () => void;
  onCancel: () => void;
}

function CheckoutForm({ 
  quoteId, 
  quoteAmount, 
  vendorName,
  customerEmail, 
  onSuccess, 
  onCancel 
}: QuoteAcceptanceCheckoutProps) {
  const stripe = useStripe();
  const elements = useElements();
  const router = useRouter();
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState(customerEmail);
  const [paymentIntentClientSecret, setPaymentIntentClientSecret] = useState<string | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);

  const { total, fees, finalTotal } = useMemo(() => {
    // Ensure quoteAmount is converted to a number
    const subtotal = typeof quoteAmount === 'number' ? quoteAmount : parseFloat(String(quoteAmount)) || 0;
    const serviceFees = Math.round(subtotal * 0.1);
    return {
      total: subtotal,
      fees: serviceFees,
      finalTotal: subtotal + serviceFees,
    };
  }, [quoteAmount]);

  const cardElementOptions = useCallback(() => ({
    style: {
      base: {
        fontSize: "16px",
        color: "#1a1a1a",
        fontFamily: "Inter, system-ui, sans-serif",
        "::placeholder": { color: "#9ca3af" },
      },
      invalid: { color: "#ef4444", iconColor: "#ef4444" },
    },
    hidePostalCode: true,
  }), []);

  useEffect(() => {
    const createAndSetPaymentIntent = async () => {
      if (!stripe || !elements || !finalTotal || !email) return;
      setProcessing(true);
      setError(null);
      try {
        const API_BASE = resolveApiBaseUrl();
        const amountInCents = Math.round(finalTotal * 100);
        
        console.log('📤 Creating payment intent to platform account for quote:', {
          API_BASE,
          amountInCents,
          finalTotal,
          currency: 'usd',
          captureMethod: 'manual',
          quoteId,
          vendorName,
          email
        });

        const response = await fetch(`${API_BASE}/payments/create-intent`, {
          method: "POST",
          headers: getAuthHeaders(),
          credentials: "include",
          body: JSON.stringify({
            amount: amountInCents, // Amount in cents (total including platform fee)
            currency: "usd",
            captureMethod: 'manual', // ESCROW MODE - authorize but don't capture
            metadata: { 
              quoteId, 
              type: 'quote_acceptance',
              vendorName,
            },
            customerEmail: email,
          }),
        });
        
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ message: "Failed to create payment intent" }));
          console.error('❌ Payment intent creation failed:', errorData);
          throw new Error(errorData.message || "Failed to create payment intent");
        }
        
        const data = await response.json();
        console.log('✅ Payment intent created successfully (platform account):', {
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
  }, [stripe, elements, finalTotal, email, quoteId, vendorName]);


  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements || !paymentIntentClientSecret || !paymentIntentId) {
      setError("Payment not initialized. Please refresh and try again.");
      return;
    }
    if (!email || !email.includes("@")) {
      setError("Please enter a valid email address");
      return;
    }

    setProcessing(true);
    setError(null);

    try {
      const API_BASE = resolveApiBaseUrl();
      const cardElement = elements.getElement(CardElement);
      if (!cardElement) { throw new Error("Card element not found"); }

      // Confirm payment - this will AUTHORIZE but not CAPTURE (escrow)
      const { error: stripeError, paymentIntent } = await stripe.confirmCardPayment(
        paymentIntentClientSecret,
        { payment_method: { card: cardElement, billing_details: { email: email } } }
      );

      if (stripeError) { throw new Error(stripeError.message || "Payment failed"); }

      // For escrow, payment should be 'requires_capture' (authorized but not captured)
      if (paymentIntent?.status === "requires_capture" || paymentIntent?.status === "succeeded") {
        console.log("✅ Payment authorized (escrow)! Payment Intent ID:", paymentIntent.id);
        console.log("📝 Accepting quote with escrow payment...");
        
        // Accept quote with payment intent ID
        const acceptResponse = await fetch(`${API_BASE}/quote-requests/${quoteId}/respond`, {
          method: "POST",
          headers: getAuthHeaders(),
          credentials: "include",
          body: JSON.stringify({
            userResponse: 'ACCEPT',
            paymentIntentId: paymentIntent.id,
          }),
        });

        if (!acceptResponse.ok) {
          const errorData = await acceptResponse.json().catch(() => ({ message: "Failed to accept quote" }));
          console.error("❌ Failed to accept quote:", errorData);
          throw new Error(errorData.message || "Failed to accept quote after payment authorization");
        }
        const acceptData = await acceptResponse.json();
        console.log("✅ Quote accepted successfully with escrow payment:", acceptData);
        onSuccess();
      } else {
        throw new Error(`Payment authorization failed. Status: ${paymentIntent?.status}`);
      }
    } catch (err: any) {
      console.error("Payment error:", err);
      setError(err.message || "Payment failed. Please try again.");
    } finally {
      setProcessing(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5" style={{ width: '100%', maxWidth: '100%' }}>
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
        <p className="text-sm text-blue-800">
          <strong>Escrow Payment:</strong> Your payment will be authorized (held) but not charged until you accept the completed work.
        </p>
      </div>

      <div style={{ width: '100%' }}>
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
          style={{ width: '100%', boxSizing: 'border-box' }}
        />
      </div>

      <div style={{ width: '100%', maxWidth: '100%', boxSizing: 'border-box' }}>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Card Details
        </label>
        <div 
          style={{ 
            padding: '12px 16px', 
            border: '1px solid #d1d5db', 
            borderRadius: '8px', 
            backgroundColor: 'white',
            minHeight: '50px',
            width: '100%',
            maxWidth: '100%',
            boxSizing: 'border-box',
            position: 'relative',
            overflow: 'visible'
          }}
        >
          <div style={{ width: '100%', maxWidth: '100%' }}>
            <CardElement 
              options={cardElementOptions()}
            />
          </div>
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

const QuoteAcceptanceCheckoutComponent = memo(function QuoteAcceptanceCheckout(props: QuoteAcceptanceCheckoutProps) {
  const totalAmount = useMemo(() => {
    // Ensure quoteAmount is converted to a number
    const subtotal = typeof props.quoteAmount === 'number' ? props.quoteAmount : parseFloat(String(props.quoteAmount)) || 0;
    const fees = Math.round(subtotal * 0.1);
    return Math.round((subtotal + fees) * 100);
  }, [props.quoteAmount]);

  const options: StripeElementsOptions = useMemo(() => ({
    mode: "payment",
    amount: totalAmount,
    currency: "usd",
    appearance: {
      theme: 'stripe',
    },
  }), [totalAmount]);

  return (
    <Elements stripe={stripePromise} options={options}>
      <CheckoutForm {...props} />
    </Elements>
  );
});

export default QuoteAcceptanceCheckoutComponent;





