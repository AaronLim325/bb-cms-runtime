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
import { revalidatePath, revalidateTag } from "next/cache";
import type { BlogPost, CollectionDescriptor, CollectionMap } from "./types.js";
import { createHash } from "node:crypto";
import { readCollectionRaw, writeCollectionRaw, putMedia } from "./storage.js";
import { invalidateCollection } from "./revalidate.js";

/** Vercel Blob's public host — a cover already on this host is site-owned. */
const VERCEL_BLOB_HOST = "public.blob.vercel-storage.com";

/** Map an image content-type to a file extension (default "bin" for unknown). */
function extForContentType(contentType: string): string {
  const ct = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  switch (ct) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/avif":
      return "avif";
    case "image/svg+xml":
      return "svg";
    default:
      return "bin";
  }
}

/**
 * Enforce BB's iron rule for blog covers: an article must never permanently
 * render an EXTERNAL image URL (fragile + may fall outside the site's
 * next.config image whitelist → 裂图). Given a cover URL:
 *
 * - falsy, a relative path ("/..."), or already on THIS site's own Vercel Blob
 *   → returned unchanged (already local / site-owned).
 * - otherwise EXTERNAL (Supabase Storage, any http/https host) → download the
 *   bytes and re-host them on THIS site's own Blob via {@link putMedia}, then
 *   return the resulting Blob URL. The pathname is content-addressed
 *   (`media/blog-covers/<slug>-<hash>.<ext>`) so a re-ingest of the same bytes
 *   is idempotent (overwrite-tolerant, never fails).
 *
 * ANY failure in the transfer (fetch not ok, network error, upload error) →
 * logs and returns `undefined` (drop the cover). Better no cover than an
 * external one — and the article text is the priority, so this never throws.
 */
export async function ensureLocalCover(
  coverUrl: string | undefined,
  slug: string,
): Promise<string | undefined> {
  if (!coverUrl) return coverUrl;
  // Relative path or already on our own Blob → already site-owned, leave as-is.
  if (coverUrl.startsWith("/")) return coverUrl;
  if (coverUrl.includes(VERCEL_BLOB_HOST)) return coverUrl;

  // External host → download bytes → re-upload through our own pipeline.
  try {
    const res = await fetch(coverUrl);
    if (!res.ok) {
      console.warn(
        `[cms-runtime:ensureLocalCover] fetch ${res.status} for ${coverUrl} — dropping cover`,
      );
      return undefined;
    }
    const arrayBuffer = await res.arrayBuffer();
    const contentType =
      (res.headers.get("content-type")?.split(";")[0] ?? "").trim() ||
      "image/jpeg";
    const ext = extForContentType(contentType);
    const hash = createHash("sha256")
      .update(Buffer.from(arrayBuffer))
      .digest("hex")
      .slice(0, 10);
    const pathname = `media/blog-covers/${slug}-${hash}.${ext}`;
    // Content-addressed pathname → re-ingesting the same bytes is idempotent;
    // allowOverwrite tolerates the re-write so a re-ingest never fails.
    const { url } = await putMedia(pathname, arrayBuffer, contentType, {
      allowOverwrite: true,
    });
    return url;
  } catch (err) {
    console.error(
      `[cms-runtime:ensureLocalCover] transfer failed for ${coverUrl} — dropping cover`,
      err,
    );
    return undefined;
  }
}

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

/** The envelope returned by {@link publishArticles} (the batch upsert). */
export interface PublishArticlesResult {
  ok: boolean;
  /** The slugs upserted, in input order. Empty on a validation/write failure. */
  slugs: string[];
  /** Per-article upsert mode, parallel to {@link slugs}. */
  results?: { slug: string; mode: "created" | "updated" }[];
  error?: string;
}

function isBlogPostArray(v: unknown): v is BlogPost[] {
  return Array.isArray(v);
}

/**
 * Upsert MANY articles into a blog collection by slug in ONE read-modify-write —
 * the batch fix (CW-061). Reads `data/<collection>.json` ONCE, upserts every post
 * by slug into the in-memory array, writes the whole array back ONCE, THEN
 * invalidates ONCE (when a descriptor is supplied).
 *
 * This is the race-free replacement for calling {@link publishArticle} in a loop:
 * N sequential single-article publishes each do their OWN read-modify-write, and
 * Vercel Blob's list()-read lag between rapid writes lets a later write clobber an
 * earlier one (2 delivered → only 1 survives). Doing the whole batch in one
 * read-modify-write makes that structurally impossible.
 *
 * Validation mirrors {@link publishArticle}: every post needs a non-empty slug +
 * title, else the WHOLE batch is rejected (nothing is written) with an error
 * naming the offending slug.
 */
export async function publishArticles(
  collectionName: string,
  posts: BlogPost[],
  opts: PublishArticleOptions = {},
): Promise<PublishArticlesResult> {
  if (!Array.isArray(posts) || posts.length === 0) {
    return { ok: false, slugs: [], error: "No posts to publish" };
  }

  const now = (opts.now ?? (() => new Date()))().toISOString();
  const normalizedList: BlogPost[] = [];
  for (const post of posts) {
    const slug = post.slug?.trim();
    if (!slug) {
      return { ok: false, slugs: [], error: "A post is missing a slug" };
    }
    if (!post.title?.trim()) {
      return { ok: false, slugs: [], error: `Post "${slug}" is missing a title` };
    }
    normalizedList.push({
      ...post,
      slug,
      publishedAt: post.publishedAt || now,
      updatedAt: now,
    });
  }

  try {
    // ONE read for the whole batch.
    const raw = await readCollectionRaw(collectionName);
    const list: BlogPost[] = isBlogPostArray(raw) ? [...raw] : [];

    const results: { slug: string; mode: "created" | "updated" }[] = [];
    for (const normalized of normalizedList) {
      const idx = list.findIndex((p) => p.slug === normalized.slug);
      if (idx >= 0) {
        list[idx] = normalized;
        results.push({ slug: normalized.slug, mode: "updated" });
      } else {
        list.push(normalized);
        results.push({ slug: normalized.slug, mode: "created" });
      }
    }

    // ONE write for the whole batch.
    await writeCollectionRaw(collectionName, list);

    // ONE invalidation, exactly the way the data route's PUT does. Wrapped so a
    // non-Next caller (standalone script) still returns ok after the write.
    if (opts.descriptor) {
      try {
        invalidateCollection(opts.descriptor);
      } catch (err) {
        console.warn(
          "[cms-runtime:publishArticles] invalidation skipped (no Next runtime?)",
          err,
        );
      }
    }

    return { ok: true, slugs: results.map((r) => r.slug), results };
  } catch (err) {
    console.error("[cms-runtime:publishArticles]", collectionName, err);
    return {
      ok: false,
      slugs: [],
      error: err instanceof Error ? err.message : "Publish failed",
    };
  }
}

/**
 * Upsert ONE article into a blog collection by slug — the append fix. Delegates
 * to {@link publishArticles} so the single-article and batch paths share one
 * read-modify-write implementation. Other callers still import this unchanged.
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

  const res = await publishArticles(collectionName, [post], opts);
  if (!res.ok) {
    return { ok: false, slug, error: res.error };
  }
  return { ok: true, slug, mode: res.results?.[0]?.mode };
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

/** Options for {@link createBlogIngestRoute}. */
export interface BlogIngestRouteOptions {
  /**
   * Shared secret the external caller (the BB OS content engine) must present as
   * `Authorization: Bearer <secret>`. Defaults to `process.env.BLOG_REVALIDATE_SECRET`
   * — the SAME env var the {@link createRevalidateRoute} purge endpoint uses, so a
   * site wires ONE secret for both doors. When falsy the route fails CLOSED (500)
   * so a missing env var can never leave the ingest endpoint open.
   */
  secret?: string;
  /** Blog collection name (the `data/<collection>.json` document). Defaults to "blog". */
  collection?: string;
  /**
   * Public list route that renders the blog index, revalidated after every
   * ingest. Defaults to "/blog". The individual article path is derived as
   * `<listPath>/<slug>`.
   */
  listPath?: string;
  /** Cache tag purged after ingest. Defaults to the collection name (matches `defineCollection`'s tag default). */
  tag?: string;
}

/** The Next 16 route-handler shape returned by {@link createBlogIngestRoute}. */
export interface BlogIngestRouteHandlers {
  POST: (req: NextRequest) => Promise<Response>;
}

/** Required fields on an ingest payload — everything else on {@link BlogPost} is optional. */
const INGEST_REQUIRED_FIELDS = ["title", "slug", "body", "publishedAt"] as const;

/**
 * Build a `{ POST }` handler that lets an EXTERNAL system (the BB OS content
 * engine) PUBLISH one article INTO this site — without the OS ever holding this
 * site's Blob token. The OS POSTs the article JSON here; THIS site writes it into
 * its OWN Vercel Blob (via {@link publishArticle}, using this site's own
 * `BLOB_READ_WRITE_TOKEN` already in env) and revalidates the blog. This is the
 * secure standard: no cross-site token sprawl (CW-061 Phase 2).
 *
 * Auth: `Authorization: Bearer <secret>` compared to `BLOG_REVALIDATE_SECRET`
 * (the same secret the purge route already uses). Cover images stay on THIS
 * site's own Blob — the OS never sends a blob token.
 *
 * Body — accepts EITHER shape (CW-061 batch fix):
 *   - a single article object `{ title, slug, excerpt?, body, coverImage?,
 *     coverImageAlt?, category?, author?, publishedAt, updatedAt? }`
 *     → response `{ ok: true, slug }` (backward-compatible), OR
 *   - a batch: a bare array `[ {…}, {…} ]` OR `{ articles: [ {…}, {…} ] }`
 *     → response `{ ok: true, slugs: [...] }`.
 *
 * The WHOLE batch is written in ONE read-modify-write (via
 * {@link publishArticles}) so rapid sequential single-article POSTs can no
 * longer clobber each other through Vercel Blob's list()-read lag. If ANY
 * article in a batch is missing a required field the WHOLE request is rejected
 * 400 (naming which), and nothing is written.
 */
export function createBlogIngestRoute(
  options: BlogIngestRouteOptions = {},
): BlogIngestRouteHandlers {
  const collection = options.collection ?? "blog";
  const listPath = options.listPath ?? "/blog";
  const tag = options.tag ?? collection;

  async function POST(req: NextRequest): Promise<Response> {
    const secret = options.secret ?? process.env.BLOG_REVALIDATE_SECRET;
    if (!secret) {
      console.error("[cms-runtime:blog-ingest] no secret configured — failing closed");
      return NextResponse.json(
        { ok: false, error: "Blog ingest route not configured" },
        { status: 500 },
      );
    }

    const auth = req.headers.get("authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    if (token !== secret) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    let parsed: unknown;
    try {
      parsed = await req.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: "Invalid JSON body" },
        { status: 400 },
      );
    }

    // Normalize to an array of raw article objects. Accept a single object
    // (legacy, → { slug } response), a bare array, or { articles: [...] }.
    let rawArticles: unknown[];
    let isSingle = false;
    if (Array.isArray(parsed)) {
      rawArticles = parsed;
    } else if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { articles?: unknown }).articles)
    ) {
      rawArticles = (parsed as { articles: unknown[] }).articles;
    } else if (parsed && typeof parsed === "object") {
      rawArticles = [parsed];
      isSingle = true;
    } else {
      return NextResponse.json(
        { ok: false, error: "Body must be an article object, an array, or { articles: [...] }" },
        { status: 400 },
      );
    }

    if (rawArticles.length === 0) {
      return NextResponse.json(
        { ok: false, error: "No articles provided" },
        { status: 400 },
      );
    }

    // Validate EVERY article up front. If any is missing a required field the
    // WHOLE request is rejected (naming which) and nothing is written.
    const problems: string[] = [];
    rawArticles.forEach((item, i) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        problems.push(`article[${i}] is not an object`);
        return;
      }
      const b = item as Record<string, unknown>;
      const missing = INGEST_REQUIRED_FIELDS.filter((f) => {
        const v = b[f];
        return typeof v !== "string" || v.trim() === "";
      });
      if (missing.length > 0) {
        const slug = typeof b.slug === "string" && b.slug.trim() ? b.slug.trim() : "?";
        problems.push(`article[${i}] (slug=${slug}) missing: ${missing.join(", ")}`);
      }
    });
    if (problems.length > 0) {
      return NextResponse.json(
        { ok: false, error: `Missing required field(s): ${problems.join("; ")}` },
        { status: 400 },
      );
    }

    // Build the canonical BlogPosts. Only known fields are carried across so the
    // OS can never inject arbitrary keys into this site's data document. Each
    // cover is re-hosted onto THIS site's own Blob (iron rule: never persist an
    // EXTERNAL cover URL — falsy/relative/already-local pass through, a failed
    // transfer drops the cover since article text is the priority).
    const posts: BlogPost[] = [];
    for (const item of rawArticles) {
      const b = item as Record<string, unknown>;
      const post: BlogPost = {
        title: (b.title as string).trim(),
        slug: (b.slug as string).trim(),
        excerpt: typeof b.excerpt === "string" ? b.excerpt : "",
        body: b.body as string,
        publishedAt: b.publishedAt as string,
      };
      if (typeof b.coverImage === "string") post.coverImage = b.coverImage;
      if (typeof b.coverImageAlt === "string") post.coverImageAlt = b.coverImageAlt;
      if (typeof b.author === "string") post.author = b.author;
      if (typeof b.category === "string") post.category = b.category;
      if (Array.isArray(b.keywords)) {
        post.keywords = (b.keywords as unknown[]).filter(
          (k): k is string => typeof k === "string",
        );
      }
      if (typeof b.updatedAt === "string") post.updatedAt = b.updatedAt;

      post.coverImage = await ensureLocalCover(post.coverImage, post.slug);
      posts.push(post);
    }

    // ONE read-modify-write for the WHOLE batch (CW-061): no per-article blob
    // read/write, so rapid sequential deliveries can no longer clobber.
    const result = await publishArticles(collection, posts);
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: result.error ?? "Publish failed" },
        { status: 500 },
      );
    }

    // Revalidate the blog ONCE: purge the read tag + the list HTML + every
    // article HTML (mirrors createRevalidateRoute/invalidateCollection, plus the
    // [slug] pages which are not in the collection's `consumers`). Failures here
    // never fail the write — the Blob is already persisted.
    try {
      revalidateTag(tag, "max");
      revalidatePath(listPath);
      const base = listPath.replace(/\/+$/, "");
      for (const slug of result.slugs) {
        revalidatePath(`${base}/${slug}`);
      }
    } catch (err) {
      console.warn("[cms-runtime:blog-ingest] revalidation skipped", err);
    }

    // Single-object body keeps the legacy { ok, slug } shape; a batch returns
    // { ok, slugs }.
    return isSingle
      ? NextResponse.json({ ok: true, slug: result.slugs[0] }, { status: 200 })
      : NextResponse.json({ ok: true, slugs: result.slugs }, { status: 200 });
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
