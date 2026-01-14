import 'server-only';
import admin from 'firebase-admin';

let _app: admin.app.App | null = null;

function getApp() {
  // Reuse existing app if hot reloaded / reused
  if (_app) return _app;
  if (admin.apps.length) {
    _app = admin.app();
    return _app;
  }

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const bucket = process.env.FIREBASE_STORAGE_BUCKET;

  // IMPORTANT: don't crash the build. Only throw when actually used at runtime.
  if (raw) {
    const svc = JSON.parse(raw);
    _app = admin.initializeApp({
      credential: admin.credential.cert(svc),
      storageBucket: bucket,
    });
    return _app;
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    _app = admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      storageBucket: bucket,
    });
    return _app;
  }

  throw new Error(
    'Missing FIREBASE_SERVICE_ACCOUNT_JSON (preferred) or GOOGLE_APPLICATION_CREDENTIALS'
  );
}

export function adminDb() {
  return getApp().firestore();
}

export function adminBucket() {
  return getApp().storage().bucket();
}

export const FieldValue = admin.firestore.FieldValue;
