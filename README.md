# @bb/cms-runtime

Shared CMS save chain + media upload chain for BB Media's Next.js 16 + Vercel Blob
client websites. It exists to make two recurring, fleet-wide bug families
**structurally impossible** rather than re-fixing them in ~11 separate repos.

> **This README is the single canonical adoption guide.** It supersedes the old
> "clone the Mayblossom template as a gold-master" model (Mayblossom itself
> carried the FRC stale bug + a silent save — see disease D-035). For every Next
> 16 + Blob BB Media client site, the CMS save + media chains MUST come from this
> package (proposed Iron Rule IR-25), not from per-repo copies.

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

## Auth (two-tier admin login)

The fleet historically authed the CMS admin with a single weak shared password
(`ADMIN_PASSWORD`, e.g. `8888`) in env, checked in `proxy.ts` against a
plaintext-reversible `base64(user:password)` cookie. That is replaced — runtime
side — by a **two-tier** model owned by this package (`createAuth`, server-only,
import from `@bb/cms-runtime` or `@bb/cms-runtime/auth`):

| Tier | Where it lives | Who controls it | Login result |
|---|---|---|---|
| **BB master** | `BB_MASTER_PASSWORD` env | BB staff only (clients have no Vercel access) | always grants access; never `mustChange` |
| **Client password** | bcrypt **hash** in Blob `data/_auth.json` | the client (self-managed via a settings page) | grants access |
| **Legacy default** | the old `ADMIN_PASSWORD` value, passed as `defaultClientPassword` | — (initial only) | grants access **but** `mustChange:true` until the client sets their own |

Login accepts **either** the client hash **or** the master → in. The master is a
fleet-wide skeleton key so BB is never locked out of a client's own CMS. The
default works only until a client hash exists, and forces a change.

**Session** is a **signed** token (HMAC-SHA256 over `{sid,iat,exp,mode}` with
`COOKIE_SECRET`), with issued-at + expiry — NOT base64 plaintext, carries no
password, unforgeable without the secret. `parseSession()` is the helper
`proxy.ts` calls.

**Brute-force lockout** is Blob-backed (`failedAttempts` + `lockedUntil` in
`data/_auth.json`) so it holds **across serverless instances** — an in-memory
counter would reset on every cold start / new lambda and not actually defend the
master. After `maxAttempts` (default 5) failures, login is rejected with a
`lockedUntil` for `lockoutMinutes` (default 15). A successful login clears it.

> Caveat: `data/_auth.json` is an `access:"public"` blob like every other data
> blob this package writes (storage.ts is the single Blob boundary; nothing else
> may import `@vercel/blob`). Only the **bcrypt hash** (never a plaintext
> password) is at rest there; the real perimeter is the signed cookie + bcrypt +
> lockout. Hashing uses **bcryptjs** (pure-JS, runs on Vercel serverless).

### Env vars

| Var | Purpose |
|---|---|
| `BB_MASTER_PASSWORD` | fleet-wide master skeleton key (BB-only). REQUIRED, non-empty (else `createAuth` throws). |
| `COOKIE_SECRET` | server-only HMAC key for the session cookie. REQUIRED, non-empty. Rotating it logs everyone out. |
| `ADMIN_PASSWORD` | the legacy `8888`; pass its value as `defaultClientPassword`. Optional once every site has set a client password. |

### Blob shape — `data/_auth.json`

```jsonc
{
  "clientPasswordHash": "string|null", // bcrypt hash, or null until the client sets one
  "mustChange": true,                  // true until the client sets their own password
  "failedAttempts": 0,                 // consecutive failures since last success
  "lockedUntil": "ISO-8601|null"       // login locked until this time, or null
}
```

### `createAuth` API

```ts
import { createAuth } from "@bb/cms-runtime"; // or "@bb/cms-runtime/auth"

const auth = createAuth({
  masterPassword: process.env.BB_MASTER_PASSWORD!, // required, non-empty
  cookieSecret: process.env.COOKIE_SECRET!,        // required, non-empty
  defaultClientPassword: process.env.ADMIN_PASSWORD, // optional initial default
  minPasswordLength: 8,   // default 8
  maxAttempts: 5,         // default 5
  lockoutMinutes: 15,     // default 15
  sessionHours: 12,       // default 12
  bcryptRounds: 12,       // default 12
});

// Login route:
auth.verifyLogin(submitted): Promise<
  | { ok: true; mode: "master"|"client"|"default"; mustChange: boolean }
  | { ok: false; error: string; lockedUntil?: string }
>;
auth.issueSessionCookie(mode?): string;            // signed token to set as the cookie

// proxy.ts / middleware:
auth.parseSession(cookieValue): SessionPayload | null; // null = invalid/expired

// Settings change-password page:
auth.changeClientPassword(current, next): Promise<{ ok: true } | { ok: false; error: string }>;

// Admin shell (decide whether to show the forced modal):
auth.getAuthState(): Promise<{ clientPasswordSet: boolean; mustChange: boolean }>;
```

### Per-site adoption checklist (UI wired in a later pass)

1. **Set env**: `BB_MASTER_PASSWORD` (fleet value, BB-only), `COOKIE_SECRET`
   (random per site), keep `ADMIN_PASSWORD` for the default.
2. **`src/lib/auth.ts`**: `export const auth = createAuth({ ... })` from those env vars.
3. **Login route** (`app/api/admin/login/route.ts`): `await auth.verifyLogin(pw)`;
   on `ok`, set the session cookie to `auth.issueSessionCookie(result.mode)`
   (HttpOnly, Secure, SameSite=Lax); surface `mustChange` to the client so the
   admin shows the forced modal; on `!ok`, return `error` (+ `lockedUntil` if present).
4. **`proxy.ts` / middleware**: replace the old base64 check with
   `auth.parseSession(cookie) !== null`. The existing `createCmsRoute` /
   `createMediaUploadRoute` `isAuthed` callback becomes
   `() => auth.parseSession(cookieStore.get(NAME)?.value) !== null`.
5. **Change-password page** (settings): POST `{current, next}` →
   `auth.changeClientPassword(current, next)`; on `ok`, clear the forced modal.
6. **Forced-change modal**: on admin load call `auth.getAuthState()`; if
   `mustChange` (or login returned `mustChange`), block the admin behind the
   change-password modal until the client sets their own password.

## Distribution mechanism

**Target (steady state): GitHub Packages.** The package will be published to
**GitHub Packages** under the **Aaron-Lim** org as `@bb/cms-runtime`. Each client
repo then:

1. Adds an `.npmrc` mapping the `@bb` scope to GitHub Packages (see
   `.npmrc.example`) and a `GITHUB_PACKAGES_TOKEN` (`read:packages`) — set it in
   Vercel env for builds.
2. Adds `@bb/cms-runtime` as a dependency, **pinned to a version** (`^1.x`).
3. Upgrades fleet-wide via `npm i @bb/cms-runtime@^1`.

Publishing requires a `write:packages` PAT (supplied later); the `publishConfig`
block in `package.json` already points at `https://npm.pkg.github.com`.

**Now (pilot phase): local `file:` link.** Until the package is published, the 9
pilot repos depend on it via a local file link, NOT GitHub Packages. This is the
**proven** recipe — 3 sites built fully green this way:

1. In the client repo's `package.json`, add (path relative to the client repo):
   ```jsonc
   "dependencies": { "@bb/cms-runtime": "file:../bb-cms-runtime" }
   ```
2. Add an `.npmrc` to the client repo with:
   ```
   install-links=true
   ```
   A plain symlink install breaks with `Module not found: @vercel/blob` —
   `install-links=true` copies the package into `node_modules` so its peer
   resolution works. **Do not skip this.**
3. Install: `npm install --install-links`.
4. **Pin `turbopack.root`** in `next.config.ts` to the **parent dir** that holds
   BOTH repos, so Turbopack can see the linked package:
   ```ts
   const nextConfig = { turbopack: { root: "/Users/aaron/Documents" }, /* ... */ };
   ```
   **Revert this once the package is published** — GitHub Packages installs into
   `node_modules` normally and needs no root pin.
5. **If a duplicate-`next` typecheck clash appears** (two copies of `next` types
   resolving), symlink the package's bundled `next` to the host's:
   ```bash
   ln -sfn "$CLIENT_REPO/node_modules/next" "../bb-cms-runtime/node_modules/next"
   ```

When the package goes to GitHub Packages: swap the `file:` dep for `^1.x`, drop
`install-links=true` and the `turbopack.root` pin, and replace `.npmrc` with the
scope→registry mapping from `.npmrc.example`.

## How to adopt in an existing client repo

A mechanical swap — the API mirrors Playplex's idioms on purpose (Playplex is the
cleanest reference, 8.5/10, and was the pilot). Eligible repos are **Next 16 +
Blob** sites (MAYBLOSSOM- or JOSEN-pattern). BLISS-pattern (Vite SPA) is out of
scope; Eastern Bay must be upgraded to Next 16 first.

1. **Install** via the pilot `file:` link or GitHub Packages — see *Distribution
   mechanism* above for the exact `.npmrc` / `install-links` / `turbopack.root`
   steps. Pilot phase: `file:../bb-cms-runtime` + `install-links=true` +
   `npm install --install-links`.

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

10. **Verify (build + smoke):**
    - `npm run build` locally to catch type/import breaks.
    - `grep -rln "@vercel/blob" src/` should show imports ONLY in `src/storage.ts`
      (or the package), never in components.
    - `grep -rn "revalidateTag" src/app/api` should be empty after the swap — the
      package owns revalidation; no hand-rolled `revalidateTag`-only routes.
    - `grep -rn "unoptimized" next.config.*` must be absent.
    - **True-green is the Vercel build, not local.** Admin pages that prerender
      Blob content need `BLOB_READ_WRITE_TOKEN` set in the environment, so a
      fully-clean signal comes from the Vercel preview/production build — local
      can pass while a Blob-prerendering admin page would fail without the token.
      After deploy, smoke the save chain: save in `/admin`, confirm the public
      page reflects it (the FRC fix means no manual cache-bust).

## Invariants

- Fail loud, never silent. Every write returns `{ok,error}`; no swallowed catch.
- No hardcoded hostnames, no `unoptimized:true`, no external CDN URLs by default.
- `src/storage.ts` is the only module that imports `@vercel/blob`.
- Auth fails closed: no master/secret ⇒ `createAuth` throws; the session cookie
  is HMAC-signed (never plaintext); brute-force state is Blob-backed so lockout
  survives serverless cold starts.

## Adoption status

Pilot adoption is on `feat/cms-runtime-pilot` branches. 9 Next 16 + Blob sites
adopted; 3 not yet (reasons below).

| Site | Stack | Status |
|---|---|---|
| Josen | Next 16 + Blob (JOSEN-pattern) | Adopted (pilot branch) |
| Gyumono | Next 16 + Blob (JOSEN-pattern) | Adopted (pilot branch) |
| Zovel | Next 16 + Blob (JOSEN-pattern) | Adopted (pilot branch) |
| Playplex | Next 16.1 + Blob (MAYBLOSSOM-pattern, 15 collections) | Adopted — cleanest reference + pilot |
| XR | Next 16 + Blob (MAYBLOSSOM-pattern) | Adopted (pilot branch) |
| Mayblossom | Next 16 + Blob (MAYBLOSSOM-pattern) | Adopted (pilot branch) |
| Difan | Next 16 + Blob (MAYBLOSSOM-pattern) | Adopted (pilot branch) |
| 6-Cloud (customer site) | Next 16.1 + Blob (MAYBLOSSOM-pattern) | Adopted (pilot branch) |
| Auroe | Next 16.1 + Blob (MAYBLOSSOM-pattern) | Adopted (pilot branch) |
| Eastern Bay | **Next 15.2** | Not yet — needs Next 16 upgrade first |
| Noon Moment | Next 16.1, no data layer | Not yet — no CMS data layer wired |
| Bliss | Vite SPA (BLISS-pattern) | Out of scope — not a Next 16 + Blob site |

See `STACK_VARIANTS.md` (BB IT Team knowledge library) for the variant taxonomy
and proposed `IR-25` for the dependency rule.
