// src/app/api/n8n/create-asset/route.ts
import { NextRequest, NextResponse } from "next/server";
import { openai } from "@/lib/openai";
import { db, storage } from "@/lib/firebase";
import { collection, addDoc, serverTimestamp } from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    // -------- 1) Read & sanitize body --------
    const body = (await req.json().catch(() => ({}))) as Record<string, any>;

    const rawTitle = (body.title ?? "").toString().trim();
    const rawNiche = (body.niche ?? "").toString().trim();
    const rawPrompt = (body.prompt ?? "").toString().trim();
    const rawStyle = (body.style ?? "").toString().trim();

    let count = Number(body.count ?? 1);
    if (!Number.isFinite(count) || count < 1) count = 1;
    if (count > 8) count = 8; // safety cap

    const title = rawTitle || "AI generated design";
    const niche = rawNiche || "general";
    const style = rawStyle || "t-shirt vector illustration";

    // If n8n sends an empty prompt, we synthesize one instead of 400’ing
    const prompt =
      rawPrompt ||
      `${title}, ${style}, ${niche} niche, high quality t-shirt illustration, clean vector art, centered, transparent background`;

    console.log("[n8n/create-asset] Incoming body:", {
      title,
      niche,
      style,
      count,
      prompt,
    });

    // -------- 2) Call OpenAI image API --------
    // Use `any` here to stay out of TS's way; we still guard at runtime.
    const response: any = await openai.images.generate({
      model: "gpt-image-1",
      prompt,
      n: count,
      size: "1024x1024",
      // Using b64_json on the server is fine (the 400 you saw before
      // was from the *HTTP* call, not this library call).
      response_format: "b64_json",
    });

    const images = (response?.data ?? []) as Array<{ b64_json?: string }>;

    if (!Array.isArray(images) || images.length === 0) {
      console.error("[n8n/create-asset] No images returned from OpenAI", {
        response,
      });
      return NextResponse.json(
        { ok: false, error: "No images generated" },
        { status: 500 },
      );
    }

    // -------- 3) Upload each image to Storage + Firestore --------
    const assetsCol = collection(db, "assets");
    const uploaded: { assetId: string; imageUrl: string }[] = [];

    for (let i = 0; i < images.length; i++) {
      const b64 = images[i]?.b64_json;
      if (!b64 || typeof b64 !== "string") {
        console.warn(`[n8n/create-asset] Skipping index ${i} (no b64_json)`);
        continue;
      }

      const buffer = Buffer.from(b64, "base64");
      const filename = `assets/${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 10)}.png`;

      const fileRef = ref(storage, filename);
      await uploadBytes(fileRef, buffer, {
        contentType: "image/png",
      });

      const url = await getDownloadURL(fileRef);

      const docRef = await addDoc(assetsCol, {
        title,
        prompt,
        niche,
        style,
        imageUrl: url,
        storagePath: filename,
        source: "n8n",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      uploaded.push({ assetId: docRef.id, imageUrl: url });
    }

    if (uploaded.length === 0) {
      console.error(
        "[n8n/create-asset] All images skipped, nothing uploaded.",
      );
      return NextResponse.json(
        { ok: false, error: "No images were uploaded" },
        { status: 500 },
      );
    }

    // -------- 4) Return n8n-friendly payload --------
    return NextResponse.json(
      {
        ok: true,
        count: uploaded.length,
        assets: uploaded,
      },
      { status: 200 },
    );
  } catch (err: any) {
    console.error("[n8n/create-asset] Internal error:", err);
    return NextResponse.json(
      { ok: false, error: "Internal server error" },
      { status: 500 },
    );
  }
}
