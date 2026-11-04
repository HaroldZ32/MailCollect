/**
 * 把 apps/desktop/release/win-unpacked 打成可分发 zip。
 * 这是「在 Linux 上交叉编 Windows」时唯一不需要 wine 的产物形态：
 * 双击里面的 mailcollect.exe 就能跑（免安装）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = join(root, "apps", "desktop", "release", "win-unpacked");
const out = join(root, "apps", "desktop", "release", "MailCollect-win-portable-x64.zip");

if (!existsSync(src)) {
  console.error("找不到 release/win-unpacked，请先跑: npm run build:win:dir -w @mailcollect/desktop");
  process.exit(1);
}

rmSync(out, { force: true });
const result = spawnSync("zip", ["-qr", out, "."], { cwd: src, stdio: "inherit" });
if (result.error) {
  console.error("需要系统里有 zip 命令（或用平台自带的压缩工具手动压 win-unpacked）");
  process.exit(1);
}
console.log(`已生成 ${out}`);
