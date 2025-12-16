import Stripe from "stripe";
import { NextRequest, NextResponse } from "next/server";

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

if (!stripeSecretKey) {
  throw new Error("STRIPE_SECRET_KEY is not set in environment variables");
}

const stripe = new Stripe(stripeSecretKey);

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const items: Array<{
      id: string;
      assetId: string;
      productId: string;
      assetTitle: string;
      productName: string;
      quantity: number;
    }> = body.items ?? [];

    if (!items.length) {
      return NextResponse.json(
        { error: "No items provided" },
        { status: 400 }
      );
    }

    // TEMP: flat price per item (e.g. $25.00)
    const UNIT_AMOUNT_CENTS = 2500;

    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] =
      items.map((item) => ({
        quantity: item.quantity || 1,
        price_data: {
          currency: "usd",
          unit_amount: UNIT_AMOUNT_CENTS,
          product_data: {
            name: `${item.productName} - ${item.assetTitle}`,
            metadata: {
              assetId: item.assetId,
              productId: item.productId,
              cartItemId: item.id,
            },
          },
        },
      }));

    const origin =
      req.headers.get("origin") || "http://localhost:3000";

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      success_url: `${origin}/cart?status=success`,
      cancel_url: `${origin}/cart?status=cancel`,
      
      metadata: {
    userId: body.userId ?? "unknown",
    cartItemIds: JSON.stringify(items.map(i => i.id)),
      },
    });

    return NextResponse.json({ url: session.url });
  } catch (err: any) {
    console.error("Error creating checkout session:", err);
    return NextResponse.json(
      { error: err?.message ?? "Internal server error" },
      { status: 500 }
    );
  }
}
