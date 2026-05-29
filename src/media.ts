import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import sharp from "sharp";
import { mediaUsageBytes, putMedia } from "./storage.js";

/** Options for {@link createMediaUploadRoute}. */
export interface MediaUploadOptions {
  /** Returns true for an authenticated admin. REQUIRED (fails closed). */
  isAuthed: () => Promise<boolean> | boolean;
  /** Hard storage cap in MB for the media prefix. Upload is rejected if exceeded. */
  storageCapMb: number;
  /** Per-file ceiling in MB (after which even images are rejected). Default 15. */
  maxFileMb?: number;
  /** Per-video ceiling in MB. Default 3. */
  maxVideoMb?: number;
  /** sharp resize width for images. Default 1600. Lower = less egress. */
  imageMaxWidth?: number;
  /** webp quality 1-100. Default 75. */
  webpQuality?: number;
}

export interface MediaUploadHandlers {
  POST: (req: NextRequest) => Promise<Response>;
}

const HEVC_FOURCCS = ["hvc1", "hev1", "hvcC"];

/**
 * Probe a video buffer for HEVC/H.265. ISO-BMFF (mp4/mov) stores codec config in
 * an `hvcC`/`hev1`/`hvc1` box; we scan the first 256 KB for those fourCCs. This
 * is a heuristic (no full demux) but reliably catches iPhone HEVC clips, which
 * are the egress offenders. Pre-compressed H.264/AAC mp4 passes.
 */
function looksLikeHevc(buf: Buffer): boolean {
  const window = buf.subarray(0, Math.min(buf.length, 256 * 1024)).toString("latin1");
  return HEVC_FOURCCS.some((fcc) => window.includes(fcc));
}

/**
 * Best-effort height probe for ISO-BMFF video via the `tkhd` track-header box.
 * Returns the largest track height found, or null if undetectable. Used to
 * reject >720p uploads. Conservative: if we cannot read it, we do NOT block on
 * resolution (size cap still applies).
 */
function probeVideoHeight(buf: Buffer): number | null {
  let best: number | null = null;
  let idx = buf.indexOf("tkhd");
  while (idx !== -1) {
    // tkhd: after the 4-byte type, version(1)+flags(3), then version-dependent
    // fields. width/height are the last two 32.32 fixed-point fields in the box.
    const version = buf[idx + 4];
    // Offsets of width/height relative to the start of the box payload differ by
    // version (v1 uses 64-bit times). width@-8, height@-4 from box end is hard
    // without the box size, so compute from known field layout.
    const base = idx + 4 + 4; // skip "tkhd" + version/flags
    const timesBytes = version === 1 ? 8 + 8 + 4 + 8 : 4 + 4 + 4 + 4;
    // base + times + reserved(8) + layer(2)+altgroup(2)+volume(2)+reserved(2)
    // + matrix(36) -> then width(4) height(4)
    const whStart = base + timesBytes + 8 + 8 + 36;
    if (whStart + 8 <= buf.length) {
      const height = buf.readUInt16BE(whStart + 4); // integer part of 16.16 fixed
      if (height > 0 && (best === null || height > best)) best = height;
    }
    idx = buf.indexOf("tkhd", idx + 4);
  }
  return best;
}

/**
 * Build the POST handler for `app/api/media/upload/route.ts`.
 *
 * Enforces, with ZERO bypass path:
 * - images  → sharp().rotate().resize({width,withoutEnlargement}).webp({quality})
 * - gif     → animated webp
 * - svg     → passed through (no raster transcode)
 * - video   → reject HEVC/H.265, reject > maxVideoMb, reject > 720p; otherwise
 *             pass through (no server-side transcode available)
 */
export function createMediaUploadRoute(
  options: MediaUploadOptions,
): MediaUploadHandlers {
  const maxFileBytes = (options.maxFileMb ?? 15) * 1024 * 1024;
  const maxVideoBytes = (options.maxVideoMb ?? 3) * 1024 * 1024;
  const imageWidth = options.imageMaxWidth ?? 1600;
  const quality = options.webpQuality ?? 75;
  const capBytes = options.storageCapMb * 1024 * 1024;

  async function POST(req: NextRequest): Promise<Response> {
    if (!(await options.isAuthed())) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    let file: File | null;
    try {
      const formData = await req.formData();
      file = formData.get("file") as File | null;
    } catch (err) {
      console.error("[cms-runtime:media] formData", err);
      return NextResponse.json({ ok: false, error: "Invalid form data" }, { status: 400 });
    }
    if (!file) {
      return NextResponse.json({ ok: false, error: "No file provided" }, { status: 400 });
    }
    if (file.size > maxFileBytes) {
      return NextResponse.json(
        { ok: false, error: `File too large. Max ${maxFileBytes / 1024 / 1024} MB.` },
        { status: 400 },
      );
    }

    const mime = file.type.toLowerCase();
    const isVideo = mime.startsWith("video/");
    const isGif = mime === "image/gif";
    const isSvg = mime === "image/svg+xml";
    const isImage = mime.startsWith("image/") && !isGif && !isSvg;

    try {
      const inputBuffer = Buffer.from(await file.arrayBuffer());
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "");
      const baseName = safeName.replace(/\.[^.]+$/, "") || "file";

      let uploadBuffer: Buffer = inputBuffer;
      let finalExt = safeName.split(".").pop() ?? "bin";
      let finalMime = file.type;

      if (isImage) {
        uploadBuffer = await sharp(inputBuffer)
          .rotate() // bake EXIF orientation into pixels (portrait phone shots)
          .resize({ width: imageWidth, withoutEnlargement: true })
          .webp({ quality })
          .toBuffer();
        finalExt = "webp";
        finalMime = "image/webp";
      } else if (isGif) {
        uploadBuffer = await sharp(inputBuffer, { animated: true })
          .webp({ quality })
          .toBuffer();
        finalExt = "webp";
        finalMime = "image/webp";
      } else if (isVideo) {
        if (file.size > maxVideoBytes) {
          return NextResponse.json(
            {
              ok: false,
              error: `Video too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max ${
                maxVideoBytes / 1024 / 1024
              } MB; pre-compress first.`,
            },
            { status: 400 },
          );
        }
        if (looksLikeHevc(inputBuffer)) {
          return NextResponse.json(
            {
              ok: false,
              error:
                "HEVC/H.265 video is not allowed (Safari-only, huge egress). Re-export as H.264 MP4.",
            },
            { status: 400 },
          );
        }
        const height = probeVideoHeight(inputBuffer);
        if (height !== null && height > 720) {
          return NextResponse.json(
            {
              ok: false,
              error: `Video resolution too high (${height}p). Max 720p; downscale first.`,
            },
            { status: 400 },
          );
        }
        // passes: H.264-ish mp4 within size + resolution caps → store as-is.
      } else if (!isSvg) {
        // Unknown, non-svg, non-image, non-video type: reject loudly.
        return NextResponse.json(
          { ok: false, error: `Unsupported file type "${mime || "unknown"}".` },
          { status: 400 },
        );
      }

      // Storage cap check uses the FINAL (compressed) size.
      const used = await mediaUsageBytes();
      if (used + uploadBuffer.byteLength > capBytes) {
        return NextResponse.json(
          {
            ok: false,
            error: `Storage cap reached (${(used / 1024 / 1024).toFixed(1)}MB / ${
              options.storageCapMb
            }MB).`,
          },
          { status: 400 },
        );
      }

      const pathname = `media/${Date.now()}-${baseName}.${finalExt}`;
      const result = await putMedia(pathname, uploadBuffer, finalMime);
      return NextResponse.json({ ok: true, ...result });
    } catch (err) {
      console.error("[cms-runtime:media] POST", err);
      return NextResponse.json(
        { ok: false, error: err instanceof Error ? err.message : "Upload failed" },
        { status: 500 },
      );
    }
  }

  return { POST };
}
