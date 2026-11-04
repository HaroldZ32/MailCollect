import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "dist-electron");

const common = {
  bundle: true,
  platform: "node",
  target: "node24",
  sourcemap: true,
  logLevel: "info",
  external: ["electron"],
};

// Main process: ESM is fine (package.json has type: module).
await build({ ...common, entryPoints: [join(here, "..", "src", "main.ts")], outfile: join(out, "main.mjs"), format: "esm" });
// Sandboxed preloads MUST be CommonJS.
await build({ ...common, entryPoints: [join(here, "..", "src", "preload.ts")], outfile: join(out, "preload.cjs"), format: "cjs" });
