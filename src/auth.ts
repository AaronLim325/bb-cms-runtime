/**
 * @bb/cms-runtime — shared CMS admin auth (two-tier model).
 *
 * Replaces the fleet's legacy single-shared-password scheme (a plaintext
 * `base64(user:password)` cookie validated against one weak `ADMIN_PASSWORD`
 * env, reused across ~11 client sites) with a two-tier model the runtime owns:
 *
 *  - BB MASTER password (`BB_MASTER_PASSWORD` env): one fleet-wide skeleton key,
 *    known to BB staff. ALWAYS grants access. The client cannot see, change, or
 *    remove it (it lives in Vercel env; clients have no Vercel access) — so BB
 *    can never be locked out of a client's own CMS.
 *  - CLIENT password: each site's client sets their own. Stored as a bcrypt
 *    HASH in Blob (`data/_auth.json`); the client self-manages it.
 *
 * Login accepts EITHER the client hash OR the master → in. The legacy
 * `ADMIN_PASSWORD` (e.g. 8888) is kept ONLY as the INITIAL default client
 * password: until the client sets their own, that default works but every
 * login via it returns `mustChange: true`, which the admin uses to force a
 * change-password modal. Master logins NEVER set `mustChange`.
 *
 * Session is a SIGNED token (HMAC-SHA256 over `issuedAt|expiresAt|mode` with a
 * server-only `cookieSecret`), NOT base64 plaintext — it carries no password and
 * cannot be forged without the secret, nor decoded into a credential.
 *
 * Brute-force defence: failed attempts are counted in `data/_auth.json` (so the
 * lockout actually holds across serverless instances — an in-memory counter
 * would reset per cold start). After `maxAttempts` failures, login is rejected
 * with a `lockedUntil` for `lockoutMinutes`. A SUCCESSFUL login clears it.
 *
 * Server-only: imports `node:crypto` and the Blob storage boundary. It is NOT
 * part of the `/client` barrel. The bcrypt hash blob is `access:"public"` like
 * the rest of the package's data blobs, so the hash (never plaintext) is the
 * thing at rest; the real perimeter is the signed cookie + bcrypt + lockout.
 */
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { readAuthStateRaw, writeAuthStateRaw } from "./storage.js";

/** The shape persisted to Blob `data/_auth.json`. */
export interface AuthState {
  /** bcrypt hash of the client's chosen password, or null if never set. */
  clientPasswordHash: string | null;
  /** True until the client sets their own password (drives the forced modal). */
  mustChange: boolean;
  /** Consecutive failed login attempts since the last success. */
  failedAttempts: number;
  /** ISO timestamp until which login is locked, or null. */
  lockedUntil: string | null;
}

const DEFAULT_STATE: AuthState = {
  clientPasswordHash: null,
  mustChange: true,
  failedAttempts: 0,
  lockedUntil: null,
};

/** How the login matched, when it succeeds. */
export type LoginMode = "master" | "client" | "default";

/** Result of {@link Auth.verifyLogin}. */
export type VerifyLoginResult =
  | { ok: true; mode: LoginMode; mustChange: boolean }
  | { ok: false; error: string; lockedUntil?: string };

/** Result of {@link Auth.changeClientPassword}. */
export type ChangePasswordResult = { ok: true } | { ok: false; error: string };

/** Public-facing auth state for the admin (no secrets). */
export interface PublicAuthState {
  clientPasswordSet: boolean;
  mustChange: boolean;
}

/** Options for {@link createAuth}. */
export interface CreateAuthOptions {
  /**
   * The BB fleet-wide master password (from `BB_MASTER_PASSWORD` env). ALWAYS
   * grants access. REQUIRED and must be non-empty — an empty master is a footgun
   * (it would let `""` log in), so {@link createAuth} throws on it.
   */
  masterPassword: string;
  /**
   * Server-only secret used to HMAC-sign the session cookie (from
   * `COOKIE_SECRET` env). REQUIRED and non-empty. Rotating it invalidates all
   * existing sessions.
   */
  cookieSecret: string;
  /**
   * The legacy default client password (the old `ADMIN_PASSWORD`, e.g. "8888").
   * Used ONLY as the initial client password until the client sets their own;
   * logging in with it returns `mustChange:true`. Optional — omit to disable the
   * default-password path entirely (then only the client hash or master work).
   */
  defaultClientPassword?: string;
  /** Minimum length for a client-chosen password. Default 8. */
  minPasswordLength?: number;
  /** Failed attempts before lockout. Default 5. */
  maxAttempts?: number;
  /** Lockout duration in minutes. Default 15. */
  lockoutMinutes?: number;
  /** Session lifetime in hours. Default 12. */
  sessionHours?: number;
  /** bcrypt cost factor. Default 12. */
  bcryptRounds?: number;
}

/** The object returned by {@link createAuth}. */
export interface Auth {
  /**
   * Verify a submitted password against (a) the master (constant-time),
   * (b) the client bcrypt hash, (c) the legacy default if no client hash is set
   * yet. Honours and updates the Blob-backed lockout counter.
   */
  verifyLogin(submittedPassword: string): Promise<VerifyLoginResult>;
  /**
   * Mint a signed session token for a cookie. `mode` records how the login
   * matched (only ever read for diagnostics; access is identical for all modes).
   */
  issueSessionCookie(mode?: LoginMode): string;
  /**
   * Parse + verify a session token from a cookie. Returns the payload when the
   * signature is valid AND it has not expired, else null. Use this in proxy.ts.
   */
  parseSession(cookieValue: string | undefined | null): SessionPayload | null;
  /**
   * Change the client password: verifies `current` (client hash OR default),
   * enforces strength, bcrypt-hashes `next`, persists it, and clears the
   * mustChange/default state. Used by the settings change-password page.
   */
  changeClientPassword(
    current: string,
    next: string,
  ): Promise<ChangePasswordResult>;
  /** Whether the admin should show the forced change-password popup. */
  getAuthState(): Promise<PublicAuthState>;
}

/** The verified contents of a session token. */
export interface SessionPayload {
  /** Random session id (so two logins differ even within the same second). */
  sid: string;
  /** Issued-at, epoch ms. */
  iat: number;
  /** Expiry, epoch ms. */
  exp: number;
  /** How the login matched. */
  mode: LoginMode;
}

/** Constant-time string compare that does not early-return on length. */
function safeStringEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // timingSafeEqual requires equal length; HMAC both sides to a fixed width so a
  // length mismatch can't leak via the length check itself.
  const ah = createHmac("sha256", "len-norm").update(ab).digest();
  const bh = createHmac("sha256", "len-norm").update(bb).digest();
  return timingSafeEqual(ah, bh);
}

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Read the auth state, coercing a missing/partial blob to the default shape. */
async function loadState(): Promise<AuthState> {
  const raw = (await readAuthStateRaw()) as Partial<AuthState> | null;
  if (!raw || typeof raw !== "object") return { ...DEFAULT_STATE };
  return {
    clientPasswordHash:
      typeof raw.clientPasswordHash === "string" ? raw.clientPasswordHash : null,
    mustChange:
      typeof raw.mustChange === "boolean"
        ? raw.mustChange
        : // No hash yet ⇒ still on the default ⇒ must change.
          typeof raw.clientPasswordHash !== "string",
    failedAttempts:
      typeof raw.failedAttempts === "number" && raw.failedAttempts >= 0
        ? raw.failedAttempts
        : 0,
    lockedUntil:
      typeof raw.lockedUntil === "string" ? raw.lockedUntil : null,
  };
}

/**
 * Create the auth helper. Throws if `masterPassword` or `cookieSecret` is empty
 * — failing closed at construction rather than silently allowing `""` in.
 */
export function createAuth(options: CreateAuthOptions): Auth {
  if (!options.masterPassword) {
    throw new Error(
      "[cms-runtime:auth] masterPassword (BB_MASTER_PASSWORD) is required and must be non-empty",
    );
  }
  if (!options.cookieSecret) {
    throw new Error(
      "[cms-runtime:auth] cookieSecret (COOKIE_SECRET) is required and must be non-empty",
    );
  }

  const masterPassword = options.masterPassword;
  const cookieSecret = options.cookieSecret;
  const defaultClientPassword = options.defaultClientPassword ?? "";
  const minPasswordLength = options.minPasswordLength ?? 8;
  const maxAttempts = options.maxAttempts ?? 5;
  const lockoutMs = (options.lockoutMinutes ?? 15) * 60 * 1000;
  const sessionMs = (options.sessionHours ?? 12) * 60 * 60 * 1000;
  const bcryptRounds = options.bcryptRounds ?? 12;

  function sign(payloadB64: string): string {
    return base64url(
      createHmac("sha256", cookieSecret).update(payloadB64).digest(),
    );
  }

  function issueSessionCookie(mode: LoginMode = "client"): string {
    const now = Date.now();
    const payload: SessionPayload = {
      sid: randomUUID(),
      iat: now,
      exp: now + sessionMs,
      mode,
    };
    const payloadB64 = base64url(Buffer.from(JSON.stringify(payload), "utf8"));
    return `${payloadB64}.${sign(payloadB64)}`;
  }

  function parseSession(
    cookieValue: string | undefined | null,
  ): SessionPayload | null {
    if (!cookieValue) return null;
    const dot = cookieValue.lastIndexOf(".");
    if (dot <= 0) return null;
    const payloadB64 = cookieValue.slice(0, dot);
    const sig = cookieValue.slice(dot + 1);
    const expected = sign(payloadB64);
    // Constant-time signature compare (equal length by construction).
    if (
      sig.length !== expected.length ||
      !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    ) {
      return null;
    }
    let payload: SessionPayload;
    try {
      const json = Buffer.from(
        payloadB64.replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
      ).toString("utf8");
      payload = JSON.parse(json) as SessionPayload;
    } catch {
      return null;
    }
    if (
      typeof payload.exp !== "number" ||
      typeof payload.iat !== "number" ||
      payload.exp <= Date.now()
    ) {
      return null;
    }
    return payload;
  }

  function lockoutActive(state: AuthState): string | null {
    if (!state.lockedUntil) return null;
    const until = Date.parse(state.lockedUntil);
    if (Number.isNaN(until) || until <= Date.now()) return null;
    return state.lockedUntil;
  }

  async function persist(state: AuthState): Promise<void> {
    await writeAuthStateRaw(state);
  }

  /** Record a failed attempt; arm the lockout when the threshold is reached. */
  async function registerFailure(state: AuthState): Promise<string | null> {
    const failedAttempts = state.failedAttempts + 1;
    let lockedUntil: string | null = state.lockedUntil;
    if (failedAttempts >= maxAttempts) {
      lockedUntil = new Date(Date.now() + lockoutMs).toISOString();
    }
    await persist({ ...state, failedAttempts, lockedUntil });
    // Only signal a lockout to the caller once it is actually armed.
    return failedAttempts >= maxAttempts ? lockedUntil : null;
  }

  async function clearFailures(state: AuthState): Promise<void> {
    if (state.failedAttempts === 0 && state.lockedUntil === null) return;
    await persist({ ...state, failedAttempts: 0, lockedUntil: null });
  }

  async function verifyLogin(
    submittedPassword: string,
  ): Promise<VerifyLoginResult> {
    const state = await loadState();

    const locked = lockoutActive(state);
    if (locked) {
      return {
        ok: false,
        error: "Too many failed attempts. Try again later.",
        lockedUntil: locked,
      };
    }

    if (typeof submittedPassword !== "string" || submittedPassword.length === 0) {
      const lk = await registerFailure(state);
      return lk
        ? { ok: false, error: "Incorrect password", lockedUntil: lk }
        : { ok: false, error: "Incorrect password" };
    }

    // 1) Master — constant-time. Always grants access, never mustChange.
    if (safeStringEqual(submittedPassword, masterPassword)) {
      await clearFailures(state);
      return { ok: true, mode: "master", mustChange: false };
    }

    // 2) Client hash, if the client has set their own password.
    if (state.clientPasswordHash) {
      const match = await bcrypt.compare(
        submittedPassword,
        state.clientPasswordHash,
      );
      if (match) {
        await clearFailures(state);
        return { ok: true, mode: "client", mustChange: false };
      }
    } else if (
      defaultClientPassword &&
      safeStringEqual(submittedPassword, defaultClientPassword)
    ) {
      // 3) Legacy default — only valid while no client hash is set. Forces change.
      await clearFailures(state);
      return { ok: true, mode: "default", mustChange: true };
    }

    const lk = await registerFailure(state);
    return lk
      ? { ok: false, error: "Incorrect password", lockedUntil: lk }
      : { ok: false, error: "Incorrect password" };
  }

  function checkStrength(next: string): string | null {
    if (typeof next !== "string" || next.length < minPasswordLength) {
      return `Password must be at least ${minPasswordLength} characters.`;
    }
    if (/^\d+$/.test(next)) {
      return "Password cannot be all numbers.";
    }
    return null;
  }

  async function changeClientPassword(
    current: string,
    next: string,
  ): Promise<ChangePasswordResult> {
    const state = await loadState();

    const locked = lockoutActive(state);
    if (locked) {
      return { ok: false, error: "Too many failed attempts. Try again later." };
    }

    // Verify `current`: master OR client hash OR (default while unset).
    let currentOk = false;
    if (safeStringEqual(current, masterPassword)) {
      currentOk = true;
    } else if (state.clientPasswordHash) {
      currentOk = await bcrypt.compare(current, state.clientPasswordHash);
    } else if (
      defaultClientPassword &&
      safeStringEqual(current, defaultClientPassword)
    ) {
      currentOk = true;
    }
    if (!currentOk) {
      await registerFailure(state);
      return { ok: false, error: "Current password is incorrect." };
    }

    const strengthError = checkStrength(next);
    if (strengthError) return { ok: false, error: strengthError };

    // Reject no-op changes that keep the site on a weak/known credential.
    if (defaultClientPassword && safeStringEqual(next, defaultClientPassword)) {
      return { ok: false, error: "Choose a password different from the default." };
    }
    if (safeStringEqual(next, masterPassword)) {
      return { ok: false, error: "Choose a different password." };
    }

    const hash = await bcrypt.hash(next, bcryptRounds);
    await persist({
      clientPasswordHash: hash,
      mustChange: false,
      failedAttempts: 0,
      lockedUntil: null,
    });
    return { ok: true };
  }

  async function getAuthState(): Promise<PublicAuthState> {
    const state = await loadState();
    return {
      clientPasswordSet: state.clientPasswordHash !== null,
      mustChange: state.mustChange,
    };
  }

  return {
    verifyLogin,
    issueSessionCookie,
    parseSession,
    changeClientPassword,
    getAuthState,
  };
}
