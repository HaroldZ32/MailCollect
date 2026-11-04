import { describe, expect, it } from "vitest";
import { classifyBroadcast, processEmail, stripQuoted } from "./index.js";
import {
  extractionItem,
  extractionJson,
  makeEmail,
  makeProfile,
  ScriptedLlm,
} from "./__test-helpers__/fixtures.js";

describe("pipeline 对外表面（服务端集成契约）", () => {
  it("导出 processEmail / classifyBroadcast / stripQuoted", () => {
    expect(typeof processEmail).toBe("function");
    expect(typeof classifyBroadcast).toBe("function");
    expect(typeof stripQuoted).toBe("function");
  });

  it("classifyBroadcast 从入口可用且规则一致", () => {
    const profile = makeProfile();
    const verdict = classifyBroadcast(
      makeEmail({ headers: { "List-Id": "<devs.lists.example.com>" } }),
      profile,
    );
    expect(verdict.kind).toBe("broadcast");
    expect(verdict.signals).toContain("header:list-id");
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

    const result = await processEmail({ llm, profile }, email);

    expect(result.verdict.kind).toBe("personal");
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.sourceEmailId).toBe("mail-entry");
    expect(result.tasks[0]?.time).toMatchObject({ timezone: "Asia/Shanghai" });
  });
});
