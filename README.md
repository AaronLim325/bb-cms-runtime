# @bb/cms-runtime

Shared CMS save chain + media upload chain for BB Media's Next.js 16 + Vercel Blob
client websites. It exists to make two recurring, fleet-wide bug families
**structurally impossible** rather than re-fixing them in 11 separate repos.

## The problem family

BB Media runs ~11 independent Next.js 16 + Vercel Blob sites, each cloned from a
template, each with a hand-rolled CMS. The same bugs keep recurring:

### A) "Admin saves, frontend doesn't update" — 4 root causes seen in 5 months
1. Blob never actually written.
2. `updateTag` throws E872 inside a route handler (must use `revalidateTag`).
3. Admin re-reads and races the Blob overwrite.
4. **Next 16 Full Route Cache (FRC) not cleared.** `revalidateTag` only purges
   the `unstable_cache` *data* entry — NOT the statically-prerendered HTML. The
   fix is to call **`revalidatePath` ALONGSIDE `revalidateTag`** for every page
   that renders the collection. This is the #1 trap; even the "gold master"
   template (Mayblossom) shipped with only `revalidateTag` and no
   `revalidatePath`, so its public HTML went stale.

### B) Blob egress blowout
Raw `<img src={blobUrl}>`, `images.unoptimized:true`, CSS `background-image:url(blob)`,
and raw/HEVC video. Several sites hit 5–27 GB per billing cycle.

## The 6 pillars (the public API)

| Pillar | Export | What it bakes in |
|---|---|---|
| 1. Collection model | `defineCollection` / `defineCollections` | Each collection declares the `consumers` (route paths) it renders. |
| 2. Save route | `createCmsRoute` | PUT writes Blob, then `revalidateTag(tag,"max")` **AND** `revalidatePath(consumer)` for every consumer. Fail-loud `{ok,error}`. |
| 3. Read chain | `cmsRead` / `createReader` | `unstable_cache` with the tag **actually wired** + `revalidate:60`; inner fetch `no-store`. |
| 4. Page guard | `cmsPage` | Forces an explicit cache mode so a page can't silently fall into static-prerender + stale HTML. |
| 5. Media upload | `createMediaUploadRoute` | sharp `rotate→resize(1600)→webp(75)`, animated-webp for gif, **rejects HEVC/H.265, >3 MB, >720p** video. Zero bypass. |
| 6. Image render + config | `CmsImage` (`/client`) + `cmsImagesConfig` (`/config`) | `unoptimized` is unrepresentable at the type level; `sizes`+`quality` mandatory; avif/webp + 1-year cache. |

## Distribution mechanism

This package is published to **GitHub Packages** under the **Aaron-Lim** org as
`@bb/cms-runtime`. Each client repo:

1. Adds an `.npmrc` mapping the `@bb` scope to GitHub Packages (see
   `.npmrc.example`) and a `GITHUB_PACKAGES_TOKEN` (read:packages) — set it in
   Vercel env for builds.
2. Adds `@bb/cms-runtime` as a dependency, **pinned to a version** (`^1.x`).
3. Upgrades fleet-wide via `npm i @bb/cms-runtime@^1`.

Publishing requires a `write:packages` PAT (supplied later); the `publishConfig`
block in `package.json` already points at `https://npm.pkg.github.com`.

## How to adopt in an existing client repo

A mechanical swap — the API mirrors Playplex's idioms on purpose.

1. **Install:** add `.npmrc` (from `.npmrc.example`), then
   `npm i @bb/cms-runtime`.

2. **Declare collections** (e.g. `src/lib/collections.ts`):
   ```ts
   import { defineCollection, defineCollections } from "@bb/cms-runtime";
   export const collections = defineCollections([
     defineCollection("services", { consumers: ["/", "/services"] }),
     defineCollection("settings", { consumers: ["/"], singleton: true }),
   ]);
   ```

3. **Swap the data route** (`src/app/api/data/[collection]/route.ts`):
   ```ts
   import { createCmsRoute } from "@bb/cms-runtime";
   import { collections } from "@/lib/collections";
   import { isAuthed } from "@/lib/auth";
   export const { GET, PUT } = createCmsRoute(collections, { isAuthed });
   ```

4. **Swap reads** (`src/lib/fetch-data.ts`):
   ```ts
   import { createReader } from "@bb/cms-runtime";
   import { collections } from "@/lib/collections";
   const reader = createReader(collections);
   export const getServices = () => reader.read("services", [] as Service[]);
   ```

5. **Swap the upload route** (`src/app/api/media/upload/route.ts`):
   ```ts
   import { createMediaUploadRoute } from "@bb/cms-runtime";
   import { isAuthed } from "@/lib/auth";
   export const { POST } = createMediaUploadRoute({ isAuthed, storageCapMb: 500 });
   ```

6. **Replace `<img>` / `next/image`** with `<CmsImage sizes=... quality={75} />`
   from `@bb/cms-runtime/client`.

7. **Spread the images config** into `next.config.ts`:
   ```ts
   import { cmsImagesConfig } from "@bb/cms-runtime/config";
   const nextConfig = { images: cmsImagesConfig() };
   ```

8. **Guard CMS pages** with an explicit cache mode:
   ```ts
   import { cmsPage } from "@bb/cms-runtime";
   export default cmsPage(HomePage, { cacheMode: "force-dynamic" }).Page;
   export const dynamic = "force-dynamic";
   ```

9. **Wire the contract test** (`test/contract/cms-contract.spec.ts`): fill in the
   `CASES` payloads + admin cookie, then run against a preview deployment.

## Invariants

- Fail loud, never silent. Every write returns `{ok,error}`; no swallowed catch.
- No hardcoded hostnames, no `unoptimized:true`, no external CDN URLs by default.
- `src/storage.ts` is the only module that imports `@vercel/blob`.
