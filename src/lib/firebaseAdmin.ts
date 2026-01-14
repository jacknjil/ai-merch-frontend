import 'server-only';
import admin from 'firebase-admin';

let _app: admin.app.App | null = null;

function getAdminApp() {
  if (_app) return _app;
  if (admin.apps.length) {
    _app = admin.app();
    return _app;
  }

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const bucket = process.env.FIREBASE_STORAGE_BUCKET;

  // Option A: JSON in env var (best for docker env-file)
  if (raw) {
    const svc = JSON.parse(raw);
    _app = admin.initializeApp({
      credential: admin.credential.cert(svc),
      storageBucket: bucket,
    });
    return _app;
  }

  // Option B: File path (mount JSON into container)
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    _app = admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      storageBucket: bucket,
    });
    return _app;
  }

  // IMPORTANT: this throw is OK because it's inside getAdminApp()
  // and won't execute during build unless you call adminDb/adminBucket.
  throw new Error(
    'Missing FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS'
  );
}

export function adminDb() {
  return getAdminApp().firestore();
}

export function adminBucket() {
  return getAdminApp().storage().bucket();
}

export const FieldValue = admin.firestore.FieldValue;
