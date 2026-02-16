import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: "src/index.ts",
    format: "esm",
    platform: "node",
    outDir: "dist/plugin",
    clean: true,
  },
  {
    entry: "src/ui/app.ts",
    format: "esm",
    platform: "browser",
    outDir: "dist/ui",
    clean: true,
    noExternal: [/^@pierre\/diffs/],
  },
]);
