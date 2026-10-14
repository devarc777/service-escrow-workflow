"use client";

import { useState, useEffect, useMemo, useCallback, memo } from "react";
import { loadStripe, StripeElementsOptions } from "@stripe/stripe-js";
import { Elements, CardElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { useRouter } from "next/navigation";
import { getAuthHeaders } from "@/lib/auth-utils";
import { resolveApiBaseUrl } from "@/lib/api-base";

// Initialize Stripe
const stripePromise = loadStripe(
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || ""
);

interface StripeCheckoutProps {
  cart: Array<{ id: string; title: string; tierName?: string; price: number; quantity: number }>;
  eventId: string;
  customerEmail: string;
  onSuccess: () => void;
  onCancel: () => void;
}

function CheckoutForm({ cart, eventId, customerEmail, onSuccess, onCancel }: StripeCheckoutProps) {
  const stripe = useStripe();
  const elements = useElements();
  const router = useRouter();
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState(customerEmail);

  // Memoize total calculation to prevent recalculation on every render
  const { total, fees, finalTotal } = useMemo(() => {
    const subtotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const serviceFees = Math.round(subtotal * 0.1);
    return {
      total: subtotal,
      fees: serviceFees,
      finalTotal: subtotal + serviceFees,
    };
  }, [cart]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!stripe || !elements) {
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

      // Calculate total
      const subtotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
      const fees = Math.round(subtotal * 0.1);
      const totalAmount = subtotal + fees;
      // Convert to cents for Stripe (amount must be in cents)
      const amountInCents = Math.round(totalAmount * 100);

      // Validate minimum amount (Stripe requires at least $0.50 = 50 cents)
      if (amountInCents < 50) {
        throw new Error(`Minimum payment amount is $0.50. Your total is $${totalAmount.toFixed(2)}`);
      }

      // Step 1: Create payment intent (NO booking yet)
      const paymentIntentResponse = await fetch(`${API_BASE}/payments/create-intent`, {
        method: "POST",
        headers: getAuthHeaders(),
        credentials: "include",
        body: JSON.stringify({
          amount: amountInCents,
          currency: "usd",
          metadata: {
            eventId: eventId,
            ticketCount: cart.reduce((sum, item) => sum + item.quantity, 0).toString(),
          },
          customerEmail: email,
        }),
      });

      if (!paymentIntentResponse.ok) {
        const errorData = await paymentIntentResponse.json().catch(() => ({ message: "Failed to create payment intent" }));
        throw new Error(errorData.message || "Failed to create payment intent");
      }

      const { clientSecret, paymentIntentId } = await paymentIntentResponse.json();

      // Step 2: Confirm payment with Stripe
      const cardElement = elements.getElement(CardElement);
      if (!cardElement) {
        throw new Error("Card element not found");
      }

      const { error: stripeError, paymentIntent } = await stripe.confirmCardPayment(
        clientSecret,
        {
          payment_method: {
            card: cardElement,
            billing_details: {
              email: email,
            },
          },
        }
      );

      if (stripeError) {
        throw new Error(stripeError.message || "Payment failed");
      }

      if (paymentIntent?.status === "succeeded") {
        console.log("✅ Payment succeeded! Payment Intent ID:", paymentIntent.id);
        
        // Step 3: ONLY NOW create booking after payment succeeds
        console.log("📝 Creating booking after successful payment...");
        // Extract tier name from item.title (format: "Event Name - Tier Name" or just "Event Name")
        const bookingResponse = await fetch(`${API_BASE}/events/${eventId}/bookings/create`, {
          method: "POST",
          headers: getAuthHeaders(),
          credentials: "include",
          body: JSON.stringify({
            tickets: cart.map(item => {
              // Use tierName if available, otherwise extract from title
              const tierName = item.tierName || (item.title.includes(' - ') 
                ? item.title.split(' - ').slice(1).join(' - ') 
                : 'default');
              return {
                tier: tierName,
                price: item.price,
                quantity: item.quantity,
              };
            }),
            customerEmail: email,
            paymentIntentId: paymentIntent.id,
          }),
        });

        if (!bookingResponse.ok) {
          const errorData = await bookingResponse.json().catch(() => ({ message: "Failed to create booking" }));
          console.error("❌ Failed to create booking:", errorData);
          throw new Error(errorData.message || "Failed to create booking after payment");
        }

        const bookingData = await bookingResponse.json();
        console.log("✅ Booking created successfully:", bookingData);
        console.log("🎫 Tickets created:", bookingData.booking?.tickets?.length || 0);

        // Success!
        onSuccess();
      } else {
        console.error("❌ Payment status:", paymentIntent?.status);
        throw new Error(`Payment was not successful. Status: ${paymentIntent?.status}`);
      }
    } catch (err: any) {
      console.error("❌ Payment/Booking error:", err);
      console.error("Error details:", {
        message: err.message,
        stack: err.stack,
        name: err.name,
      });
      setError(err.message || "Payment failed. Please try again.");
    } finally {
      setProcessing(false);
    }
  };

  // Memoize card element options to prevent recreation on every render
  const cardElementOptions = useMemo(() => ({
    hidePostalCode: true,
    style: {
      base: {
        fontSize: "16px",
        color: "#1a1a1a",
        fontFamily: "Inter, system-ui, sans-serif",
        "::placeholder": {
          color: "#9ca3af",
        },
      },
      invalid: {
        color: "#ef4444",
        iconColor: "#ef4444",
      },
    },
  }), []);

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Email */}
      <div>
        <label className="block text-sm font-semibold text-gray-700 mb-2" style={{ fontFamily: "Inter" }}>
          Email Address
        </label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full px-4 py-3 border-2 border-gray-200 rounded-lg focus:ring-2 focus:ring-[#021945] focus:border-[#021945] transition-all"
          placeholder="your@email.com"
          required
          style={{ fontFamily: "Inter" }}
        />
        <p className="text-xs text-gray-500 mt-1" style={{ fontFamily: "Inter" }}>
          Receipt will be sent to this email
        </p>
      </div>

      {/* Card Element */}
      <div>
        <label className="block text-sm font-semibold text-gray-700 mb-2" style={{ fontFamily: "Inter" }}>
          Card Details
        </label>
        <div className="px-4 py-3 border-2 border-gray-200 rounded-lg focus-within:ring-2 focus-within:ring-[#021945] focus-within:border-[#021945] transition-all">
          <CardElement options={cardElementOptions} />
        </div>
        <p className="text-xs text-gray-500 mt-1" style={{ fontFamily: "Inter" }}>
          We accept Visa, Mastercard, American Express, and Discover
        </p>
      </div>

      {/* Error Message */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-sm text-red-700" style={{ fontFamily: "Inter" }}>{error}</p>
        </div>
      )}

      {/* Security Notice */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mt-6">
        <div className="flex gap-3">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" className="text-blue-600 flex-shrink-0 mt-0.5">
            <path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M12 16V12M12 8H12.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <div>
            <p className="text-sm font-medium text-blue-900" style={{ fontFamily: "Inter" }}>Your payment is secure</p>
            <p className="text-xs text-blue-700 mt-1" style={{ fontFamily: "Inter" }}>We use industry-standard encryption to protect your payment information.</p>
          </div>
        </div>
      </div>

      {/* Complete Purchase Button */}
      <button
        type="submit"
        disabled={!stripe || processing}
        className="w-full mt-6 py-4 bg-[#D4AF37] text-white rounded-lg font-bold text-lg hover:bg-[#B8941F] transition-all shadow-lg hover:shadow-xl transform hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none"
        style={{ fontFamily: "Raleway" }}
      >
        {processing ? "Processing..." : `Complete Purchase · $${finalTotal}`}
      </button>

      <p className="text-xs text-center text-gray-500 mt-4" style={{ fontFamily: "Inter" }}>
        By completing this purchase, you agree to our Terms of Service and Privacy Policy
      </p>
    </form>
  );
}

// Memoize the cart to prevent unnecessary recalculations
const cartKey = (cart: Array<{ id: string; title: string; price: number; quantity: number }>) => {
  return cart.map(item => `${item.id}-${item.quantity}`).join(',');
};

const StripeCheckoutComponent = memo(function StripeCheckout(props: StripeCheckoutProps) {
  // Memoize the total calculation to prevent recalculation on every render
  const totalAmount = useMemo(() => {
    const subtotal = props.cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const fees = Math.round(subtotal * 0.1);
    return Math.round((subtotal + fees) * 100);
  }, [props.cart]);

  // Memoize the options object to prevent Stripe Elements from re-initializing
  // Only recreate if totalAmount actually changes
  const options: StripeElementsOptions = useMemo(() => ({
    mode: "payment",
    amount: totalAmount,
    currency: "usd",
  }), [totalAmount]);

  return (
    <Elements stripe={stripePromise} options={options}>
      <CheckoutForm {...props} />
    </Elements>
  );
}, (prevProps, nextProps) => {
  // Custom comparison function - only re-render if cart actually changes
  if (prevProps.cart.length !== nextProps.cart.length) return false;
  if (prevProps.eventId !== nextProps.eventId) return false;
  if (prevProps.customerEmail !== nextProps.customerEmail) return false;
  
  // Deep compare cart items
  for (let i = 0; i < prevProps.cart.length; i++) {
    const prev = prevProps.cart[i];
    const next = nextProps.cart[i];
    if (prev.id !== next.id || prev.quantity !== next.quantity || prev.price !== next.price) {
      return false;
    }
  }
  
  return true; // Props are equal, skip re-render
});

export default StripeCheckoutComponent;

