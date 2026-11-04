/**
 * 演示数据种子：不接真实邮箱也能把应用跑起来看效果。
 *
 *   npm run seed:demo          # 写入 .data/mailcollect.sqlite
 *   npm run seed:demo -- --reset   # 先清空本地库再写
 *
 * 这些数据只进本地 SQLite，不会发起任何网络请求。
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { RawEmail, Task, UserProfile } from "@mailcollect/shared";
import { openStore } from "@mailcollect/core";

const dataDir = process.env["MAILCOLLECT_DATA_DIR"] ?? join(process.cwd(), ".data");
const dbFile = join(dataDir, "mailcollect.sqlite");

if (process.argv.includes("--reset")) {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${dbFile}${suffix}`, { force: true });
  }
  console.log(`已清空 ${dbFile}`);
}

const store = await openStore(dbFile, "seed-device");

const now = new Date("2026-11-04T10:40:00+08:00");
const iso = (d: Date): string => d.toISOString();

const profile: UserProfile = store.upsertProfile({
  displayName: "张三",
  aliases: ["张 三", "San Zhang", "zhangsan"],
  emails: ["zhangsan@acme.cn", "zhangsan@outlook.com"],
  timezone: "Asia/Shanghai",
});

const account = store.createAccount({
  provider: "imap",
  label: "公司邮箱",
  email: "zhangsan@acme.cn",
  config: { host: "imap.acme.cn", port: "993", tls: "true", mailbox: "INBOX" },
  secret: "demo-app-password",
});

const outlook = store.createAccount({
  provider: "graph",
  label: "Outlook 个人号",
  email: "zhangsan@outlook.com",
  config: { tenant: "common" },
  secret: "demo-refresh-token",
});

const email = (
  id: string,
  uid: string,
  from: [string, string],
  subject: string,
  minutesAgo: number,
  body: string,
  headers: Record<string, string> = {},
  accountId: string = account.id,
): RawEmail => {
  const sentAt = new Date(now.getTime() - minutesAgo * 60_000);
  return {
    id,
    accountId,
    uid,
    messageId: `<${id}@acme.cn>`,
    threadId: `thread-${id}`,
    fromName: from[0],
    fromEmail: from[1],
    to: ["zhangsan@acme.cn"],
    cc: [],
    subject,
    sentAt: iso(sentAt),
    bodyText: body,
    hasAttachments: body.includes("附件"),
    headers,
    createdAt: iso(sentAt),
  };
};

const emails: RawEmail[] = [
  email(
    "e1",
    "101",
    ["李婷", "liting@acme.cn"],
    "Q4 预算表初稿：本周五 18:00 前发我",
    108,
    "张三，你好：Q4 的预算表还差你负责的「市场投放」和「差旅」两栏。本周五 18:00 前把初稿发我，周三我们一起过一遍。附件是去年的模板。",
  ),
  email(
    "e2",
    "102",
    ["王强", "wangqiang@acme.cn"],
    "合同第 4 条付款条款，麻烦确认",
    254,
    "张工：合同第 4 条付款条款能否改成 30 天账期？我们财务这边走 45 天确实有困难。另外评审会安排在下周一至周三之间，你看哪天合适。",
  ),
  email(
    "e3",
    "103",
    ["陈晨", "chenchen@acme.cn"],
    "下周二到周三，苏州客户现场走访",
    302,
    "张三：下周二到周三我们一起去苏州客户现场走一趟，你这边时间可以吗？走访结束后请整理一份客户访谈纪要，下周三下班前给我。",
  ),
  email(
    "e4",
    "104",
    ["财务共享中心", "fssc@acme.cn"],
    "上月差旅报销：本周五截止",
    560,
    "各位同事：上月差旅报销请在本周五前提交，逾期要等到下个批次。附件是新的报销单模板，电子发票请一并上传。\n\n--\n此邮件由财务共享中心统一发送",
    { "list-id": "<fssc.acme.cn>", "list-unsubscribe": "<mailto:unsub@acme.cn>" },
  ),
  email(
    "e5",
    "105",
    ["HR 全员通知", "hr@all-hands.acme.cn"],
    "【全员】年度体检预约开始，请在下周三前完成",
    620,
    "各位同事：2026 年度体检预约已开放，请于下周三前完成预约，体检地点可就近选择。预约入口见内网。",
    { "list-id": "<all-hands.acme.cn>", "precedence": "bulk" },
  ),
  email(
    "e6",
    "106",
    ["GitHub", "noreply@github.com"],
    "[GitHub] 你的个人访问令牌将在 7 天后过期",
    700,
    "Hi zhangsan, 你的个人访问令牌（classic）将在 7 天后过期。请前往设置页重新生成，否则相关 CI 会失败。",
    { "auto-submitted": "auto-generated" },
  ),
  email(
    "e7",
    "107",
    ["周敏", "zhoumin@acme.cn"],
    "评审会改到周四 15:00，请确认能否参加",
    820,
    "张三：评审会改到周四 15:00，会议室 3 楼 A 座。请确认你能否参加，我这边要订会议室。",
    {},
    outlook.id,
  ),
  email(
    "e8",
    "108",
    ["Notifications", "notifications@medium.com"],
    "本周你错过的 5 篇文章",
    900,
    "根据你的阅读历史，为你推荐以下文章……",
    { "list-id": "<medium.digest>", "precedence": "bulk" },
  ),
];

store.upsertEmails(emails);

const task = (
  id: string,
  title: string,
  detail: string | null,
  sourceEmailId: string,
  owner: Task["owner"],
  kind: Task["kind"],
  status: Task["status"],
  origin: Task["origin"],
  evidence: string,
  confidence: number,
  time: Task["time"],
): Task => ({
  id,
  userId: profile.id,
  title,
  detail,
  owner,
  ownerName: owner === "me" ? "张三" : null,
  kind,
  status,
  origin,
  confidence,
  evidenceQuote: evidence,
  sourceEmailId,
  threadId: `thread-${sourceEmailId}`,
  time,
  createdAt: iso(now),
  updatedAt: iso(now),
});

const tz = "Asia/Shanghai";

const tasks: Task[] = [
  task(
    "t1",
    "提交 Q4 预算表初稿",
    "补齐「市场投放」与「差旅」两栏，附上口径说明。",
    "e1",
    "me",
    "deadline",
    "confirmed",
    "personal",
    "本周五 18:00 前把初稿发我",
    0.95,
    { phrase: "本周五 18:00 前", dueAt: "2026-11-06T10:00:00.000Z", windowStart: null, windowEnd: null, timezone: tz, confidence: 0.95 },
  ),
  task(
    "t2",
    "确认合同第 4 条付款条款",
    "回复财务能否接受 45 天账期。",
    "e2",
    "me",
    "action",
    "confirmed",
    "personal",
    "合同第 4 条付款条款能否改成 30 天账期",
    0.9,
    null,
  ),
  task(
    "t3",
    "确定合同评审会时间",
    "下周一至周三之间选一个上午，锁 3 楼 A 座会议室。",
    "e2",
    "me",
    "window",
    "confirmed",
    "personal",
    "评审会安排在下周一至周三之间，你定个上午",
    0.92,
    {
      phrase: "下周一至周三",
      dueAt: null,
      windowStart: "2026-11-09T01:00:00.000Z",
      windowEnd: "2026-11-11T04:00:00.000Z",
      timezone: tz,
      confidence: 0.92,
    },
  ),
  task(
    "t4",
    "苏州客户现场走访",
    "与陈晨同行，周二上午出发，周三下午返回。",
    "e3",
    "me",
    "window",
    "confirmed",
    "personal",
    "下周二到周三我们一起去苏州客户现场走一趟",
    0.9,
    {
      phrase: "下周二到周三",
      dueAt: null,
      windowStart: "2026-11-10T01:00:00.000Z",
      windowEnd: "2026-11-11T09:00:00.000Z",
      timezone: tz,
      confidence: 0.9,
    },
  ),
  task(
    "t5",
    "提交苏州客户走访纪要",
    "走访结束后整理访谈纪要。",
    "e3",
    "me",
    "deadline",
    "confirmed",
    "personal",
    "走访结束后请整理一份客户访谈纪要，下周三下班前给我",
    0.88,
    { phrase: "下周三下班前", dueAt: "2026-11-11T10:00:00.000Z", windowStart: null, windowEnd: null, timezone: tz, confidence: 0.88 },
  ),
  task(
    "t6",
    "提交上月差旅报销",
    "用新模板，电子发票一并上传。",
    "e4",
    "me",
    "deadline",
    "confirmed",
    "broadcast",
    "上月差旅报销请在本周五前提交",
    0.72,
    { phrase: "本周五前", dueAt: "2026-11-06T10:00:00.000Z", windowStart: null, windowEnd: null, timezone: tz, confidence: 0.72 },
  ),
  task(
    "t7",
    "预约年度体检",
    "下周三前在内网完成预约。",
    "e5",
    "me",
    "deadline",
    "candidate",
    "broadcast",
    "请于下周三前完成预约",
    0.66,
    { phrase: "下周三前", dueAt: "2026-11-11T10:00:00.000Z", windowStart: null, windowEnd: null, timezone: tz, confidence: 0.66 },
  ),
  task(
    "t8",
    "更新 GitHub 个人访问令牌",
    "令牌 7 天后过期，会中断 CI。",
    "e6",
    "me",
    "deadline",
    "confirmed",
    "broadcast",
    "你的个人访问令牌（classic）将在 7 天后过期",
    0.81,
    { phrase: "7 天后", dueAt: "2026-11-11T02:00:00.000Z", windowStart: null, windowEnd: null, timezone: tz, confidence: 0.81 },
  ),
  task(
    "t9",
    "确认周四评审会能否参加",
    "会议改到周四 15:00，3 楼 A 座，需要明确答复。",
    "e7",
    "unassigned",
    "deadline",
    "candidate",
    "personal",
    "评审会改到周四 15:00，会议室 3 楼 A 座，请确认你能否参加",
    0.61,
    { phrase: "周四 15:00", dueAt: "2026-11-05T07:00:00.000Z", windowStart: null, windowEnd: null, timezone: tz, confidence: 0.61 },
  ),
  task(
    "t10",
    "整理会议纪要",
    "上周产品会遗留项。",
    "e2",
    "me",
    "action",
    "done",
    "personal",
    "会议纪要请整理后同步到知识库",
    0.8,
    null,
  ),
  task(
    "t11",
    "回复供应商报价",
    "已由同事接手。",
    "e8",
    "other",
    "action",
    "dismissed",
    "broadcast",
    "请供应商在周五前回传报价单",
    0.4,
    null,
  ),
];

store.insertTasks(tasks);

for (const [emailId, kind, signals] of [
  ["e1", "personal", []],
  ["e2", "personal", []],
  ["e3", "personal", []],
  ["e4", "broadcast", ["header:list-id", "header:list-unsubscribe"]],
  ["e5", "broadcast", ["header:list-id", "header:precedence-bulk"]],
  ["e6", "broadcast", ["header:auto-submitted"]],
  ["e7", "personal", []],
  ["e8", "broadcast", ["header:list-id", "header:precedence-bulk"]],
] as const) {
  store.setBroadcastVerdict(emailId, { kind, signals: [...signals] });
}

for (const email of emails) store.markExtracted(email.id, null);

store.upsertLlmConfig({
  label: "DeepSeek（演示）",
  protocol: "openai-compatible",
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-chat",
  temperature: 0.2,
  isDefault: true,
});

console.log(
  [
    `演示数据已写入 ${dbFile}`,
    `  账号 ${store.listAccounts().length} 个 · 邮件 ${emails.length} 封 · 待办 ${tasks.length} 条`,
    `  待办分布 ${JSON.stringify(store.taskCounts())}`,
    `  提示：LLM 配置未带 Key，真实抽取前请在设置页补一个 Key；演示数据本身不需要。`,
  ].join("\n"),
);

store.close();
