import { describe, expect, it } from "vitest";
import { cleanBody, stripQuoted, stripSignature } from "./strip.js";

describe("stripQuoted", () => {
  it("切断英文 On ... wrote: 回复头及其后的引用", () => {
    const body = [
      "新内容第一行",
      "新内容第二行",
      "",
      "On Tue, Nov 4, 2025 at 10:00 AM Li <li@example.com> wrote:",
      "> 旧引用内容",
    ].join("\n");
    expect(stripQuoted(body)).toBe("新内容第一行\n新内容第二行");
  });

  it("切断 -----Original Message-----", () => {
    const body = "请查收。\n\n-----Original Message-----\nFrom: Li\n旧正文";
    expect(stripQuoted(body)).toBe("请查收。");
  });

  it("删除 > 引用行但保留正文", () => {
    const body = "保留这行\n> 引用一\n> 引用二\n再保留这行";
    expect(stripQuoted(body)).toBe("保留这行\n再保留这行");
  });

  it("切断中文「在 ... 写道：」回复头", () => {
    const body = [
      "请看附件。",
      "",
      "在 2025年11月3日 10:00，李四 <li@example.com> 写道：",
      "> 报价单一",
    ].join("\n");
    expect(stripQuoted(body)).toBe("请看附件。");
  });

  it("切断中文邮件头块（发件人/发送时间/收件人/主题）", () => {
    const body = [
      "第一行正文",
      "第二行正文",
      "",
      "发件人: 李四",
      "发送时间: 2025年11月3日 10:00",
      "收件人: 张三",
      "主题: Re: Q3 报告",
      "",
      "之前邮件的内容",
    ].join("\n");
    expect(stripQuoted(body)).toBe("第一行正文\n第二行正文");
  });

  it("删除 HTML blockquote 引用块", () => {
    const html =
      "<html><body><p>请在周五前提交报告。</p><blockquote><p>最早的邮件正文</p></blockquote><p>署名</p></body></html>";
    const stripped = stripQuoted(html);
    expect(stripped).toContain("请在周五前提交报告。");
    expect(stripped).not.toContain("最早的邮件正文");
    expect(stripped).not.toContain("<p>");
  });

  it("不把正文里的普通段落当引用", () => {
    const body = "第一段\n\n第二段\n\n第三段";
    expect(stripQuoted(body)).toBe("第一段\n\n第二段\n\n第三段");
  });
});

describe("stripSignature", () => {
  it("删除 -- 签名块", () => {
    const body = "正文内容\n\n-- \n李四\n高级工程师\n13800000000";
    expect(stripSignature(body)).toBe("正文内容");
  });

  it("删除手机签名尾巴", () => {
    const body = "正文内容\n\nSent from my iPhone";
    expect(stripSignature(body)).toBe("正文内容");
  });

  it("后面还有大段正文时不把 -- 当签名分隔线", () => {
    const body = ["第一段", "--", ...Array.from({ length: 20 }, (_, i) => `第 ${i + 3} 段`)].join("\n");
    expect(stripSignature(body)).toBe(body);
  });
});

describe("cleanBody", () => {
  it("组合剥离引文、签名并去掉首尾空白", () => {
    const body = [
      "张三，请周五下班前把 Q3 报告发给我。",
      "",
      "谢谢",
      "-- ",
      "李四",
      "",
      "On Mon, Nov 3, 2025 Li wrote:",
      "> 上一轮内容",
    ].join("\n");
    expect(cleanBody(body)).toBe("张三，请周五下班前把 Q3 报告发给我。\n\n谢谢");
  });
});
