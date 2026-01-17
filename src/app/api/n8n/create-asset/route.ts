// src/app/api/n8n/create-asset/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { openai } from '@/lib/openai';
import { adminDb, adminBucket, FieldValue } from '@/lib/firebaseAdmin';

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
  const proto = req.headers.get('x-forwarded-proto') || 'https';
  const host =
    req.headers.get('x-forwarded-host') ||
    req.headers.get('host') ||
    req.nextUrl.host;
  return `${proto}://${host}`;
}

// YYYY-MM-DD in America/Chicago (your timezone)
function dayKeyChicago(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

class RateLimitError extends Error {
  usedToday: number;
  cap: number;
  constructor(message: string, usedToday: number, cap: number) {
    super(message);
    this.usedToday = usedToday;
    this.cap = cap;
  }
}

async function uploadPngAndGetUrl(storagePath: string, png: Buffer) {
  const file = adminBucket.file(storagePath);
  const token = randomUUID();

  await file.save(png, {
    contentType: 'image/png',
    resumable: false,
    metadata: {
      metadata: {
        firebaseStorageDownloadTokens: token,
      },
    },
  });

  const bucketName = adminBucket.name;
  const encoded = encodeURIComponent(storagePath);
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encoded}?alt=media&token=${token}`;
}

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-n8n-secret');
  if (
    !process.env.N8N_SHARED_SECRET ||
    secret !== process.env.N8N_SHARED_SECRET
  ) {
    return NextResponse.json(
      { ok: false, error: 'Unauthorized' },
      { status: 401 },
    );
  }

  const startedAt = Date.now();
  const requestId = randomUUID();

  // Hoist so catch() can include them even if parsing fails
  let runId: string = requestId;
  let rowId: string | number | null = null;

  // Firestore job doc ref stored here once created
  let jobRef: FirebaseFirestore.DocumentReference | null = null;

  try {
    const body = await req.json();

    runId = body.runId ?? requestId;
    rowId = body.rowId ?? body.id ?? null;

    const promptRaw = (body.prompt ?? '').toString().trim();
    const niche = (body.niche ?? 'general').toString();
    const title = (body.title ?? 'AI generated design').toString();
    const style = body.style ? body.style.toString() : '';

    const isMock =
      asBool(body.mock) ||
      asBool(process.env.MOCK_MODE) ||
      asBool(process.env.NEXT_PUBLIC_MOCK_MODE);

    log('create_asset.request', {
      requestId,
      runId,
      rowId,
      isMock,
      bodyMock: body.mock,
    });

    if (!promptRaw) {
      log('create_asset.bad_request', {
        requestId,
        runId,
        rowId,
        reason: 'Missing prompt',
      });
      return NextResponse.json(
        { ok: false, requestId, runId, rowId, error: 'Missing prompt' },
        { status: 400 },
      );
    }

    let count = Number(body.count ?? 1);
    if (!Number.isFinite(count) || count < 1) count = 1;
    if (count > 8) count = 8;

    // ✅ Create job FIRST so jobId always exists
    jobRef = await adminDb.collection('jobs').add({
      requestId,
      runId,
      rowId: rowId?.toString?.() ?? rowId,
      status: 'pending',
      title,
      niche,
      style,
      requestedCount: count,
      isMock,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
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
    // BUT: create Firestore `assets` docs so the Gallery can read them
    if (isMock) {
      const origin = getOrigin(req);
      const placeholderUrl = process.env.MOCK_IMAGE_URL || `${origin}/mock.png`;

      const createdAssets: { assetId: string; imageUrl: string }[] = [];

      for (let i = 0; i < count; i++) {
        const docRef = await adminDb.collection('assets').add({
          title,
          prompt: promptRaw,
          niche,
          style,
          imageUrl: placeholderUrl,
          thumbUrl: placeholderUrl,
          storagePath: '',
          source: 'mock',
          runId,
          rowId: rowId?.toString?.() ?? rowId,
          jobId: jobRef.id,
          published: false,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });

        createdAssets.push({ assetId: docRef.id, imageUrl: placeholderUrl });
      }

      await jobRef.update({
        status: 'mock_done',
        assets: createdAssets,
        generatedCount: createdAssets.length,
        finishedAt: FieldValue.serverTimestamp(),
        ms: Date.now() - startedAt,
        updatedAt: FieldValue.serverTimestamp(),
      });

      log('create_asset.mock_done', {
        requestId,
        runId,
        rowId,
        jobId: jobRef.id,
        count: createdAssets.length,
      });

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
        { status: 200 },
      );
    }

    // ✅ DAILY CAP (real generations only) using counter doc (fast + reliable)
    const DAILY_CAP = Number(process.env.DAILY_CAP ?? 10);
    const dayKey = dayKeyChicago();
    const capRef = adminDb
      .collection('rate_limits')
      .doc('daily')
      .collection('days')
      .doc(dayKey);

    try {
      await adminDb.runTransaction(async (tx) => {
        const snap = await tx.get(capRef);
        const used = snap.exists ? Number(snap.data()?.used ?? 0) : 0;

        if (used + count > DAILY_CAP) {
          throw new RateLimitError('Daily limit reached', used, DAILY_CAP);
        }

        if (!snap.exists) {
          tx.set(capRef, {
            day: dayKey,
            tz: 'America/Chicago',
            used: count,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        } else {
          tx.update(capRef, {
            used: FieldValue.increment(count),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      if (e instanceof RateLimitError) {
        log('create_asset.rate_limited', {
          requestId,
          runId,
          rowId,
          jobId: jobRef.id,
          usedToday: e.usedToday,
          DAILY_CAP: e.cap,
        });

        await jobRef.update({
          status: 'error',
          error: 'Daily limit reached',
          usedToday: e.usedToday,
          DAILY_CAP: e.cap,
          ms: Date.now() - startedAt,
          updatedAt: FieldValue.serverTimestamp(),
        });

        return NextResponse.json(
          {
            ok: false,
            requestId,
            runId,
            rowId,
            jobId: jobRef.id,
            error: 'Daily limit reached',
            usedToday: e.usedToday,
            DAILY_CAP: e.cap,
          },
          { status: 429 },
        );
      }
      throw e;
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

      const filename = `assets/${rowId ?? 'row'}-${requestId}-${Date.now()}.png`;
      const url = await uploadPngAndGetUrl(filename, buffer);

      const docRef = await adminDb.collection('assets').add({
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
        published: false,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
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
      await jobRef.update({
        status: 'error',
        error: 'No images generated',
        generatedCount: 0,
        ms: Date.now() - startedAt,
        updatedAt: FieldValue.serverTimestamp(),
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
        { status: 500 },
      );
    }

    await jobRef.update({
      status: 'done',
      generatedCount: uploaded.length,
      ms: Date.now() - startedAt,
      updatedAt: FieldValue.serverTimestamp(),
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
      { status: 200 },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    const message = String(err?.message ?? 'Internal server error');

    try {
      if (jobRef) {
        await jobRef.update({
          status: 'error',
          error: message,
          ms: Date.now() - startedAt,
          updatedAt: FieldValue.serverTimestamp(),
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
      { status: 500 },
    );
  }
}
