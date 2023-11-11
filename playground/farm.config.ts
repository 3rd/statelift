import path from "node:path";
import type { UserConfig } from "@farmfe/core";

function defineConfig(config: UserConfig) {
  return config;
}

export default defineConfig({
  compilation: {
    resolve: {
      alias: {
        statelift: path.join(process.cwd(), "../lib/src/index.ts"),
        // statelift: path.join(process.cwd(), "../lib/dist"),
      },
    },
    external: ["node:fs"],
  },
  plugins: ["@farmfe/plugin-react"],
});
