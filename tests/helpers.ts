import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Actor, Role } from "../src/server/auth";
import type { AppConfig, AppMode } from "../src/server/config";
import { openDatabase, type AppDb } from "../src/server/db";
import type { FeishuHttp } from "../src/server/feishu";

export function tempDb(): AppDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mileage-"));
  return openDatabase(path.join(dir, "app.db"));
}

export function testConfig(mode: AppMode, feishu?: Partial<AppConfig["feishu"]>): AppConfig {
  return {
    mode,
    nodeEnv: "test",
    sessionSecret: "test-session-secret-not-a-real-key",
    databasePath: ":memory:",
    publicBaseUrl: "http://127.0.0.1:43123",
    maxTripMeters: 800_000,
    eventMaxSkewSeconds: 28_800,
    feishu: {
      appId: "",
      appSecret: "",
      tenantKey: "",
      redirectUri: "",
      approvalCode: "",
      encryptKey: "",
      verificationToken: "",
      oauthScopes: "",
      pkce: false,
      bootstrapAdminOpenId: "",
      accountsBase: "https://accounts.feishu.cn",
      openBase: "https://open.feishu.cn",
      ...feishu,
      widgets: { claimNo: "", amount: "", distance: "", summary: "", ...feishu?.widgets },
    },
  };
}

export function fullFeishu(secret = "app-secret-value-should-stay-server-side"): Partial<AppConfig["feishu"]> {
  return {
    appId: "cli_test",
    appSecret: secret,
    tenantKey: "tenant-test",
    redirectUri: "https://example.com/api/auth/feishu/callback",
    approvalCode: "APPROVAL-CODE",
    encryptKey: "encrypt-key-test",
    verificationToken: "verify-token-test",
    widgets: { claimNo: "w1", amount: "w2", distance: "w3", summary: "w4" },
  };
}

export function addPerson(db: AppDb, config: AppConfig, id: string, roles: Role[], name = id): Actor {
  const demo = config.mode === "demo" ? 1 : 0;
  db.run(
    `insert into employees(id, name, open_id, tenant_key, status, is_demo, created_at)
     values (?, ?, ?, ?, 'active', ?, ?)`,
    id,
    name,
    `ou_${id}`,
    config.feishu.tenantKey || "tenant-test",
    demo,
    new Date().toISOString(),
  );
  for (const role of roles) db.run("insert into employee_roles(employee_id, role) values (?, ?)", id, role);
  return {
    sessionId: "session",
    id,
    name,
    roles,
    isDemo: demo === 1,
    mode: config.mode,
    pending: false,
    openIdMasked: "masked",
  };
}

export function addRate(db: AppDb, demo: boolean) {
  db.run(
    `insert into rate_versions(
      id, name, quarter_label, baseline_price_fen_per_liter, previous_price_fen_per_liter, current_price_fen_per_liter,
      baseline_rate_fen_per_km, threshold_fen, step_fen_per_km, rounding, policy_status, effective_from, effective_to,
      region_note, source_note, is_demo, notes, created_at
    ) values ('rate1', '测试费率', '测试', 750, 750, 750, 120, 50, 5, 'toward_zero', ?, '2020-01-01', '2099-12-31', '待确认', '待确认', ?, '测试', ?)`,
    demo ? "demo_unconfirmed" : "enterprise_configured",
    demo ? 1 : 0,
    new Date().toISOString(),
  );
}

export function scriptedHttp(handler: (input: { method: string; url: string; body?: string }) => { status: number; text: string } | Promise<{ status: number; text: string }>): FeishuHttp & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    async request(input) {
      urls.push(input.url);
      return handler(input);
    },
  };
}

export function tokenOk() {
  return { status: 200, text: JSON.stringify({ code: 0, access_token: "token-for-test", expires_in: 7200, token_type: "Bearer" }) };
}

export function ctxFor(db: AppDb, config: AppConfig, http: FeishuHttp) {
  return { db, config, http, now: new Date("2026-11-08T02:00:00.000Z") };
}

export function uuid() {
  return crypto.randomUUID();
}
