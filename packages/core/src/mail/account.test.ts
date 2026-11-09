import { describe, expect, it } from "vitest";
import { hasSendConfig, readSendConfig, resolveSmtpPort, validateSendConfig } from "./account.js";

describe("readSendConfig：smtpSecure 按端口推断", () => {
  it("587/25 默认 STARTTLS（smtpSecure=false），465 才是隐式 TLS，没写端口时保守默认 true", () => {
    expect(readSendConfig({ config: { smtpPort: "587" } }).smtpSecure).toBe(false);
    expect(readSendConfig({ config: { smtpPort: "25" } }).smtpSecure).toBe(false);
    expect(readSendConfig({ config: { smtpPort: "465" } }).smtpSecure).toBe(true);
    expect(readSendConfig({ config: {} }).smtpSecure).toBe(true);
  });

  it("显式 smtpSecure 永远优先于端口推断", () => {
    expect(readSendConfig({ config: { smtpPort: "587", smtpSecure: "true" } }).smtpSecure).toBe(true);
    expect(readSendConfig({ config: { smtpPort: "465", smtpSecure: "false" } }).smtpSecure).toBe(false);
    expect(readSendConfig({ config: { smtpPort: "587", smtpSecure: "0" } }).smtpSecure).toBe(false);
  });

  it("resolveSmtpPort 与推断出的 secure 自洽（587 不再被当成隐式 TLS 端口）", () => {
    expect(resolveSmtpPort(readSendConfig({ config: { smtpPort: "587" } }))).toBe(587);
    expect(resolveSmtpPort(readSendConfig({ config: { smtpPort: "465" } }))).toBe(465);
    expect(resolveSmtpPort(readSendConfig({ config: { smtpSecure: "false" } }))).toBe(587);
    expect(resolveSmtpPort(readSendConfig({ config: {} }))).toBe(465);
  });
});

describe("validateSendConfig：ewsUrl 内嵌凭据", () => {
  const password = "s3cret-in-url";

  it("拒绝 https://user:pass@host/…，且问题文案不含密码与用户名", () => {
    const issues = validateSendConfig({ ewsUrl: `https://alice:${password}@mail.corp/EWS/Exchange.asmx` }, "ews");

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/不能包含用户名或密码/u);
    expect(issues.join(" ")).not.toContain(password);
    expect(issues.join(" ")).not.toContain("alice");
  });

  it("只有用户名（没有密码）也拒绝；不带 userinfo 的 URL 零问题", () => {
    expect(validateSendConfig({ ewsUrl: "https://alice@mail.corp/EWS/Exchange.asmx" }, "ews")).toHaveLength(1);
    expect(validateSendConfig({ ewsUrl: "https://mail.corp/EWS/Exchange.asmx" }, "ews")).toEqual([]);
  });
});

describe("readSendConfig：ewsUrl 输出脱敏（AccountView.send 回显路径）", () => {
  const password = "s3cret-in-url";

  it("带 user:pass 的 ewsUrl 只回显 scheme+host+path，序列化后不含密码/用户名", () => {
    const config = readSendConfig({
      config: { ewsUrl: `https://alice:${password}@mail.corp/EWS/Exchange.asmx?x=1` },
    });

    expect(config.ewsUrl).toBe("https://mail.corp/EWS/Exchange.asmx?x=1");
    expect(JSON.stringify(config)).not.toContain(password);
    expect(JSON.stringify(config)).not.toContain("alice");
  });

  it("无凭据的 URL 原样输出；非法 URL 与缺失都输出 null", () => {
    expect(readSendConfig({ config: { ewsUrl: "https://mail.corp/EWS/Exchange.asmx" } }).ewsUrl).toBe(
      "https://mail.corp/EWS/Exchange.asmx",
    );
    expect(readSendConfig({ config: { ewsUrl: "mail.corp/EWS" } }).ewsUrl).toBeNull();
    expect(readSendConfig({ config: {} }).ewsUrl).toBeNull();
  });
});

describe("hasSendConfig", () => {
  it("SMTP 或 EWS 任一配了就算有发信通道", () => {
    expect(hasSendConfig(readSendConfig({ config: { smtpHost: "smtp.example.com" } }))).toBe(true);
    expect(hasSendConfig(readSendConfig({ config: { ewsUrl: "https://mail.corp/EWS" } }))).toBe(true);
    expect(hasSendConfig(readSendConfig({ config: { host: "imap.example.com" } }))).toBe(false);
  });
});

describe("readSendConfig：签名与显示名（T68）", () => {
  it("回填 signature/displayName（含换行与中文），空白视为未设置", () => {
    const withIdentity = readSendConfig({
      config: { signature: "——\n张三\n本邮件由 MailCollect 发送", displayName: "张三" },
    });
    expect(withIdentity.signature).toBe("——\n张三\n本邮件由 MailCollect 发送");
    expect(withIdentity.displayName).toBe("张三");

    const blank = readSendConfig({ config: { signature: "   ", displayName: "" } });
    expect(blank.signature).toBeUndefined();
    expect(blank.displayName).toBeUndefined();
  });

  it("只有签名/显示名不算配了发信通道（hasSendConfig 只认连接字段）", () => {
    const identityOnly = readSendConfig({ config: { signature: "——\n张三", displayName: "张三" } });
    expect(hasSendConfig(identityOnly)).toBe(false);

    const withConnection = readSendConfig({
      config: { signature: "——\n张三", smtpHost: "smtp.corp.com" },
    });
    expect(hasSendConfig(withConnection)).toBe(true);
  });
});
