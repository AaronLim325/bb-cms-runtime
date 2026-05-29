"use client";

import Image from "next/image";
import type { ComponentProps } from "react";

type NextImageProps = ComponentProps<typeof Image>;

/**
 * Props for {@link CmsImage}.
 *
 * - `unoptimized` is removed AND retyped to `never`, so passing it is a compile
 *   error: the raw-egress footgun is unrepresentable.
 * - `sizes` and `quality` are REQUIRED — next/image without `sizes` on a `fill`
 *   or responsive image silently ships the largest candidate (egress), and an
 *   unset quality defaults high. Forcing both keeps transfer bounded.
 */
export type CmsImageProps = Omit<NextImageProps, "unoptimized" | "sizes" | "quality"> & {
  /** REQUIRED responsive sizes hint, e.g. "(max-width: 768px) 100vw, 50vw". */
  sizes: string;
  /** REQUIRED quality 1-100. 75 is the house default; pass it explicitly. */
  quality: number;
  /** @deprecated Never allowed — optimization is mandatory. */
  unoptimized?: never;
};

/**
 * Drop-in replacement for next/image for all CMS/Blob-sourced media. Optimization
 * is always on; `sizes` and `quality` are mandatory.
 */
export function CmsImage(props: CmsImageProps) {
  // Spread is safe: `unoptimized` is typed `never`, so it can never be present.
  return <Image {...props} />;
}

export default CmsImage;
