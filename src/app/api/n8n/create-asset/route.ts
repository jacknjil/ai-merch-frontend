// src/app/api/n8n/create-asset/route.ts
import { NextRequest, NextResponse } from "next/server";
import { openai } from "@/lib/openai";
import { db, storage } from "@/lib/firebase";
import { collection, addDoc, serverTimestamp } from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let debugStep = "start";

  try {
    // ----- 1) Parse & sanitize body -----
    debugStep = "parse-body";
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

    const prompt =
      rawPrompt ||
      `${title}, ${style}, ${niche} niche, high quality t-shirt illustration, clean vector art, centered composition, transparent background`;

    console.log("[n8n/create-asset] Parsed body:", {
      title,
      niche,
      style,
      count,
      promptSnippet: prompt.slice(0, 80),
    });

    // ----- 2) Call OpenAI image API (NO response_format) -----
    debugStep = "openai-call";

    const response: any = await openai.images.generate({
      model: "gpt-image-1",
      prompt,
      n: count,
      size: "1024x1024",
      // IMPORTANT: no response_format here, the API is complaining about it.
    });

    debugStep = "process-openai-response";

    type ImageItem = {
      b64_json?: string;
      url?: string;
      [key: string]: any;
    };

    const images = (response?.data ?? []) as ImageItem[];

    if (!Array.isArray(images) || images.length === 0) {
      console.error("[n8n/create-asset] No images from OpenAI", { response });
      return NextResponse.json(
        { ok: false, error: "No images generated" },
        { status: 500 },
      );
    }

    console.log("[n8n/create-asset] OpenAI image item keys:", Object.keys(images[0] || {}));

    // ----- 3) Upload each image to Firebase Storage + Firestore -----
    debugStep = "upload-loop";

    const assetsCol = collection(db, "assets");
    const uploaded: { assetId: string; imageUrl: string }[] = [];

    for (let i = 0; i < images.length; i++) {
      const img = images[i];

      let buffer: Buffer | null = null;

      // Prefer b64_json if present
      if (img.b64_json && typeof img.b64_json === "string") {
        try {
          buffer = Buffer.from(img.b64_json, "base64");
        } catch (e) {
          console.warn(
            `[n8n/create-asset] Failed to decode b64_json at index ${i}`,
            e,
          );
        }
      }

      // Fallback to fetching from URL if provided
      if (!buffer && img.url && typeof img.url === "string") {
        try {
          const res = await fetch(img.url);
          if (!res.ok) {
            throw new Error(`Fetch failed with status ${res.status}`);
          }
          const arrayBuffer = await res.arrayBuffer();
          buffer = Buffer.from(arrayBuffer);
        } catch (e) {
          console.warn(
            `[n8n/create-asset] Failed to fetch image URL at index ${i}: ${img.url}`,
            e,
          );
        }
      }

      if (!buffer) {
        console.warn(
          `[n8n/create-asset] Skipping image index ${i} (no usable data)`,
        );
        continue;
      }

      const filename = `assets/${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 10)}.png`;

      const fileRef = ref(storage, filename);
      await uploadBytes(fileRef, buffer, { contentType: "image/png" });

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
      console.error("[n8n/create-asset] No images uploaded");
      return NextResponse.json(
        { ok: false, error: "No images were uploaded" },
        { status: 500 },
      );
    }

    debugStep = "return-success";
    return NextResponse.json(
      { ok: true, count: uploaded.length, assets: uploaded },
      { status: 200 },
    );
  } catch (err: any) {
    console.error(
      "[n8n/create-asset] Internal error at step:",
      debugStep,
      err,
    );

    return NextResponse.json(
      {
        ok: false,
        error: `Internal error at step ${debugStep}: ${
          err?.message || String(err)
        }`,
      },
      { status: 500 },
    );
  }
}
