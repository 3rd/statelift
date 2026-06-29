import { defineConfig } from "tsdown";

export default defineConfig({
  entry: "src/index.ts",
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  outDir: "dist",
  fixedExtension: false,
  platform: "browser",
  treeshake: true,
  sourcemap: false,
  shims: false,
  hash: false,
});
