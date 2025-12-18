// src/app/api/n8n/create-asset/route.ts
import { NextRequest, NextResponse } from "next/server";
import { openai } from "@/lib/openai";
import { db, storage } from "@/lib/firebase";
import { collection, addDoc, serverTimestamp } from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  // This variable helps us see *where* things blow up
  let debugStep = "start";

  try {
    debugStep = "parse-body";
    const body = (await req.json().catch(() => ({}))) as Record<string, any>;

    const rawTitle = (body.title ?? "").toString().trim();
    const rawNiche = (body.niche ?? "").toString().trim();
    const rawPrompt = (body.prompt ?? "").toString().trim();
    const rawStyle = (body.style ?? "").toString().trim();

    let count = Number(body.count ?? 1);
    if (!Number.isFinite(count) || count < 1) count = 1;
    if (count > 8) count = 8;

    const title = rawTitle || "AI generated design";
    const niche = rawNiche || "general";
    const style = rawStyle || "t-shirt vector illustration";

    const prompt =
      rawPrompt ||
      `${title}, ${style}, ${niche} niche, high quality t-shirt illustration, clean vector art, centered, transparent background`;

    console.log("[n8n/create-asset] Parsed body:", {
      title,
      niche,
      style,
      count,
      promptSnippet: prompt.slice(0, 80),
    });

    // ----- OpenAI call -----
    debugStep = "openai-call";
    const response: any = await openai.images.generate({
      model: "gpt-image-1",
      prompt,
      n: count,
      size: "1024x1024",
      response_format: "b64_json",
    });

    debugStep = "process-openai-response";
    const images = (response?.data ?? []) as Array<{ b64_json?: string }>;

    if (!Array.isArray(images) || images.length === 0) {
      console.error("[n8n/create-asset] No images from OpenAI", { response });
      return NextResponse.json(
        { ok: false, error: "No images generated" },
        { status: 500 },
      );
    }

    // ----- Upload to Storage + Firestore -----
    debugStep = "upload-loop";
    const assetsCol = collection(db, "assets");
    const uploaded: { assetId: string; imageUrl: string }[] = [];

    for (let i = 0; i < images.length; i++) {
      const b64 = images[i]?.b64_json;
      if (!b64 || typeof b64 !== "string") {
        console.warn(`[n8n/create-asset] Skipping image index ${i} (no b64_json)`);
        continue;
      }

      const buffer = Buffer.from(b64, "base64");
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

    // TEMP: return the internal message so we see what's wrong
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
