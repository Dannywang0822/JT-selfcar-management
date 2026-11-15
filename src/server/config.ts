import path from "node:path";
import { AppError } from "./errors";

export type AppMode = "demo" | "sandbox" | "production";

export type FeishuWidgets = {
  claimNo: string;
  amount: string;
  distance: string;
  summary: string;
};

export type AppConfig = {
  mode: AppMode;
  nodeEnv: string;
  sessionSecret: string;
  databasePath: string;
  publicBaseUrl: string;
  maxTripMeters: number;
  eventMaxSkewSeconds: number;
  feishu: {
    appId: string;
    appSecret: string;
    tenantKey: string;
    redirectUri: string;
    approvalCode: string;
    encryptKey: string;
    verificationToken: string;
    oauthScopes: string;
    pkce: boolean;
    bootstrapAdminOpenId: string;
    widgets: FeishuWidgets;
    accountsBase: "https://accounts.feishu.cn";
    openBase: "https://open.feishu.cn";
  };
};

const DEMO_SESSION_SECRET = "demo-dev-session-secret-not-for-production";
const PLACEHOLDERS = new Set(["", "changeme", "change-me", DEMO_SESSION_SECRET, "your-secret"]);

export type ConfigGroup = "oauth" | "approval" | "events";

const FIELD_GROUPS: Record<ConfigGroup, Array<{ key: string; label: string; value: (config: AppConfig) => string }>> = {
  oauth: [
    { key: "FEISHU_APP_ID", label: "应用 App ID", value: (c) => c.feishu.appId },
    { key: "FEISHU_APP_SECRET", label: "应用 App Secret", value: (c) => c.feishu.appSecret },
    { key: "FEISHU_TENANT_KEY", label: "企业 tenant_key", value: (c) => c.feishu.tenantKey },
    { key: "FEISHU_REDIRECT_URI", label: "OAuth 回调地址", value: (c) => c.feishu.redirectUri },
  ],
  approval: [
    { key: "FEISHU_APPROVAL_CODE", label: "审批定义 Code", value: (c) => c.feishu.approvalCode },
    { key: "FEISHU_WIDGET_CLAIM_NO", label: "表单控件：单号", value: (c) => c.feishu.widgets.claimNo },
    { key: "FEISHU_WIDGET_AMOUNT", label: "表单控件：金额", value: (c) => c.feishu.widgets.amount },
    { key: "FEISHU_WIDGET_DISTANCE", label: "表单控件：里程", value: (c) => c.feishu.widgets.distance },
    { key: "FEISHU_WIDGET_SUMMARY", label: "表单控件：摘要", value: (c) => c.feishu.widgets.summary },
  ],
  events: [
    { key: "FEISHU_ENCRYPT_KEY", label: "事件 Encrypt Key", value: (c) => c.feishu.encryptKey },
    { key: "FEISHU_VERIFICATION_TOKEN", label: "Verification Token", value: (c) => c.feishu.verificationToken },
    { key: "FEISHU_APP_ID", label: "应用 App ID", value: (c) => c.feishu.appId },
    { key: "FEISHU_TENANT_KEY", label: "企业 tenant_key", value: (c) => c.feishu.tenantKey },
  ],
};

export function missingFields(config: AppConfig, group: ConfigGroup): string[] {
  return FIELD_GROUPS[group].filter((field) => !field.value(config).trim()).map((field) => field.key);
}

export function assertFields(config: AppConfig, group: ConfigGroup): void {
  const missing = missingFields(config, group);
  if (missing.length) {
    const error = new AppError("CONFIG_MISSING", `飞书${groupLabel(group)}未配置，已阻断真实请求`, 409);
    error.missing = missing;
    throw error;
  }
}

function groupLabel(group: ConfigGroup): string {
  if (group === "oauth") return "登录";
  if (group === "approval") return "审批";
  return "事件订阅";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): AppConfig {
  const nodeEnv = env.NODE_ENV || "development";
  const rawMode = (env.APP_ENV || "").trim();
  let mode: AppMode;
  if (!rawMode) {
    if (nodeEnv === "production") {
      throw new Error("NODE_ENV=production 时必须显式设置 APP_ENV=sandbox 或 production，禁止默认进入演示");
    }
    mode = "demo";
  } else if (rawMode === "demo" || rawMode === "sandbox" || rawMode === "production") {
    mode = rawMode;
  } else {
    throw new Error("APP_ENV 只能是 demo、sandbox 或 production");
  }
  if (mode === "demo" && nodeEnv === "production") {
    throw new Error("APP_ENV=demo 不能与 NODE_ENV=production 同时使用");
  }

  const sessionFromEnv = (env.SESSION_SECRET || "").trim();
  let sessionSecret = sessionFromEnv;
  if (mode === "demo" && !sessionSecret) sessionSecret = DEMO_SESSION_SECRET;
  if (mode !== "demo") {
    if (PLACEHOLDERS.has(sessionSecret) || sessionSecret.length < 24) {
      throw new Error("sandbox/production 必须配置长度不少于 24 的 SESSION_SECRET，且不能使用演示占位值");
    }
  }

  const redirectUri = (env.FEISHU_REDIRECT_URI || "").trim();
  if (mode !== "demo" && redirectUri && !redirectUri.startsWith("https://")) {
    throw new Error("sandbox/production 的 FEISHU_REDIRECT_URI 必须是 https");
  }

  const skew = Number(env.FEISHU_EVENT_MAX_SKEW_SECONDS || "28800");
  if (!Number.isFinite(skew) || skew < 60) {
    throw new Error("FEISHU_EVENT_MAX_SKEW_SECONDS 无效");
  }

  const databasePath =
    (env.DATABASE_PATH || "").trim() || path.join(cwd, "data", `${mode}.db`);

  return {
    mode,
    nodeEnv,
    sessionSecret,
    databasePath,
    publicBaseUrl: (env.PUBLIC_BASE_URL || "http://127.0.0.1:43123").replace(/\/$/, ""),
    maxTripMeters: Number(env.MAX_TRIP_METERS || `${800 * 1000}`),
    eventMaxSkewSeconds: skew,
    feishu: {
      appId: (env.FEISHU_APP_ID || "").trim(),
      appSecret: (env.FEISHU_APP_SECRET || "").trim(),
      tenantKey: (env.FEISHU_TENANT_KEY || "").trim(),
      redirectUri,
      approvalCode: (env.FEISHU_APPROVAL_CODE || "").trim(),
      encryptKey: (env.FEISHU_ENCRYPT_KEY || "").trim(),
      verificationToken: (env.FEISHU_VERIFICATION_TOKEN || "").trim(),
      oauthScopes: (env.FEISHU_OAUTH_SCOPES || "").trim(),
      pkce: env.FEISHU_OAUTH_PKCE === "1",
      bootstrapAdminOpenId: (env.FEISHU_BOOTSTRAP_ADMIN_OPEN_ID || "").trim(),
      widgets: {
        claimNo: (env.FEISHU_WIDGET_CLAIM_NO || "").trim(),
        amount: (env.FEISHU_WIDGET_AMOUNT || "").trim(),
        distance: (env.FEISHU_WIDGET_DISTANCE || "").trim(),
        summary: (env.FEISHU_WIDGET_SUMMARY || "").trim(),
      },
      accountsBase: "https://accounts.feishu.cn",
      openBase: "https://open.feishu.cn",
    },
  };
}

export function secretMaterial(config: AppConfig): string[] {
  return [
    config.sessionSecret,
    config.feishu.appSecret,
    config.feishu.encryptKey,
    config.feishu.verificationToken,
  ];
}
