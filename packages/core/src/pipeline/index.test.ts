import type { RawEmail } from "@mailcollect/shared";
import { describe, expect, it } from "vitest";
import * as pipeline from "./index.js";
import {
  extractionItem,
  extractionJson,
  makeEmail,
  makeProfile,
  ScriptedLlm,
} from "./__test-helpers__/fixtures.js";

describe("pipeline 对外表面（服务端集成契约）", () => {
  it("导出分类闸门、抽取与确定性后处理的入口", () => {
    expect(typeof pipeline.processEmail).toBe("function");
    expect(typeof pipeline.processEmails).toBe("function");
    expect(typeof pipeline.extractTasks).toBe("function");
    expect(typeof pipeline.stripQuoted).toBe("function");
    expect(typeof pipeline.countSameDayDuplicateBodies).toBe("function");
  });

  it("AC-27：入口不再导出 R3/R4 的旧符号", () => {
    // 下面的字符串是「必须不存在」的断言目标，不是对旧实现的引用/调用；
    // 全仓 grep 证明见 T17 的 report（路径与调用形态均为空）。
    const legacy = [
      "classifyBroadcast",
      "judgeBroadcast",
      "mentionsUser",
      "describeIdentityMentions",
      "findIdentityHits",
      "hashBody",
      "isBroadcast",
    ];
    for (const name of legacy) {
      expect(name in pipeline, `${name} 不应再从 pipeline 入口导出`).toBe(false);
    }
  });

  it("processEmail 从入口可用并返回完整 Task", async () => {
    const profile = makeProfile();
    const email = makeEmail({ id: "mail-entry", bodyText: "张三，请提交周报。" });
    const llm = new ScriptedLlm(() =>
      extractionJson([
        extractionItem({
          title: "提交周报",
          owner: "me",
          evidenceQuote: "张三，请提交周报。",
        }),
      ]),
    );

    const result = await pipeline.processEmail(
      {
        llm,
        profile,
        classify: (item: RawEmail) => ({
          emailId: item.id,
          enterTodo: true,
          broadcast: false,
          uncategorized: false,
          categoryIds: ["seed-category-personal"],
        }),
      },
      email,
    );

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.sourceEmailId).toBe("mail-entry");
    expect(result.tasks[0]?.time).toMatchObject({ timezone: "Asia/Shanghai" });
    expect(result.reminders).toHaveLength(0);
  });
});
