import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type { CollectionMap, WriteResult } from "./types.js";
import { emptyFor } from "./collections.js";
import { readCollectionRaw, writeCollectionRaw } from "./storage.js";
import { invalidateCollection } from "./revalidate.js";

/** Options for {@link createCmsRoute}. */
export interface CmsRouteOptions {
  /**
   * Returns true when the request is an authenticated admin. Each repo injects
   * its own scheme (cookie/password/etc). REQUIRED — there is no default
   * "allow", so a forgotten auth wiring fails closed.
   */
  isAuthed: () => Promise<boolean> | boolean;
  /**
   * Optional gate: return false to treat a collection as disabled (e.g. a
   * site-config module toggle). Returns 410 when disabled.
   */
  isEnabled?: (collection: string) => boolean;
  /**
   * Optional hook to validate/normalize the body before it is written. Throw to
   * reject (the route turns it into a loud 400). Return the value to persist.
   */
  validate?: (collection: string, body: unknown) => unknown | Promise<unknown>;
}

/** The Next 16 route-handler shape returned by {@link createCmsRoute}. */
export interface CmsRouteHandlers {
  GET: (
    req: NextRequest,
    ctx: { params: Promise<{ collection: string }> },
  ) => Promise<Response>;
  PUT: (
    req: NextRequest,
    ctx: { params: Promise<{ collection: string }> },
  ) => Promise<Response>;
}

/**
 * Build the `{ GET, PUT }` handlers for `app/api/data/[collection]/route.ts`.
 *
 * - GET reads the Blob (public).
 * - PUT writes the Blob THEN invalidates BOTH the tag AND every consumer path
 *   (the FRC fix), all wrapped in try/catch returning `{ok:false,error}` loudly.
 * - The allowlist is exactly the keys of `collections`; anything else → 404.
 */
export function createCmsRoute(
  collections: CollectionMap,
  options: CmsRouteOptions,
): CmsRouteHandlers {
  const allowlist = collections;

  function resolve(name: string) {
    return Object.prototype.hasOwnProperty.call(allowlist, name)
      ? allowlist[name]
      : undefined;
  }

  async function GET(
    _req: NextRequest,
    ctx: { params: Promise<{ collection: string }> },
  ): Promise<Response> {
    const { collection } = await ctx.params;
    const descriptor = resolve(collection);
    if (!descriptor) {
      return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    }
    if (options.isEnabled && !options.isEnabled(collection)) {
      return NextResponse.json({ ok: false, error: "Module disabled" }, { status: 410 });
    }
    try {
      const raw = await readCollectionRaw(collection);
      return NextResponse.json(raw === null ? emptyFor(descriptor) : raw);
    } catch (err) {
      // Reads fail soft to the empty shape so the public site never 500s,
      // but we still log loudly.
      console.error("[cms-runtime:GET]", collection, err);
      return NextResponse.json(emptyFor(descriptor));
    }
  }

  async function PUT(
    req: NextRequest,
    ctx: { params: Promise<{ collection: string }> },
  ): Promise<Response> {
    const { collection } = await ctx.params;
    const descriptor = resolve(collection);
    if (!descriptor) {
      return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    }
    if (options.isEnabled && !options.isEnabled(collection)) {
      return NextResponse.json({ ok: false, error: "Module disabled" }, { status: 410 });
    }
    if (!(await options.isAuthed())) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: "Invalid JSON body" } satisfies WriteResult,
        { status: 400 },
      );
    }

    try {
      if (options.validate) {
        body = await options.validate(collection, body);
      }
    } catch (err) {
      return NextResponse.json(
        {
          ok: false,
          error: err instanceof Error ? err.message : "Validation failed",
        } satisfies WriteResult,
        { status: 400 },
      );
    }

    try {
      // 1) Persist to Blob.
      await writeCollectionRaw(collection, body);
      // 2) Invalidate tag + EVERY consumer path. The FRC fix lives here.
      invalidateCollection(descriptor);
      return NextResponse.json({ ok: true } satisfies WriteResult);
    } catch (err) {
      // Fail LOUD: no swallowed catch. The caller gets ok:false + a 500.
      console.error("[cms-runtime:PUT]", collection, err);
      return NextResponse.json(
        {
          ok: false,
          error: err instanceof Error ? err.message : "Write failed",
        } satisfies WriteResult,
        { status: 500 },
      );
    }
  }

  return { GET, PUT };
}
