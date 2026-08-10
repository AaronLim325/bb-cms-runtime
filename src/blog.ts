/**
 * Blog capability for @bb/cms-runtime.
 *
 * The base data route's PUT OVERWRITES the whole collection document. That is
 * correct for admin JSON editors that own the full array, but it makes an
 * append ("publish one new article") impossible without first reading, mutating,
 * and re-writing the whole array client-side. {@link publishArticle} closes that
 * gap server-side: read → upsert-by-slug → write → invalidate, atomically from
 * the caller's point of view.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type { BlogPost, CollectionDescriptor, CollectionMap } from "./types.js";
import { readCollectionRaw, writeCollectionRaw } from "./storage.js";
import { invalidateCollection } from "./revalidate.js";

/** Options for {@link publishArticle}. */
export interface PublishArticleOptions {
  /**
   * The collection descriptor, used to invalidate the read tag + every consumer
   * path after the write (the same fan-out {@link invalidateCollection} does).
   *
   * When omitted, invalidation is SKIPPED — appropriate for an out-of-band node
   * script that runs outside a Next.js request/render context (where
   * `revalidateTag`/`revalidatePath` are unavailable). Such callers should
   * instead purge afterwards via a {@link createRevalidateRoute} POST (the BB OS
   * cron path). Even when a descriptor IS passed, invalidation failures never
   * fail the write — the Blob is already persisted.
   */
  descriptor?: CollectionDescriptor;
  /** Clock injection for tests. Defaults to `() => new Date()`. */
  now?: () => Date;
}

/** The envelope returned by {@link publishArticle}. */
export interface PublishArticleResult {
  ok: boolean;
  slug: string;
  /** "created" when the slug was new, "updated" when an existing post replaced. */
  mode?: "created" | "updated";
  error?: string;
}

function isBlogPostArray(v: unknown): v is BlogPost[] {
  return Array.isArray(v);
}

/**
 * Upsert one article into a blog collection by slug — the append fix.
 *
 * Reads the current `data/<collection>.json` array (fallback `[]`), replaces the
 * post whose slug matches or appends when new, writes the whole array back via
 * the storage boundary, THEN invalidates (when a descriptor is supplied) so an
 * out-of-band write never serves stale HTML/data.
 */
export async function publishArticle(
  collectionName: string,
  post: BlogPost,
  opts: PublishArticleOptions = {},
): Promise<PublishArticleResult> {
  const slug = post.slug?.trim();
  if (!slug) {
    return { ok: false, slug: post.slug ?? "", error: "Post is missing a slug" };
  }
  if (!post.title?.trim()) {
    return { ok: false, slug, error: "Post is missing a title" };
  }

  const now = (opts.now ?? (() => new Date()))().toISOString();
  const normalized: BlogPost = {
    ...post,
    slug,
    publishedAt: post.publishedAt || now,
    updatedAt: now,
  };

  try {
    const raw = await readCollectionRaw(collectionName);
    const list: BlogPost[] = isBlogPostArray(raw) ? [...raw] : [];

    const idx = list.findIndex((p) => p.slug === slug);
    let mode: "created" | "updated";
    if (idx >= 0) {
      list[idx] = normalized;
      mode = "updated";
    } else {
      list.push(normalized);
      mode = "created";
    }

    await writeCollectionRaw(collectionName, list);

    // Invalidate exactly the way the data route's PUT does. Wrapped so a
    // non-Next caller (standalone script) still returns ok after the write.
    if (opts.descriptor) {
      try {
        invalidateCollection(opts.descriptor);
      } catch (err) {
        console.warn(
          "[cms-runtime:publishArticle] invalidation skipped (no Next runtime?)",
          err,
        );
      }
    }

    return { ok: true, slug, mode };
  } catch (err) {
    console.error("[cms-runtime:publishArticle]", collectionName, err);
    return {
      ok: false,
      slug,
      error: err instanceof Error ? err.message : "Publish failed",
    };
  }
}

/** Options for {@link createRevalidateRoute}. */
export interface RevalidateRouteOptions {
  /**
   * Shared secret the external caller must present as `Authorization: Bearer
   * <secret>`. When falsy the route fails CLOSED (500) so a missing env var can
   * never leave the purge endpoint open.
   */
  secret: string | undefined;
  /**
   * The same collection map the reader/route use, so the descriptor (tag +
   * consumers) can never drift from what the reader tags.
   */
  collections: CollectionMap;
}

/** The Next 16 route-handler shape returned by {@link createRevalidateRoute}. */
export interface RevalidateRouteHandlers {
  POST: (req: NextRequest) => Promise<Response>;
}

/**
 * Build a `{ POST }` handler that lets an EXTERNAL system (e.g. the BB OS cron)
 * purge the CMS caches after it writes a collection's Blob directly — the write
 * path that does NOT go through the data route's PUT, so nothing else would ever
 * call `invalidateCollection` for it.
 *
 * Body: `{ "collection": "<name>" }` invalidates that one; an empty body /
 * `{ "collection": "*" }` invalidates EVERY collection in the map. Auth is a
 * bearer token compared to `secret`.
 */
export function createRevalidateRoute(
  options: RevalidateRouteOptions,
): RevalidateRouteHandlers {
  async function POST(req: NextRequest): Promise<Response> {
    if (!options.secret) {
      console.error("[cms-runtime:revalidate] no secret configured — failing closed");
      return NextResponse.json(
        { ok: false, error: "Revalidate route not configured" },
        { status: 500 },
      );
    }

    const auth = req.headers.get("authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    if (token !== options.secret) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    let target: string | undefined;
    try {
      const body = (await req.json()) as { collection?: string } | null;
      target = body?.collection;
    } catch {
      // No/invalid body → treat as "all".
      target = undefined;
    }

    const names =
      !target || target === "*"
        ? Object.keys(options.collections)
        : [target];

    const revalidated: string[] = [];
    const unknown: string[] = [];
    for (const name of names) {
      const descriptor = options.collections[name];
      if (!descriptor) {
        unknown.push(name);
        continue;
      }
      invalidateCollection(descriptor);
      revalidated.push(name);
    }

    if (revalidated.length === 0 && unknown.length > 0) {
      return NextResponse.json(
        { ok: false, error: "Unknown collection", unknown },
        { status: 404 },
      );
    }

    return NextResponse.json({ ok: true, revalidated, unknown });
  }

  return { POST };
}

/** One sitemap entry shape (mirrors Next's MetadataRoute.Sitemap element). */
export interface BlogSitemapEntry {
  url: string;
  lastModified: string;
  changeFrequency:
    | "always"
    | "hourly"
    | "daily"
    | "weekly"
    | "monthly"
    | "yearly"
    | "never";
  priority: number;
}

/**
 * Map published posts to sitemap entries at `<baseUrl>/blog/<slug>`. Pass an
 * already-published, sorted list (e.g. the site's `getPublishedPosts()`); this
 * helper does not re-filter by date so a caller keeps one publish policy.
 */
export function blogSitemapEntries(
  posts: readonly BlogPost[],
  baseUrl: string,
): BlogSitemapEntry[] {
  const base = baseUrl.replace(/\/+$/, "");
  return posts.map((p) => ({
    url: `${base}/blog/${p.slug}`,
    lastModified: p.updatedAt || p.publishedAt,
    changeFrequency: "monthly",
    priority: 0.6,
  }));
}
