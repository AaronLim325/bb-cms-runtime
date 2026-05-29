/**
 * The Blob boundary. This is the ONLY module in @bb/cms-runtime that imports
 * @vercel/blob. Mirrors Playplex's src/lib/storage.ts so adoption is mechanical.
 */
import { put, list, del } from "@vercel/blob";

export const BLOB_DATA_PREFIX = "data/";
export const BLOB_MEDIA_PREFIX = "media/";

export interface StoredBlob {
  url: string;
  pathname: string;
  size: number;
  uploadedAt: string;
}

/** Read a collection's JSON document. Returns null when no Blob exists yet. */
export async function readCollectionRaw(
  collection: string,
): Promise<unknown | null> {
  const { blobs } = await list({ prefix: `${BLOB_DATA_PREFIX}${collection}.json` });
  const url = blobs[0]?.url;
  if (!url) return null;
  // cache:"no-store" is mandatory: the freshness boundary is the unstable_cache
  // wrapper in the reader, NOT this fetch. If this fetch is cached, the reader's
  // tag invalidation can never see new data (the Difan bug).
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;
  return res.json();
}

/** Overwrite a collection's JSON document. */
export async function writeCollectionRaw(
  collection: string,
  data: unknown,
): Promise<void> {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  await put(`${BLOB_DATA_PREFIX}${collection}.json`, blob, {
    access: "public",
    allowOverwrite: true,
    // Edge cache must NOT hold the JSON; the framework cache (tags) owns freshness.
    cacheControlMaxAge: 0,
  });
}

export async function listMedia(): Promise<StoredBlob[]> {
  const { blobs } = await list({ prefix: BLOB_MEDIA_PREFIX });
  return blobs
    .map((b) => ({
      url: b.url,
      pathname: b.pathname,
      size: b.size ?? 0,
      uploadedAt:
        b.uploadedAt instanceof Date
          ? b.uploadedAt.toISOString()
          : String(b.uploadedAt),
    }))
    .sort(
      (a, b) =>
        new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime(),
    );
}

export async function mediaUsageBytes(): Promise<number> {
  const { blobs } = await list({ prefix: BLOB_MEDIA_PREFIX });
  return blobs.reduce((sum, b) => sum + (b.size ?? 0), 0);
}

export async function putMedia(
  pathname: string,
  body: Buffer | ArrayBuffer | Blob,
  contentType: string,
): Promise<{ url: string; pathname: string }> {
  const blob = await put(pathname, body as ArrayBuffer | Blob, {
    access: "public",
    allowOverwrite: false,
    contentType,
  });
  return { url: blob.url, pathname: blob.pathname };
}

export async function deleteMedia(url: string): Promise<void> {
  await del(url);
}

/**
 * The auth state document path. A single JSON blob under the data prefix, owned
 * by {@link "./auth.js"}. Kept here so this module remains the ONLY @vercel/blob
 * importer. See `AuthState` in auth.ts for the shape.
 */
export const BLOB_AUTH_PATH = `${BLOB_DATA_PREFIX}_auth.json`;

/** Read the raw auth-state document. Returns null when no blob exists yet. */
export async function readAuthStateRaw(): Promise<unknown | null> {
  const { blobs } = await list({ prefix: BLOB_AUTH_PATH });
  // Exact-match guard: list() is a prefix scan, so "_auth.json" could also
  // surface a hypothetical "_auth.json.bak". Pick the exact pathname only.
  const match = blobs.find((b) => b.pathname === BLOB_AUTH_PATH);
  const url = match?.url;
  if (!url) return null;
  // no-store: auth state must never be edge-cached or a stale lockout/hash lingers.
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;
  return res.json();
}

/** Overwrite the auth-state document. */
export async function writeAuthStateRaw(data: unknown): Promise<void> {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  await put(BLOB_AUTH_PATH, blob, {
    access: "public",
    allowOverwrite: true,
    cacheControlMaxAge: 0,
  });
}
