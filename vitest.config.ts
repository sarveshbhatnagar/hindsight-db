import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Some lifecycle tests open/close on-disk databases repeatedly; CI runners
    // with slow disks can take well over vitest's 5 s default.
    testTimeout: 20_000,
  },
});
