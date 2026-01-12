import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';

import { db } from '@/lib/firebase';
import {
  collection,
  addDoc,
  serverTimestamp,
  doc,
  runTransaction,
} from 'firebase/firestore';

export const runtime = 'nodejs';

// --- Stripe client & secrets ---

const rawStripeSecretKey = process.env.STRIPE_SECRET_KEY;
if (!rawStripeSecretKey) throw new Error('STRIPE_SECRET_KEY is not set');
const stripe = new Stripe(rawStripeSecretKey);

const rawWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
if (!rawWebhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET is not set');
const webhookSecret = rawWebhookSecret;

// --- Handler ---

export async function POST(req: NextRequest) {
  const sig = req.headers.get('stripe-signature');
  if (!sig) {
    return NextResponse.json(
      { error: 'Missing Stripe-Signature header' },
      { status: 400 }
    );
  }

  let event: Stripe.Event;

  try {
    const body = await req.text();
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    console.error(
      '⚠️ Webhook signature verification failed.',
      err?.message ?? err
    );
    return NextResponse.json(
      { error: 'Webhook signature verification failed' },
      { status: 400 }
    );
  }

  // --- (Optional) Basic logging into stripe_events ---
  try {
    await addDoc(collection(db, 'stripe_events'), {
      stripe_event_id: event.id,
      type: event.type,
      created: new Date((event.created ?? 0) * 1000),
      // Keep logging light. Raw events can get large.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      object_id: (event.data?.object as any)?.id ?? null,
      createdAt: serverTimestamp(),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    console.error('[stripe-webhook] Failed to log event:', err?.message ?? err);
  }

  // --- Step B: checkout.session.completed => create order + mark checkout paid ---
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;

    const checkoutId = session.metadata?.checkoutId;
    const userId = session.metadata?.userId ?? 'unknown';

    if (!checkoutId) {
      console.warn(
        '[stripe-webhook] Missing metadata.checkoutId on session:',
        session.id
      );
      // Still return 200 so Stripe doesn't retry forever
      return NextResponse.json({ received: true }, { status: 200 });
    }

    const checkoutRef = doc(db, 'checkout_sessions', checkoutId);
    const orderRef = doc(db, 'orders', checkoutId); // deterministic id = idempotent

    try {
      await runTransaction(db, async (tx) => {
        const existingOrderSnap = await tx.get(orderRef);
        if (existingOrderSnap.exists()) {
          // Already processed (idempotent)
          return;
        }

        const checkoutSnap = await tx.get(checkoutRef);
        const checkoutData = checkoutSnap.exists() ? checkoutSnap.data() : null;

        const amountTotal = session.amount_total ?? null;
        const currency = session.currency ?? 'usd';

        // Build order document (manual fulfillment friendly)
        tx.set(orderRef, {
          orderId: checkoutId,
          status: 'paid', // payment status
          fulfillmentStatus: 'new', // manual fulfillment pipeline
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),

          user: {
            userId,
            // later you can add email/shipping from Stripe if you want
          },

          stripe: {
            eventId: event.id,
            sessionId: session.id,
            paymentIntentId:
              typeof session.payment_intent === 'string'
                ? session.payment_intent
                : session.payment_intent?.id ?? null,
            amountTotal,
            currency,
          },

          // Copy the exact items you saved at checkout creation time
          items: checkoutData?.items ?? [],

          // Helpful for debugging
          checkout: {
            checkoutId,
            createdStatus: checkoutData?.status ?? null,
          },
        });

        // Update checkout session doc (if it exists)
        if (checkoutSnap.exists()) {
          tx.update(checkoutRef, {
            status: 'paid',
            updatedAt: serverTimestamp(),
            'stripe.sessionId': session.id,
            'stripe.paymentIntentId':
              typeof session.payment_intent === 'string'
                ? session.payment_intent
                : session.payment_intent?.id ?? null,
            orderId: checkoutId,
            paidAt: serverTimestamp(),
          });
        }
      });

      console.log('[stripe-webhook] Order created for checkoutId:', checkoutId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      console.error(
        '[stripe-webhook] Failed to create order:',
        err?.message ?? err
      );
      // Return 200 anyway to avoid infinite retries while in dev
      return NextResponse.json({ received: true }, { status: 200 });
    }
  }

  // Optional: mark abandoned checkouts
  if (event.type === 'checkout.session.expired') {
    const session = event.data.object as Stripe.Checkout.Session;
    const checkoutId = session.metadata?.checkoutId;
    if (checkoutId) {
      try {
        await runTransaction(db, async (tx) => {
          const checkoutRef = doc(db, 'checkout_sessions', checkoutId);
          const snap = await tx.get(checkoutRef);
          if (snap.exists()) {
            tx.update(checkoutRef, {
              status: 'expired',
              updatedAt: serverTimestamp(),
            });
          }
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        console.error(
          '[stripe-webhook] Failed to mark expired:',
          err?.message ?? err
        );
      }
    }
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
