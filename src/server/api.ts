import { completeFeishuLogin, createSession, loadActor, requireRole, type Role } from "./auth";
import type { AppConfig } from "./config";
import { loadConfig } from "./config";
import { openDatabase, type AppDb } from "./db";
import {
  consoleSummary,
  createClaim,
  createDemoCruise,
  createGpsTrip,
  createManualTrip,
  createRate,
  decideDemo,
  employeeSummary,
  exportClaims,
  listAudits,
  listLedger,
  listMyTrips,
  listPeople,
  listRates,
  listVisibleClaims,
  mapOpenId,
  periodStats,
  readClaim,
  reconcileClaims,
  recordReversal,
  setRoles,
  settleClaim,
  submitClaim,
} from "./domain";
import { AppError, isAppError } from "./errors";
import { buildAuthorizeUrl, createFetchHttp, FeishuClient, handleFeishuWebhook, integrationView, newOauthState, type FeishuHttp } from "./feishu";
import { ensureDemoSeed } from "./seed";

export type Services = { db: AppDb; config: AppConfig; http: FeishuHttp };

let cached: Services | null = null;

export function defaultServices(): Services {
  if (!cached) {
    const config = loadConfig();
    const db = openDatabase(config.databasePath);
    if (config.mode === "demo") ensureDemoSeed(db);
    cached = { db, config, http: createFetchHttp() };
  }
  return cached;
}

export async function dispatch(request: Request, slug: string[], services: Services = defaultServices()): Promise<Response> {
  try {
    if (!(request.method === "GET" || request.method === "POST")) return json({ message: "不支持的方法" }, 405);
    const key = `${request.method} ${slug.join("/")}`;
    if (key === "POST feishu/events") {
      const raw = Buffer.from(await request.arrayBuffer());
      const result = handleFeishuWebhook({ config: services.config, db: services.db, rawBody: raw, headers: request.headers });
      return json(result.body, result.status);
    }
    if (request.method === "POST") assertBrowserWrite(request);
    const url = new URL(request.url);
    if (key === "GET bootstrap") return json(bootstrap(services.config));
    if (key === "GET session") return json({ actor: publicActor(services, request) });
    if (key === "POST auth/logout") return logout(services, request);
    if (key === "GET auth/feishu/start") return startOauth(services);
    if (key === "GET auth/feishu/callback") return callbackOauth(services, url);
    if (key === "POST demo/enter") return enterDemo(services, request);
    const actor = loadActor(services.db, services.config, readCookie(request, "mileage_session"));
    if (!actor) return json({ message: "请先登录" }, 401);
    const ctx = { db: services.db, config: services.config, http: services.http };
    if (key === "GET me/summary") return json(employeeSummary(ctx, actor));
    if (key === "GET me/stats") return json(periodStats(ctx, actor));
    if (key === "GET trips") return json({ trips: listMyTrips(ctx, actor) });
    if (key === "POST trips") return json(await createTrip(ctx, actor, await request.json()));
    if (key === "GET claims") return json({ claims: listVisibleClaims(ctx, actor, {}) });
    if (key === "POST claims") return json(createClaim(ctx, actor, await request.json()), 201);
    if (key === "GET console/summary") return json(consoleSummary(ctx, actor));
    if (key === "GET console/claims") {
      return json({ claims: listVisibleClaims(ctx, actor, { status: url.searchParams.get("status") || undefined, q: url.searchParams.get("q") || undefined, month: url.searchParams.get("month") || undefined }) });
    }
    if (key === "GET console/claims/export") {
      const csv = exportClaims(ctx, actor);
      return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=claims.csv" } });
    }
    if (key === "POST console/settlements") return json(settleClaim(ctx, actor, await request.json()));
    if (key === "POST console/reversals") {
      const body = await request.json();
      return json(recordReversal(ctx, actor, String(body.claimId), String(body.comment ?? "")));
    }
    if (key === "GET console/ledger") return json({ trips: listLedger(ctx, actor) });
    if (key === "GET console/people") return json(listPeople(ctx, actor));
    if (key === "GET console/rates") return json({ rates: listRates(ctx, actor) });
    if (key === "POST console/rates") return json(createRate(ctx, actor, await request.json()), 201);
    if (key === "GET console/audits") return json({ audits: listAudits(ctx, actor) });
    if (key === "GET integration/health") {
      if (!actor.roles.includes("admin")) return json({ message: "只有管理员可以查看集成健康" }, 403);
      return json(integrationView(services.config, services.db));
    }
    if (key === "POST integration/reconcile") return json(await reconcileClaims(ctx, actor));
    const claimDetail = key.match(/^GET claims\/([^/]+)$/);
    if (claimDetail) return json(readClaim(ctx, actor, claimDetail[1]));
    const submit = key.match(/^POST claims\/([^/]+)\/submit$/);
    if (submit) {
      const header = request.headers.get("idempotency-key") || "";
      const approvalProvider = request.headers.get("x-approval-provider") || undefined;
      return json(await submitClaim(ctx, actor, submit[1], header, approvalProvider));
    }
    const decide = key.match(/^POST demo\/claims\/([^/]+)\/decide$/);
    if (decide) {
      const body = await request.json();
      return json(decideDemo(ctx, actor, decide[1], body.decision, String(body.comment ?? "")));
    }
    const roles = key.match(/^POST console\/people\/([^/]+)\/roles$/);
    if (roles) {
      const body = await request.json();
      setRoles(ctx, actor, roles[1], parseRoleList(body.roles));
      return json({ ok: true });
    }
    const openId = key.match(/^POST console\/people\/([^/]+)\/open-id$/);
    if (openId) {
      const body = await request.json();
      mapOpenId(ctx, actor, openId[1], String(body.openId ?? ""));
      return json({ ok: true });
    }
    return json({ message: "没有这个接口" }, 404);
  } catch (error) {
    if (isAppError(error)) return json({ error: error.code, message: error.message, missing: error.missing }, error.status);
    console.error("api_error", error instanceof Error ? error.name : "unknown");
    return json({ message: "服务暂时不可用" }, 500);
  }
}

function bootstrap(config: AppConfig) {
  const missing = ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_TENANT_KEY", "FEISHU_REDIRECT_URI"].filter((key) => {
    const map: Record<string, string> = {
      FEISHU_APP_ID: config.feishu.appId,
      FEISHU_APP_SECRET: config.feishu.appSecret,
      FEISHU_TENANT_KEY: config.feishu.tenantKey,
      FEISHU_REDIRECT_URI: config.feishu.redirectUri,
    };
    return !map[key];
  });
  return {
    mode: config.mode,
    product: "私车公用 · 里程补贴",
    demoAvailable: config.mode === "demo",
    feishuLoginReady: missing.length === 0 && config.mode !== "demo",
    missingOauth: missing,
    connected: false,
  };
}

function publicActor(services: Services, request: Request) {
  const actor = loadActor(services.db, services.config, readCookie(request, "mileage_session"));
  if (!actor) return null;
  return { name: actor.name, roles: actor.roles, pending: actor.pending, isDemo: actor.isDemo, mode: actor.mode, openIdMasked: actor.openIdMasked };
}

function logout(services: Services, request: Request) {
  const id = readCookie(request, "mileage_session");
  if (id) services.db.run("delete from sessions where id = ?", id);
  return json({ ok: true }, 200, clearCookie(services.config));
}

function startOauth(services: Services) {
  if (services.config.mode === "demo") {
    return json({ message: "演示模式使用演示身份进入，不会跳转飞书" }, 409);
  }
  const fresh = newOauthState(services.config);
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  services.db.run("insert into oauth_states(state, code_verifier, expires_at) values (?, ?, ?)", fresh.state, fresh.verifier ?? null, expires);
  return Response.redirect(buildAuthorizeUrl(services.config, fresh.state, fresh.verifier), 302);
}

async function callbackOauth(services: Services, url: URL) {
  if (url.searchParams.get("error")) return Response.redirect(`${services.config.publicBaseUrl}/login?error=denied`, 302);
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const client = new FeishuClient(services.config, services.http);
  const result = await completeFeishuLogin({ db: services.db, config: services.config, client, code, state });
  const response = Response.redirect(`${services.config.publicBaseUrl}/home`, 302);
  response.headers.set("set-cookie", sessionCookie(result.sessionId, services.config));
  return response;
}

async function enterDemo(services: Services, request: Request) {
  if (services.config.mode !== "demo") return json({ error: "DEMO_ONLY", message: "当前不是演示模式，不能自行选择角色" }, 403);
  const body = await request.json();
  const persona = String(body.persona || "");
  const map: Record<string, string> = {
    zhang: "emp_zhang",
    li: "emp_li",
    wang: "emp_wang",
    zhou: "emp_zhou",
    zhao: "emp_zhao",
    chen: "emp_chen",
  };
  const employeeId = map[persona];
  if (!employeeId) return json({ message: "未知的演示身份" }, 400);
  const employee = services.db.get<{ is_demo: number }>("select is_demo from employees where id = ?", employeeId);
  if (!employee || employee.is_demo !== 1) return json({ message: "演示身份不存在" }, 404);
  const sessionId = createSession(services.db, services.config, { employeeId });
  return json({ ok: true, demo: true }, 200, sessionCookie(sessionId, services.config));
}

async function createTrip(ctx: { db: AppDb; config: AppConfig; http: FeishuHttp }, actor: NonNullable<ReturnType<typeof loadActor>>, body: {
  source?: string;
  startedAt?: string;
  endedAt?: string;
  distanceKm?: string;
  purpose?: string;
  origin?: string;
  destination?: string;
  evidenceNote?: string;
  points?: Array<{ lat: number; lng: number; recordedAt: string; accuracyM?: number }>;
}) {
  if (body.source === "demo_cruise") return createDemoCruise(ctx, actor);
  if (body.source === "browser_gps") {
    return createGpsTrip(ctx, actor, {
      purpose: body.purpose || "",
      origin: body.origin || "",
      destination: body.destination || "",
      points: body.points || [],
    });
  }
  return createManualTrip(ctx, actor, {
    startedAt: body.startedAt || "",
    endedAt: body.endedAt || "",
    distanceKm: body.distanceKm || "",
    purpose: body.purpose || "",
    origin: body.origin || "",
    destination: body.destination || "",
    evidenceNote: body.evidenceNote || "",
  });
}

function parseRoleList(input: unknown): Role[] {
  if (!Array.isArray(input)) throw new AppError("ROLE", "角色无效", 400);
  return input.map((item) => {
    if (typeof item !== "string") throw new AppError("ROLE", "角色无效", 400);
    return requireRole(item, 400);
  });
}

function assertBrowserWrite(request: Request) {
  if (request.headers.get("x-mileage-client") !== "1") {
    throw new AppError("CSRF", "缺少本站请求头", 403);
  }
  const origin = request.headers.get("origin");
  if (!origin) return;
  const originHost = new URL(origin).host;
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || "";
  if (!sameSite(originHost, host)) throw new AppError("CSRF", "来源站点不匹配", 403);
}

function sameSite(originHost: string, host: string): boolean {
  if (originHost === host) return true;
  const local = new Set(["localhost", "127.0.0.1", "[::1]"]);
  const [leftHost, leftPort] = splitHost(originHost);
  const [rightHost, rightPort] = splitHost(host);
  return local.has(leftHost) && local.has(rightHost) && leftPort === rightPort;
}

function splitHost(value: string): [string, string] {
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return [value.slice(0, end + 1), value.slice(end + 2)];
  }
  const index = value.lastIndexOf(":");
  if (index === -1) return [value, ""];
  return [value.slice(0, index), value.slice(index + 1)];
}

function readCookie(request: Request, name: string): string | undefined {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

function sessionCookie(id: string, config: AppConfig): string {
  const secure = config.publicBaseUrl.startsWith("https://") ? "; Secure" : "";
  return `mileage_session=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${secure}`;
}

function clearCookie(config: AppConfig): string {
  const secure = config.publicBaseUrl.startsWith("https://") ? "; Secure" : "";
  return `mileage_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}

function json(data: unknown, status = 200, cookie?: string) {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  if (cookie) headers.set("set-cookie", cookie);
  return new Response(JSON.stringify(data), { status, headers });
}
