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

/**
 * The canonical shape of one blog article across every BB Media client site.
 *
 * A "blog" collection is a plain array of these under `data/blog.json`. `slug`
 * is the stable identity (the URL segment + the upsert key used by
 * {@link "./blog.js".publishArticle}). `body` is Markdown; each site renders it
 * however it likes. `coverImage`, when present, is an already-uploaded media
 * path (e.g. "/media/…") or a value a `<CmsImage>` can take as `src` — it is
 * NEVER a free-typed remote URL field (IR-26: images are real uploads).
 */
export interface BlogPost {
  /** Human title, shown as the H1 and in listings. */
  title: string;
  /** Stable URL segment + upsert identity, e.g. "spring-facial-guide". */
  slug: string;
  /** Short summary for cards/listings + meta description. */
  excerpt: string;
  /** Article body as Markdown. */
  body: string;
  /**
   * Optional cover image. An already-uploaded media path or a `<CmsImage>` src.
   * Never a "paste image URL" field.
   */
  coverImage?: string;
  /** Alt text for the cover image (accessibility + SEO). */
  coverImageAlt?: string;
  /** Optional author display name. */
  author?: string;
  /** Optional category label. */
  category?: string;
  /** Optional SEO keywords. */
  keywords?: string[];
  /** ISO 8601 publish timestamp. Posts with a FUTURE value are unpublished. */
  publishedAt: string;
  /** ISO 8601 last-updated timestamp. */
  updatedAt?: string;
}
