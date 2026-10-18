import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // Pure-function tests import modules that also create the Supabase client, which throws at
    // import time without a URL. Placeholder values let the suite run in a fresh checkout or CI
    // (no .env), and keep tests from ever talking to the real project.
    env: { VITE_SUPABASE_URL: "http://localhost:54321", VITE_SUPABASE_PUBLISHABLE_KEY: "test-publishable-key" },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
