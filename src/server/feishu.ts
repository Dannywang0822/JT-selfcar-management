import crypto from "node:crypto";
import { assertFields, missingFields, type AppConfig } from "./config";
import type { AppDb } from "./db";
import { AppError } from "./errors";
import { decryptFeishu, feishuSignature, pkceChallenge, randomToken, sha256Hex, timingSafeEqualText } from "./feishu-crypto";
import { createDisabledOaAdapter } from "./oa";
import { redactText } from "./redact";
import { applyExternalStatus } from "./approval-state";

export type FeishuHttp = {
  request(input: {
    method: "GET" | "POST";
    url: string;
    headers: Record<string, string>;
    body?: string;
    timeoutMs: number;
  }): Promise<{ status: number; text: string }>;
};

export type CreateOutcome =
  | { kind: "created"; instanceCode: string; logId?: string }
  | { kind: "timeout"; message: string }
  | { kind: "uuid_conflict"; message: string; logId?: string }
  | { kind: "retryable"; message: string; logId?: string }
  | { kind: "rejected"; message: string; logId?: string };

export type InstanceView = { status: string };

export interface ApprovalProvider {
  readonly channel: "demo" | "live";
  createInstance(input: { uuid: string; openId: string; form: string }): Promise<CreateOutcome>;
  getInstance(instanceCode: string, openId?: string): Promise<InstanceView>;
}

export class FeishuTimeout extends Error {
  constructor() {
    super("飞书请求超时");
    this.name = "FeishuTimeout";
  }
}

export function createFetchHttp(): FeishuHttp {
  return {
    async request(input) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), input.timeoutMs);
      try {
        const response = await fetch(input.url, {
          method: input.method,
          headers: input.headers,
          body: input.body,
          signal: ctrl.signal,
        });
        return { status: response.status, text: await response.text() };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw new FeishuTimeout();
        throw new Error("飞书网络失败");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

type TokenCache = { token: string; expiresAt: number };

export class FeishuClient {
  private cache: TokenCache | null = null;
  private inflight: Promise<string> | null = null;

  constructor(
    private config: AppConfig,
    private http: FeishuHttp,
    private now: () => number = Date.now,
  ) {}

  private secrets(): string[] {
    return [this.config.feishu.appSecret, this.config.feishu.encryptKey, this.config.feishu.verificationToken];
  }

  private clean(text: string): string {
    return redactText(text, this.secrets()).slice(0, 400);
  }

  async tenantToken(): Promise<string> {
    assertFields(this.config, "oauth");
    const current = this.cache;
    if (current && current.expiresAt - this.now() > 60_000) return current.token;
    if (!this.inflight) {
      this.inflight = this.mintTenantToken().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async mintTenantToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.config.feishu.appId,
      client_secret: this.config.feishu.appSecret,
    });
    const url = `${this.config.feishu.accountsBase}/oauth/v3/token`;
    let response: { status: number; text: string };
    try {
      response = await this.http.request({
        method: "POST",
        url,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        timeoutMs: 8000,
      });
    } catch (error) {
      throw this.transportError(error);
    }
    const parsed = safeJson(response.text);
    const token = typeof parsed.access_token === "string" ? parsed.access_token : "";
    const code = Number(parsed.code);
    if (response.status >= 200 && response.status < 300 && code === 0 && token) {
      const expiresIn = Number(parsed.expires_in);
      const ttl = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 60_000;
      this.cache = { token, expiresAt: this.now() + ttl };
      return token;
    }
    throw new AppError(
      "FEISHU_TOKEN",
      `获取 tenant_access_token 失败（HTTP ${response.status}，code ${Number.isFinite(code) ? code : "无"}）`,
      502,
    );
  }

  async exchangeUserCode(code: string, codeVerifier?: string): Promise<string> {
    assertFields(this.config, "oauth");
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: this.config.feishu.appId,
      client_secret: this.config.feishu.appSecret,
      code,
      redirect_uri: this.config.feishu.redirectUri,
    });
    if (codeVerifier) params.set("code_verifier", codeVerifier);
    let response: { status: number; text: string };
    try {
      response = await this.http.request({
        method: "POST",
        url: `${this.config.feishu.accountsBase}/oauth/v3/token`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: params.toString(),
        timeoutMs: 8000,
      });
    } catch (error) {
      throw this.transportError(error);
    }
    const parsed = safeJson(response.text);
    const token = typeof parsed.access_token === "string" ? parsed.access_token : "";
    if (Number(parsed.code) === 0 && token) return token;
    throw new AppError("FEISHU_OAUTH", `授权码换取用户 token 失败（code ${String(parsed.code ?? "无")}）`, 401);
  }

  async userInfo(userAccessToken: string): Promise<{
    openId: string;
    tenantKey: string;
    name: string;
    userId?: string;
  }> {
    let response: { status: number; text: string };
    try {
      response = await this.http.request({
        method: "GET",
        url: `${this.config.feishu.openBase}/open-apis/authen/v1/user_info`,
        headers: { authorization: `Bearer ${userAccessToken}` },
        timeoutMs: 8000,
      });
    } catch (error) {
      throw this.transportError(error);
    }
    const parsed = safeJson(response.text);
    const data = (parsed.data ?? {}) as Record<string, unknown>;
    const openId = String(data.open_id ?? "");
    const tenantKey = String(data.tenant_key ?? "");
    const name = String(data.name ?? "");
    if (Number(parsed.code) !== 0 || !openId || !tenantKey || !name) {
      throw new AppError("FEISHU_USER", "飞书用户信息不完整，不能建立会话", 401);
    }
    if (!timingSafeEqualText(tenantKey, this.config.feishu.tenantKey)) {
      throw new AppError("TENANT_MISMATCH", "登录租户与部署配置的 tenant_key 不一致", 403);
    }
    const userId = typeof data.user_id === "string" ? data.user_id : undefined;
    return { openId, tenantKey, name, userId };
  }

  async createInstance(input: { uuid: string; openId: string; form: string }): Promise<CreateOutcome> {
    assertFields(this.config, "oauth");
    assertFields(this.config, "approval");
    let token: string;
    try {
      token = await this.tenantToken();
    } catch (error) {
      if (isTimeout(error)) return { kind: "timeout", message: "获取租户 token 超时，未更换 uuid" };
      if (error instanceof AppError && error.code === "CONFIG_MISSING") throw error;
      return { kind: "retryable", message: error instanceof Error ? this.clean(error.message) : "token 失败" };
    }
    const url = `${this.config.feishu.openBase}/open-apis/approval/v4/instances`;
    const body = JSON.stringify({
      approval_code: this.config.feishu.approvalCode,
      open_id: input.openId,
      form: input.form,
      uuid: input.uuid,
    });
    let response: { status: number; text: string };
    try {
      response = await this.http.request({
        method: "POST",
        url,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=utf-8",
        },
        body,
        timeoutMs: 10000,
      });
    } catch (error) {
      if (isTimeout(error)) return { kind: "timeout", message: "创建审批超时，将用原 uuid 对账，不会另开新单" };
      return { kind: "retryable", message: "创建审批网络失败，将用原 uuid 重试" };
    }
    return this.readCreate(response);
  }

  private readCreate(response: { status: number; text: string }): CreateOutcome {
    const parsed = safeJson(response.text);
    const code = Number(parsed.code);
    const logId = typeof parsed.log_id === "string" ? parsed.log_id : undefined;
    const data = (parsed.data ?? {}) as Record<string, unknown>;
    const instanceCode = typeof data.instance_code === "string" ? data.instance_code : "";
    if (code === 0 && instanceCode) return { kind: "created", instanceCode, logId };
    const message = this.clean(String(parsed.msg || parsed.error_description || "飞书拒绝创建"));
    if (code === 60012) {
      return { kind: "uuid_conflict", message: "飞书返回 60012，uuid 冲突。未当作新单成功，需按原 uuid 对账", logId };
    }
    if (response.status === 429 || response.status >= 500) {
      return { kind: "retryable", message, logId };
    }
    return { kind: "rejected", message: `飞书创建失败 code=${Number.isFinite(code) ? code : "无"} ${message}`, logId };
  }

  async getInstance(instanceCode: string, openId?: string): Promise<InstanceView> {
    assertFields(this.config, "oauth");
    assertFields(this.config, "approval");
    const token = await this.tenantToken();
    const url = new URL(
      `${this.config.feishu.openBase}/open-apis/approval/v4/instances/${encodeURIComponent(instanceCode)}`,
    );
    url.searchParams.set("locale", "zh-CN");
    url.searchParams.set("user_id_type", "open_id");
    if (openId) url.searchParams.set("user_id", openId);
    const response = await this.http.request({
      method: "GET",
      url: url.toString(),
      headers: { authorization: `Bearer ${token}` },
      timeoutMs: 8000,
    });
    const parsed = safeJson(response.text);
    const data = (parsed.data ?? {}) as Record<string, unknown>;
    const status = typeof data.status === "string" ? data.status : "";
    if (Number(parsed.code) !== 0 || !status) {
      throw new AppError("FEISHU_QUERY", "拉取审批实例失败，未把单据改成已通过", 502);
    }
    return { status };
  }

  async subscribe(): Promise<{ already: boolean; message: string }> {
    assertFields(this.config, "oauth");
    assertFields(this.config, "approval");
    const token = await this.tenantToken();
    const url = `${this.config.feishu.openBase}/open-apis/approval/v4/approvals/${encodeURIComponent(this.config.feishu.approvalCode)}/subscribe`;
    const response = await this.http.request({
      method: "POST",
      url,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: "{}",
      timeoutMs: 8000,
    });
    const parsed = safeJson(response.text);
    const code = Number(parsed.code);
    if (code === 0) return { already: false, message: "订阅请求已成功。仍需在开发者后台订阅 approval_instance 事件。" };
    if (code === 1390007) return { already: true, message: "该审批定义已订阅或已取消，飞书返回 1390007，未重复制造订阅。" };
    throw new AppError("FEISHU_SUBSCRIBE", `订阅失败 code=${Number.isFinite(code) ? code : "无"}`, 502);
  }

  private transportError(error: unknown): AppError {
    if (isTimeout(error)) return new AppError("FEISHU_TIMEOUT", "飞书请求超时", 504);
    return new AppError("FEISHU_NETWORK", "飞书网络失败", 502);
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof FeishuTimeout;
}

function safeJson(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export class LiveApprovalProvider implements ApprovalProvider {
  readonly channel = "live" as const;
  constructor(private client: FeishuClient) {}
  createInstance(input: { uuid: string; openId: string; form: string }): Promise<CreateOutcome> {
    return this.client.createInstance(input);
  }
  getInstance(instanceCode: string, openId?: string): Promise<InstanceView> {
    return this.client.getInstance(instanceCode, openId);
  }
}

export class DemoApprovalProvider implements ApprovalProvider {
  readonly channel = "demo" as const;
  constructor(private db: AppDb) {}
  async createInstance(input: { uuid: string; openId: string; form: string }): Promise<CreateOutcome> {
    void input.openId;
    void input.form;
    return { kind: "created", instanceCode: `demo-${input.uuid}` };
  }
  async getInstance(instanceCode: string): Promise<InstanceView> {
    const row = this.db.get<{ external_status: string | null }>(
      "select external_status from approval_bindings where instance_code = ?",
      instanceCode,
    );
    if (!row?.external_status) throw new AppError("DEMO_INSTANCE", "演示实例不存在", 404);
    return { status: row.external_status };
  }
}

export function createApprovalProvider(config: AppConfig, db: AppDb, http: FeishuHttp): ApprovalProvider {
  if (config.mode === "demo") return new DemoApprovalProvider(db);
  return new LiveApprovalProvider(new FeishuClient(config, http));
}

export function buildAuthorizeUrl(config: AppConfig, state: string, verifier?: string): string {
  assertFields(config, "oauth");
  const url = new URL(`${config.feishu.accountsBase}/open-apis/authen/v1/authorize`);
  url.searchParams.set("client_id", config.feishu.appId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", config.feishu.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "consent");
  if (config.feishu.oauthScopes) url.searchParams.set("scope", config.feishu.oauthScopes);
  if (config.feishu.pkce && verifier) {
    url.searchParams.set("code_challenge", pkceChallenge(verifier));
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

export function newOauthState(config: AppConfig): { state: string; verifier?: string } {
  const state = randomToken(24);
  const verifier = config.feishu.pkce ? randomToken(48) : undefined;
  return { state, verifier };
}

export type WebhookResult = { status: number; body: Record<string, unknown> };

export function handleFeishuWebhook(input: {
  config: AppConfig;
  db: AppDb;
  rawBody: Buffer;
  headers: Headers;
  now?: Date;
}): WebhookResult {
  const now = input.now ?? new Date();
  if (input.config.mode === "demo") {
    return { status: 403, body: { error: "DEMO_MODE", message: "演示模式不接收飞书回调" } };
  }
  const missing = missingFields(input.config, "events");
  if (missing.length) {
    return { status: 503, body: { error: "CONFIG_MISSING", message: "事件密钥未配置，已拒绝回调", missing } };
  }
  const timestamp = input.headers.get("x-lark-request-timestamp") ?? "";
  const nonce = input.headers.get("x-lark-request-nonce") ?? "";
  const signature = (input.headers.get("x-lark-signature") ?? "").toLowerCase();
  if (!timestamp || !nonce || !signature) {
    auditReject(input.db, now, "缺少签名头");
    return { status: 401, body: { error: "BAD_SIGNATURE", message: "缺少飞书签名头" } };
  }
  const expected = feishuSignature(timestamp, nonce, input.config.feishu.encryptKey, input.rawBody);
  if (!timingSafeEqualText(expected, signature)) {
    auditReject(input.db, now, "签名不匹配");
    return { status: 401, body: { error: "BAD_SIGNATURE", message: "回调签名校验失败" } };
  }
  const bodyHash = sha256Hex(input.rawBody);
  const seenNonce = input.db.get<{ body_sha256: string }>("select body_sha256 from callback_nonces where nonce = ?", nonce);
  if (seenNonce && seenNonce.body_sha256 !== bodyHash) {
    auditReject(input.db, now, "nonce 复用且正文不同");
    return { status: 401, body: { error: "REPLAY", message: "nonce 与不同正文重复使用" } };
  }
  const knownBody = input.db.get<{ dedupe_key: string }>("select dedupe_key from callback_inbox where body_sha256 = ?", bodyHash);
  const skew = Math.abs(now.getTime() / 1000 - Number(timestamp));
  if (!Number.isFinite(Number(timestamp)) || skew > input.config.eventMaxSkewSeconds) {
    if (knownBody) return { status: 200, body: { code: 0, duplicate: true } };
    auditReject(input.db, now, "时间窗超出");
    return { status: 401, body: { error: "STALE_TIMESTAMP", message: "回调时间超出允许窗口" } };
  }
  let payload: Record<string, unknown>;
  try {
    const envelope = JSON.parse(input.rawBody.toString("utf8")) as { encrypt?: string };
    if (!envelope.encrypt) throw new Error("缺少 encrypt");
    payload = JSON.parse(decryptFeishu(input.config.feishu.encryptKey, envelope.encrypt)) as Record<string, unknown>;
  } catch {
    auditReject(input.db, now, "解密失败");
    return { status: 401, body: { error: "DECRYPT", message: "事件解密失败" } };
  }
  const token = String(payload.token ?? (payload.header as { token?: string } | undefined)?.token ?? "");
  if (!timingSafeEqualText(token, input.config.feishu.verificationToken)) {
    auditReject(input.db, now, "verification token 不匹配");
    return { status: 401, body: { error: "BAD_TOKEN", message: "Verification Token 不匹配" } };
  }
  if (!seenNonce) {
    input.db.run("insert into callback_nonces(nonce, body_sha256, received_at) values (?, ?, ?)", nonce, bodyHash, now.toISOString());
  }
  if (payload.type === "url_verification") {
    audit(input.db, now, "url_verification", "callback", "challenge", null, null, "仅返回 challenge");
    return { status: 200, body: { challenge: String(payload.challenge ?? "") } };
  }
  const event = normalizeEvent(payload);
  if (!event) {
    return { status: 400, body: { error: "BAD_EVENT", message: "无法识别的事件结构" } };
  }
  if (event.appId && event.appId !== input.config.feishu.appId) {
    auditReject(input.db, now, "app_id 不匹配");
    return { status: 403, body: { error: "APP_MISMATCH", message: "事件 app_id 与当前应用不一致" } };
  }
  if (event.tenantKey && event.tenantKey !== input.config.feishu.tenantKey) {
    auditReject(input.db, now, "tenant_key 不匹配");
    return { status: 403, body: { error: "TENANT_MISMATCH", message: "事件租户与部署租户不一致" } };
  }
  const existing = input.db.get<{ process_state: string }>(
    "select process_state from callback_inbox where dedupe_key = ?",
    event.dedupeKey,
  );
  if (existing && (existing.process_state === "applied" || existing.process_state === "ignored_stale" || existing.process_state === "ignored_unknown" || existing.process_state === "ignored_type" || existing.process_state === "ignored_foreign")) {
    return { status: 200, body: { code: 0, duplicate: true } };
  }
  if (!existing) {
    try {
      input.db.run(
        `insert into callback_inbox(id, dedupe_key, body_sha256, event_uuid, event_type, instance_code, external_status, operate_time, process_state, received_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        crypto.randomUUID(),
        event.dedupeKey,
        bodyHash,
        event.dedupeKey,
        event.type,
        event.instanceCode,
        event.status,
        event.operateTime,
        now.toISOString(),
      );
    } catch {
      return { status: 500, body: { error: "PERSIST", message: "事件未能落库，请重试" } };
    }
  }
  let processState = "applied";
  let errorText: string | null = null;
  try {
    processState = applyExternalStatus(input.db, {
      instanceCode: event.instanceCode,
      approvalCode: event.approvalCode,
      status: event.status,
      operateTime: event.operateTime,
      type: event.type,
      now,
      source: "feishu_event",
    });
  } catch (error) {
    processState = "failed";
    errorText = error instanceof Error ? error.message : "处理失败";
  }
  input.db.run(
    "update callback_inbox set process_state = ?, error = ?, processed_at = ? where dedupe_key = ?",
    processState,
    errorText,
    now.toISOString(),
    event.dedupeKey,
  );
  return { status: 200, body: { code: 0, processState } };
}

type NormalEvent = {
  dedupeKey: string;
  type: string;
  appId: string;
  tenantKey: string;
  approvalCode: string;
  instanceCode: string;
  status: string;
  operateTime: string | null;
};

function normalizeEvent(payload: Record<string, unknown>): NormalEvent | null {
  if (payload.schema === "2.0") {
    const header = (payload.header ?? {}) as Record<string, unknown>;
    const event = (payload.event ?? {}) as Record<string, unknown>;
    const dedupeKey = String(header.event_id ?? "");
    if (!dedupeKey) return null;
    return {
      dedupeKey,
      type: String(header.event_type ?? event.type ?? ""),
      appId: String(header.app_id ?? ""),
      tenantKey: String(header.tenant_key ?? ""),
      approvalCode: String(event.approval_code ?? ""),
      instanceCode: String(event.instance_code ?? ""),
      status: String(event.status ?? ""),
      operateTime: normalizeOperateTime(event.operate_time),
    };
  }
  const event = (payload.event ?? {}) as Record<string, unknown>;
  const dedupeKey = String(payload.uuid ?? "");
  if (!dedupeKey || payload.type !== "event_callback") return null;
  return {
    dedupeKey,
    type: String(event.type ?? ""),
    appId: String(event.app_id ?? ""),
    tenantKey: String(event.tenant_key ?? ""),
    approvalCode: String(event.approval_code ?? ""),
    instanceCode: String(event.instance_code ?? ""),
    status: String(event.status ?? ""),
    operateTime: normalizeOperateTime(event.operate_time ?? event.instance_operate_time),
  };
}

export function normalizeOperateTime(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value === "string" && /^-?\d+$/.test(value)) return value;
  return null;
}

function oaHealth() {
  const capabilities = createDisabledOaAdapter().capabilities();
  const live = capabilities.enabled || capabilities.canSubmit || capabilities.canCallback || capabilities.canPay;
  return {
    status: live ? "已接通" : "预留禁用",
    missing: [] as string[],
    note: capabilities.reason,
    canSubmit: capabilities.canSubmit,
    canPay: capabilities.canPay,
  };
}

function auditReject(db: AppDb, now: Date, comment: string) {
  audit(db, now, "callback_rejected", "callback", "rejected", null, null, comment);
}

function audit(
  db: AppDb,
  now: Date,
  action: string,
  objectType: string,
  objectId: string,
  fromStatus: string | null,
  toStatus: string | null,
  comment: string,
) {
  db.run(
    `insert into audit_events(id, actor_id, action, object_type, object_id, from_status, to_status, comment, source, at)
     values (?, null, ?, ?, ?, ?, ?, ?, 'feishu', ?)`,
    crypto.randomUUID(),
    action,
    objectType,
    objectId,
    fromStatus,
    toStatus,
    comment,
    now.toISOString(),
  );
}

export function integrationView(config: AppConfig, db: AppDb) {
  const oauthMissing = missingFields(config, "oauth");
  const approvalMissing = missingFields(config, "approval");
  const eventMissing = missingFields(config, "events");
  const last = db.get<{ at: string; ok: number; message: string }>(
    "select at, ok, message from integration_checks order by at desc limit 1",
  );
  const describe = (missing: string[]) => {
    if (config.mode === "demo") return missing.length ? "未配置" : "已填写，演示模式仍不会调用飞书";
    return missing.length ? "未配置" : "已填写 · 待企业联调";
  };
  return {
    mode: config.mode,
    connected: false,
    feishuOauth: { status: describe(oauthMissing), missing: oauthMissing },
    feishuApproval: { status: describe(approvalMissing), missing: approvalMissing },
    feishuEvents: { status: describe(eventMissing), missing: eventMissing },
    oa: oaHealth(),
    map: { status: "未配置", note: "没有地图服务配置，不提供智能路线导航。" },
    message: { status: "未启用", note: "首期不发送飞书消息。" },
    lastCheck: last
      ? { at: last.at, ok: last.ok === 1, message: last.message }
      : { at: null, ok: false, message: "从未向飞书发起校验请求" },
    secretsDisplayed: false,
  };
}
