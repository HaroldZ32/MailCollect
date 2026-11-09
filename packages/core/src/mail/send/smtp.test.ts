import { describe, expect, it } from "vitest";
import { MailError } from "../types.js";
import { SmtpClient, stripBccHeader, verifySmtp, type SmtpReply } from "./smtp.js";
import { ScriptedSmtpWire, smtpConfig, smtpReply, smtpRequest } from "./test-support.js";

/**
 * SMTP 的验收（AC-07）：成功/认证失败/连接失败/超时四条路径，用脚本化假 wire 驱动，
 * 断言命令序列、密码不出现在任何错误文案里。
 */

describe("SmtpClient", () => {
  it("STARTTLS + AUTH PLAIN + 多收件人投递成功（命令序列可核对）", async () => {
    const wire = new ScriptedSmtpWire([
      smtpReply(220, "smtp.example.com ESMTP"),
      smtpReply(250, "smtp.example.com", "STARTTLS", "AUTH PLAIN LOGIN", "8BITMIME"),
      smtpReply(220, "ready"),
      smtpReply(250, "smtp.example.com", "AUTH PLAIN LOGIN", "8BITMIME"),
      smtpReply(235, "Authentication successful"),
      smtpReply(250, "sender ok"),
      smtpReply(250, "recipient ok"),
      smtpReply(250, "recipient ok"),
      smtpReply(250, "recipient ok"),
      smtpReply(354, "go ahead"),
      smtpReply(250, "queued as ABC123"),
      smtpReply(221, "bye"),
    ]);
    const client = new SmtpClient(smtpConfig(), async () => wire);

    const delivery = await client.send(smtpRequest());

    expect(delivery.accepted).toEqual(["alice@example.com", "bob@example.com", "carol@example.com"]);
    expect(wire.startTlsCalls).toBe(1);
    expect(wire.transcript).toContain("STARTTLS");
    expect(wire.transcript.filter((line) => line.startsWith("EHLO"))).toHaveLength(2);
    expect(wire.transcript).toContain("MAIL FROM:<me@example.com>");
    expect(wire.transcript).toContain("RCPT TO:<alice@example.com>");
    expect(wire.transcript).toContain("RCPT TO:<bob@example.com>");
    expect(wire.transcript).toContain("RCPT TO:<carol@example.com>");
    expect(wire.transcript).toContain("DATA");
    expect(wire.transcript.at(-1)).toBe("QUIT");
    expect(wire.payloadText()).toContain("Subject: Hi");
    // 密码只以 base64 出现在 AUTH PLAIN 参数里，绝不出现原文。
    expect(wire.text()).not.toContain("s3cret-app-password");
    const auth = wire.transcript.find((line) => line.startsWith("AUTH PLAIN "));
    expect(auth).toBeDefined();
    expect(Buffer.from(auth!.slice("AUTH PLAIN ".length), "base64").toString("utf8")).toBe(
      "\u0000me@example.com\u0000s3cret-app-password",
    );
    expect(wire.closeCalls).toBe(1);
  });

  it("认证失败：类型化 auth，错误文案与执行轨迹都不含密码", async () => {
    const wire = new ScriptedSmtpWire([
      smtpReply(220, "smtp.example.com"),
      smtpReply(250, "smtp.example.com", "STARTTLS", "AUTH PLAIN LOGIN"),
      smtpReply(220, "ready"),
      smtpReply(250, "smtp.example.com", "AUTH PLAIN LOGIN"),
      smtpReply(535, "5.7.8 Authentication credentials invalid"),
    ]);
    const client = new SmtpClient(smtpConfig(), async () => wire);

    let caught: unknown = null;
    try {
      await client.send(smtpRequest());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MailError);
    const error = caught as MailError;
    expect(error.code).toBe("auth");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("认证失败");
    expect(error.message).not.toContain("s3cret-app-password");
    expect(wire.text()).not.toContain("s3cret-app-password");
  });

  it("AUTH LOGIN：用户名/密码分两步 base64，成功后继续投递", async () => {
    const wire = new ScriptedSmtpWire([
      smtpReply(220, "smtp.example.com"),
      smtpReply(250, "smtp.example.com", "STARTTLS", "AUTH LOGIN"),
      smtpReply(220, "ready"),
      smtpReply(250, "smtp.example.com", "AUTH LOGIN"),
      smtpReply(334, "VXNlcm5hbWU6"),
      smtpReply(334, "UGFzc3dvcmQ6"),
      smtpReply(235, "accepted"),
      smtpReply(250, "sender ok"),
      smtpReply(250, "recipient ok"),
      smtpReply(250, "recipient ok"),
      smtpReply(250, "recipient ok"),
      smtpReply(354, "go"),
      smtpReply(250, "queued"),
      smtpReply(221, "bye"),
    ]);
    const client = new SmtpClient(smtpConfig(), async () => wire);

    await client.send(smtpRequest());
    expect(wire.transcript).toContain(Buffer.from("me@example.com").toString("base64"));
    expect(wire.transcript).toContain(Buffer.from("s3cret-app-password").toString("base64"));
    expect(wire.text()).not.toContain("s3cret-app-password");
  });

  it("连接失败映射为 network，可重试，文案保留主机名", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:587"), { code: "ECONNREFUSED" });
    const client = new SmtpClient(smtpConfig(), async () => {
      throw refused;
    });

    let caught: unknown = null;
    try {
      await client.send(smtpRequest());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MailError);
    const error = caught as MailError;
    expect(error.code).toBe("network");
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("smtp.example.com");
  });

  it("读回复超时映射为 network + retryable，不泄漏密码", async () => {
    const hang = new ScriptedSmtpWire([() => new Promise<SmtpReply>(() => {})]);
    const client = new SmtpClient(smtpConfig({ timeoutMs: 15 }), async () => hang);

    let caught: unknown = null;
    try {
      await client.send(smtpRequest());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MailError);
    const error = caught as MailError;
    expect(error.code).toBe("network");
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("超时");
    expect(error.message).not.toContain("s3cret-app-password");
  });

  it("服务器不提供 STARTTLS 时默认拒绝明文发送", async () => {
    const wire = new ScriptedSmtpWire([
      smtpReply(220, "smtp.example.com"),
      smtpReply(250, "smtp.example.com", "AUTH PLAIN"),
    ]);
    const client = new SmtpClient(smtpConfig(), async () => wire);

    await expect(client.send(smtpRequest())).rejects.toMatchObject({ code: "protocol" });
    expect(wire.startTlsCalls).toBe(0);
    expect(wire.transcript.filter((line) => line.startsWith("AUTH "))).toHaveLength(0);
  });

  it("显式允许不安全连接后可以在无 STARTTLS 的服务器上发送", async () => {
    const wire = new ScriptedSmtpWire([
      smtpReply(220, "smtp.example.com"),
      smtpReply(250, "smtp.example.com", "AUTH PLAIN"),
      smtpReply(235, "ok"),
      smtpReply(250, "sender ok"),
      smtpReply(250, "recipient ok"),
      smtpReply(250, "recipient ok"),
      smtpReply(250, "recipient ok"),
      smtpReply(354, "go"),
      smtpReply(250, "queued"),
      smtpReply(221, "bye"),
    ]);
    const client = new SmtpClient(smtpConfig({ allowInsecure: true }), async () => wire);
    const delivery = await client.send(smtpRequest());
    expect(delivery.accepted).toHaveLength(3);
    expect(wire.startTlsCalls).toBe(0);
  });

  it("隐式 TLS（465）不发送 STARTTLS", async () => {
    const wire = new ScriptedSmtpWire(
      [
        smtpReply(220, "smtp.example.com"),
        smtpReply(250, "smtp.example.com", "AUTH PLAIN"),
        smtpReply(235, "ok"),
        smtpReply(250, "sender ok"),
        smtpReply(250, "recipient ok"),
        smtpReply(250, "recipient ok"),
        smtpReply(250, "recipient ok"),
        smtpReply(354, "go"),
        smtpReply(250, "queued"),
        smtpReply(221, "bye"),
      ],
      true,
    );
    const client = new SmtpClient(smtpConfig({ secure: true, port: 465 }), async () => wire);
    await client.send(smtpRequest());
    expect(wire.transcript).not.toContain("STARTTLS");
    expect(wire.startTlsCalls).toBe(0);
  });

  it("DATA 行首的 . 被转义为 ..（SMTP 透明度）", async () => {
    const wire = new ScriptedSmtpWire([
      smtpReply(220, "smtp.example.com"),
      smtpReply(250, "smtp.example.com", "STARTTLS", "AUTH PLAIN"),
      smtpReply(220, "ready"),
      smtpReply(250, "smtp.example.com", "AUTH PLAIN"),
      smtpReply(235, "ok"),
      smtpReply(250, "sender ok"),
      smtpReply(250, "recipient ok"),
      smtpReply(250, "recipient ok"),
      smtpReply(250, "recipient ok"),
      smtpReply(354, "go"),
      smtpReply(250, "queued"),
      smtpReply(221, "bye"),
    ]);
    const client = new SmtpClient(smtpConfig(), async () => wire);
    await client.send(smtpRequest({ mime: new Uint8Array(Buffer.from("Subject: Hi\r\n\r\n.starts-with-dot\r\nok", "utf8")) }));
    expect(wire.payloadText()).toContain("\r\n..starts-with-dot\r\n");
    expect(wire.payloadText().endsWith("\r\n")).toBe(true);
  });

  it("DATA 前剥掉 Bcc：线上没有盲抄名单，但 RCPT 仍然投递 bcc 地址", async () => {
    const wire = new ScriptedSmtpWire([
      smtpReply(220, "smtp.example.com"),
      smtpReply(250, "smtp.example.com", "STARTTLS", "AUTH PLAIN"),
      smtpReply(220, "ready"),
      smtpReply(250, "smtp.example.com", "AUTH PLAIN"),
      smtpReply(235, "ok"),
      smtpReply(250, "sender ok"),
      smtpReply(250, "recipient ok"),
      smtpReply(250, "recipient ok"),
      smtpReply(250, "recipient ok"),
      smtpReply(354, "go"),
      smtpReply(250, "queued"),
      smtpReply(221, "bye"),
    ]);
    const client = new SmtpClient(smtpConfig(), async () => wire);
    const mime = Buffer.from(
      "From: me@example.com\r\nTo: alice@example.com\r\nBcc: carol@example.com\r\nSubject: Hi\r\n\r\nbody",
      "utf8",
    );

    await client.send(smtpRequest({ mime: new Uint8Array(mime) }));

    expect(wire.transcript).toContain("RCPT TO:<carol@example.com>");
    expect(wire.payloadText()).not.toMatch(/^Bcc:/mi);
    expect(wire.payloadText()).not.toContain("carol@example.com");
    expect(wire.payloadText()).toContain("To: alice@example.com");
  });

});

describe("stripBccHeader", () => {
  const base = [
    "From: me@example.com",
    "To: alice@example.com",
    "Cc: bob@example.com",
    "Bcc: carol@example.com",
    "Subject: Hi",
    "",
    "body",
  ].join("\r\n");

  it("删除 Bcc 行，保留其余头与正文；不修改入参", () => {
    const source = new Uint8Array(Buffer.from(base, "utf8"));
    const projected = stripBccHeader(source);
    const text = Buffer.from(projected).toString("utf8");

    expect(text).not.toMatch(/^Bcc:/mi);
    expect(text).toContain("To: alice@example.com");
    expect(text).toContain("Cc: bob@example.com");
    expect(text).toContain("\r\n\r\nbody");
    // 入参保持原样（调用方可能还要用它做 APPEND）。
    expect(Buffer.from(source).toString("utf8")).toContain("Bcc: carol@example.com");
  });

  it("折叠的 Bcc 续行一起删除", () => {
    const folded = [
      "From: me@example.com",
      "Bcc: carol@example.com,",
      " dave@example.com",
      "Subject: Hi",
      "",
      "body",
    ].join("\r\n");
    const text = Buffer.from(stripBccHeader(new Uint8Array(Buffer.from(folded, "utf8")))).toString("utf8");
    expect(text).not.toContain("carol@example.com");
    expect(text).not.toContain("dave@example.com");
    expect(text).toContain("Subject: Hi");
  });

  it("没有 Bcc 时返回原字节（不影响普通邮件）", () => {
    const plain = "From: me@example.com\r\nTo: alice@example.com\r\n\r\nbody";
    const source = new Uint8Array(Buffer.from(plain, "utf8"));
    expect(Buffer.from(stripBccHeader(source)).toString("utf8")).toBe(plain);
  });
});

describe("verifySmtp", () => {
  it("465 隐式 TLS：连接 + EHLO + AUTH 成功，不发送任何邮件", async () => {
    const wire = new ScriptedSmtpWire(
      [
        smtpReply(220, "smtp.example.com ESMTP"),
        smtpReply(250, "smtp.example.com", "AUTH PLAIN LOGIN", "8BITMIME"),
        smtpReply(235, "Authentication successful"),
        smtpReply(221, "bye"),
      ],
      true,
    );

    const result = await verifySmtp(smtpConfig({ secure: true, port: 465 }), async () => wire);

    expect(result.ok).toBe(true);
    expect(result.detail).toContain("465");
    expect(result.detail).toContain("TLS");
    expect(result.detail).not.toContain("s3cret-app-password");
    expect(result.detail).not.toContain("me@example.com");
    expect(wire.transcript.filter((line) => line.startsWith("MAIL FROM") || line.startsWith("RCPT TO"))).toHaveLength(0);
    expect(wire.startTlsCalls).toBe(0);
    expect(wire.closeCalls).toBe(1);
  });

  it("587 STARTTLS：升级后重新 EHLO，再做密码认证", async () => {
    const wire = new ScriptedSmtpWire([
      smtpReply(220, "smtp.example.com"),
      smtpReply(250, "smtp.example.com", "STARTTLS", "AUTH PLAIN"),
      smtpReply(220, "ready"),
      smtpReply(250, "smtp.example.com", "AUTH PLAIN"),
      smtpReply(235, "ok"),
      smtpReply(221, "bye"),
    ]);

    const result = await verifySmtp(smtpConfig({ port: 587 }), async () => wire);

    expect(result.ok).toBe(true);
    expect(result.detail).toContain("587");
    expect(result.detail).toContain("TLS");
    expect(wire.startTlsCalls).toBe(1);
    expect(wire.transcript.filter((line) => line.startsWith("EHLO"))).toHaveLength(2);
  });

  it("AUTH 被拒绝：ok:false + 「认证失败」，detail 不含密码与完整用户名", async () => {
    const wire = new ScriptedSmtpWire([
      smtpReply(220, "smtp.example.com"),
      smtpReply(250, "smtp.example.com", "STARTTLS", "AUTH PLAIN"),
      smtpReply(220, "ready"),
      smtpReply(250, "smtp.example.com", "AUTH PLAIN"),
      smtpReply(535, "5.7.8 Authentication credentials invalid"),
    ]);

    const result = await verifySmtp(smtpConfig(), async () => wire);

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("认证失败");
    expect(result.detail).not.toContain("s3cret-app-password");
    expect(result.detail).not.toContain("me@example.com");
  });

  it("DNS 解析失败：ok:false + 可读的连接失败原因", async () => {
    const dns = Object.assign(new Error("getaddrinfo ENOTFOUND smtp.example.com"), { code: "ENOTFOUND" });
    const result = await verifySmtp(smtpConfig(), async () => {
      throw dns;
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("连接邮件服务器失败");
    expect(result.detail).toContain("smtp.example.com");
    expect(result.detail).not.toContain("s3cret-app-password");
  });

  it("TCP 拒连：ok:false + 可读原因", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:587"), { code: "ECONNREFUSED" });
    const result = await verifySmtp(smtpConfig(), async () => {
      throw refused;
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("连接邮件服务器失败");
    expect(result.detail).toContain("smtp.example.com");
  });

  it("超时：ok:false + 超时提示", async () => {
    const hang = new ScriptedSmtpWire([() => new Promise<SmtpReply>(() => {})]);
    const result = await verifySmtp(smtpConfig({ timeoutMs: 15 }), async () => hang);

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("超时");
    expect(result.detail).not.toContain("s3cret-app-password");
  });

  it("TLS 握手失败：ok:false + 明确的 TLS 原因（不是笼统的 protocol）", async () => {
    const tlsError = Object.assign(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    const result = await verifySmtp(smtpConfig(), async () => {
      throw tlsError;
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("TLS 握手失败");
    expect(result.detail).toContain("self-signed certificate");
    expect(result.detail).not.toContain("s3cret-app-password");
  });

  it("未配置用户时不发 AUTH，仍可探测成功（隐式 TLS 路径）", async () => {
    const wire = new ScriptedSmtpWire(
      [
        smtpReply(220, "smtp.example.com"),
        smtpReply(250, "smtp.example.com", "8BITMIME"),
        smtpReply(221, "bye"),
      ],
      true,
    );

    const result = await verifySmtp(smtpConfig({ user: null, secure: true }), async () => wire);
    expect(result.ok).toBe(true);
    expect(wire.transcript.filter((line) => line.startsWith("AUTH"))).toHaveLength(0);
  });
});
