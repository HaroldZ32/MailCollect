/**
 * 证据库补充种子：把「正常同步才会写入」的文件夹快照、分类与多标签手工补进演示库，
 * 让收件箱/侧栏/分类筛选在没有真实 IMAP 的机器上也能被截图验证。
 *
 * 用法（见 run.mjs）：
 *   MAILCOLLECT_DATA_DIR=<throwaway dir> node_modules/tsx/dist/cli.mjs evidence/ui/mail/seed-extra.ts
 */
import { join } from "node:path";
import { openStore } from "@mailcollect/core";

const dataDir = process.env["MAILCOLLECT_DATA_DIR"] ?? "";
if (dataDir.trim() === "") {
  console.error("MAILCOLLECT_DATA_DIR 必填");
  process.exit(2);
}

const store = await openStore(join(dataDir, "mailcollect.sqlite"), "evidence-mail");
const accounts = store.listAccounts();
if (accounts.length === 0) {
  console.error("库里没有账号：请先跑 scripts/seed-demo.ts");
  process.exit(3);
}

const primary = accounts.find((account) => account.label === "公司邮箱") ?? accounts[0];
const secondary = accounts.find((account) => account.id !== primary.id) ?? null;

// 文件夹快照（真实同步时由适配器写入；这里手工补，避免 GET /folders 去打真实 IMAP）。
store.replaceFolders(primary.id, [
  { accountId: primary.id, path: "INBOX", role: "inbox", unread: 4 },
  { accountId: primary.id, path: "Sent", role: "sent", unread: 0 },
  { accountId: primary.id, path: "Archive", role: "archive", unread: 0 },
  { accountId: primary.id, path: "Trash", role: "trash", unread: 0 },
]);
if (secondary !== null) {
  store.replaceFolders(secondary.id, [
    { accountId: secondary.id, path: "INBOX", role: "inbox", unread: 1 },
    { accountId: secondary.id, path: "Sent", role: "sent", unread: 0 },
  ]);
}

const categoryNames: readonly { name: string; enterTodo: boolean; broadcast: boolean }[] = [
  { name: "点名给我", enterTodo: true, broadcast: false },
  { name: "群发/通知", enterTodo: false, broadcast: true },
  { name: "项目跟进", enterTodo: true, broadcast: false },
];

const categories = new Map<string, string>();
for (const input of categoryNames) {
  const existing = store.listCategories().find((item) => item.name === input.name);
  const category = existing ?? store.createCategory(input);
  categories.set(category.name, category.id);
}

// 多标签：一封邮件可以同时命中多个分类（ANY 筛选与「每封显示全部标签」的证据）。
const tagPlan: Readonly<Record<string, readonly string[]>> = {
  e1: ["点名给我"],
  e2: ["点名给我"],
  e3: ["点名给我", "项目跟进"],
  e4: ["群发/通知"],
  e5: ["群发/通知"],
  e6: ["群发/通知"],
  e7: ["点名给我", "项目跟进"],
  e8: ["群发/通知"],
};

let tagged = 0;
for (const [emailId, names] of Object.entries(tagPlan)) {
  if (store.getEmail(emailId) === null) continue;
  const hits = names.flatMap((name) => {
    const categoryId = categories.get(name);
    return categoryId === undefined ? [] : [{ categoryId, ruleId: null }];
  });
  store.replaceTagsForEmail(emailId, hits);
  tagged += 1;
}

// 两封保持已读，其余未读 → 未读点与「未读 6」都有得看。
for (const emailId of ["e6", "e8"]) store.markEmailRead(emailId, true);

console.log(
  JSON.stringify({
    accounts: accounts.length,
    folders: store.listFolders(primary.id).length,
    categories: [...categories.keys()],
    tagged,
  }),
);
