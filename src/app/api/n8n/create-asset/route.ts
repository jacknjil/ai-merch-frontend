import { NextRequest, NextResponse } from 'next/server';
import { openai } from '@/lib/openai';
import { db, storage } from '@/lib/firebase';
import {
  collection,
  addDoc,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { randomUUID } from 'crypto';
import {
  getCountFromServer,
  query,
  where,
  Timestamp,
} from 'firebase/firestore';

export const runtime = 'nodejs';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function log(event: string, data: Record<string, any> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  const requestId = randomUUID();

  // Hoist so catch() can include them even if parsing fails
  let runId: string = requestId;
  let rowId: string | number | null = null;

  // Firestore job doc ref (DocumentReference) stored here once created
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let jobRef: any = null;

  try {
    const body = await req.json();

    // Assign to the OUTER variables (do NOT redeclare with const)
    runId = body.runId ?? requestId;
    rowId = body.rowId ?? body.id ?? null;

    const promptRaw = (body.prompt ?? '').toString().trim();
    const niche = (body.niche ?? 'general').toString();
    const title = (body.title ?? 'AI generated design').toString();
    const style = body.style ? body.style.toString() : '';
    const Mock =
     body.mock === true ||
     body.mock === "true" ||
     process.env.MOCK_MODE === "1" ||
     process.env.MOCK_MODE === "true";

     console.log("create-asset: isMock =", Mock, "body.mock =", body.mock, "MOCK_MODE =", process.env.MOCK_MODE);


    if (!promptRaw) {
      log('create_asset.bad_request', {
        requestId,
        runId,
        rowId,
        reason: 'Missing prompt',
      });
      return NextResponse.json(
        { ok: false, requestId, runId, rowId, error: 'Missing prompt' },
        { status: 400 }
      );
    }

    let count = Number(body.count ?? 1);
    if (!Number.isFinite(count) || count < 1) count = 1;
    if (count > 8) count = 8;

    if (Mock) {
     // Serve a cheap placeholder (no OpenAI call, no Firebase Storage upload)
     const placeholderUrl =
     process.env.MOCK_IMAGE_URL || "https://YOUR_DOMAIN/mock.png";

    const assets = Array.from({ length: count }).map((_, i) => ({
     assetId: `mock-${requestId}-${i}`,
     imageUrl: placeholderUrl,
  }));


    // ---- Daily cap ----
    const DAILY_CAP = Number(process.env.DAILY_CAP ?? 30); // start small
    const now = new Date();

    // Use UTC day boundary (simple + consistent)
    const dayStart = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        0,
        0,
        0
      )
    );
    const dayStartTs = Timestamp.fromDate(dayStart);

    // Count assets created today
    const q = query(
      collection(db, 'assets'),
      where('createdAt', '>=', dayStartTs)
    );

    const snap = await getCountFromServer(q);
    const usedToday = snap.data().count;

    // If this request would exceed the cap, block it
    if (usedToday >= DAILY_CAP) {
      log('create_asset.rate_limited', {
        requestId,
        runId,
        rowId,
        usedToday,
        DAILY_CAP,
      });
      return NextResponse.json(
        {
          ok: false,
          requestId,
          runId,
          rowId,
          error: 'Daily limit reached',
          usedToday,
          DAILY_CAP,
        },
        { status: 429 }
      );
    }

    const fullPrompt = style ? `${promptRaw}\n\nStyle: ${style}` : promptRaw;

    // Create job doc once
    jobRef = await addDoc(collection(db, 'jobs'), {
      requestId,
      runId,
      rowId: rowId?.toString?.() ?? rowId,
      status: 'pending',
      title,
      niche,
      style,
      requestedCount: count,
      Mock,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    log('create_asset.start', {
      requestId,
      runId,
      rowId,
      jobId: jobRef.id,
      count,
      Mock,
    });

    // 1) Generate
    const tGen = Date.now();
    const response = await openai.images.generate({
      model: 'gpt-image-1',
      prompt: fullPrompt,
      n: count,
      size: '1024x1024',
    });
    log('create_asset.generated', {
      requestId,
      runId,
      rowId,
      jobId: jobRef.id,
      ms: Date.now() - tGen,
    });

    // 2) Upload + Firestore assets
    const images = response.data ?? [];
    const uploaded: { assetId: string; imageUrl: string }[] = [];

    const tUp = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const image of images as any[]) {
      let buffer: Buffer | null = null;

      if (image.b64_json) {
        buffer = Buffer.from(image.b64_json, 'base64');
      } else if (image.url) {
        const res = await fetch(image.url);
        if (!res.ok) {
          log('create_asset.fetch_failed', {
            requestId,
            runId,
            rowId,
            jobId: jobRef.id,
            url: image.url,
          });
          continue;
        }
        const arr = await res.arrayBuffer();
        buffer = Buffer.from(arr);
      }

      if (!buffer) continue;

      const filename = `assets/${
        rowId ?? 'row'
      }-${requestId}-${Date.now()}.png`;
      const fileRef = ref(storage, filename);

      await uploadBytes(fileRef, buffer, { contentType: 'image/png' });
      const url = await getDownloadURL(fileRef);

      const docRef = await addDoc(collection(db, 'assets'), {
        title,
        prompt: promptRaw,
        niche,
        style,
        imageUrl: url,
        storagePath: filename,
        source: 'n8n',
        runId,
        rowId: rowId?.toString?.() ?? rowId,
        jobId: jobRef.id,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      uploaded.push({ assetId: docRef.id, imageUrl: url });
    }

    log('create_asset.uploaded', {
      requestId,
      runId,
      rowId,
      jobId: jobRef.id,
      uploaded: uploaded.length,
      ms: Date.now() - tUp,
    });

    if (uploaded.length === 0) {
      await updateDoc(jobRef, {
        status: 'error',
        error: 'No images generated',
        generatedCount: 0,
        ms: Date.now() - startedAt,
        updatedAt: serverTimestamp(),
      });

      log('create_asset.error', {
        requestId,
        runId,
        rowId,
        jobId: jobRef.id,
        message: 'No images generated',
      });

      return NextResponse.json(
        {
          ok: false,
          requestId,
          runId,
          rowId,
          jobId: jobRef.id,
          error: 'No images generated',
        },
        { status: 500 }
      );
    }

    await updateDoc(jobRef, {
      status: 'done',
      generatedCount: uploaded.length,
      ms: Date.now() - startedAt,
      updatedAt: serverTimestamp(),
    });

    log('create_asset.success', {
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    const message = String(err?.message ?? 'Internal server error');

    // Try to mark job as error if it exists
    try {
      if (jobRef) {
        await updateDoc(jobRef, {
          status: 'error',
          error: message,
          ms: Date.now() - startedAt,
          updatedAt: serverTimestamp(),
        });
      }
    } catch {}

    log('create_asset.crash', {
      requestId,
      runId,
      rowId,
      jobId: jobRef?.id ?? null,
      message,
    });

    return NextResponse.json(
      {
        ok: false,
        requestId,
        runId,
        rowId,
        jobId: jobRef?.id ?? null,
        error: 'Internal server error',
      },
      { status: 500 }
    );
  }
  }
