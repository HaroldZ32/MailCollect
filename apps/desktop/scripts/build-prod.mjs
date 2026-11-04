import { build } from "esbuild";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const out = join(here, "..", "dist-electron");

const run = (cmd, args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`))));
  });

// 1) Build the UI bundle.
await run(process.execPath, [join(repo, "node_modules", "vite", "bin", "vite.js"), "build"], join(repo, "apps", "ui"));

// 2) Bundle the server into a single ESM file: it runs on Electron's own Node
//    (ELECTRON_RUN_AS_NODE), so no node_modules and no native modules ship.
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(repo, "apps", "server", "src", "main.ts")],
  outfile: join(out, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  logLevel: "info",
  external: ["electron"],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});

// 3) Main + preload.
await run(process.execPath, [join(here, "build-main.mjs")], here);

// 3.5) The SQLite schema is read at runtime via import.meta.url, so it must sit
//      next to the bundle — esbuild does not copy non-JS assets.
cpSync(join(repo, "packages", "core", "src", "store", "schema.sql"), join(out, "schema.sql"));

// 4) Ship the built UI next to the app so the server can serve it.
const uiOut = join(here, "..", "ui");
rmSync(uiOut, { recursive: true, force: true });
cpSync(join(repo, "apps", "ui", "dist"), uiOut, { recursive: true });

console.log("生产构建完成：apps/desktop/dist-electron + apps/desktop/ui");
