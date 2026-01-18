// src/app/api/stripe-webhook/route.ts
import Stripe from 'stripe';
import { NextRequest, NextResponse } from 'next/server';
import { adminDb, FieldValue } from '@/lib/firebaseAdmin';

export const runtime = 'nodejs';

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

const stripeSecretKey = mustEnv('STRIPE_SECRET_KEY');
const webhookSecret = mustEnv('STRIPE_WEBHOOK_SECRET');

const stripe = new Stripe(stripeSecretKey, { apiVersion: '2025-11-17.clover' });

export async function POST(req: NextRequest) {
  const sig = req.headers.get('stripe-signature');
  if (!sig) {
    return NextResponse.json(
      { ok: false, error: 'Missing stripe-signature header' },
      { status: 400 },
    );
  }

  let stripeEvent: Stripe.Event;

  try {
    // IMPORTANT: raw body for signature verification
    const rawBody = await req.text();
    stripeEvent = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    console.error(
      'stripe-webhook: signature verification failed:',
      err?.message ?? err,
    );
    return NextResponse.json(
      { ok: false, error: 'Webhook signature verification failed' },
      { status: 400 },
    );
  }

  try {
    // Idempotent write: event.id is unique
    const eventRef = adminDb.collection('stripe_events').doc(stripeEvent.id);

    await eventRef.set(
      {
        id: stripeEvent.id,
        type: stripeEvent.type,
        created: stripeEvent.created,
        livemode: stripeEvent.livemode,
        api_version: stripeEvent.api_version ?? null,
        // Store the event payload (can be large but usually OK). If you hit limits, we’ll slim it.
        data: stripeEvent.data,
        request: stripeEvent.request ?? null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        pending_webhooks: (event as any).pending_webhooks ?? null,
        receivedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    // Optional: on checkout.session.completed, you can create/update an order doc here later
    // without breaking signature handling.

    return NextResponse.json({ ok: true }, { status: 200 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    console.error(
      'stripe-webhook: failed to persist event:',
      err?.message ?? err,
    );
    return NextResponse.json(
      { ok: false, error: 'Failed to persist event' },
      { status: 500 },
    );
  }
}
