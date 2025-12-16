import { NextRequest, NextResponse } from 'next/server';
import { openai } from '@/lib/openai';
import { db, storage } from '@/lib/firebase';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const prompt: string = body.prompt;
    const niche: string = body.niche || 'general';
    const title: string = body.title || 'AI generated design';
    const style: string = body.style || 't-shirt illustration';

    // batch size
    let count: number = body.count ?? 1;
    if (isNaN(count) || count < 1) count = 1;
    if (count > 8) count = 8; // safety cap

    if (!prompt) {
      return NextResponse.json({ error: 'Missing prompt' }, { status: 400 });
    }

    const img = await openai.images.generate({
      model: 'gpt-image-1',
      prompt,
      n: count,
      size: '1024x1024',
      response_format: 'b64_json',
    });

    // Safely handle case where img.data might be undefined
    const images = img.data ?? [];

    const uploaded: {
      assetId: string;
      imageUrl: string;
    }[] = [];

    for (let i = 0; i < images.length; i++) {
      const b64 = images[i].b64_json;
      if (!b64) {
        console.warn(`No image data for index ${i}`);
        continue;
      }

      const buffer = Buffer.from(b64, 'base64');
      const filename = `assets/${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 10)}.png`;

      const fileRef = ref(storage, filename);
      await uploadBytes(fileRef, buffer, {
        contentType: 'image/png',
      });

      const url = await getDownloadURL(fileRef);

      const docRef = await addDoc(collection(db, 'assets'), {
        title,
        prompt,
        niche,
        style,
        imageUrl: url,
        storagePath: filename,
        source: 'app',
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
        { error: 'No images generated' },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        assets: uploaded,
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error('Error in generate-asset API:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
