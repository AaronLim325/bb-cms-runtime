/**
 * next.config.ts image config helper.
 *
 * The return type DELIBERATELY omits `unoptimized`, making
 * `cmsImagesConfig({ unoptimized: true })` a type error and the raw-egress
 * footgun unrepresentable. Spread the result into `next.config.ts`:
 *
 * @example
 * import { cmsImagesConfig } from "@bb/cms-runtime/config";
 * const nextConfig = { images: cmsImagesConfig() };
 */

/** A single allowed remote image host pattern (next/image remotePatterns entry). */
export interface RemotePattern {
  protocol: "https" | "http";
  hostname: string;
  port?: string;
  pathname?: string;
}

/** The images block we emit. Note: NO `unoptimized` field exists here. */
export interface CmsImagesConfig {
  formats: ("image/avif" | "image/webp")[];
  minimumCacheTTL: number;
  remotePatterns: RemotePattern[];
}

export interface CmsImagesConfigOptions {
  /** Extra remote hosts to allow (e.g. a partner CDN). Vercel Blob is always included. */
  extraRemotePatterns?: RemotePattern[];
  /** Override the long cache TTL (seconds). Default 1 year. */
  minimumCacheTTL?: number;
}

const VERCEL_BLOB_PATTERN: RemotePattern = {
  protocol: "https",
  hostname: "*.public.blob.vercel-storage.com",
};

/**
 * Returns the `images` block for next.config.ts with optimization ON, avif/webp
 * formats, a 1-year minimum cache TTL, and the Vercel Blob host allowlisted.
 * `unoptimized:true` is structurally impossible (not in the type).
 */
export function cmsImagesConfig(
  options: CmsImagesConfigOptions = {},
): CmsImagesConfig {
  return {
    formats: ["image/avif", "image/webp"],
    minimumCacheTTL: options.minimumCacheTTL ?? 31536000,
    remotePatterns: [VERCEL_BLOB_PATTERN, ...(options.extraRemotePatterns ?? [])],
  };
}
