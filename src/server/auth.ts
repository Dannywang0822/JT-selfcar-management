import crypto from "node:crypto";
import type { AppMode } from "./config";
import type { AppConfig } from "./config";
import type { AppDb } from "./db";
import { AppError } from "./errors";
import { FeishuClient } from "./feishu";
import { timingSafeEqualText } from "./feishu-crypto";
import { isRole, type Role } from "../lib/states";

export type { Role } from "../lib/states";
export { isRole } from "../lib/states";

export function requireRole(value: string, httpStatus = 500): Role {
  if (!isRole(value)) throw new AppError("ROLE", "角色无效", httpStatus);
  return value;
}

export type Actor = {
  sessionId: string;
  id: string;
  name: string;
  roles: Role[];
  isDemo: boolean;
  mode: AppMode;
  pending: boolean;
  openIdMasked: string;
};

export function loadActor(db: AppDb, config: AppConfig, sessionId: string | undefined, now = new Date()): Actor | null {
  if (!sessionId) return null;
  const session = db.get<{
    id: string;
    employee_id: string | null;
    pending_identity_id: string | null;
    mode: string;
    expires_at: string;
  }>("select * from sessions where id = ?", sessionId);
  if (!session || session.mode !== config.mode) return null;
  if (new Date(session.expires_at).getTime() <= now.getTime()) return null;
  if (session.employee_id) {
    const employee = db.get<Employee>("select * from employees where id = ?", session.employee_id);
    if (!employee || employee.status !== "active") return null;
    if (Boolean(employee.is_demo) !== (config.mode === "demo")) return null;
    const roles = db
      .all<{ role: string }>("select role from employee_roles where employee_id = ?", employee.id)
      .map((row) => requireRole(row.role));
    return {
      sessionId: session.id,
      id: employee.id,
      name: employee.name,
      roles,
      isDemo: employee.is_demo === 1,
      mode: config.mode,
      pending: false,
      openIdMasked: mask(employee.open_id),
    };
  }
  if (session.pending_identity_id) {
    const pending = db.get<{ id: string; name: string; open_id: string }>(
      "select * from pending_identities where id = ?",
      session.pending_identity_id,
    );
    if (!pending) return null;
    return {
      sessionId: session.id,
      id: pending.id,
      name: pending.name,
      roles: [],
      isDemo: false,
      mode: config.mode,
      pending: true,
      openIdMasked: mask(pending.open_id),
    };
  }
  return null;
}

export function assertRole(actor: Actor, role: Role) {
  if (actor.pending || !actor.roles.includes(role)) {
    throw new AppError("FORBIDDEN", "当前身份没有此操作权限", 403);
  }
}

export function assertAnyRole(actor: Actor, roles: Role[]) {
  if (actor.pending || !roles.some((role) => actor.roles.includes(role))) {
    throw new AppError("FORBIDDEN", "当前身份没有此操作权限", 403);
  }
}

export function createSession(db: AppDb, config: AppConfig, input: { employeeId?: string; pendingId?: string }, now = new Date()): string {
  const id = crypto.randomBytes(32).toString("hex");
  const expires = new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString();
  db.run(
    "insert into sessions(id, employee_id, pending_identity_id, mode, expires_at, created_at) values (?, ?, ?, ?, ?, ?)",
    id,
    input.employeeId ?? null,
    input.pendingId ?? null,
    config.mode,
    expires,
    now.toISOString(),
  );
  return id;
}

export async function completeFeishuLogin(input: {
  db: AppDb;
  config: AppConfig;
  client: FeishuClient;
  code: string;
  state: string;
  now?: Date;
}): Promise<{ sessionId: string; pending: boolean; name: string }> {
  const now = input.now ?? new Date();
  const state = input.db.get<{ code_verifier: string | null; expires_at: string; used_at: string | null }>(
    "select * from oauth_states where state = ?",
    input.state,
  );
  if (!state || state.used_at || new Date(state.expires_at).getTime() <= now.getTime()) {
    throw new AppError("OAUTH_STATE", "登录状态无效或已使用", 401);
  }
  input.db.run("update oauth_states set used_at = ? where state = ?", now.toISOString(), input.state);
  const userToken = await input.client.exchangeUserCode(input.code, state.code_verifier ?? undefined);
  const profile = await input.client.userInfo(userToken);
  let employee = input.db.get<Employee>(
    "select * from employees where tenant_key = ? and open_id = ?",
    profile.tenantKey,
    profile.openId,
  );
  if (!employee && input.config.feishu.bootstrapAdminOpenId && timingSafeEqualText(profile.openId, input.config.feishu.bootstrapAdminOpenId)) {
    const id = crypto.randomUUID();
    input.db.run(
      `insert into employees(id, name, open_id, tenant_key, feishu_user_id, status, is_demo, created_at)
       values (?, ?, ?, ?, ?, 'active', 0, ?)`,
      id,
      profile.name,
      profile.openId,
      profile.tenantKey,
      profile.userId ?? null,
      now.toISOString(),
    );
    input.db.run("insert into employee_roles(employee_id, role) values (?, 'admin')", id);
    employee = input.db.get<Employee>("select * from employees where id = ?", id);
  }
  if (!employee || employee.status !== "active") {
    const existing = input.db.get<{ id: string }>(
      "select id from pending_identities where tenant_key = ? and open_id = ?",
      profile.tenantKey,
      profile.openId,
    );
    let pendingId = existing?.id;
    if (!pendingId) {
      pendingId = crypto.randomUUID();
      input.db.run(
        `insert into pending_identities(id, open_id, tenant_key, name, feishu_user_id, created_at)
         values (?, ?, ?, ?, ?, ?)`,
        pendingId,
        profile.openId,
        profile.tenantKey,
        profile.name,
        profile.userId ?? null,
        now.toISOString(),
      );
    }
    const sessionId = createSession(input.db, input.config, { pendingId }, now);
    return { sessionId, pending: true, name: profile.name };
  }
  if (profile.userId && employee.feishu_user_id !== profile.userId) {
    input.db.run("update employees set feishu_user_id = ? where id = ?", profile.userId, employee.id);
  }
  const sessionId = createSession(input.db, input.config, { employeeId: employee.id }, now);
  return { sessionId, pending: false, name: employee.name };
}

type Employee = {
  id: string;
  name: string;
  open_id: string | null;
  status: string;
  is_demo: number;
  feishu_user_id: string | null;
};

function mask(openId: string | null): string {
  if (!openId) return "未映射";
  if (openId.length <= 8) return "已映射";
  return `${openId.slice(0, 3)}····${openId.slice(-4)}`;
}
