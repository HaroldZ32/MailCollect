import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AccountView,
  AutodiscoverResponse,
  DiscoverAccountResponse,
  OnboardingStatusResponse,
} from "@mailcollect/shared";
import {
  ACCOUNT_DISPLAY_NAME_MAX_LENGTH,
  ACCOUNT_SIGNATURE_MAX_LENGTH,
  SEED_RULE_BROADCAST_ID,
  SEED_RULE_PERSONAL_ID,
} from "@mailcollect/shared";
import { openStore, type Store } from "@mailcollect/core";
import { discoverAutodiscover, MailError } from "@mailcollect/core/mail";
import type { SmtpConfig } from "@mailcollect/core/mail";
import { createEventBus } from "../services.js";
import type { ServerServices } from "../services.js";
import { registerAccounts } from "./accounts.js";
import type {
  AccountsRouteOptions,
  AutodiscoverProbe,
  DiscoverProbe,
  SmtpVerifier,
} from "./accounts.js";

const JSON_HEADERS = { "content-type": "application/json" };

let dir: string;
let store: Store;
let services: ServerServices;
const makeVerifyAccount = (): ReturnType<typeof vi.fn<ServerServices["verifyAccount"]>> =>
  vi.fn<ServerServices["verifyAccount"]>(async () => ({ ok: true, detail: "IMAP 连接成功" }));
const makeLoginAccount = (): ReturnType<typeof vi.fn<ServerServices["loginAccount"]>> =>
  vi.fn<ServerServices["loginAccount"]>(async () => undefined);
let verifyAccount: ReturnType<typeof makeVerifyAccount>;
let loginAccount: ReturnType<typeof makeLoginAccount>;
let app: Hono;

const buildApp = (options: AccountsRouteOptions = {}): Hono => {
  const instance = new Hono();
  registerAccounts(
    instance,
    { store, services, events: createEventBus(), version: "test", dataDir: dir },
    options,
  );
  return instance;
};

const call = (path: string, init: RequestInit = {}): Promise<Response> =>
  Promise.resolve(app.request(path, init));

const sendJson = (
  method: "POST" | "PUT" | "PATCH",
  path: string,
  body: unknown,
): Promise<Response> =>
  call(path, { method, headers: JSON_HEADERS, body: JSON.stringify(body) });

const post = (path: string, body: unknown = {}): Promise<Response> =>
  sendJson("POST", path, body);

interface CreatedAccount {
  readonly status: number;
  readonly text: string;
  readonly account: AccountView | null;
}

const createAccount = async (body: Record<string, unknown>): Promise<CreatedAccount> => {
  const res = await post("/api/accounts", body);
  const text = await res.text();
  const parsed = JSON.parse(text) as { account?: AccountView };
  return { status: res.status, text, account: parsed.account ?? null };
};

const createMailbox = async (
  extra: Record<string, unknown> = {},
): Promise<AccountView> => {
  const created = await createAccount({
    provider: "imap",
    label: "工作",
    email: "me@corp.com",
    config: { host: "imap.corp.com", port: "993", tls: "1" },
    secret: "app-pw",
    ...extra,
  });
  expect(created.status).toBe(201);
  if (created.account === null) throw new Error("账号创建失败");
  return created.account;
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mailcollect-accounts-"));
  store = await openStore(join(dir, "db.sqlite"), "device-test");
  verifyAccount = makeVerifyAccount();
  loginAccount = makeLoginAccount();
  services = {
    verifyAccount,
    loginAccount,
    syncAccount: vi.fn(async () => undefined),
    extract: vi.fn(async () => ({ done: 0, total: 0 })),
    testLlm: vi.fn(async () => ({ ok: true, latencyMs: 1, detail: "pong" })),
    startBackground: vi.fn(),
    stopBackground: vi.fn(async () => undefined),
  };
  app = buildApp();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("onboarding", () => {
  it("seeds ONLY the broadcast rule when no profile identity exists (AC-03)", async () => {
    const initial = await call("/api/onboarding");
    expect(initial.status).toBe(200);
    expect((await initial.json()) as OnboardingStatusResponse).toEqual({
      completed: false,
      skipped: false,
    });

    const skipped = await sendJson("PUT", "/api/onboarding", { skipped: true });
    expect(skipped.status).toBe(200);
    expect((await skipped.json()) as OnboardingStatusResponse).toEqual({
      completed: false,
      skipped: true,
    });

    // 无档案身份时绝不落一条永不命中的「点名给我」：只种「群发/通知」一条。
    expect(store.getRule(SEED_RULE_BROADCAST_ID)).not.toBeNull();
    expect(store.getRule(SEED_RULE_PERSONAL_ID)).toBeNull();
    expect(store.listRules()).toHaveLength(1);

    // 第二次写入不得重复播种。
    const completed = await sendJson("PUT", "/api/onboarding", { completed: true });
    expect(completed.status).toBe(200);
    expect((await completed.json()) as OnboardingStatusResponse).toEqual({
      completed: true,
      skipped: true,
    });
    expect(store.listRules()).toHaveLength(1);

    const reread = await call("/api/onboarding");
    expect((await reread.json()) as OnboardingStatusResponse).toEqual({
      completed: true,
      skipped: true,
    });
  });

  it("expands the personal seed once a profile identity exists, idempotently", async () => {
    const profile = await sendJson("PUT", "/api/profile", {
      displayName: "张三",
      aliases: ["San Zhang"],
      emails: ["me@corp.com"],
      timezone: "Asia/Shanghai",
    });
    expect(profile.status).toBe(200);

    // 保存档案即幂等展开「点名给我」；「群发/通知」在开库时已种下。
    expect(store.getRule(SEED_RULE_PERSONAL_ID)).not.toBeNull();
    expect(store.getRule(SEED_RULE_BROADCAST_ID)).not.toBeNull();
    expect(store.listRules()).toHaveLength(2);

    const completed = await sendJson("PUT", "/api/onboarding", { completed: true });
    expect(completed.status).toBe(200);
    const skipped = await sendJson("PUT", "/api/onboarding", { skipped: true });
    expect(skipped.status).toBe(200);
    expect((await skipped.json()) as OnboardingStatusResponse).toEqual({
      completed: true,
      skipped: true,
    });
    // 两次 setInitState 都不重复播种。
    expect(store.listRules()).toHaveLength(2);
  });

  it("never resurrects a deleted personal seed on later profile saves (AC-03)", async () => {
    await sendJson("PUT", "/api/profile", {
      displayName: "张三",
      aliases: [],
      emails: ["me@corp.com"],
      timezone: "Asia/Shanghai",
    });
    expect(store.getRule(SEED_RULE_PERSONAL_ID)).not.toBeNull();
    expect(store.deleteRule(SEED_RULE_PERSONAL_ID)).toBe(true);

    // 再保存档案、再完成向导，都不得把用户删掉的规则播回来（tombstone）。
    const resaved = await sendJson("PUT", "/api/profile", {
      displayName: "张三",
      aliases: ["San Zhang"],
      emails: ["me@corp.com"],
      timezone: "Asia/Shanghai",
    });
    expect(resaved.status).toBe(200);
    await sendJson("PUT", "/api/onboarding", { completed: true });

    expect(store.getRule(SEED_RULE_PERSONAL_ID)).toBeNull();
    expect(store.getRule(SEED_RULE_BROADCAST_ID)).not.toBeNull();
    expect(store.listRules()).toHaveLength(1);
  });

  it("rejects malformed onboarding payloads instead of 500", async () => {
    const notObject = await call("/api/onboarding", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(["completed"]),
    });
    expect(notObject.status).toBe(400);

    const wrongType = await sendJson("PUT", "/api/onboarding", { completed: "yes" });
    expect(wrongType.status).toBe(400);
    const body = (await wrongType.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_input");
  });
});

describe("accounts", () => {
  it("creates an IMAP account with SMTP settings and never returns secrets", async () => {
    const created = await createAccount({
      provider: "imap",
      label: "工作",
      email: "me@corp.com",
      config: { host: "imap.corp.com", port: "993", tls: "1" },
      secret: "app-pw",
      send: {
        smtpHost: "smtp.corp.com",
        smtpPort: 587,
        smtpSecure: false,
        smtpUser: "me@corp.com",
        smtpPassword: "smtp-pw",
      },
    });

    expect(created.status).toBe(201);
    expect(created.text).not.toContain("app-pw");
    expect(created.text).not.toContain("smtp-pw");
    const account = created.account;
    if (account === null) throw new Error("账号创建失败");
    expect(account.provider).toBe("imap");
    expect(account.hasSecret).toBe(true);
    expect(account.hasSmtpPassword).toBe(true);
    expect(account.send?.smtpHost).toBe("smtp.corp.com");
    expect(account.send?.smtpPort).toBe(587);
    expect(account.send?.smtpSecure).toBe(false);

    // 密文落盘可回读：证明走的是加密 secret store，而不是明文列。
    expect(store.getAccountWithSmtpSecret(account.id)?.smtpPassword).toBe("smtp-pw");

    const list = await call("/api/accounts");
    const listText = await list.text();
    expect(listText).not.toContain("app-pw");
    expect(listText).not.toContain("smtp-pw");
    const listBody = JSON.parse(listText) as { items: AccountView[] };
    expect(listBody.items).toHaveLength(1);
    expect(listBody.items[0]?.send?.smtpHost).toBe("smtp.corp.com");
  });

  it("rejects plaintext credentials on POST and PATCH (same validation)", async () => {
    const rejected = await createAccount({
      provider: "imap",
      label: "工作",
      email: "me@corp.com",
      config: { host: "imap.corp.com", password: "hunter2" },
      secret: "",
    });
    expect(rejected.status).toBe(400);
    expect(rejected.text).not.toContain("hunter2");
    expect((JSON.parse(rejected.text) as { error: { code: string } }).error.code).toBe(
      "invalid_input",
    );

    const account = await createMailbox();
    const patched = await sendJson("PATCH", `/api/accounts/${account.id}`, {
      config: { host: "imap.corp.com", password: "hunter2" },
    });
    expect(patched.status).toBe(400);
    expect(await patched.text()).not.toContain("hunter2");
  });

  it("validates EWS accounts and rejects userinfo in ewsUrl without echoing it", async () => {
    const missingUrl = await createAccount({
      provider: "ews",
      label: "公司",
      email: "a@corp.com",
      config: {},
      secret: "ews-pw",
    });
    expect(missingUrl.status).toBe(400);
    expect(missingUrl.text).toContain("ewsUrl");
    expect(missingUrl.text).not.toContain("ews-pw");

    const created = await createAccount({
      provider: "ews",
      label: "公司",
      email: "a@corp.com",
      config: {},
      secret: "ews-pw",
      send: {
        ewsUrl: "https://mail.corp.com/EWS/Exchange.asmx",
        authMode: "ntlm",
        smtpHost: "smtp.corp.com",
        smtpPort: 465,
        smtpSecure: true,
      },
    });
    expect(created.status).toBe(201);
    expect(created.account?.send?.ewsUrl).toBe("https://mail.corp.com/EWS/Exchange.asmx");
    expect(created.account?.send?.authMode).toBe("ntlm");

    const embedded = await createAccount({
      provider: "ews",
      label: "公司",
      email: "a@corp.com",
      config: {},
      secret: "ews-pw",
      send: { ewsUrl: "https://user:secret-pw@mail.corp.com/EWS/Exchange.asmx" },
    });
    expect(embedded.status).toBe(400);
    expect(embedded.text).not.toContain("secret-pw");
    expect(embedded.text).toContain("ewsUrl");
  });

  it("round-trips signature/displayName through POST and PATCH (trim, null clears)", async () => {
    const signature = "——\n张三\n本邮件由 MailCollect 发送";
    const created = await createAccount({
      provider: "imap",
      label: "工作",
      email: "me@corp.com",
      config: { host: "imap.corp.com" },
      secret: "app-pw",
      send: {
        smtpHost: "smtp.corp.com",
        smtpPort: 587,
        smtpPassword: "smtp-pw",
        signature,
        displayName: " 张三 ",
      },
    });
    expect(created.status).toBe(201);
    const account = created.account;
    if (account === null) throw new Error("账号创建失败");
    expect(account.signature).toBe(signature);
    expect(account.displayName).toBe("张三");
    expect(account.send?.signature).toBe(signature);
    expect(account.send?.displayName).toBe("张三");

    const listBody = (await (await call("/api/accounts")).json()) as { items: AccountView[] };
    expect(listBody.items[0]?.signature).toBe(signature);
    expect(listBody.items[0]?.displayName).toBe("张三");

    const patched = await sendJson("PATCH", `/api/accounts/${account.id}`, {
      send: { signature: null, displayName: null },
    });
    expect(patched.status).toBe(200);
    const patchedBody = JSON.parse(await patched.text()) as { account: AccountView };
    expect(patchedBody.account.signature).toBeNull();
    expect(patchedBody.account.displayName).toBeNull();
    expect(patchedBody.account.send?.signature).toBeUndefined();

    const blank = await sendJson("PATCH", `/api/accounts/${account.id}`, {
      send: { signature: "   " },
    });
    expect(blank.status).toBe(200);
    const blankBody = JSON.parse(await blank.text()) as { account: AccountView };
    expect(blankBody.account.signature).toBeNull();
  });

  it("keeps a signature on an account with no send channel (Graph)", async () => {
    const created = await createAccount({
      provider: "graph",
      label: "Outlook",
      email: "me@outlook.com",
      config: { clientId: "abc", tenant: "common" },
      secret: "",
      send: { signature: "——\n个人签名", displayName: "张三" },
    });
    expect(created.status).toBe(201);
    expect(created.account?.send).toBeNull();
    expect(created.account?.signature).toBe("——\n个人签名");
    expect(created.account?.displayName).toBe("张三");
  });

  it("rejects over-long or non-string identity fields without echoing them (POST and PATCH)", async () => {
    const tooLong = "签".repeat(ACCOUNT_SIGNATURE_MAX_LENGTH + 1);
    const rejected = await createAccount({
      provider: "imap",
      label: "工作",
      email: "me@corp.com",
      config: { host: "imap.corp.com" },
      secret: "app-pw",
      send: { smtpHost: "smtp.corp.com", signature: tooLong },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.text).not.toContain("签".repeat(50));
    expect(rejected.text).toContain("signature");
    expect(rejected.text).toContain("超过");
    expect((JSON.parse(rejected.text) as { error: { code: string } }).error.code).toBe(
      "invalid_input",
    );

    const longName = await createAccount({
      provider: "imap",
      label: "工作",
      email: "me@corp.com",
      config: { host: "imap.corp.com" },
      secret: "app-pw",
      send: {
        smtpHost: "smtp.corp.com",
        displayName: "名".repeat(ACCOUNT_DISPLAY_NAME_MAX_LENGTH + 1),
      },
    });
    expect(longName.status).toBe(400);
    expect(longName.text).not.toContain("名".repeat(50));

    const notString = await createAccount({
      provider: "imap",
      label: "工作",
      email: "me@corp.com",
      config: { host: "imap.corp.com" },
      secret: "app-pw",
      send: { smtpHost: "smtp.corp.com", signature: 42 },
    });
    expect(notString.status).toBe(400);

    // PATCH 走同一套校验，同样不回显值。
    const account = await createMailbox();
    const patched = await sendJson("PATCH", `/api/accounts/${account.id}`, {
      send: { signature: tooLong },
    });
    expect(patched.status).toBe(400);
    expect(await patched.text()).not.toContain("签".repeat(50));

    // 边界值（正好 2000 / 200 字符）可接受。
    const boundary = await createAccount({
      provider: "imap",
      label: "工作",
      email: "me@corp.com",
      config: { host: "imap.corp.com" },
      secret: "app-pw",
      send: {
        smtpHost: "smtp.corp.com",
        signature: "签".repeat(ACCOUNT_SIGNATURE_MAX_LENGTH),
        displayName: "名".repeat(ACCOUNT_DISPLAY_NAME_MAX_LENGTH),
      },
    });
    expect(boundary.status).toBe(201);
  });

  it("patches label, enabled and rotating send settings; 404 for unknown ids", async () => {
    const account = await createMailbox();
    const patched = await sendJson("PATCH", `/api/accounts/${account.id}`, {
      label: "改名",
      enabled: false,
      send: {
        smtpHost: "smtp.corp.com",
        smtpPort: 465,
        smtpSecure: true,
        smtpUser: "me@corp.com",
        smtpPassword: "new-pw",
      },
    });
    expect(patched.status).toBe(200);
    const text = await patched.text();
    expect(text).not.toContain("new-pw");
    const body = JSON.parse(text) as { account: AccountView };
    expect(body.account.label).toBe("改名");
    expect(body.account.enabled).toBe(false);
    expect(body.account.hasSmtpPassword).toBe(true);
    expect(body.account.send?.smtpHost).toBe("smtp.corp.com");
    expect(store.getAccountWithSmtpSecret(account.id)?.smtpPassword).toBe("new-pw");

    const missing = await sendJson("PATCH", "/api/accounts/nope", { label: "x" });
    expect(missing.status).toBe(404);
  });
});

describe("verify", () => {
  it("combines receive verification with the injected SMTP verifier", async () => {
    const account = await createMailbox({
      send: { smtpHost: "smtp.corp.com", smtpPort: 587, smtpSecure: false, smtpPassword: "smtp-pw" },
    });
    const verifySmtp = vi.fn<SmtpVerifier>(async () => ({ ok: true, detail: "SMTP 连接成功" }));
    app = buildApp({ verifySmtp });

    const res = await post(`/api/accounts/${account.id}/verify`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; detail: string };
    expect(body.ok).toBe(true);
    expect(body.detail).toContain("收信");
    expect(body.detail).toContain("发信");

    expect(verifySmtp).toHaveBeenCalledTimes(1);
    const target = verifySmtp.mock.calls[0]?.[0] as SmtpConfig | undefined;
    expect(target?.host).toBe("smtp.corp.com");
    expect(target?.port).toBe(587);
    expect(target?.password).toBe("smtp-pw");
  });

  it("redacts the SMTP password from verifier failures", async () => {
    const account = await createMailbox({
      send: { smtpHost: "smtp.corp.com", smtpPort: 465, smtpSecure: true, smtpPassword: "smtp-pw" },
    });
    app = buildApp({
      verifySmtp: vi.fn<SmtpVerifier>(async () => ({
        ok: false,
        detail: "auth: 535 bad credentials smtp-pw",
      })),
    });

    const res = await post(`/api/accounts/${account.id}/verify`);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain("smtp-pw");
    expect((JSON.parse(text) as { ok: boolean }).ok).toBe(false);
  });

  it("turns a thrown not_configured into {ok:false} instead of a 500 (AC-06)", async () => {
    const created = await createAccount({
      provider: "graph",
      label: "Outlook",
      email: "me@outlook.com",
      config: { clientId: "abc", tenant: "common" },
      secret: "",
    });
    expect(created.status).toBe(201);
    const account = created.account;
    if (account === null) throw new Error("账号创建失败");
    verifyAccount.mockRejectedValueOnce(
      new MailError("not_configured", "「graph」缺少必要配置：缺少 clientId"),
    );

    const res = await post(`/api/accounts/${account.id}/verify`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; detail: string };
    expect(body.ok).toBe(false);
    expect(body.detail).toContain("not_configured");
    // 提示需要为发信重新授权（Mail.Send）。
    expect(body.detail).toContain("Mail.Send");
  });

  it("keeps the v1 shape for an unknown account", async () => {
    const res = await post("/api/accounts/nope/verify");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; detail: string };
    expect(body).toEqual({ ok: false, detail: "账号不存在" });
  });
});

describe("autodiscover", () => {
  it("maps an Exchange Online result to exchange-online + device-code", async () => {
    const account = await createMailbox();
    const autodiscover = vi.fn<AutodiscoverProbe>(async () => ({
      kind: "graph" as const,
      ewsUrl: null,
      server: "outlook.office365.com",
      serverVersion: null,
      detail: "指向 Exchange Online：请改用 Microsoft Graph 设备码登录",
    }));
    app = buildApp({ autodiscover });

    const res = await post(`/api/accounts/${account.id}/autodiscover`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as AutodiscoverResponse;
    expect(body.ok).toBe(true);
    expect(body.kind).toBe("exchange-online");
    expect(body.ewsUrl).toBeNull();
    expect(body.authMode).toBe("device-code");
    expect(autodiscover).toHaveBeenCalledTimes(1);
  });

  it("maps an on-prem EWS result to exchange-onprem + password", async () => {
    const account = await createMailbox();
    app = buildApp({
      autodiscover: vi.fn<AutodiscoverProbe>(async () => ({
        kind: "ews" as const,
        ewsUrl: "https://mail.corp.com/EWS/Exchange.asmx",
        server: "mail.corp.com",
        serverVersion: "15.1",
        detail: "使用 EWS 端点",
      })),
    });

    const res = await post(`/api/accounts/${account.id}/autodiscover`);
    const body = (await res.json()) as AutodiscoverResponse;
    expect(body.ok).toBe(true);
    expect(body.kind).toBe("exchange-onprem");
    expect(body.ewsUrl).toBe("https://mail.corp.com/EWS/Exchange.asmx");
    expect(body.authMode).toBe("password");
  });

  it("never echoes credentials from a legacy config.ewsUrl (T54-F1)", async () => {
    // 模拟旧版 v1 落库的脏行：绕过 API 校验，直接写入带 userinfo 的 EWS URL。
    const legacy = store.createAccount({
      provider: "ews",
      label: "旧版 Exchange",
      email: "alice@corp.com",
      config: { ewsUrl: "https://alice:legacy-pw@mail.corp.com/EWS/Exchange.asmx" },
      secret: "ews-pw",
    });

    const res = await post(`/api/accounts/${legacy.id}/autodiscover`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("legacy-pw");
    expect(text).not.toMatch(/:\/\/[^/\s@]+@/u);
    const body = JSON.parse(text) as AutodiscoverResponse;
    expect(body.ok).toBe(true);
    expect(body.kind).toBe("exchange-onprem");
    expect(body.ewsUrl).toBe("https://mail.corp.com/EWS/Exchange.asmx");
    expect(body.detail).toContain("凭据");
  });

  it("returns a readable, redacted failure and still allows manual entry", async () => {
    const account = await createMailbox();
    app = buildApp({
      autodiscover: vi.fn<AutodiscoverProbe>(async () => {
        throw new MailError("auth", "Autodiscover 认证失败：密码 app-pw 被拒绝，请手工填写");
      }),
    });

    const res = await post(`/api/accounts/${account.id}/autodiscover`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("app-pw");
    const body = JSON.parse(text) as AutodiscoverResponse;
    expect(body.ok).toBe(false);
    expect(body.kind).toBe("unknown");
    expect(body.ewsUrl).toBeNull();
    expect(body.detail).toContain("auth");
  });

  it("404s for an unknown account", async () => {
    const res = await post("/api/accounts/nope/autodiscover");
    expect(res.status).toBe(404);
  });
});

describe("discover", () => {
  it("recommends an EWS account from a discovered endpoint without echoing the secret", async () => {
    const discover = vi.fn<DiscoverProbe>(async () => ({
      kind: "ews" as const,
      ewsUrl: "https://mail.corp.com/EWS/Exchange.asmx",
      server: "mail.corp.com",
      serverVersion: null,
      detail: "发现 EWS 端点",
    }));
    app = buildApp({ discover });

    const res = await post("/api/accounts/discover", {
      email: "me@corp.com",
      secret: "probe-pw",
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("probe-pw");
    const body = JSON.parse(text) as DiscoverAccountResponse;
    expect(body.ok).toBe(true);
    expect(body.kind).toBe("exchange-onprem");
    expect(body.provider).toBe("ews");
    expect(body.config["ewsUrl"]).toBe("https://mail.corp.com/EWS/Exchange.asmx");
    expect(discover).toHaveBeenCalledWith({ email: "me@corp.com", secret: "probe-pw" });
  });

  it("rejects credentials from a hostile Autodiscover XML without echoing them (T54-F2)", async () => {
    const hostileXml = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">',
      '<Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a">',
      "<Account><AccountType>email</AccountType><Action>settings</Action>",
      '<Protocol><Type>EXCH</Type><Server>mail.corp.com</Server>',
      "<EwsUrl>https://bob:xml-pw@mail.corp.com/EWS/Exchange.asmx</EwsUrl></Protocol>",
      "</Account></Response></Autodiscover>",
    ].join("");
    // 真 core 解析器 + 敌对 XML fixture：core 拒绝带 userinfo 的 EWS URL（T55 纵深防御），
    // 路由必须把拒绝收敛成可读、无凭据、可手填的响应。
    const discover: DiscoverProbe = (request) =>
      discoverAutodiscover(request, {
        endpoints: ["https://autodiscover.corp.com/autodiscover/autodiscover.xml"],
        fetch: async () => ({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: { get: () => null },
          text: async () => hostileXml,
        }),
      });
    app = buildApp({ discover });

    const res = await post("/api/accounts/discover", { email: "me@corp.com" });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("xml-pw");
    expect(text).not.toMatch(/:\/\/[^/\s@]+@/u);
    const body = JSON.parse(text) as DiscoverAccountResponse;
    expect(body.ok).toBe(false);
    expect(body.kind).toBe("unknown");
    expect(body.provider).toBeNull();
    expect(body.config).toEqual({});
    expect(body.send).toBeNull();
    expect(body.detail).toContain("手工填写");
  });

  it("strips userinfo if a probe ever returns such an EWS URL (route defence)", async () => {
    // 纵深防御：即使探测结果带了 user:pass@，路由出口也只回 scheme+host+path 并提示用户。
    app = buildApp({
      discover: vi.fn<DiscoverProbe>(async () => ({
        kind: "ews" as const,
        ewsUrl: "https://bob:probe-pw@mail.corp.com/EWS/Exchange.asmx",
        server: "mail.corp.com",
        serverVersion: null,
        detail: "已找到本地 Exchange EWS 端点：https://bob:probe-pw@mail.corp.com/EWS/Exchange.asmx",
      })),
    });

    const res = await post("/api/accounts/discover", { email: "me@corp.com" });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("probe-pw");
    expect(text).not.toMatch(/:\/\/[^/\s@]+@/u);
    const body = JSON.parse(text) as DiscoverAccountResponse;
    expect(body.ok).toBe(true);
    expect(body.provider).toBe("ews");
    expect(body.config["ewsUrl"]).toBe("https://mail.corp.com/EWS/Exchange.asmx");
    expect(body.send?.ewsUrl).toBe("https://mail.corp.com/EWS/Exchange.asmx");
    expect(body.detail).toContain("凭据");
  });

  it("does not probe when the caller already chose IMAP/POP3", async () => {
    const discover = vi.fn<DiscoverProbe>();
    app = buildApp({ discover });
    const res = await post("/api/accounts/discover", {
      email: "me@corp.com",
      providerHint: "imap",
    });
    const body = (await res.json()) as DiscoverAccountResponse;
    expect(body.ok).toBe(false);
    expect(body.provider).toBe("imap");
    expect(body.detail).toContain("IMAP");
    expect(discover).not.toHaveBeenCalled();
  });

  it("recommends Graph when the caller already chose it", async () => {
    app = buildApp();
    const res = await post("/api/accounts/discover", {
      email: "me@outlook.com",
      providerHint: "graph",
    });
    const body = (await res.json()) as DiscoverAccountResponse;
    expect(body.ok).toBe(true);
    expect(body.provider).toBe("graph");
    expect(body.send?.authMode).toBe("device-code");
  });

  it("returns a readable failure instead of throwing", async () => {
    app = buildApp({
      discover: vi.fn<DiscoverProbe>(async () => {
        throw new MailError("network", "Autodiscover 连接超时，请手工填写 EWS URL");
      }),
    });
    const res = await post("/api/accounts/discover", { email: "me@corp.com" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DiscoverAccountResponse;
    expect(body.ok).toBe(false);
    expect(body.kind).toBe("unknown");
    expect(body.detail).toContain("network");
  });

  it("requires an email", async () => {
    const res = await post("/api/accounts/discover", { email: "  " });
    expect(res.status).toBe(400);
  });
});

describe("device login", () => {
  it("keeps the 202 + SSE contract and 404s for an unknown account", async () => {
    const created = await createAccount({
      provider: "graph",
      label: "Outlook",
      email: "me@outlook.com",
      config: { clientId: "abc", tenant: "common" },
      secret: "",
    });
    const account = created.account;
    if (account === null) throw new Error("账号创建失败");

    const res = await post(`/api/accounts/${account.id}/login`);
    expect(res.status).toBe(202);
    await Promise.resolve();
    expect(loginAccount).toHaveBeenCalledWith(account.id, expect.any(Function));

    const missing = await post("/api/accounts/nope/login");
    expect(missing.status).toBe(404);
  });
});
