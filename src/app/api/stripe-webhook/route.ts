import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { db } from '@/lib/firebase';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';

export const runtime = 'nodejs';

// --- Stripe client & secrets with proper narrowing ---

// STRIPE_SECRET_KEY
const rawStripeSecretKey = process.env.STRIPE_SECRET_KEY;
if (!rawStripeSecretKey) {
  throw new Error('STRIPE_SECRET_KEY is not set');
}
const stripeSecretKey: string = rawStripeSecretKey;
const stripe = new Stripe(stripeSecretKey);

// STRIPE_WEBHOOK_SECRET
const rawWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
if (!rawWebhookSecret) {
  throw new Error('STRIPE_WEBHOOK_SECRET is not set');
}
const webhookSecret: string = rawWebhookSecret;

// --- Route handler ---

export async function POST(req: NextRequest) {
  // Get Stripe signature header from request
  const sig = req.headers.get('stripe-signature');

  if (!sig) {
    console.error('Missing Stripe-Signature header');
    return NextResponse.json(
      { error: 'Missing Stripe-Signature header' },
      { status: 400 }
    );
  }

  let event: Stripe.Event;

  try {
    // IMPORTANT: use raw text body for webhook verification
    const body = await req.text();
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
  } catch (err: any) {
    console.error('⚠️  Webhook signature verification failed.', err);
    return NextResponse.json(
      { error: 'Webhook signature verification failed' },
      { status: 400 }
    );
  }

  // --- Basic logging into stripe_events collection ---

  try {
    const stripeEventsRef = collection(db, 'stripe_events');

    await addDoc(stripeEventsRef, {
      stripe_event_id: event.id,
      type: event.type,
      created: new Date((event.created ?? 0) * 1000),
      raw: event,
      createdAt: serverTimestamp(),
    });
  } catch (err: any) {
    console.error('[stripe-webhook] Failed to log event to Firestore:', err);
    // Don't break the webhook if logging fails
  }

  // Example handler for checkout.session.completed
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    console.log(
      '[stripe-webhook] Checkout session completed:',
      session.id,
      session.amount_total
    );
    // Optional: create/update orders here
  }

  // Always acknowledge receipt to Stripe
  return NextResponse.json({ received: true }, { status: 200 });
}
