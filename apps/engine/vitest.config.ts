import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@momentum-scan/shared": path.resolve(
        __dirname,
        "../../packages/shared/src/index.ts",
      ),
    },
  },
  test: {
    include: ["src/**/*.spec.ts", "test/**/*.spec.ts"],
  },
});
