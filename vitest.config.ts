import { defineConfig } from "vitest/config";

/**
 * Test files that exercise the context stores through the public API only,
 * so they run unchanged against both storage backends. The "postgres"
 * project exists only when DATABASE_URL is set (see tests/helpers/backend.ts).
 */
const SHARED = [
  "tests/spec-conformance.test.ts",
  "tests/fuzz-invariants.test.ts",
  "tests/timeline.test.ts",
  "tests/decisions-outcomes.test.ts",
  "tests/history.test.ts",
  "tests/pagination.test.ts",
  "tests/catalog.test.ts",
  "tests/review-regressions.test.ts",
];

const shared = {
  // Some lifecycle tests open/close on-disk databases repeatedly; CI runners
  // with slow disks can take well over vitest's 5 s default.
  testTimeout: 20_000,
};

export default defineConfig({
  test: {
    ...shared,
    projects: [
      { test: { ...shared, name: "sqlite", include: ["tests/**/*.test.ts"], env: { HINDSIGHT_TEST_BACKEND: "sqlite" } } },
      ...(process.env.DATABASE_URL
        ? [{ test: { ...shared, name: "postgres", include: SHARED, env: { HINDSIGHT_TEST_BACKEND: "postgres" } } }]
        : []),
    ],
  },
});
