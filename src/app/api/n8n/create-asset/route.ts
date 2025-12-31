import { NextRequest, NextResponse } from 'next/server';
import { openai } from '@/lib/openai';
import { db, storage } from '@/lib/firebase';
import {
  collection,
  addDoc,
  updateDoc,
  serverTimestamp,
  query,
  where,
  getCountFromServer,
  Timestamp,
} from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { randomUUID } from 'crypto';

export const runtime = 'nodejs';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function log(event: string, data: Record<string, any> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asBool(v: any): boolean {
  if (v === true || v === 1) return true;
  if (v === false || v === 0 || v == null) return false;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return ['1', 'true', 'yes', 'y', 'on'].includes(s);
  }
  return false;
}

function getOrigin(req: NextRequest): string {
  // Works behind reverse proxies too
  const proto = req.headers.get('x-forwarded-proto') || 'https';
  const host =
    req.headers.get('x-forwarded-host') ||
    req.headers.get('host') ||
    req.nextUrl.host;
  return `${proto}://${host}`;
}

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-n8n-secret');
  if (
    !process.env.N8N_SHARED_SECRET ||
    secret !== process.env.N8N_SHARED_SECRET
  ) {
    return NextResponse.json(
      { ok: false, error: 'Unauthorized' },
      { status: 401 }
    );
  }

  const startedAt = Date.now();
  const requestId = randomUUID();

  // Hoist so catch() can include them even if parsing fails
  let runId: string = requestId;
  let rowId: string | number | null = null;

  // Firestore job doc ref stored here once created
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let jobRef: any = null;

  try {
    const body = await req.json();

    // Assign to OUTER variables (do NOT redeclare with const)
    runId = body.runId ?? requestId;
    rowId = body.rowId ?? body.id ?? null;

    const promptRaw = (body.prompt ?? '').toString().trim();
    const niche = (body.niche ?? 'general').toString();
    const title = (body.title ?? 'AI generated design').toString();
    const style = body.style ? body.style.toString() : '';

    // Safe mock parsing: supports boolean/string/env
    const isMock = asBool(body.mock) || asBool(process.env.MOCK_MODE);

    console.log(
      'create-asset: isMock =',
      isMock,
      'body.mock =',
      body.mock,
      'MOCK_MODE =',
      process.env.MOCK_MODE
    );

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

    // ✅ Create the job doc FIRST so jobId exists for BOTH mock + real.
    jobRef = await addDoc(collection(db, 'jobs'), {
      requestId,
      runId,
      rowId: rowId?.toString?.() ?? rowId,
      status: 'pending',
      title,
      niche,
      style,
      requestedCount: count,
      isMock,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    log('create_asset.start', {
      requestId,
      runId,
      rowId,
      jobId: jobRef.id,
      count,
      isMock,
    });

    // ✅ MOCK SHORT-CIRCUIT (NO OPENAI, NO STORAGE UPLOADS)
    // BUT: we DO create Firestore `assets` docs so the Gallery can read from `assets`
    if (isMock) {
      const origin = getOrigin(req);
      const placeholderUrl = process.env.MOCK_IMAGE_URL || `${origin}/mock.png`;

      // 1) Create assets docs (published=false) so Gallery has real data
      const createdAssets: { assetId: string; imageUrl: string }[] = [];

      for (let i = 0; i < count; i++) {
        const docRef = await addDoc(collection(db, 'assets'), {
          title,
          // Store the concept prompt (not the full expanded style string if you prefer)
          prompt: promptRaw,
          niche,
          style,
          imageUrl: placeholderUrl,
          thumbUrl: placeholderUrl,

          // No Storage path in mock mode
          storagePath: '',
          source: 'mock',

          // link back for debugging/traceability
          runId,
          rowId: rowId?.toString?.() ?? rowId,
          jobId: jobRef?.id ?? null,

          // economy MVP gating
          published: false,

          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        createdAssets.push({
          assetId: docRef.id, // ✅ real Firestore doc id
          imageUrl: placeholderUrl,
        });
      }

      // 2) Update the job doc to reflect completion + include assets list
      await updateDoc(jobRef, {
        status: 'mock_done',
        assets: createdAssets,
        generatedCount: createdAssets.length,
        finishedAt: serverTimestamp(),
        ms: Date.now() - startedAt,
        updatedAt: serverTimestamp(),
      });

      log('create_asset.mock_done', {
        requestId,
        runId,
        rowId,
        jobId: jobRef.id,
        count: createdAssets.length,
      });

      // 3) Respond to n8n with real asset IDs + URLs
      return NextResponse.json(
        {
          ok: true,
          requestId,
          runId,
          rowId,
          jobId: jobRef.id,
          mock: true,
          count: createdAssets.length,
          assets: createdAssets,
        },
        { status: 200 }
      );
    }

    // ---- Daily cap (real generations only) ----
    const DAILY_CAP = Number(process.env.DAILY_CAP ?? 10); // economy default
    const now = new Date();

    // Simple + consistent boundary (UTC midnight). If you want NY midnight, we can adjust later.
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
    const q = query(
      collection(db, 'assets'),
      where('createdAt', '>=', dayStartTs)
    );

    const snapshot = await getCountFromServer(q);
    const usedToday = snapshot.data().count;

    // If generating `count` would exceed cap, block
    if (usedToday + count > DAILY_CAP) {
      log('create_asset.rate_limited', {
        requestId,
        runId,
        rowId,
        jobId: jobRef.id,
        usedToday,
        DAILY_CAP,
      });

      await updateDoc(jobRef, {
        status: 'error',
        error: 'Daily limit reached',
        usedToday,
        DAILY_CAP,
        ms: Date.now() - startedAt,
        updatedAt: serverTimestamp(),
      });

      return NextResponse.json(
        {
          ok: false,
          requestId,
          runId,
          rowId,
          jobId: jobRef.id,
          error: 'Daily limit reached',
          usedToday,
          DAILY_CAP,
        },
        { status: 429 }
      );
    }

    // Compose prompt
    const fullPrompt = style ? `${promptRaw}\n\nStyle: ${style}` : promptRaw;

    // ---- Generate images with OpenAI ----
    const genStart = Date.now();
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
      ms: Date.now() - genStart,
    });

    const images = response.data ?? [];
    const uploaded: { assetId: string; imageUrl: string }[] = [];

    const uploadStart = Date.now();

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
        thumbUrl: url,
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
      ms: Date.now() - uploadStart,
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

    // If we created a job doc, mark it error
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
