import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/devtools.ts", "src/vanilla.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  outDir: "dist",
  fixedExtension: false,
  platform: "browser",
  define: {
    // Keep NODE_ENV unresolved so the consumer's bundler can substitute it.
    "process.env.NODE_ENV": "process.env.NODE_ENV",
  },
  treeshake: true,
  sourcemap: false,
  shims: false,
  hash: false,
});
