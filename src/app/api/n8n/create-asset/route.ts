import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { db } from '@/lib/firebase';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'firebase/storage';

export const runtime = 'nodejs';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const N8N_API_KEY = process.env.N8N_API_KEY;

function checkApiKey(req: NextRequest): boolean {
  const headerKey = req.headers.get('x-api-key');
  return !!N8N_API_KEY && headerKey === N8N_API_KEY;
}

export async function POST(req: NextRequest) {
  try {
    if (!checkApiKey(req)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const {
      title,
      niche,
      prompt,
      style,
      count = 1,
    }: {
      title?: string;
      niche?: string;
      prompt: string;
      style?: string;
      count?: number;
    } = body;

    if (!prompt || typeof prompt !== 'string') {
      return NextResponse.json(
        { error: "Missing or invalid 'prompt'" },
        { status: 400 }
      );
    }

    const finalTitle = title || 'Untitled design';
    const finalNiche = niche || 'general';
    const finalStyle = style || 'vector t-shirt illustration';

    // clamp count 1–4 for safety
    const numImages = Math.min(Math.max(count, 1), 4);

    const response = await openai.images.generate({
      model: 'gpt-image-1',
      prompt: `${prompt}\n\nNiche: ${finalNiche}\nStyle: ${finalStyle}`,
      n: numImages,
      size: '1024x1024',
      response_format: 'b64_json',
    });

    const storage = getStorage();
    const createdAssets: any[] = [];

    // ✅ guard against response.data being undefined
    const images = response.data ?? [];

    // 2) Upload each image to Storage + create Firestore doc
    for (const image of images) {
      if (!image.b64_json) continue;

      const imageBuffer = Buffer.from(image.b64_json, 'base64');
      const fileName = `assets/${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 10)}.png`;

      const fileRef = ref(storage, fileName);
      await uploadBytes(fileRef, imageBuffer, {
        contentType: 'image/png',
      });

      const downloadUrl = await getDownloadURL(fileRef);

      const assetData = {
        title: finalTitle,
        niche: finalNiche,
        style: finalStyle,
        prompt,
        imageUrl: downloadUrl,
        storagePath: fileName,
        provider: 'openai',
        providerAssetId: image ?? null,
        generationSource: 'n8n',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };

      const docRef = await addDoc(collection(db, 'assets'), assetData);

      createdAssets.push({
        id: docRef.id,
        ...assetData,
      });
    }

    return NextResponse.json(
      {
        ok: true,
        count: createdAssets.length,
        assets: createdAssets,
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error('[n8n/create-asset] Error:', err);
    return NextResponse.json(
      {
        error: err?.message || 'Internal server error',
      },
      { status: 500 }
    );
  }
}
