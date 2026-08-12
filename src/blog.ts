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
 * (the same secret the purge route already uses). Body: one article JSON
 * (`{ title, slug, excerpt?, body, coverImage?, coverImageAlt?, category?,
 * author?, publishedAt, updatedAt? }`). Cover images stay on THIS site's own
 * Blob — the OS never sends a blob token.
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

    let body: Record<string, unknown> | null;
    try {
      body = (await req.json()) as Record<string, unknown> | null;
    } catch {
      return NextResponse.json(
        { ok: false, error: "Invalid JSON body" },
        { status: 400 },
      );
    }
    if (!body || typeof body !== "object") {
      return NextResponse.json(
        { ok: false, error: "Body must be a single article object" },
        { status: 400 },
      );
    }

    const missing = INGEST_REQUIRED_FIELDS.filter((f) => {
      const v = body[f];
      return typeof v !== "string" || v.trim() === "";
    });
    if (missing.length > 0) {
      return NextResponse.json(
        { ok: false, error: `Missing required field(s): ${missing.join(", ")}` },
        { status: 400 },
      );
    }

    // Build the canonical BlogPost. Only known fields are carried across so the
    // OS can never inject arbitrary keys into this site's data document.
    const post: BlogPost = {
      title: (body.title as string).trim(),
      slug: (body.slug as string).trim(),
      excerpt: typeof body.excerpt === "string" ? body.excerpt : "",
      body: body.body as string,
      publishedAt: body.publishedAt as string,
    };
    if (typeof body.coverImage === "string") post.coverImage = body.coverImage;
    if (typeof body.coverImageAlt === "string") post.coverImageAlt = body.coverImageAlt;
    if (typeof body.author === "string") post.author = body.author;
    if (typeof body.category === "string") post.category = body.category;
    if (Array.isArray(body.keywords)) {
      post.keywords = (body.keywords as unknown[]).filter(
        (k): k is string => typeof k === "string",
      );
    }
    if (typeof body.updatedAt === "string") post.updatedAt = body.updatedAt;

    // Iron rule: never persist an EXTERNAL cover URL. Download any external
    // cover (e.g. an OS Supabase Storage URL) and re-host it on THIS site's own
    // Blob before saving. Falsy/relative/already-on-our-Blob covers pass through
    // unchanged; a failed transfer drops the cover (article text is priority).
    post.coverImage = await ensureLocalCover(post.coverImage, post.slug);

    // Write into THIS site's own Blob (its own BLOB_READ_WRITE_TOKEN in env).
    const result = await publishArticle(collection, post);
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: result.error ?? "Publish failed" },
        { status: 500 },
      );
    }

    // Revalidate the blog: purge the read tag + the list HTML + the article HTML
    // (mirrors what createRevalidateRoute/invalidateCollection do, plus the
    // [slug] page which is not in the collection's `consumers`). Failures here
    // never fail the write — the Blob is already persisted.
    try {
      revalidateTag(tag, "max");
      revalidatePath(listPath);
      revalidatePath(`${listPath.replace(/\/+$/, "")}/${result.slug}`);
    } catch (err) {
      console.warn("[cms-runtime:blog-ingest] revalidation skipped", err);
    }

    return NextResponse.json({ ok: true, slug: result.slug }, { status: 200 });
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
