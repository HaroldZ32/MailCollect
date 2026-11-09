import type { RawEmail, UserProfile } from "@mailcollect/shared";

/**
 * AC-25 种子等价的固定语料（≥10 封）。
 *
 * 覆盖需求点名的全部用例：中文点名、英文点名/别名、邮箱前缀、List-Id、
 * Precedence bulk、no-reply、纯广告、截止时间、时段，外加「同日同文哈希」
 * 的确定性后处理（两封正文完全相同）。
 *
 * 语料刻意避开 shared/rules.ts SEED_BROADCAST_TREE 注释里列出的三类偏差
 * （只有 List-Unsubscribe/List-Post 的列表、仅 Precedence: junk、仅靠
 * 「我不在 To」判 uncertain 的邮件），这样 v1 判定与两条种子规则可以逐封等价。
 *
 * golden 由 `record-v1-golden.ts` 在删除 R3/R4 之前用 v1 管线跑出，落在
 * `seed-parity-golden.json`；seed-parity.test.ts 只读这两个文件。
 */
export const PARITY_PROFILE: UserProfile = {
  id: "user-parity",
  displayName: "张三",
  aliases: ["San Zhang"],
  emails: ["zhangsan@example.com"],
  timezone: "Asia/Shanghai",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function rawEmail(overrides: Partial<RawEmail> & Pick<RawEmail, "id" | "bodyText">): RawEmail {
  const { id, bodyText, ...rest } = overrides;
  return {
    id,
    accountId: "account-parity",
    uid: `uid-${id}`,
    messageId: `<${id}@example.com>`,
    threadId: `thread-${id}`,
    fromName: "同事",
    fromEmail: "colleague@corp.example.com",
    to: ["zhangsan@example.com"],
    cc: [],
    subject: "（无主题）",
    sentAt: "2026-11-02T09:00:00+08:00",
    bodyText,
    hasAttachments: false,
    headers: {},
    createdAt: "2026-11-02T09:00:01+08:00",
    ...rest,
  };
}

export const PARITY_CORPUS: readonly RawEmail[] = [
  rawEmail({
    id: "m01-zh-name",
    subject: "请提交 Q3 周报",
    bodyText: "张三，请在本周五 18:00 前提交 Q3 周报。",
  }),
  rawEmail({
    id: "m02-en-alias",
    subject: "Review the deck",
    bodyText: "San Zhang, please review the deck before Monday.",
  }),
  rawEmail({
    id: "m03-email-local",
    subject: "更新邮寄地址",
    bodyText: "zhangsan，请更新你的邮寄地址。",
  }),
  rawEmail({
    id: "m04-list-id",
    subject: "本周产品更新",
    fromEmail: "news@vendor.example.com",
    bodyText: "本周产品更新：新增规则分类与面板切换。",
    headers: { "List-Id": "<news.vendor.example.com>" },
  }),
  rawEmail({
    id: "m05-precedence",
    subject: "限时优惠",
    fromEmail: "promo@shop.example.com",
    bodyText: "限时优惠：全场五折，仅此三天。",
    headers: { Precedence: "bulk" },
  }),
  rawEmail({
    id: "m06-no-reply",
    subject: "您的账单已生成",
    fromEmail: "no-reply@service.example.com",
    bodyText: "您的账单已生成，请登录查看。",
  }),
  rawEmail({
    id: "m07-pure-ad",
    subject: "双十一大促",
    fromEmail: "deals@shop.example.com",
    bodyText: "双十一大促，全场五折，退订请点链接。",
    headers: { "List-Id": "<deals.shop.example.com>" },
  }),
  rawEmail({
    id: "m08-deadline",
    subject: "合同确认",
    bodyText: "张三，合同截止时间是本周五 18:00，请确认。",
  }),
  rawEmail({
    id: "m09-window",
    subject: "用户访谈安排",
    bodyText: "张三，下周一至周三做用户访谈，请安排时间。",
  }),
  rawEmail({
    id: "m10-bulk-recipients",
    subject: "公司年度大会通知",
    fromEmail: "notice@corp.example.com",
    bodyText: "公司年度大会通知：下周五下午三点，请准时参加。",
    to: Array.from({ length: 10 }, (_, index) =>
      index === 0 ? "zhangsan@example.com" : `colleague${index}@corp.example.com`,
    ),
  }),
  rawEmail({
    id: "m11-dup-a",
    subject: "系统维护通知",
    fromEmail: "notice@corp.example.com",
    bodyText: "系统通知：本周六 22:00 起停机维护两小时。",
    sentAt: "2026-11-03T09:00:00+08:00",
  }),
  rawEmail({
    id: "m12-dup-b",
    subject: "系统维护通知（转发）",
    fromEmail: "notice@corp.example.com",
    bodyText: "系统通知：本周六 22:00 起停机维护两小时。",
    sentAt: "2026-11-03T15:00:00+08:00",
  }),
];
