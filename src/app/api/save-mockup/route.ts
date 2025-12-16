import { NextRequest, NextResponse } from "next/server";
import { db, storage } from "@/lib/firebase";
import { collection, addDoc, serverTimestamp } from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { dataUrl, assetId, productId } = body;

    if (!dataUrl || !assetId || !productId) {
      return NextResponse.json(
        { error: "Missing dataUrl, assetId, or productId" },
        { status: 400 }
      );
    }

    // Expecting a data URL like "data:image/png;base64,AAAA..."
    const matches = dataUrl.match(/^data:image\/png;base64,(.+)$/);
    if (!matches) {
      return NextResponse.json(
        { error: "Invalid data URL format" },
        { status: 400 }
      );
    }

    const base64 = matches[1];
    const buffer = Buffer.from(base64, "base64");

    // 1) Upload to Firebase Storage
    const filename = `mockups/${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.png`;

    const fileRef = ref(storage, filename);
    await uploadBytes(fileRef, buffer, {
      contentType: "image/png",
    });

    const imageUrl = await getDownloadURL(fileRef);

    // 2) Create Firestore doc in mockups collection
    const colRef = collection(db, "mockups");
    const docRef = await addDoc(colRef, {
      assetId,
      productId,
      imageUrl,
      created_at: serverTimestamp(),
    });

    return NextResponse.json(
      {
        id: docRef.id,
        imageUrl,
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("Error in save-mockup API:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
