/**
 * @bb/cms-runtime — server entry.
 *
 * Shared CMS save + media chain for BB Media client websites. Import the client
 * `<CmsImage>` from "@bb/cms-runtime/client" and the next.config helper from
 * "@bb/cms-runtime/config".
 */

// Types
export type {
  RoutePath,
  CollectionOptions,
  CollectionDescriptor,
  CollectionMap,
  WriteResult,
} from "./types.js";

// Collection definition
export { defineCollection, defineCollections, emptyFor } from "./collections.js";

// Read chain
export {
  cmsRead,
  createReader,
  CMS_READ_REVALIDATE_SECONDS,
  type CmsReader,
} from "./reader.js";

// Write/route chain (the FRC fix)
export {
  createCmsRoute,
  type CmsRouteOptions,
  type CmsRouteHandlers,
} from "./route.js";
export { invalidateCollection } from "./revalidate.js";

// Page cache-mode guard
export {
  cmsPage,
  cmsPageDynamic,
  type CmsPageCacheMode,
  type CmsPageOptions,
} from "./page.js";

// Media upload chain (egress guard)
export {
  createMediaUploadRoute,
  type MediaUploadOptions,
  type MediaUploadHandlers,
} from "./media.js";

// Auth chain (two-tier master + client-hash, signed cookie, lockout). Server-only.
export {
  createAuth,
  type Auth,
  type CreateAuthOptions,
  type LoginMode,
  type VerifyLoginResult,
  type ChangePasswordResult,
  type PublicAuthState,
  type SessionPayload,
  type AuthState,
} from "./auth.js";

// Storage boundary (the only @vercel/blob importer)
export {
  readCollectionRaw,
  writeCollectionRaw,
  listMedia,
  mediaUsageBytes,
  putMedia,
  deleteMedia,
  readAuthStateRaw,
  writeAuthStateRaw,
  BLOB_DATA_PREFIX,
  BLOB_MEDIA_PREFIX,
  BLOB_AUTH_PATH,
  type StoredBlob,
} from "./storage.js";
