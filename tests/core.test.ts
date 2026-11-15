import assert from "node:assert/strict";
import test from "node:test";
import { dispatch } from "../src/server/api";
import { adjustedRate } from "../src/server/rates";
import { createClaim, createDemoCruise, createManualTrip, decideDemo, getTrip, listLedger, readClaim, reconcileClaims, setRoles, settleClaim, submitClaim } from "../src/server/domain";
import { FeishuTimeout } from "../src/server/feishu";
import { createDisabledOaAdapter } from "../src/server/oa";
import { ensureDemoSeed } from "../src/server/seed";
import { addPerson, addRate, ctxFor, fullFeishu, scriptedHttp, tempDb, testConfig, tokenOk } from "./helpers";

test("油价不足 0.50 元不调，满 0.50 元才按 0.05 元/公里调整", () => {
  const base = { baselineRateFenPerKm: 120, thresholdFen: 50, stepFenPerKm: 5, previousPriceFenPerLiter: 750 };
  assert.equal(adjustedRate({ ...base, currentPriceFenPerLiter: 799 }).steps, 0);
  assert.equal(adjustedRate({ ...base, currentPriceFenPerLiter: 800 }).rateFenPerKm, 125);
  assert.equal(adjustedRate({ ...base, currentPriceFenPerLiter: 700 }).rateFenPerKm, 115);
  assert.equal(adjustedRate({ ...base, currentPriceFenPerLiter: 701 }).steps, 0);
});

test("角色隔离：员工看不到别人的行程，管理员和审批人不能结算", async () => {
  const db = tempDb();
  const config = testConfig("production", fullFeishu());
  addRate(db, false);
  const staff = addPerson(db, config, "staff", ["employee"], "员工甲");
  const other = addPerson(db, config, "other", ["employee"], "员工乙");
  const approver = addPerson(db, config, "appr", ["approver"], "审批人");
  const admin = addPerson(db, config, "admin", ["admin"], "管理员");
  const finance = addPerson(db, config, "fin", ["finance"], "财务");
  const http = scriptedHttp(async () => tokenOk());
  const ctx = ctxFor(db, config, http);
  const trip = createManualTrip(ctx, staff, tripInput("10.0"));
  assert.equal(trip.distanceLabel, "10.0");
  createManualTrip(ctx, other, tripInput("8.0"));
  assert.throws(() => getTrip(ctx, other, trip.id), /行程不存在/);
  assert.throws(() => listLedger(ctx, finance), /没有此操作权限/);
  const claim = createClaim(ctx, staff, { tripIds: [trip.id], purpose: "拜访客户" });
  assert.throws(() => settleClaim(ctx, staff, { claimId: claim.id, voucherNo: "FIN-1001", comment: "不行" }), /没有此操作权限/);
  assert.throws(() => settleClaim(ctx, approver, { claimId: claim.id, voucherNo: "FIN-1001", comment: "不行" }), /没有此操作权限/);
  assert.throws(() => settleClaim(ctx, admin, { claimId: claim.id, voucherNo: "FIN-1001", comment: "不行" }), /没有此操作权限/);
  assert.throws(() => setRoles(ctx, admin, admin.id, ["admin", "finance"]), /不能给自己追加/);
  void finance;
  db.close();
});

test("未审批不能结算，通过后才能结算且不能重复结算", () => {
  const db = tempDb();
  const config = testConfig("production", fullFeishu());
  addRate(db, false);
  const staff = addPerson(db, config, "staff", ["employee"], "员工甲");
  const finance = addPerson(db, config, "fin", ["finance"], "财务");
  const ctx = ctxFor(db, config, scriptedHttp(async () => tokenOk()));
  const trip = createManualTrip(ctx, staff, tripInput("12.5"));
  const claim = createClaim(ctx, staff, { tripIds: [trip.id], purpose: "巡检" });
  assert.throws(() => settleClaim(ctx, finance, { claimId: claim.id, voucherNo: "FIN-2001", comment: "未审批" }), /审批未通过|只有审批通过/);
  db.run("update claims set status = 'settlement_pending' where id = ?", claim.id);
  assert.throws(() => settleClaim(ctx, finance, { claimId: claim.id, voucherNo: "FIN-2001", comment: "仍无外部通过" }), /审批未通过/);
  db.run(
    `insert into approval_bindings(id, claim_id, provider, approval_code, instance_code, uuid, external_status, needs_reconcile, updated_at)
     values ('b1', ?, 'feishu', 'APPROVAL-CODE', 'INST', 'uuid-1', 'PENDING', 0, ?)`,
    claim.id,
    new Date().toISOString(),
  );
  assert.throws(() => settleClaim(ctx, finance, { claimId: claim.id, voucherNo: "FIN-2001", comment: "审批中" }), /审批未通过/);
  db.run("update approval_bindings set external_status = 'APPROVED' where claim_id = ?", claim.id);
  const settled = settleClaim(ctx, finance, { claimId: claim.id, voucherNo: "FIN-2001", comment: "核对无误，不自动付款" });
  assert.equal(settled.status, "settled");
  assert.throws(() => settleClaim(ctx, finance, { claimId: claim.id, voucherNo: "FIN-2002", comment: "再结一次" }), /已结算|只有审批通过/);
  db.close();
});

test("同一行程不能重复报销，驳回后才可修订", () => {
  const db = tempDb();
  const config = testConfig("production", fullFeishu());
  addRate(db, false);
  const staff = addPerson(db, config, "staff", ["employee"]);
  const ctx = ctxFor(db, config, scriptedHttp(async () => tokenOk()));
  const trip = createManualTrip(ctx, staff, tripInput("6.0"));
  createClaim(ctx, staff, { tripIds: [trip.id], purpose: "第一次" });
  assert.throws(() => createClaim(ctx, staff, { tripIds: [trip.id], purpose: "第二次" }), /有效报销占用/);
  db.close();
});

test("演示巡航不能进入申请", () => {
  const db = tempDb();
  const config = testConfig("demo");
  addRate(db, true);
  const staff = addPerson(db, config, "staff", ["employee"]);
  const ctx = ctxFor(db, config, scriptedHttp(async () => tokenOk()));
  const cruise = createDemoCruise(ctx, staff);
  assert.equal(cruise.eligible, false);
  assert.throws(() => createClaim(ctx, staff, { tripIds: [cruise.id], purpose: "想报销演示巡航" }), /演示巡航不能进入/);
  db.close();
});

test("缺配置阻断真实提交，失败不会改成演示成功", async () => {
  const db = tempDb();
  const config = testConfig("production", { appId: "cli_test", appSecret: "secret-value-xxx", tenantKey: "tenant-test", redirectUri: "https://example.com/cb" });
  addRate(db, false);
  const staff = addPerson(db, config, "staff", ["employee"]);
  const http = scriptedHttp(async () => {
    throw new Error("不应该被调用");
  });
  const ctx = ctxFor(db, config, http);
  const trip = createManualTrip(ctx, staff, tripInput("5.0"));
  const claim = createClaim(ctx, staff, { tripIds: [trip.id], purpose: "真实提交" });
  await assert.rejects(() => submitClaim(ctx, staff, claim.id, "idem-key-001"), /未配置/);
  const row = db.get<{ status: string }>("select status from claims where id = ?", claim.id);
  assert.equal(row?.status, "draft");
  assert.equal(http.urls.length, 0);
  db.close();
});

test("创建超时沿用原 uuid，60012 不当作新单成功", async () => {
  const db = tempDb();
  const config = testConfig("production", fullFeishu());
  addRate(db, false);
  const staff = addPerson(db, config, "staff", ["employee"]);
  let creates = 0;
  const http = scriptedHttp(async (input) => {
    if (input.url.endsWith("/oauth/v3/token")) return tokenOk();
    creates += 1;
    const body = JSON.parse(input.body || "{}") as { uuid: string };
    if (creates === 1) {
      assert.equal(body.uuid.length, 36);
      throw new FeishuTimeout();
    }
    return { status: 400, text: JSON.stringify({ code: 60012, msg: "uuid conflict" }) };
  });
  const ctx = ctxFor(db, config, http);
  const trip = createManualTrip(ctx, staff, tripInput("9.0"));
  const claim = createClaim(ctx, staff, { tripIds: [trip.id], purpose: "超时" });
  const first = await submitClaim(ctx, staff, claim.id, "idem-key-timeout");
  assert.equal(first.status, "submitting");
  const uuid1 = db.get<{ uuid: string }>("select uuid from approval_outbox where claim_id = ?", claim.id)?.uuid;
  const second = await submitClaim(ctx, staff, claim.id, "idem-key-timeout");
  const uuid2 = db.get<{ uuid: string }>("select uuid from approval_outbox where claim_id = ?", claim.id)?.uuid;
  assert.equal(uuid1, uuid2);
  assert.equal(second.status, "sync_exception");
  assert.notEqual(second.status, "in_approval");
  assert.equal(http.urls.some((url) => url.includes("/im/v1/messages")), false);
  const third = await submitClaim(ctx, staff, claim.id, "idem-key-timeout");
  assert.equal(third.status, "sync_exception");
  assert.equal(creates, 2);
  db.close();
});

test("重复提交同一个键只创建一次，不同内容被拒绝", async () => {
  const db = tempDb();
  const config = testConfig("production", fullFeishu());
  addRate(db, false);
  const staff = addPerson(db, config, "staff", ["employee"]);
  let creates = 0;
  const http = scriptedHttp(async (input) => {
    if (input.url.includes("/oauth/v3/token")) return tokenOk();
    creates += 1;
    return { status: 200, text: JSON.stringify({ code: 0, data: { instance_code: "INST-1" } }) };
  });
  const ctx = ctxFor(db, config, http);
  const trip = createManualTrip(ctx, staff, tripInput("4.0"));
  const claim = createClaim(ctx, staff, { tripIds: [trip.id], purpose: "幂等" });
  const done = await submitClaim(ctx, staff, claim.id, "same-key-123");
  const again = await submitClaim(ctx, staff, claim.id, "same-key-123");
  assert.equal(done.id, again.id);
  assert.equal(done.status, "in_approval");
  assert.equal(creates, 1);
  await assert.rejects(() => submitClaim(ctx, staff, claim.id, "same-key-123-changed"), /另一次提交键|IDEMPOTENCY/);
  db.close();
});

test("真实接口失败不会走演示通过", async () => {
  const db = tempDb();
  const config = testConfig("production", fullFeishu());
  addRate(db, false);
  const staff = addPerson(db, config, "staff", ["employee"]);
  const http = scriptedHttp(async (input) => {
    if (input.url.includes("/oauth/v3/token")) return tokenOk();
    return { status: 400, text: JSON.stringify({ code: 1390001, msg: "param is invalid" }) };
  });
  const ctx = ctxFor(db, config, http);
  const trip = createManualTrip(ctx, staff, tripInput("3.0"));
  const claim = createClaim(ctx, staff, { tripIds: [trip.id], purpose: "失败" });
  const result = await submitClaim(ctx, staff, claim.id, "idem-fail-001");
  assert.equal(result.status, "sync_exception");
  assert.equal(result.channelLabel.includes("演示"), false);
  db.close();
});

test("演示模式可走完全程，生产不能自选角色或模拟审批", async () => {
  const db = tempDb();
  const demoConfig = testConfig("demo");
  addRate(db, true);
  const staff = addPerson(db, demoConfig, "staff", ["employee"], "张示例");
  const approver = addPerson(db, demoConfig, "appr", ["approver"], "周示例");
  const finance = addPerson(db, demoConfig, "fin", ["finance"], "赵示例");
  const http = scriptedHttp(async () => {
    throw new Error("演示不应访问网络");
  });
  const ctx = ctxFor(db, demoConfig, http);
  const trip = createManualTrip(ctx, staff, tripInput("8.5"));
  const claim = createClaim(ctx, staff, { tripIds: [trip.id], purpose: "演示申请" });
  db.run("update claims set assigned_approver_id = ? where id = ?", approver.id, claim.id);
  const submitted = await submitClaim(ctx, staff, claim.id, "demo-key-001");
  assert.equal(submitted.status, "in_approval");
  assert.match(submitted.channelLabel, /演示/);
  assert.equal(http.urls.length, 0);
  const approved = decideDemo(ctx, approver, claim.id, "APPROVED", "演示通过");
  assert.equal(approved.status, "settlement_pending");
  const settled = settleClaim(ctx, finance, { claimId: claim.id, voucherNo: "DEMO-9001", comment: "演示结算" });
  assert.equal(settled.status, "settled");

  const prod = testConfig("production", fullFeishu());
  const response = await dispatch(new Request("http://127.0.0.1/api/demo/enter", {
    method: "POST",
    headers: { "content-type": "application/json", "x-mileage-client": "1" },
    body: JSON.stringify({ persona: "chen" }),
  }), ["demo", "enter"], { db, config: prod, http });
  assert.equal(response.status, 403);
  assert.throws(() => decideDemo(ctxFor(db, prod, http), approver, claim.id, "APPROVED", "越权"), /不能在本系统内模拟审批|演示身份与当前运行模式不一致|没有此操作权限/);
  db.close();
});

test("历史快照不随新费率版本变化", () => {
  const db = tempDb();
  const config = testConfig("production", fullFeishu());
  addRate(db, false);
  const staff = addPerson(db, config, "staff", ["employee"]);
  const ctx = ctxFor(db, config, scriptedHttp(async () => tokenOk()));
  const trip = createManualTrip(ctx, staff, tripInput("10.0"));
  const claim = createClaim(ctx, staff, { tripIds: [trip.id], purpose: "快照" });
  assert.equal(claim.amountLabel, "12.00");
  db.run("update rate_versions set baseline_rate_fen_per_km = 200 where id = 'rate1'");
  const again = readClaim(ctx, staff, claim.id);
  assert.equal(again.amountFen, claim.amountFen);
  assert.equal(again.rateLabel, "1.20 元/公里");
  db.close();
});

test("补偿对账在冲突 uuid 上不会另开新单", async () => {
  const db = tempDb();
  const config = testConfig("production", fullFeishu());
  addRate(db, false);
  const admin = addPerson(db, config, "admin", ["admin"]);
  const staff = addPerson(db, config, "staff", ["employee"]);
  const http = scriptedHttp(async () => tokenOk());
  const ctx = ctxFor(db, config, http);
  const trip = createManualTrip(ctx, staff, tripInput("2.0"));
  const claim = createClaim(ctx, staff, { tripIds: [trip.id], purpose: "对账" });
  db.run(
    `insert into approval_outbox(id, claim_id, uuid, state, attempts, payload_json, created_at, updated_at)
     values ('o1', ?, 'fixed-uuid', 'conflict', 1, '{}', ?, ?)`,
    claim.id,
    new Date().toISOString(),
    new Date().toISOString(),
  );
  db.run("update claims set status = 'sync_exception' where id = ?", claim.id);
  const report = await reconcileClaims(ctx, admin);
  assert.equal(report.results[0]?.result, "needs_manual");
  assert.equal(http.urls.length, 0);
  db.close();
});

test("本机 Origin 与 Host 一致时允许进入演示，外部来源拒绝", async () => {
  const db = tempDb();
  ensureDemoSeed(db, new Date("2026-11-08T02:00:00.000Z"));
  const config = testConfig("demo");
  const http = scriptedHttp(async () => ({ status: 500, text: "" }));
  const ok = await dispatch(new Request("http://localhost:43123/api/demo/enter", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mileage-client": "1",
      origin: "http://127.0.0.1:43123",
      host: "127.0.0.1:43123",
    },
    body: JSON.stringify({ persona: "chen" }),
  }), ["demo", "enter"], { db, config, http });
  assert.equal(ok.status, 200);
  const blocked = await dispatch(new Request("http://127.0.0.1:43123/api/demo/enter", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mileage-client": "1",
      origin: "https://evil.example",
      host: "127.0.0.1:43123",
    },
    body: JSON.stringify({ persona: "chen" }),
  }), ["demo", "enter"], { db, config, http });
  assert.equal(blocked.status, 403);
  db.close();
});

test("OA 适配器拒绝发单", async () => {
  const oa = createDisabledOaAdapter();
  assert.equal(oa.capabilities().enabled, false);
  await assert.rejects(() => oa.submit({}, "key"), /不会向任何 OA 发单/);
});

function tripInput(distanceKm: string) {
  return {
    startedAt: "2026-11-02T09:00:00+08:00",
    endedAt: "2026-11-02T11:00:00+08:00",
    distanceKm,
    purpose: "客户拜访",
    origin: "公司",
    destination: "客户处",
    evidenceNote: "测试",
  };
}
