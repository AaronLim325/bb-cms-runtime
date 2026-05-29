/**
 * Shared types for @bb/cms-runtime.
 *
 * A "collection" is one Blob-backed JSON document (a list like `services`, or a
 * SINGLETON like `settings`). Every collection declares the public route paths
 * that render it (`consumers`) so the save chain can invalidate BOTH the data
 * tag AND the static HTML for those paths — the core fix for the
 * "admin saves, frontend doesn't update" bug family.
 */

/** A public route path that renders a collection, e.g. "/" or "/services". */
export type RoutePath = `/${string}`;

/** Options accepted by {@link defineCollection}. */
export interface CollectionOptions {
  /**
   * The cache tag used by both the reader (`unstable_cache` tags) and the
   * writer (`revalidateTag`). Defaults to the collection name. Keep it stable
   * and unique per collection.
   */
  tag?: string;
  /**
   * Public route paths that render this collection. The save route calls
   * `revalidatePath(consumer)` for EVERY entry here. If a collection appears on
   * a statically-prerendered page, that page MUST be listed or its HTML goes
   * stale (the Mayblossom bug). An empty list is allowed only for collections
   * that are never rendered on a public route (e.g. policy docs read live).
   */
  consumers: readonly RoutePath[];
  /**
   * Whether the Blob document is a single object (`{}`) rather than a list
   * (`[]`). Controls the empty/fallback shape returned when no Blob exists yet.
   */
  singleton?: boolean;
}

/** A frozen, fully-resolved collection descriptor. */
export interface CollectionDescriptor {
  readonly name: string;
  readonly tag: string;
  readonly consumers: readonly RoutePath[];
  readonly singleton: boolean;
}

/** A map of collection-name → descriptor, produced from {@link defineCollection} results. */
export type CollectionMap = Record<string, CollectionDescriptor>;

/** The envelope returned by every write. Never silently succeeds or fails. */
export type WriteResult =
  | { ok: true }
  | { ok: false; error: string };
