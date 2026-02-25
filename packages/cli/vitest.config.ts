import { defineConfig } from "vitest/config";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@tokenxtractor/core": path.resolve(__dirname, "../core/src/index.ts"),
    },
  },
  test: {
    environment: "node",
  },
});
