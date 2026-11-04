import { contextBridge } from "electron";

/**
 * The only bridge between Electron and the renderer. It exposes WHERE the local
 * service is and the per-launch token — never a Node capability, never a file
 * system path, never a secret.
 */
const arg = (prefix: string): string => {
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : "";
};

contextBridge.exposeInMainWorld("__MAILCOLLECT__", {
  apiBase: arg("--mc-api-base="),
  token: arg("--mc-token="),
  desktop: true,
  platform: process.platform,
});
