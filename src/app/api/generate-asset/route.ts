import { NextRequest, NextResponse } from "next/server";
import { openai } from "@/lib/openai";
import { db, storage } from "@/lib/firebase";
import { collection, addDoc, serverTimestamp } from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const promptRaw = (body.prompt ?? "").toString().trim();
    const niche = (body.niche ?? "general").toString();
    const title = (body.title ?? "AI generated design").toString();
    const style = body.style ? body.style.toString() : "";

    if (!promptRaw) {
      return NextResponse.json(
        { error: "Missing prompt" },
        { status: 400 },
      );
    }

    let count = Number(body.count ?? 1);
    if (!Number.isFinite(count) || count < 1) count = 1;
    if (count > 8) count = 8;

    const fullPrompt = style
      ? `${promptRaw}\n\nStyle: ${style}`
      : promptRaw;

    // ⚠️ NOTE: no `response_format` here
    const response = await openai.images.generate({
      model: "gpt-image-1",
      prompt: fullPrompt,
      n: count,
      size: "1024x1024",
    });

    const images = response.data ?? [];
    const uploaded: { assetId: string; imageUrl: string }[] = [];

    for (const image of images as any[]) {
      let buffer: Buffer | null = null;

      if (image.b64_json) {
        buffer = Buffer.from(image.b64_json, "base64");
      } else if (image.url) {
        const res = await fetch(image.url);
        if (!res.ok) {
          console.warn("Failed to fetch image URL:", image.url);
          continue;
        }
        const arr = await res.arrayBuffer();
        buffer = Buffer.from(arr);
      }

      if (!buffer) {
        console.warn("No image data for one of the results");
        continue;
      }

      const filename = `assets/${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 10)}.png`;

      const fileRef = ref(storage, filename);
      await uploadBytes(fileRef, buffer, {
        contentType: "image/png",
      });

      const url = await getDownloadURL(fileRef);

      const docRef = await addDoc(collection(db, "assets"), {
        title,
        prompt: promptRaw,
        niche,
        style,
        imageUrl: url,
        storagePath: filename,
        source: "app",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      uploaded.push({
        assetId: docRef.id,
        imageUrl: url,
      });
    }

    if (uploaded.length === 0) {
      return NextResponse.json(
        { error: "No images generated" },
        { status: 500 },
      );
    }

    return NextResponse.json(
      {
        ok: true,
        count: uploaded.length,
        assets: uploaded,
      },
      { status: 200 },
    );
  } catch (err: any) {
    console.error("Error in generate-asset API:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
