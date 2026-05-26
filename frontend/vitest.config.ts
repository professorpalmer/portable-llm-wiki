/// <reference types="vitest" />
import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * Vitest config for the Next.js 14 frontend.
 *
 * Notes:
 * - Uses jsdom so component tests have a DOM. Some Next.js APIs (e.g.
 *   `next/navigation`) are mocked in `tests/setup.ts` so we don't have to
 *   spin up a full Next.js runtime.
 * - The `@/` alias mirrors what tsconfig.json defines so imports look the
 *   same in app code and tests.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    globals: true,
    css: false,
    include: ["tests/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}", "lib/**/*.ts"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
    },
  },
});
