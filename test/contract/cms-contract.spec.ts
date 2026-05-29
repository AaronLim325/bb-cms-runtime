/**
 * CMS CONTRACT TEST (skeleton).
 *
 * Proves the end-to-end "admin saves → frontend updates" chain for each
 * collection. For each one:
 *   1. PUT a sentinel value through /api/data/<collection> (authed).
 *   2. wait 5s for Blob propagation + revalidation.
 *   3. GET the public consumer route (HTML) and assert the sentinel is rendered.
 *
 * This is the regression net for the FRC bug: if a consuming repo wires only
 * revalidateTag (no revalidatePath), step 3 FAILS because the static HTML is
 * stale. With createCmsRoute it passes.
 *
 * The consuming repo plugs in: base URL, admin cookie, and per-collection
 * sentinel field + read-back selector (see the TODOs).
 */
import { test, expect, request } from "@playwright/test";

// ---------------------------------------------------------------------------
// TODO(consumer): set these for your repo.
// ---------------------------------------------------------------------------

/** Base URL of the deployment under test (preview or prod). */
const BASE_URL = process.env.CMS_CONTRACT_BASE_URL ?? "http://localhost:3000";

/**
 * Admin auth cookie. Most BB repos use `bb_admin_session=<base64 user:pass>`.
 * TODO(consumer): provide via env so secrets never live in the repo.
 */
const ADMIN_COOKIE = process.env.CMS_CONTRACT_ADMIN_COOKIE ?? "";

/** One contract case per collection you want covered. */
interface ContractCase {
  /** Collection name as in your collection map / route allowlist. */
  collection: string;
  /** Public consumer route that renders it (must be in the descriptor's consumers). */
  consumer: `/${string}`;
  /**
   * Build the full collection payload to PUT, embedding `sentinel` somewhere
   * that the consumer page renders. Start from your real shape.
   * TODO(consumer): fill in a realistic payload per collection.
   */
  makePayload: (sentinel: string) => unknown;
  /**
   * Assert the sentinel is present in the rendered HTML. Default checks raw
   * substring; override for collections that transform the text.
   */
  assertRendered?: (html: string, sentinel: string) => void;
}

// TODO(consumer): replace with your real collections + payload shapes.
const CASES: ContractCase[] = [
  // Example shape — DELETE and replace:
  // {
  //   collection: "settings",
  //   consumer: "/",
  //   makePayload: (s) => ({ site_name: s, phone: "000" }),
  // },
];

// ---------------------------------------------------------------------------
// Harness (generic — consumers should not need to edit below).
// ---------------------------------------------------------------------------

function sentinel(): string {
  return `cms-contract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

test.describe("CMS save → frontend contract", () => {
  test.skip(CASES.length === 0, "No contract CASES defined — see TODO(consumer).");
  test.skip(!ADMIN_COOKIE, "CMS_CONTRACT_ADMIN_COOKIE not set — see TODO(consumer).");

  for (const c of CASES) {
    test(`${c.collection} → ${c.consumer} reflects a saved sentinel`, async () => {
      const value = sentinel();
      const api = await request.newContext({
        baseURL: BASE_URL,
        extraHTTPHeaders: { cookie: ADMIN_COOKIE },
      });

      // 1) PUT the sentinel.
      const put = await api.put(`/api/data/${c.collection}`, {
        data: c.makePayload(value),
        headers: { "content-type": "application/json" },
      });
      expect(put.ok(), `PUT ${c.collection} failed: ${put.status()}`).toBeTruthy();
      const body = await put.json();
      expect(body.ok, `PUT ${c.collection} returned ok:false`).toBeTruthy();

      // 2) Wait for propagation + revalidation.
      await new Promise((r) => setTimeout(r, 5000));

      // 3) GET the public consumer page and assert the sentinel rendered.
      const page = await api.get(c.consumer);
      expect(page.ok(), `GET ${c.consumer} failed: ${page.status()}`).toBeTruthy();
      const html = await page.text();
      if (c.assertRendered) {
        c.assertRendered(html, value);
      } else {
        expect(
          html.includes(value),
          `Sentinel "${value}" NOT found in ${c.consumer} HTML — ` +
            "static HTML is stale. Likely missing revalidatePath (FRC bug).",
        ).toBeTruthy();
      }

      await api.dispose();
    });
  }
});
