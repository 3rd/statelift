import { access, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entries = ["index", "devtools", "vanilla"];
const require = createRequire(import.meta.url);

for (const entry of entries) {
  const browserEntry = resolve(packageRoot, "dist", `${entry}.js`);
  const canonicalEntry = resolve(packageRoot, "dist", `${entry}.cjs`);
  const nodeEntry = resolve(packageRoot, "dist", `${entry}.node.js`);

  await Promise.all([access(browserEntry), access(canonicalEntry)]);
  const runtime = require(canonicalEntry);
  const names = Object.keys(runtime).sort();
  const invalidName = names.find((name) => !/^[$A-Z_a-z][$\w]*$/u.test(name));
  if (invalidName) throw new Error(`Cannot generate an ESM binding for export ${JSON.stringify(invalidName)}`);
  const bindings = names.join(", ");
  await writeFile(
    nodeEntry,
    `import runtime from "./${entry}.cjs";\nconst { ${bindings} } = runtime;\nexport { ${bindings} };\n`,
  );
}

process.stdout.write("Node ESM wrappers written for index, devtools, and vanilla.\n");
