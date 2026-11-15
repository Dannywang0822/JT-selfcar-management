import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { dispatch } from "../src/server/api";
import { createSession } from "../src/server/auth";
import { openDatabase } from "../src/server/db";
import { createClaim, createManualTrip, submitClaim } from "../src/server/domain";
import { integrationView } from "../src/server/feishu";
import { addPerson, addRate, ctxFor, fullFeishu, scriptedHttp, tempDb, testConfig, tokenOk } from "./helpers";

test("非法角色和状态写不进去，外键违规写不进去，旧库迁移后仍守住这些约束", () => {
  const db = tempDb();
  const config = testConfig("production", fullFeishu());
  addRate(db, false);
  const admin = addPerson(db, config, "admin", ["admin"], "管理员");
  const staff = addPerson(db, config, "staff", ["employee"], "员工甲");
  const ctx = ctxFor(db, config, scriptedHttp(async () => tokenOk()));
  const trip = createManualTrip(ctx, staff, {
    startedAt: "2026-11-02T09:00:00+08:00",
    endedAt: "2026-11-02T11:00:00+08:00",
    distanceKm: "4.0",
    purpose: "约束",
    origin: "公司",
    destination: "客户",
    evidenceNote: "测试",
  });
  const claim = createClaim(ctx, staff, { tripIds: [trip.id], purpose: "约束申请" });
  assert.throws(() => db.run("update claims set status = 'paid' where id = ?", claim.id));
  assert.throws(() => db.run("insert into employee_roles(employee_id, role) values (?, 'wizard')", staff.id));
  assert.throws(() => db.run(
    `insert into settlements(id, claim_id, amount_fen, voucher_no, operator_id, comment, status, created_at)
     values ('s-missing', 'missing-claim', 100, 'V-NO', ?, 'x', 'confirmed', ?)`,
    admin.id,
    new Date().toISOString(),
  ));
  assert.throws(() => db.run(
    `insert into claims(id, number, employee_id, status, revision, rate_version_id, distance_m, rate_fen_per_km, amount_fen, rule_snapshot_json, trip_snapshot_json, approval_provider, runtime_channel, is_demo, purpose, created_at, updated_at)
     values ('ghost', 'CL-GHOST', 'nobody', 'draft', 1, 'rate1', 1000, 120, 120, '{}', '[]', 'feishu', 'production', 0, 'x', ?, ?)`,
    new Date().toISOString(),
    new Date().toISOString(),
  ));
  const sessionId = createSession(db, config, { employeeId: admin.id });
  return dispatch(new Request("http://127.0.0.1:43123/api/console/people/staff/roles", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mileage-client": "1",
      cookie: `mileage_session=${sessionId}`,
    },
    body: JSON.stringify({ roles: ["employee", "wizard"] }),
  }), ["console", "people", "staff", "roles"], { db, config, http: scriptedHttp(async () => tokenOk()) }).then(async (response) => {
    assert.equal(response.status, 400);
    const body = await response.json() as { error: string };
    assert.equal(body.error, "ROLE");
    const roles = db.all<{ role: string }>("select role from employee_roles where employee_id = ?", staff.id).map((row) => row.role);
    assert.deepEqual(roles, ["employee"]);
    db.close();
  }).then(() => migrateLegacy());
});

function migrateLegacy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mileage-legacy-"));
  const file = path.join(dir, "legacy.db");
  const raw = new DatabaseSync(file);
  raw.exec(`
    create table employees (
      id text primary key, name text not null, open_id text, tenant_key text,
      status text not null, is_demo integer not null, created_at text not null
    );
    create table rate_versions (id text primary key, name text not null);
    create table employee_roles (employee_id text not null, role text not null, primary key (employee_id, role));
    create table claims (
      id text primary key, number text not null unique, employee_id text not null, status text not null,
      revision integer not null, previous_claim_id text, rate_version_id text not null, distance_m integer not null,
      rate_fen_per_km integer not null, amount_fen integer not null, rule_snapshot_json text not null,
      trip_snapshot_json text not null, approval_provider text not null, runtime_channel text not null,
      is_demo integer not null, assigned_approver_id text, idempotency_key text, request_hash text,
      purpose text not null, submitted_at text, created_at text not null, updated_at text not null
    );
    create table settlements (
      id text primary key, claim_id text not null unique, amount_fen integer not null, voucher_no text not null unique,
      operator_id text not null, comment text not null, status text not null, created_at text not null
    );
    create table approval_bindings (
      id text primary key, claim_id text not null unique, provider text not null, approval_code text,
      instance_code text, uuid text not null unique, external_status text, last_operate_time text,
      needs_reconcile integer not null, updated_at text not null
    );
  `);
  const now = new Date().toISOString();
  raw.prepare("insert into employees(id, name, status, is_demo, created_at) values ('emp', '旧库员工', 'active', 0, ?)").run(now);
  raw.prepare("insert into rate_versions(id, name) values ('rate1', '旧费率')").run();
  raw.prepare("insert into employee_roles(employee_id, role) values ('emp', 'employee')").run();
  raw.prepare(`insert into claims(id, number, employee_id, status, revision, rate_version_id, distance_m, rate_fen_per_km, amount_fen, rule_snapshot_json, trip_snapshot_json, approval_provider, runtime_channel, is_demo, purpose, created_at, updated_at)
    values ('c1', 'CL-OLD-001', 'emp', 'draft', 1, 'rate1', 1000, 120, 120, '{}', '[]', 'feishu', 'production', 0, '保留', ?, ?)`).run(now, now);
  raw.prepare(`insert into settlements(id, claim_id, amount_fen, voucher_no, operator_id, comment, status, created_at)
    values ('set1', 'c1', 120, 'OLD-1', 'emp', '旧结算', 'confirmed', ?)`).run(now);
  raw.prepare(`insert into approval_bindings(id, claim_id, provider, uuid, external_status, needs_reconcile, updated_at)
    values ('b1', 'c1', 'feishu', 'uuid-old', 'PENDING', 0, ?)`).run(now);
  raw.close();

  const upgraded = openDatabase(file);
  const claim = upgraded.get<{ number: string; status: string; amount_fen: number }>("select number, status, amount_fen from claims where id = 'c1'");
  assert.equal(claim?.number, "CL-OLD-001");
  assert.equal(claim?.status, "draft");
  assert.equal(claim?.amount_fen, 120);
  assert.equal(upgraded.get<{ n: number }>("select count(*) as n from settlements")?.n, 1);
  assert.throws(() => upgraded.run("update claims set status = 'paid' where id = 'c1'"));
  assert.throws(() => upgraded.run("insert into employee_roles(employee_id, role) values ('emp', 'wizard')"));
  assert.throws(() => upgraded.run(
    "insert into approval_bindings(id, claim_id, provider, uuid, needs_reconcile, updated_at) values ('b2', 'missing', 'feishu', 'uuid-2', 0, ?)",
    now,
  ));
  upgraded.close();
}

test("提交入口选择 OA 时失败，单据保持草稿，也不访问飞书", async () => {
  const db = tempDb();
  const config = testConfig("production", fullFeishu());
  addRate(db, false);
  const staff = addPerson(db, config, "staff", ["employee"]);
  const http = scriptedHttp(async () => tokenOk());
  const ctx = ctxFor(db, config, http);
  const trip = createManualTrip(ctx, staff, {
    startedAt: "2026-11-03T09:00:00+08:00",
    endedAt: "2026-11-03T10:00:00+08:00",
    distanceKm: "2.0",
    purpose: "OA",
    origin: "公司",
    destination: "客户",
    evidenceNote: "测试",
  });
  const claim = createClaim(ctx, staff, { tripIds: [trip.id], purpose: "不要发 OA" });
  await assert.rejects(() => submitClaim(ctx, staff, claim.id, "idem-oa-0001", "oa"), /不会向任何 OA 发单/);
  assert.equal(db.get<{ status: string }>("select status from claims where id = ?", claim.id)?.status, "draft");
  assert.equal(http.urls.length, 0);
  const health = integrationView(config, db);
  assert.equal(health.oa.status, "预留禁用");
  assert.equal(health.oa.canSubmit, false);
  assert.equal(health.oa.canPay, false);
  assert.equal(health.connected, false);
  db.close();
});
