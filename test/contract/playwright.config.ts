import { defineConfig } from "@playwright/test";

/**
 * Contract-test config. Run against a real deployment (preview or prod):
 *
 *   CMS_CONTRACT_BASE_URL=https://<preview>.vercel.app \
 *   CMS_CONTRACT_ADMIN_COOKIE="bb_admin_session=..." \
 *   npx playwright test -c test/contract/playwright.config.ts
 *
 * These tests WRITE real collections, so point them at a disposable/preview
 * deployment, or use sentinel-only fields that are safe to overwrite.
 */
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // writes share Blob state; keep serial
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.CMS_CONTRACT_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
  },
});
