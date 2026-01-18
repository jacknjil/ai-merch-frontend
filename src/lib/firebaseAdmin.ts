// src/lib/firebaseAdmin.ts
import 'server-only';

import {
  getApps,
  initializeApp,
  cert,
  applicationDefault,
} from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import type { ServiceAccount } from 'firebase-admin/app';
import type { Bucket } from '@google-cloud/storage';

function parseServiceAccount(): ServiceAccount {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const rawB64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;

  if (raw) {
    try {
      return JSON.parse(raw) as ServiceAccount;
    } catch {
      throw new Error(
        'FIREBASE_SERVICE_ACCOUNT_JSON is set but is not valid JSON. Tip: use FIREBASE_SERVICE_ACCOUNT_B64 to avoid escaping issues.',
      );
    }
  }

  if (rawB64) {
    try {
      const decoded = Buffer.from(rawB64, 'base64').toString('utf8');
      return JSON.parse(decoded) as ServiceAccount;
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_B64 is set but is invalid.');
    }
  }

  throw new Error(
    'Missing FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_B64',
  );
}

const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
if (!bucketName) {
  throw new Error(
    'Missing FIREBASE_STORAGE_BUCKET (e.g. your-project-id.firebasestorage.app)',
  );
}

const adminApp =
  getApps().length > 0
    ? getApps()[0]
    : initializeApp(
        process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
          process.env.FIREBASE_SERVICE_ACCOUNT_B64
          ? {
              credential: cert(parseServiceAccount()),
              storageBucket: bucketName,
            }
          : { credential: applicationDefault(), storageBucket: bucketName },
      );

// ✅ export VALUES (not functions)
export const adminDb = getFirestore(adminApp);
export const adminBucket: Bucket = getStorage(adminApp).bucket(bucketName);
export { FieldValue };
