import { unstable_cache } from "next/cache";
import type { CollectionDescriptor, CollectionMap } from "./types.js";
import { emptyFor } from "./collections.js";
import { readCollectionRaw } from "./storage.js";

/**
 * The READ chain. Wraps the Blob fetch in `unstable_cache` keyed + tagged by the
 * collection's tag, with `revalidate: 60`. Critically, the tag is ALWAYS wired
 * (Difan's bug was reading with no-store and never tagging, so revalidateTag was
 * a no-op). The inner Blob fetch uses cache:"no-store" — see storage.ts.
 */
export const CMS_READ_REVALIDATE_SECONDS = 60;

/** Read one collection with caching + tagging. */
export function cmsRead<T>(
  descriptor: CollectionDescriptor,
  fallback: T,
): Promise<T> {
  const cached = unstable_cache(
    async (): Promise<T> => {
      const raw = await readCollectionRaw(descriptor.name);
      if (raw === null) return fallback;
      if (descriptor.singleton) {
        // Merge over the fallback so newly-added fields keep a default.
        return { ...(fallback as object), ...(raw as object) } as T;
      }
      return raw as T;
    },
    // The unstable_cache key MUST include the tag so each collection is a
    // distinct cache entry.
    [descriptor.tag],
    { tags: [descriptor.tag], revalidate: CMS_READ_REVALIDATE_SECONDS },
  );
  return cached();
}

/** A typed reader bound to a collection map: `reader.read("services", [])`. */
export interface CmsReader {
  read<T>(collection: string, fallback: T): Promise<T>;
  descriptor(collection: string): CollectionDescriptor;
}

/**
 * Build a reader bound to the same collection map the route uses, so reads and
 * writes can never drift on tag/name.
 */
export function createReader(collections: CollectionMap): CmsReader {
  function descriptor(collection: string): CollectionDescriptor {
    const d = collections[collection];
    if (!d) {
      throw new Error(
        `[cms-runtime] Unknown collection "${collection}". Declared: ${Object.keys(
          collections,
        ).join(", ")}`,
      );
    }
    return d;
  }
  return {
    descriptor,
    read<T>(collection: string, fallback: T): Promise<T> {
      return cmsRead<T>(descriptor(collection), fallback);
    },
  };
}

/** Re-exported for callers that want the empty shape (e.g. building fallbacks). */
export { emptyFor };
