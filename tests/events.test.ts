import assert from "node:assert/strict";
import test from "node:test";
import { applyExternalStatus } from "../src/server/approval-state";
import { settleClaim } from "../src/server/domain";
import { encryptFeishu, feishuSignature } from "../src/server/feishu-crypto";
import { handleFeishuWebhook, integrationView } from "../src/server/feishu";
import { redactText } from "../src/server/redact";
import { ensureDemoSeed } from "../src/server/seed";
import { addPerson, addRate, ctxFor, fullFeishu, scriptedHttp, tempDb, testConfig } from "./helpers";

const secret = "app-secret-value-should-stay-server-side";

test("伪造回调被拒绝，不改变单据", () => {
  const db = tempDb();
  const config = testConfig("production", fullFeishu(secret));
  const { claimId } = seedApprovedReady(db, config, "PENDING", "in_approval");
  const body = Buffer.from(JSON.stringify({ encrypt: "forged" }));
  const result = handleFeishuWebhook({
    config,
    db,
    rawBody: body,
    headers: new Headers({
      "x-lark-request-timestamp": String(Math.floor(Date.now() / 1000)),
      "x-lark-request-nonce": "nonce-1",
      "x-lark-signature": "deadbeef",
    }),
  });
  assert.equal(result.status, 401);
  assert.equal(db.get<{ status: string }>("select status from claims where id = ?", claimId)?.status, "in_approval");
  assert.equal(db.get<{ n: number }>("select count(*) as n from callback_inbox")?.n, 0);
  db.close();
});

test("重复事件只生效一次，旧事件不能把已通过打回，缺配置拒绝回调", () => {
  const db = tempDb();
  const config = testConfig("production", fullFeishu(secret));
  const seeded = seedApprovedReady(db, config, "PENDING", "in_approval");
  const approvedPacket = packet(config, "event-approve", "APPROVED", "2000", seeded.instance);
  const approved = handleFeishuWebhook({ config, db, rawBody: approvedPacket.raw, headers: approvedPacket.headers });
  assert.equal(approved.status, 200);
  assert.equal(db.get<{ status: string }>("select status from claims where id = ?", seeded.claimId)?.status, "settlement_pending");
  const replay = handleFeishuWebhook({ config, db, rawBody: approvedPacket.raw, headers: approvedPacket.headers });
  assert.equal(replay.body.duplicate, true);
  assert.equal(db.get<{ n: number }>("select count(*) as n from audit_events where action = 'approval_status' and to_status = 'settlement_pending'")?.n, 1);
  const stale = post(db, config, "event-old", "PENDING", "1000", seeded.instance);
  assert.equal(stale.status, 200);
  assert.equal(db.get<{ status: string }>("select status from claims where id = ?", seeded.claimId)?.status, "settlement_pending");
  const bare = testConfig("production", { ...fullFeishu(secret), encryptKey: "", verificationToken: "" });
  const blocked = handleFeishuWebhook({
    config: bare,
    db,
    rawBody: Buffer.from("{}"),
    headers: new Headers(),
  });
  assert.equal(blocked.status, 503);
  assert.equal(db.get<{ status: string }>("select status from claims where id = ?", seeded.claimId)?.status, "settlement_pending");
  db.close();
});

test("URL 校验只回 challenge，跨租户事件拒绝，超时恢复不直接算通过", () => {
  const db = tempDb();
  const config = testConfig("production", fullFeishu(secret));
  const seeded = seedApprovedReady(db, config, "PENDING", "in_approval");
  const challengeBody = JSON.stringify({ type: "url_verification", challenge: "abc123", token: "verify-token-test" });
  const challenge = deliver(db, config, challengeBody, "nonce-challenge");
  assert.equal(challenge.status, 200);
  assert.equal(challenge.body.challenge, "abc123");
  assert.equal(db.get<{ status: string }>("select status from claims where id = ?", seeded.claimId)?.status, "in_approval");

  const foreign = {
    uuid: "event-foreign",
    token: "verify-token-test",
    type: "event_callback",
    event: {
      app_id: "cli_test",
      tenant_key: "other-tenant",
      type: "approval_instance",
      approval_code: "APPROVAL-CODE",
      instance_code: seeded.instance,
      status: "APPROVED",
      operate_time: "3000",
    },
  };
  const rejected = deliver(db, config, JSON.stringify(foreign), "nonce-foreign");
  assert.equal(rejected.status, 403);
  assert.equal(db.get<{ status: string }>("select status from claims where id = ?", seeded.claimId)?.status, "in_approval");

  const recover = post(db, config, "event-recover", "OVERTIME_RECOVER", "4000", seeded.instance);
  assert.equal(recover.status, 200);
  const after = db.get<{ status: string; external_status: string; needs_reconcile: number }>(
    `select c.status, b.external_status, b.needs_reconcile from claims c join approval_bindings b on b.claim_id = c.id where c.id = ?`,
    seeded.claimId,
  );
  assert.equal(after?.status, "in_approval");
  assert.equal(after?.needs_reconcile, 1);
  assert.notEqual(after?.external_status, "APPROVED");
  db.close();
});

test("对账拿到权威通过后才进入待结算，查询失败不自动通过", () => {
  const db = tempDb();
  const config = testConfig("production", fullFeishu(secret));
  const seeded = seedApprovedReady(db, config, "OVERTIME_RECOVER", "in_approval");
  db.run("update approval_bindings set needs_reconcile = 1 where claim_id = ?", seeded.claimId);
  const now = new Date("2026-11-08T02:00:00.000Z");
  const held = applyExternalStatus(db, {
    instanceCode: seeded.instance,
    approvalCode: "APPROVAL-CODE",
    status: "PENDING",
    operateTime: null,
    type: "approval_instance",
    now,
    source: "reconcile",
    authoritative: true,
  });
  assert.equal(held, "applied");
  assert.equal(db.get<{ status: string }>("select status from claims where id = ?", seeded.claimId)?.status, "in_approval");
  const finance = addPerson(db, config, "fin", ["finance"]);
  assert.throws(
    () => settleClaim(ctxFor(db, config, scriptedHttp(async () => ({ status: 500, text: "" }))), finance, { claimId: seeded.claimId, voucherNo: "FIN-3001", comment: "不行" }),
    /只有审批通过|审批未通过/,
  );
  applyExternalStatus(db, {
    instanceCode: seeded.instance,
    approvalCode: "APPROVAL-CODE",
    status: "APPROVED",
    operateTime: null,
    type: "approval_instance",
    now,
    source: "reconcile",
    authoritative: true,
  });
  const settled = settleClaim(ctxFor(db, config, scriptedHttp(async () => ({ status: 500, text: "" }))), finance, {
    claimId: seeded.claimId,
    voucherNo: "FIN-3001",
    comment: "权威状态已通过",
  });
  assert.equal(settled.status, "settled");
  db.close();
});

test("健康检查不回显密钥，演示种子金额自洽且标为演示", () => {
  const db = tempDb();
  const config = testConfig("production", fullFeishu(secret));
  const view = integrationView(config, db);
  const text = JSON.stringify(view);
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes("encrypt-key-test"), false);
  assert.equal(view.connected, false);
  assert.equal(view.feishuApproval.status, "已填写 · 待企业联调");
  assert.equal(redactText(`token ${secret}`, [secret]).includes(secret), false);

  const demoDb = tempDb();
  ensureDemoSeed(demoDb, new Date("2026-11-08T02:00:00.000Z"));
  const finance = demoDb.get<{ amount: number; n: number }>(
    "select sum(amount_fen) as amount, count(*) as n from claims where status = 'settlement_pending'",
  );
  assert.equal(finance?.n, 8);
  assert.equal(finance?.amount, 328620);
  const approval = demoDb.get<{ n: number }>("select count(*) as n from claims where status = 'in_approval'");
  assert.equal(approval?.n, 12);
  const settled = demoDb.get<{ amount: number }>("select sum(amount_fen) as amount from claims where status = 'settled'");
  assert.equal(settled?.amount, 1255920);
  const open = demoDb.get<{ distance: number; n: number }>(
    `select sum(t.distance_m) as distance, count(*) as n from trips t
     where t.employee_id = 'emp_zhang' and t.real_claim_eligible = 1
     and not exists (select 1 from trip_occupancy o where o.trip_id = t.id)`,
  );
  assert.equal(open?.n, 6);
  assert.equal(open?.distance, 214000);
  demoDb.close();
  db.close();
});

function seedApprovedReady(db: ReturnType<typeof tempDb>, config: ReturnType<typeof testConfig>, external: string, status: string) {
  addRate(db, false);
  addPerson(db, config, "staff", ["employee"], "员工甲");
  const claimId = "claim-1";
  const instance = "INST-1";
  const now = new Date().toISOString();
  db.run(
    `insert into trips(id, employee_id, started_at, ended_at, distance_m, source, purpose, origin_text, dest_text, trust, real_claim_eligible, is_demo, cross_quarter, point_count, created_at)
     values ('trip-1', 'staff', '2026-11-02T01:00:00.000Z', '2026-11-02T03:00:00.000Z', 10000, 'manual', '拜访', '公司', '客户', 'unverified', 1, 0, 0, 0, ?)`,
    now,
  );
  db.run(
    `insert into claims(id, number, employee_id, status, revision, rate_version_id, distance_m, rate_fen_per_km, amount_fen, rule_snapshot_json, trip_snapshot_json, approval_provider, runtime_channel, is_demo, purpose, created_at, updated_at)
     values (?, 'CL-202611-900', 'staff', ?, 1, 'rate1', 10000, 120, 1200, '{"rateFenPerKm":120,"policyStatus":"enterprise_configured"}', '[]', 'feishu', 'production', 0, '拜访', ?, ?)`,
    claimId,
    status,
    now,
    now,
  );
  db.run("insert into trip_occupancy(trip_id, claim_id) values ('trip-1', ?)", claimId);
  db.run(
    `insert into approval_bindings(id, claim_id, provider, approval_code, instance_code, uuid, external_status, last_operate_time, needs_reconcile, updated_at)
     values ('bind-1', ?, 'feishu', 'APPROVAL-CODE', ?, 'uuid-fixed', ?, '1500', 0, ?)`,
    claimId,
    instance,
    external,
    now,
  );
  return { claimId, instance };
}

function post(db: ReturnType<typeof tempDb>, config: ReturnType<typeof testConfig>, eventId: string, status: string, operateTime: string, instance: string) {
  const packed = packet(config, eventId, status, operateTime, instance);
  return handleFeishuWebhook({ config, db, rawBody: packed.raw, headers: packed.headers });
}

function packet(config: ReturnType<typeof testConfig>, eventId: string, status: string, operateTime: string, instance: string) {
  const payload = {
    uuid: eventId,
    token: "verify-token-test",
    type: "event_callback",
    event: {
      app_id: "cli_test",
      tenant_key: "tenant-test",
      type: "approval_instance",
      approval_code: "APPROVAL-CODE",
      instance_code: instance,
      status,
      operate_time: operateTime,
    },
  };
  const nonce = `nonce-${eventId}`;
  const encrypt = encryptFeishu(config.feishu.encryptKey, JSON.stringify(payload));
  const raw = Buffer.from(JSON.stringify({ encrypt }));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = feishuSignature(timestamp, nonce, config.feishu.encryptKey, raw);
  return {
    raw,
    headers: new Headers({
      "x-lark-request-timestamp": timestamp,
      "x-lark-request-nonce": nonce,
      "x-lark-signature": signature,
    }),
  };
}

function deliver(db: ReturnType<typeof tempDb>, config: ReturnType<typeof testConfig>, plain: string, nonce: string) {
  const encrypt = encryptFeishu(config.feishu.encryptKey, plain);
  const raw = Buffer.from(JSON.stringify({ encrypt }));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = feishuSignature(timestamp, nonce, config.feishu.encryptKey, raw);
  return handleFeishuWebhook({
    config,
    db,
    rawBody: raw,
    headers: new Headers({
      "x-lark-request-timestamp": timestamp,
      "x-lark-request-nonce": nonce,
      "x-lark-signature": signature,
    }),
  });
}
