import { NextRequest, NextResponse } from "next/server";
import { openai } from "@/lib/openai";
import { db, storage } from "@/lib/firebase";
import { collection, addDoc, serverTimestamp, updateDoc } from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { randomUUID } from "crypto";

export const runtime = "nodejs";

function log(event: string, data: Record<string, any> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  const requestId = randomUUID();

  // jobRef is used in catch() too
  let runId: string = requestId;
  let rowId: string | number | null = null;
  let jobRef: any = null;

  try {
    const body = await req.json();

    // n8n should send these, but they are optional
    const runId = body.runId ?? requestId;
    const rowId = body.rowId ?? body.id ?? null;

    jobRef = await addDoc(collection(db, "jobs"), {
    requestId,
    runId,
    rowId: rowId?.toString?.() ?? rowId,
    status: "pending",
    // ...
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

    const promptRaw = (body.prompt ?? "").toString().trim();
    const niche = (body.niche ?? "general").toString();
    const title = (body.title ?? "AI generated design").toString();
    const style = body.style ? body.style.toString() : "";
    const mock = Boolean(body.mock ?? false);

    if (!promptRaw) {
      log("create_asset.bad_request", { requestId, runId, rowId, reason: "Missing prompt" });
      return NextResponse.json(
        { ok: false, requestId, runId, rowId, error: "Missing prompt" },
        { status: 400 }
      );
    }

    let count = Number(body.count ?? 1);
    if (!Number.isFinite(count) || count < 1) count = 1;
    if (count > 8) count = 8;

    const fullPrompt = style ? `${promptRaw}\n\nStyle: ${style}` : promptRaw;

    // Create a job doc (observability + audit trail)
    jobRef = await addDoc(collection(db, "jobs"), {
      requestId,
      runId,
      rowId: rowId?.toString?.() ?? rowId,
      status: "pending",
      title,
      niche,
      style,
      requestedCount: count,
      mock,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    log("create_asset.start", {
      requestId,
      runId,
      rowId,
      jobId: jobRef.id,
      count,
      mock,
    });

    // 1) Generate
    const tGen = Date.now();
    const response = await openai.images.generate({
      model: "gpt-image-1",
      prompt: fullPrompt,
      n: count,
      size: "1024x1024",
    });
    log("create_asset.generated", { requestId, runId, rowId, jobId: jobRef.id, ms: Date.now() - tGen });

    // 2) Upload + Firestore assets
    const images = response.data ?? [];
    const uploaded: { assetId: string; imageUrl: string }[] = [];

    const tUp = Date.now();
    for (const image of images as any[]) {
      let buffer: Buffer | null = null;

      if (image.b64_json) {
        buffer = Buffer.from(image.b64_json, "base64");
      } else if (image.url) {
        const res = await fetch(image.url);
        if (!res.ok) {
          log("create_asset.fetch_failed", { requestId, runId, rowId, jobId: jobRef.id, url: image.url });
          continue;
        }
        const arr = await res.arrayBuffer();
        buffer = Buffer.from(arr);
      }

      if (!buffer) continue;

      const filename = `assets/${rowId ?? "row"}-${requestId}-${Date.now()}.png`;
      const fileRef = ref(storage, filename);

      await uploadBytes(fileRef, buffer, { contentType: "image/png" });
      const url = await getDownloadURL(fileRef);

      const docRef = await addDoc(collection(db, "assets"), {
        title,
        prompt: promptRaw,
        niche,
        style,
        imageUrl: url,
        storagePath: filename,
        source: "n8n",
        runId,
        rowId: rowId?.toString?.() ?? rowId,
        jobId: jobRef.id,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      uploaded.push({ assetId: docRef.id, imageUrl: url });
    }
    log("create_asset.uploaded", { requestId, runId, rowId, jobId: jobRef.id, uploaded: uploaded.length, ms: Date.now() - tUp });

    if (uploaded.length === 0) {
      await updateDoc(jobRef, {
        status: "error",
        error: "No images generated",
        generatedCount: 0,
        ms: Date.now() - startedAt,
        updatedAt: serverTimestamp(),
      });

      log("create_asset.error", { requestId, runId, rowId, jobId: jobRef.id, message: "No images generated" });

      return NextResponse.json(
        { ok: false, requestId, runId, rowId, jobId: jobRef.id, error: "No images generated" },
        { status: 500 }
      );
    }

    await updateDoc(jobRef, {
      status: "done",
      generatedCount: uploaded.length,
      ms: Date.now() - startedAt,
      updatedAt: serverTimestamp(),
    });

    log("create_asset.success", {
      requestId,
      runId,
      rowId,
      jobId: jobRef.id,
      count: uploaded.length,
      ms: Date.now() - startedAt,
    });

    return NextResponse.json(
      {
        ok: true,
        requestId,
        runId,
        rowId,
        jobId: jobRef.id,
        count: uploaded.length,
        assets: uploaded,
      },
      { status: 200 }
    );
  } catch (err: any) {
    const message = String(err?.message ?? "Internal server error");

    // Try to mark job as error if it exists
    try {
      if (jobRef) {
        await updateDoc(jobRef, {
          status: "error",
          error: message,
          ms: Date.now() - startedAt,
          updatedAt: serverTimestamp(),
        });
      }
    } catch {}

    log("create_asset.crash", { requestId, runId, rowId, jobId: jobRef?.id ?? null, message });

    return NextResponse.json(
      { ok: false, requestId, runId, rowId, jobId: jobRef?.id ?? null, error: "Internal server error" },
      { status: 500 }
    );
  }
}
