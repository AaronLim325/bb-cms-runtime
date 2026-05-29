import { revalidateTag, revalidatePath } from "next/cache";
import type { CollectionDescriptor } from "./types.js";

/**
 * THE CORE FIX for the "admin saves, frontend doesn't update" bug family.
 *
 * In Next 16, `revalidateTag` only purges the `unstable_cache` DATA entry. It
 * does NOT purge the Full Route Cache (the statically-prerendered HTML). A page
 * that read the collection at build/first-render keeps serving stale HTML until
 * its own time-based revalidate fires. The ONLY reliable fix is to ALSO call
 * `revalidatePath` for every public route that renders the collection.
 *
 * That is why a collection declares `consumers`: this function fans out a
 * `revalidatePath` to each of them. Skipping this is the Mayblossom bug.
 *
 * We use the "max" cache profile on revalidateTag so tagged reads are purged
 * as aggressively as possible.
 */
export function invalidateCollection(descriptor: CollectionDescriptor): void {
  // 1) Purge the cached data entry (the unstable_cache tag).
  revalidateTag(descriptor.tag, "max");
  // 2) Purge the static HTML for every page that renders this collection.
  for (const consumer of descriptor.consumers) {
    revalidatePath(consumer);
  }
}
