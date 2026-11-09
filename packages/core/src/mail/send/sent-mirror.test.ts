import { describe, expect, it } from "vitest";
import type { RawEmail } from "@mailcollect/shared";
import { mirrorSentMessage, sentMirrorUid, type SentMirrorPort } from "./sent-mirror.js";

/** AC-10 的「本地 Sent 镜像」：raw_email 行形状 + 幂等去重（change_log 由注入端口负责）。 */

class FakeStore implements SentMirrorPort {
  readonly written: RawEmail[] = [];
  readonly seen = new Set<string>();

  upsertEmails(emails: readonly RawEmail[]): { inserted: number; ids: readonly string[] } {
    const ids: string[] = [];
    for (const email of emails) {
      const key = `${email.accountId}:${email.uid}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.written.push(email);
      ids.push(email.id);
    }
    return { inserted: ids.length, ids };
  }
}

function input(overrides: Partial<Parameters<typeof mirrorSentMessage>[1]> = {}) {
  return {
    accountId: "acc-1",
    fromName: "我",
    fromEmail: "me@example.com",
    to: ["alice@example.com"],
    cc: ["bob@example.com"],
    subject: "Hello",
    bodyText: "正文",
    messageId: "<msg-1@example.com>",
    sentAt: "2026-11-09T03:00:00.000Z",
    ...overrides,
  };
}

describe("mirrorSentMessage", () => {
  it("写入一条与收件不冲突的 raw_email 行", () => {
    const store = new FakeStore();
    const record = mirrorSentMessage(store, input());

    expect(record.inserted).toBe(true);
    expect(record.id).toBe("acc-1:sent:msg-1@example.com");
    expect(store.written).toHaveLength(1);
    const email = store.written[0];
    if (email === undefined) throw new Error("未写入");
    expect(email.id).toBe(record.id);
    expect(email.uid).toBe("msg-1@example.com");
    expect(email.messageId).toBe("<msg-1@example.com>");
    expect(email.accountId).toBe("acc-1");
    expect(email.fromName).toBe("我");
    expect(email.fromEmail).toBe("me@example.com");
    expect(email.to).toEqual(["alice@example.com"]);
    expect(email.cc).toEqual(["bob@example.com"]);
    expect(email.subject).toBe("Hello");
    expect(email.bodyText).toBe("正文");
    expect(email.hasAttachments).toBe(false);
    expect(email.sentAt).toBe("2026-11-09T03:00:00.000Z");
    expect(email.createdAt).toBe("2026-11-09T03:00:00.000Z");
    expect(email.headers["message-id"]).toBe("<msg-1@example.com>");
    // Bcc 不落本地镜像：RawEmail 只有 to/cc，且这里显式断言没有 bcc 头。
    expect(email.headers.bcc).toBeUndefined();
    expect(email.threadId).toBeNull();
  });

  it("回复时写入 in-reply-to / references（带尖括号）与 threadId", () => {
    const store = new FakeStore();
    const record = mirrorSentMessage(
      store,
      input({
        threadId: "<orig@example.com>",
        inReplyTo: "orig@example.com",
        references: ["root@example.com", "<orig@example.com>"],
      }),
    );
    expect(record.inserted).toBe(true);
    const email = store.written[0];
    if (email === undefined) throw new Error("未写入");
    expect(email.threadId).toBe("<orig@example.com>");
    expect(email.headers["in-reply-to"]).toBe("<orig@example.com>");
    expect(email.headers.references).toBe("<root@example.com> <orig@example.com>");
  });

  it("同一 Message-ID 重放是幂等的：同一 id，inserted=false，不重复写", () => {
    const store = new FakeStore();
    const first = mirrorSentMessage(store, input());
    const second = mirrorSentMessage(store, input({ bodyText: "重放" }));

    expect(second.id).toBe(first.id);
    expect(second.inserted).toBe(false);
    expect(store.written).toHaveLength(1);
  });

  it("附件与自定义 id/sentAt 生效", () => {
    const store = new FakeStore();
    const record = mirrorSentMessage(
      store,
      input({ id: "custom-id", hasAttachments: true, sentAt: "2026-01-01T00:00:00.000Z" }),
    );
    expect(record.id).toBe("custom-id");
    expect(record.email.id).toBe("custom-id");
    expect(record.email.hasAttachments).toBe(true);
    expect(record.email.sentAt).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("sentMirrorUid", () => {
  it("归一尖括号、空白与换行，空值有稳定兜底", () => {
    expect(sentMirrorUid("<a@b.c>")).toBe("a@b.c");
    expect(sentMirrorUid("  a@b.c  ")).toBe("a@b.c");
    expect(sentMirrorUid("<a@b.c\r\nInjected: x>")).toBe("a@b.cInjected: x");
    expect(sentMirrorUid("   ")).toBe("unknown-message-id");
  });

  it("超长 Message-ID 被截断到上限", () => {
    const long = `<${"x".repeat(500)}@example.com>`;
    const uid = sentMirrorUid(long);
    expect(uid.length).toBe(300);
  });
});
