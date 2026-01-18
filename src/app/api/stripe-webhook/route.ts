/* eslint-disable @typescript-eslint/no-explicit-any */
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

function log(event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
}

export async function POST(req: NextRequest) {
  const sig = req.headers.get('stripe-signature');
  if (!sig) {
    return NextResponse.json(
      { ok: false, error: 'Missing stripe-signature header' },
      { status: 400 },
    );
  }

  log('stripe_webhook.hit', {
    hasSig: true,
    contentType: req.headers.get('content-type'),
  });

  let stripeEvent: Stripe.Event;
  let rawBody = '';

  try {
    rawBody = await req.text(); // raw body is required
    stripeEvent = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err: any) {
    log('stripe_webhook.signature_failed', {
      message: String(err?.message ?? err),
    });
    return NextResponse.json(
      { ok: false, error: 'Webhook signature verification failed' },
      { status: 400 },
    );
  }

  log('stripe_webhook.verified', {
    id: stripeEvent.id,
    type: stripeEvent.type,
    created: stripeEvent.created,
  });

  try {
    // OPTIONAL: store a smaller payload to avoid Firestore 1MB doc limit surprises
    const obj: any = stripeEvent.data?.object ?? null;
    const checkoutId = obj?.metadata?.checkoutId ?? null;

    await adminDb
      .collection('stripe_events')
      .doc(stripeEvent.id)
      .set(
        {
          id: stripeEvent.id,
          type: stripeEvent.type,
          created: stripeEvent.created,
          livemode: stripeEvent.livemode,
          api_version: stripeEvent.api_version ?? null,

          // “Slim but useful” payload:
          object: obj,
          checkoutId,

          receivedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

    log('stripe_webhook.persisted', {
      id: stripeEvent.id,
      type: stripeEvent.type,
      checkoutId,
    });

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err: any) {
    // IMPORTANT: fail the webhook so Stripe shows the error and retries
    log('stripe_webhook.persist_failed', {
      message: String(err?.message ?? err),
    });
    return NextResponse.json(
      { ok: false, error: 'Failed to persist event' },
      { status: 500 },
    );
  }
}
