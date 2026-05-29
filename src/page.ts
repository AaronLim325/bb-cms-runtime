import type { ComponentType } from "react";

/**
 * Cache mode a CMS-backed page must explicitly opt into. There is no implicit
 * "static prerender" mode — that is exactly what lets HTML go stale.
 *
 * - "force-dynamic": the page is rendered per request. Pair the export below.
 * - "use-cache":     the page uses Next 16 `'use cache'` + cacheTag so it is
 *                    purged by the SAME tag the writer revalidates.
 */
export type CmsPageCacheMode = "force-dynamic" | "use-cache";

export interface CmsPageOptions {
  /** REQUIRED — pick the page's cache strategy explicitly. */
  cacheMode: CmsPageCacheMode;
  /**
   * For cacheMode:"use-cache" — the cache tag(s) this page is keyed by. These
   * MUST be the tags of the collections it renders so the writer's
   * `revalidateTag` purges this page. Required when cacheMode is "use-cache".
   */
  cacheTags?: readonly string[];
}

/**
 * The `dynamic` route-segment value a page module should re-export when using
 * cacheMode "force-dynamic":
 *
 * @example
 * export const dynamic = cmsPageDynamic("force-dynamic"); // "force-dynamic"
 */
export function cmsPageDynamic(mode: CmsPageCacheMode): string {
  // For "force-dynamic" the route segment config value is literally
  // "force-dynamic". For "use-cache" the page should NOT set `dynamic`; it uses
  // the `'use cache'` directive + cacheTag instead, so we return "auto".
  return mode === "force-dynamic" ? "force-dynamic" : "auto";
}

/**
 * Wrap a CMS-backed page component to make its cache mode explicit and to
 * surface a misconfiguration (use-cache without tags) loudly at module load.
 *
 * This does NOT magically rewrite the page's caching — Next route-segment config
 * is static. It (a) forces the author to declare the mode, (b) validates the
 * combination, and (c) returns the matching `dynamic` value to re-export.
 *
 * @example
 * function HomePage() { ... }
 * export default cmsPage(HomePage, { cacheMode: "force-dynamic" }).Page;
 * export const dynamic = cmsPage(HomePage, { cacheMode: "force-dynamic" }).dynamic;
 */
export function cmsPage<P extends object>(
  Component: ComponentType<P>,
  opts: CmsPageOptions,
): { Page: ComponentType<P>; dynamic: string; cacheMode: CmsPageCacheMode } {
  if (opts.cacheMode === "use-cache") {
    if (!opts.cacheTags || opts.cacheTags.length === 0) {
      throw new Error(
        '[cms-runtime] cmsPage with cacheMode:"use-cache" MUST pass cacheTags ' +
          "matching the collections it renders, or the page can never be " +
          "purged by the writer's revalidateTag.",
      );
    }
  }
  return {
    Page: Component,
    dynamic: cmsPageDynamic(opts.cacheMode),
    cacheMode: opts.cacheMode,
  };
}
