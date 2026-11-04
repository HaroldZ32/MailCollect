import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const require = createRequire(import.meta.url);
const electronBin = require("electron");

const children = [];
const run = (cmd, args, opts = {}) => {
  const child = spawn(cmd, args, { stdio: "inherit", ...opts });
  children.push(child);
  return child;
};
const shutdown = () => {
  for (const child of children) child.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// 1) API server (tsx watch) on the documented dev port.
run(process.execPath, [join(root, "node_modules", "tsx", "dist", "cli.mjs"), "watch", join(root, "apps", "server", "src", "main.ts")], {
  cwd: root,
  env: {
    ...process.env,
    MAILCOLLECT_PORT: "8787",
    MAILCOLLECT_TOKEN: "dev-local-token",
    MAILCOLLECT_DATA_DIR: join(root, ".data"),
  },
});

// 2) Vite dev server for the UI.
run(process.execPath, [join(root, "node_modules", "vite", "bin", "vite.js"), "--port", "5173"], {
  cwd: join(root, "apps", "ui"),
});

// 3) Electron shell, once Vite answers.
const waitFor = async (url, timeoutMs = 30000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
};

if (!(await waitFor("http://127.0.0.1:5173/"))) {
  console.error("Vite 未能在 30s 内就绪");
  shutdown();
}
run(electronBin, ["."], {
  cwd: join(root, "apps", "desktop"),
  env: { ...process.env, MAILCOLLECT_DEV_URL: "http://127.0.0.1:5173", MAILCOLLECT_DEV_TOKEN: "dev-local-token" },
});
