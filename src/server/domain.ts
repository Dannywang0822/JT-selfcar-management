import crypto from "node:crypto";
import { applyExternalStatus } from "./approval-state";
import type { Actor, Role } from "./auth";
import { approvalRegistry, rejectOaProvider, requestedProvider } from "./approval-registry";
import { assertRole, requireRole } from "./auth";
import type { AppConfig } from "./config";
import { assertFields } from "./config";
import type { AppDb } from "./db";
import { AppError } from "./errors";
import { sha256Hex } from "./feishu-crypto";
import { type ApprovalProvider, type FeishuHttp } from "./feishu";
import { CLAIM_STATUS_LABEL, SOURCE_LABEL, nextActionFor } from "./labels";
import { parseClaimStatus, parseExternalApprovalStatus, parseStoredProvider } from "./parse-state";
import type { ClaimStatus, StoredApprovalProvider } from "../lib/states";
import { amountFen, fenToYuan, formatKm, maskOpenId, parseKmToMeters } from "./money";
import { adjustedRate } from "./rates";
import { redactText } from "./redact";
import { secretMaterial } from "./config";
import {
  beijingDay,
  beijingMonthRange,
  beijingQuarterRange,
  formatBeijing,
  parseBeijingInput,
  quarterOfDay,
} from "./time";

export type Ctx = { db: AppDb; config: AppConfig; http: FeishuHttp; now?: Date };

type TripRow = {
  id: string;
  employee_id: string;
  started_at: string;
  ended_at: string;
  distance_m: number;
  source: string;
  purpose: string;
  origin_text: string;
  dest_text: string;
  trust: string;
  real_claim_eligible: number;
  is_demo: number;
  evidence_note: string | null;
  cross_quarter: number;
  point_count: number;
  created_at: string;
};

type ClaimRow = {
  id: string;
  number: string;
  employee_id: string;
  status: ClaimStatus;
  revision: number;
  previous_claim_id: string | null;
  rate_version_id: string;
  distance_m: number;
  rate_fen_per_km: number;
  amount_fen: number;
  rule_snapshot_json: string;
  trip_snapshot_json: string;
  approval_provider: StoredApprovalProvider;
  runtime_channel: string;
  is_demo: number;
  assigned_approver_id: string | null;
  idempotency_key: string | null;
  request_hash: string | null;
  purpose: string;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type TripDto = {
  id: string;
  purpose: string;
  origin: string;
  destination: string;
  startedAt: string;
  endedAt: string;
  distanceLabel: string;
  distanceM: number;
  source: string;
  sourceLabel: string;
  trustLabel: string;
  eligible: boolean;
  occupied: boolean;
  crossQuarter: boolean;
  pointCount: number;
  evidenceNote: string | null;
};

export type ClaimDto = {
  id: string;
  number: string;
  employeeId: string;
  employeeName: string;
  status: ClaimStatus;
  statusLabel: string;
  nextAction: string;
  distanceLabel: string;
  amountLabel: string;
  amountFen: number;
  purpose: string;
  submittedAt: string | null;
  externalStatus: string | null;
  instanceCode: string | null;
  needsReconcile: boolean;
  channelLabel: string;
  isDemo: boolean;
  rateLabel: string;
  policyStatus: string;
  voucherNo: string | null;
  assignedToMe: boolean;
};

function nowOf(ctx: Ctx): Date {
  return ctx.now ?? new Date();
}

function assertDemoFlag(actor: Actor, config: AppConfig) {
  if (actor.pending) throw new AppError("UNPROVISIONED", "飞书身份已验证，但尚未列入企业名册，不能办理业务", 403);
  if (actor.isDemo !== (config.mode === "demo")) throw new AppError("MODE", "演示身份与当前运行模式不一致", 403);
}

export function createManualTrip(ctx: Ctx, actor: Actor, input: {
  startedAt: string;
  endedAt: string;
  distanceKm: string;
  purpose: string;
  origin: string;
  destination: string;
  evidenceNote: string;
}) {
  assertRole(actor, "employee");
  assertDemoFlag(actor, ctx.config);
  const distanceM = parseKmToMeters(input.distanceKm);
  return insertTrip(ctx, actor, {
    source: "manual",
    distanceM,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    purpose: input.purpose,
    origin: input.origin,
    destination: input.destination,
    evidenceNote: input.evidenceNote || "人工补录，需审核",
    eligible: true,
    pointCount: 0,
    points: [],
  });
}

export function createGpsTrip(ctx: Ctx, actor: Actor, input: {
  purpose: string;
  origin: string;
  destination: string;
  points: Array<{ lat: number; lng: number; recordedAt: string; accuracyM?: number }>;
}) {
  assertRole(actor, "employee");
  assertDemoFlag(actor, ctx.config);
  if (input.points.length < 2) throw new AppError("GPS", "至少需要两个定位点");
  if (input.points.length > 500) throw new AppError("GPS", "单次记录最多 500 个点");
  const points = input.points.map((point) => ({
    ...point,
    at: parseBeijingInput(point.recordedAt).getTime(),
  }));
  points.sort((a, b) => a.at - b.at);
  for (const point of points) {
    if (point.lat < -90 || point.lat > 90 || point.lng < -180 || point.lng > 180) {
      throw new AppError("GPS", "定位坐标超出范围");
    }
  }
  let meters = 0;
  for (let i = 1; i < points.length; i += 1) meters += haversine(points[i - 1], points[i]);
  const distanceM = Math.round(meters);
  const hours = (points[points.length - 1].at - points[0].at) / 3600000;
  if (hours <= 0) throw new AppError("GPS", "定位时间没有间隔");
  if (distanceM / hours > 160_000) throw new AppError("GPS", "轨迹速度不合理。浏览器定位不可信，请改用人工补录并注明原因");
  return insertTrip(ctx, actor, {
    source: "browser_gps",
    distanceM,
    startedAt: new Date(points[0].at).toISOString(),
    endedAt: new Date(points[points.length - 1].at).toISOString(),
    purpose: input.purpose,
    origin: input.origin,
    destination: input.destination,
    evidenceNote: "浏览器定位，不能证明后台持续记录，也不能防篡改",
    eligible: true,
    pointCount: points.length,
    points,
  });
}

export function createDemoCruise(ctx: Ctx, actor: Actor) {
  if (ctx.config.mode !== "demo") throw new AppError("DEMO_ONLY", "演示巡航只存在于演示模式", 403);
  assertRole(actor, "employee");
  const now = nowOf(ctx);
  const points = [0, 1, 2, 3, 4].map((index) => ({
    lat: 39.9 + index * 0.01,
    lng: 116.4 + index * 0.01,
    recordedAt: new Date(now.getTime() - (5 - index) * 60000).toISOString(),
    at: now.getTime() - (5 - index) * 60000,
  }));
  let meters = 0;
  for (let i = 1; i < points.length; i += 1) meters += haversine(points[i - 1], points[i]);
  return insertTrip(ctx, actor, {
    source: "demo_cruise",
    distanceM: Math.max(1, Math.round(meters)),
    startedAt: new Date(points[0].at).toISOString(),
    endedAt: new Date(points[points.length - 1].at).toISOString(),
    purpose: "演示巡航",
    origin: "演示起点",
    destination: "演示终点",
    evidenceNote: "演示巡航不是真实轨迹，不能进入任何补贴申请",
    eligible: false,
    pointCount: points.length,
    points,
  });
}

function insertTrip(ctx: Ctx, actor: Actor, input: {
  source: string;
  distanceM: number;
  startedAt: string;
  endedAt: string;
  purpose: string;
  origin: string;
  destination: string;
  evidenceNote: string;
  eligible: boolean;
  pointCount: number;
  points: Array<{ lat: number; lng: number; recordedAt?: string; at?: number; accuracyM?: number }>;
}) {
  const started = typeof input.startedAt === "string" && input.startedAt.endsWith("Z")
    ? new Date(input.startedAt)
    : parseBeijingInput(input.startedAt);
  const ended = typeof input.endedAt === "string" && input.endedAt.endsWith("Z")
    ? new Date(input.endedAt)
    : parseBeijingInput(input.endedAt);
  if (Number.isNaN(started.getTime()) || Number.isNaN(ended.getTime()) || ended <= started) {
    throw new AppError("TIME", "结束时间必须晚于开始时间");
  }
  if (!input.purpose.trim() || !input.origin.trim() || !input.destination.trim()) {
    throw new AppError("TRIP", "事由、出发地和目的地都要填写");
  }
  if (input.distanceM < 100 || input.distanceM > ctx.config.maxTripMeters) {
    throw new AppError("DISTANCE", `里程需在 0.1 至 ${formatKm(ctx.config.maxTripMeters)} 公里之间`);
  }
  const cross = quarterOfDay(beijingDay(started)) !== quarterOfDay(beijingDay(ended));
  const id = crypto.randomUUID();
  const now = nowOf(ctx).toISOString();
  ctx.db.transaction(() => {
    const overlap = ctx.db.get<{ id: string }>(
      "select id from trips where employee_id = ? and started_at < ? and ended_at > ?",
      actor.id,
      ended.toISOString(),
      started.toISOString(),
    );
    if (overlap) throw new AppError("OVERLAP", "与本人已有行程时间重叠");
    ctx.db.run(
      `insert into trips(id, employee_id, started_at, ended_at, distance_m, source, purpose, origin_text, dest_text, trust, real_claim_eligible, is_demo, evidence_note, cross_quarter, point_count, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unverified', ?, ?, ?, ?, ?, ?)`,
      id,
      actor.id,
      started.toISOString(),
      ended.toISOString(),
      input.distanceM,
      input.source,
      input.purpose.trim(),
      input.origin.trim(),
      input.destination.trim(),
      input.eligible ? 1 : 0,
      ctx.config.mode === "demo" ? 1 : 0,
      input.evidenceNote,
      cross ? 1 : 0,
      input.pointCount,
      now,
    );
    input.points.forEach((point, index) => {
      ctx.db.run(
        "insert into trip_points(id, trip_id, seq, lat, lng, recorded_at, accuracy_m) values (?, ?, ?, ?, ?, ?, ?)",
        crypto.randomUUID(),
        id,
        index,
        point.lat,
        point.lng,
        new Date(point.at ?? Date.parse(point.recordedAt || "")).toISOString(),
        point.accuracyM ?? null,
      );
    });
    audit(ctx, actor, "create_trip", "trip", id, null, input.source, input.evidenceNote);
  });
  return getTrip(ctx, actor, id);
}

export function listMyTrips(ctx: Ctx, actor: Actor): TripDto[] {
  assertDemoFlag(actor, ctx.config);
  assertRole(actor, "employee");
  return ctx.db
    .all<TripRow>("select * from trips where employee_id = ? order by started_at desc", actor.id)
    .map((row) => toTrip(ctx.db, row));
}

export function getTrip(ctx: Ctx, actor: Actor, id: string): TripDto {
  const row = ctx.db.get<TripRow>("select * from trips where id = ?", id);
  if (!row || row.employee_id !== actor.id) throw new AppError("NOT_FOUND", "行程不存在", 404);
  if (Boolean(row.is_demo) !== (ctx.config.mode === "demo")) throw new AppError("NOT_FOUND", "行程不存在", 404);
  return toTrip(ctx.db, row);
}

export function createClaim(ctx: Ctx, actor: Actor, input: { tripIds: string[]; purpose: string; previousClaimId?: string }) {
  assertRole(actor, "employee");
  assertDemoFlag(actor, ctx.config);
  const ids = [...new Set(input.tripIds)];
  if (!ids.length) throw new AppError("CLAIM", "请选择行程");
  if (!input.purpose.trim()) throw new AppError("CLAIM", "请填写申请说明");
  const now = nowOf(ctx);
  return ctx.db.transaction(() => {
    if (input.previousClaimId) {
      const previous = mustOwnClaim(ctx, actor, input.previousClaimId);
      if (!["rejected", "canceled"].includes(previous.status)) {
        throw new AppError("REVISION", "只有驳回或撤回的申请可以修订重提");
      }
    }
    const trips = ids.map((id) => {
      const trip = ctx.db.get<TripRow>("select * from trips where id = ?", id);
      if (!trip || trip.employee_id !== actor.id) throw new AppError("NOT_FOUND", "行程不存在", 404);
      return trip;
    });
    let rateId = "";
    let rateFen = 0;
    let distance = 0;
    let amount = 0;
    const snapshots = [];
    for (const trip of trips) {
      if (trip.is_demo !== (ctx.config.mode === "demo" ? 1 : 0)) throw new AppError("MODE", "不能把演示行程放进当前模式");
      if (trip.source === "demo_cruise" || trip.real_claim_eligible !== 1) {
        throw new AppError("CRUISE", "演示巡航不能进入补贴申请");
      }
      if (trip.cross_quarter) throw new AppError("CROSS_QUARTER", "跨季度行程的拆分规则未确认，不能自动入账");
      const occupied = ctx.db.get("select trip_id from trip_occupancy where trip_id = ?", trip.id);
      if (occupied) throw new AppError("DUPLICATE_CLAIM", "该行程已有有效报销占用");
      const rate = rateForDay(ctx.db, beijingDay(new Date(trip.ended_at)), ctx.config.mode === "demo");
      if (!rateId) {
        rateId = rate.id;
        rateFen = rate.rate_fen_per_km;
      } else if (rate.id !== rateId) {
        throw new AppError("RATE", "所选行程分属不同费率版本，请拆开申请");
      }
      const itemAmount = amountFen(trip.distance_m, rate.rate_fen_per_km);
      distance += trip.distance_m;
      amount += itemAmount;
      snapshots.push({ tripId: trip.id, distanceM: trip.distance_m, amountFen: itemAmount, source: trip.source, endedAt: trip.ended_at });
    }
    const rateRow = ctx.db.get<RateRow>("select * from rate_versions where id = ?", rateId)!;
    const claimId = crypto.randomUUID();
    const number = nextClaimNumber(ctx.db, now);
    ctx.db.run(
      `insert into claims(id, number, employee_id, status, revision, previous_claim_id, rate_version_id, distance_m, rate_fen_per_km, amount_fen, rule_snapshot_json, trip_snapshot_json, approval_provider, runtime_channel, is_demo, purpose, created_at, updated_at)
       values (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, 'feishu', ?, ?, ?, ?, ?)`,
      claimId,
      number,
      actor.id,
      input.previousClaimId ? 2 : 1,
      input.previousClaimId ?? null,
      rateId,
      distance,
      rateFen,
      amount,
      JSON.stringify(rateSnapshot(rateRow)),
      JSON.stringify(snapshots),
      ctx.config.mode,
      ctx.config.mode === "demo" ? 1 : 0,
      input.purpose.trim(),
      now.toISOString(),
      now.toISOString(),
    );
    for (const item of snapshots) {
      ctx.db.run(
        "insert into claim_items(id, claim_id, trip_id, distance_m, amount_fen) values (?, ?, ?, ?, ?)",
        crypto.randomUUID(),
        claimId,
        item.tripId,
        item.distanceM,
        item.amountFen,
      );
      ctx.db.run("insert into trip_occupancy(trip_id, claim_id) values (?, ?)", item.tripId, claimId);
    }
    audit(ctx, actor, "create_claim", "claim", claimId, null, "draft", "冻结行程与费率快照");
    return claimDto(ctx.db, mustClaim(ctx.db, claimId), actor);
  });
}

export async function submitClaim(
  ctx: Ctx,
  actor: Actor,
  claimId: string,
  idempotencyKey: string,
  approvalProvider?: string,
): Promise<ClaimDto> {
  assertRole(actor, "employee");
  assertDemoFlag(actor, ctx.config);
  const owned = mustOwnClaim(ctx, actor, claimId);
  const providerId = requestedProvider(approvalProvider ?? owned.approval_provider);
  const registry = approvalRegistry(ctx.config, ctx.db, ctx.http);
  await rejectOaProvider(registry, providerId, "submit", { snapshot: { claimId }, idempotencyKey });
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    throw new AppError("IDEMPOTENCY", "需要 8 到 200 字符的 Idempotency-Key");
  }
  if (ctx.config.mode !== "demo") {
    assertFields(ctx.config, "oauth");
    assertFields(ctx.config, "approval");
  }
  const employee = ctx.db.get<{ open_id: string | null }>("select open_id from employees where id = ?", actor.id);
  if (ctx.config.mode !== "demo" && !employee?.open_id) {
    throw new AppError("UNMAPPED", "员工还没有飞书 open_id 映射，不能发起真实审批", 409);
  }
  const prepared = ctx.db.transaction(() => prepareSubmit(ctx, actor, claimId, idempotencyKey));
  if (prepared.done) return claimDto(ctx.db, mustClaim(ctx.db, prepared.claimId), actor);
  const provider = approvalRegistry(ctx.config, ctx.db, ctx.http).feishu;
  let outcome;
  try {
    outcome = await provider.createInstance({ uuid: prepared.uuid, openId: prepared.openId, form: prepared.form });
  } catch (error) {
    outcome = {
      kind: "rejected" as const,
      message: error instanceof Error ? error.message : "审批创建失败",
    };
  }
  const now = nowOf(ctx).toISOString();
  ctx.db.transaction(() => {
    const outbox = ctx.db.get<{ uuid: string; attempts: number }>("select uuid, attempts from approval_outbox where claim_id = ?", prepared.claimId);
    if (!outbox || outbox.uuid !== prepared.uuid) throw new AppError("UUID", "提交 uuid 已变化，已中止", 409);
    const attempts = outbox.attempts + 1;
    if (outcome.kind === "created") {
      ctx.db.run(
        "update approval_outbox set state = 'sent', attempts = ?, updated_at = ?, last_error = null where claim_id = ?",
        attempts,
        now,
        prepared.claimId,
      );
      ctx.db.run(
        `insert into approval_bindings(id, claim_id, provider, approval_code, instance_code, uuid, external_status, needs_reconcile, updated_at)
         values (?, ?, 'feishu', ?, ?, ?, 'PENDING', 0, ?)`,
        crypto.randomUUID(),
        prepared.claimId,
        ctx.config.mode === "demo" ? "DEMO-NOT-FEISHU" : ctx.config.feishu.approvalCode,
        outcome.instanceCode,
        prepared.uuid,
        now,
      );
      ctx.db.run("update claims set status = 'in_approval', submitted_at = coalesce(submitted_at, ?), updated_at = ? where id = ?", now, now, prepared.claimId);
      audit(ctx, actor, "submit_claim", "claim", prepared.claimId, "submitting", "in_approval", ctx.config.mode === "demo" ? "演示审批已建立，未调用飞书" : "已创建飞书审批实例");
      return;
    }
    const message = redactText(outcome.message, secretMaterial(ctx.config));
    if (outcome.kind === "uuid_conflict") {
      ctx.db.run(
        "update approval_outbox set state = 'conflict', attempts = ?, last_error = ?, last_log_id = ?, updated_at = ? where claim_id = ?",
        attempts,
        message,
        "logId" in outcome ? outcome.logId ?? null : null,
        now,
        prepared.claimId,
      );
      ctx.db.run("update claims set status = 'sync_exception', updated_at = ? where id = ?", now, prepared.claimId);
      audit(ctx, actor, "submit_conflict", "claim", prepared.claimId, "submitting", "sync_exception", message);
      return;
    }
    if (outcome.kind === "rejected") {
      ctx.db.run(
        "update approval_outbox set state = 'failed', attempts = ?, last_error = ?, updated_at = ? where claim_id = ?",
        attempts,
        message,
        now,
        prepared.claimId,
      );
      ctx.db.run("update claims set status = 'sync_exception', updated_at = ? where id = ?", now, prepared.claimId);
      audit(ctx, actor, "submit_rejected", "claim", prepared.claimId, "submitting", "sync_exception", message);
      return;
    }
    ctx.db.run(
      "update approval_outbox set state = 'unknown', attempts = ?, last_error = ?, updated_at = ? where claim_id = ?",
      attempts,
      message,
      now,
      prepared.claimId,
    );
    ctx.db.run("update claims set status = 'submitting', updated_at = ? where id = ?", now, prepared.claimId);
    audit(ctx, actor, "submit_unknown", "claim", prepared.claimId, "submitting", "submitting", message);
  });
  return claimDto(ctx.db, mustClaim(ctx.db, prepared.claimId), actor);
}

function prepareSubmit(ctx: Ctx, actor: Actor, claimId: string, idempotencyKey: string): {
  done: boolean;
  claimId: string;
  uuid: string;
  openId: string;
  form: string;
} {
  const claim = mustOwnClaim(ctx, actor, claimId);
  const items = ctx.db.all<{ trip_id: string }>("select trip_id from claim_items where claim_id = ? order by trip_id", claim.id);
  const hash = sha256Hex(Buffer.from(JSON.stringify({
    claimId: claim.id,
    amountFen: claim.amount_fen,
    distanceM: claim.distance_m,
    tripIds: items.map((item) => item.trip_id),
  })));
  const existingKey = ctx.db.get<{ request_hash: string; claim_id: string }>(
    "select request_hash, claim_id from idempotency_keys where actor_id = ? and idem_key = ?",
    actor.id,
    idempotencyKey,
  );
  if (existingKey && existingKey.request_hash !== hash) {
    throw new AppError("IDEMPOTENCY_CONFLICT", "同一个 Idempotency-Key 对应了不同的申请内容", 409);
  }
  if (claim.idempotency_key && claim.idempotency_key !== idempotencyKey) {
    throw new AppError("IDEMPOTENCY", "此申请已绑定另一次提交键，不能更换后盲目重试", 409);
  }
  const terminal = ["in_approval", "settlement_pending", "settled", "rejected", "canceled", "hold_exception", "reversal_required", "reversal_recorded"];
  if (terminal.includes(claim.status)) {
    return { done: true, claimId: claim.id, uuid: "", openId: "", form: "" };
  }
  const outbox = ctx.db.get<{ uuid: string; state: string; payload_json: string }>("select * from approval_outbox where claim_id = ?", claim.id);
  if (outbox?.state === "conflict") return { done: true, claimId: claim.id, uuid: outbox.uuid, openId: "", form: "" };
  const employee = ctx.db.get<{ open_id: string | null }>("select open_id from employees where id = ?", actor.id);
  const openId = ctx.config.mode === "demo" ? `demo-${actor.id}` : employee?.open_id || "";
  const form = buildForm(ctx.config, claim);
  let uuid = outbox?.uuid;
  if (!uuid) {
    uuid = crypto.randomUUID();
    ctx.db.run(
      `insert into approval_outbox(id, claim_id, uuid, state, attempts, payload_json, created_at, updated_at)
       values (?, ?, ?, 'pending', 0, ?, ?, ?)`,
      crypto.randomUUID(),
      claim.id,
      uuid,
      JSON.stringify({ form, openId }),
      nowOf(ctx).toISOString(),
      nowOf(ctx).toISOString(),
    );
  }
  if (!existingKey) {
    ctx.db.run(
      "insert into idempotency_keys(actor_id, idem_key, request_hash, claim_id, created_at) values (?, ?, ?, ?, ?)",
      actor.id,
      idempotencyKey,
      hash,
      claim.id,
      nowOf(ctx).toISOString(),
    );
  }
  ctx.db.run(
    "update claims set status = 'submitting', idempotency_key = ?, request_hash = ?, updated_at = ? where id = ?",
    idempotencyKey,
    hash,
    nowOf(ctx).toISOString(),
    claim.id,
  );
  return { done: false, claimId: claim.id, uuid, openId, form };
}

export function decideDemo(ctx: Ctx, actor: Actor, claimId: string, decision: "APPROVED" | "REJECTED", comment: string) {
  if (ctx.config.mode !== "demo") throw new AppError("DEMO_ONLY", "生产环境不能在本系统内模拟审批", 403);
  assertRole(actor, "approver");
  if (!comment.trim()) throw new AppError("COMMENT", "请填写演示审批意见");
  const claim = mustClaim(ctx.db, claimId);
  if (claim.assigned_approver_id !== actor.id && !actor.roles.includes("approver")) {
    throw new AppError("FORBIDDEN", "只能处理分配给自己的演示单据", 403);
  }
  if (claim.assigned_approver_id && claim.assigned_approver_id !== actor.id) {
    throw new AppError("FORBIDDEN", "这张演示单据没有分配给当前审批人", 403);
  }
  if (claim.runtime_channel !== "demo") throw new AppError("MODE", "不能演示审批非演示单据", 403);
  const binding = ctx.db.get<{ instance_code: string | null }>("select instance_code from approval_bindings where claim_id = ?", claim.id);
  if (!binding?.instance_code) throw new AppError("STATE", "演示申请还没有审批实例");
  const state = applyExternalStatus(ctx.db, {
    instanceCode: binding.instance_code,
    approvalCode: "DEMO-NOT-FEISHU",
    status: decision,
    operateTime: String(nowOf(ctx).getTime()),
    type: "approval_instance",
    now: nowOf(ctx),
    source: "demo_approval",
  });
  audit(ctx, actor, "demo_decide", "claim", claim.id, claim.status, decision, `演示意见：${comment.trim()}（${state}）`);
  return claimDto(ctx.db, mustClaim(ctx.db, claim.id), actor);
}

export function settleClaim(ctx: Ctx, actor: Actor, input: { claimId: string; voucherNo: string; comment: string }) {
  assertRole(actor, "finance");
  assertDemoFlag(actor, ctx.config);
  const voucher = input.voucherNo.trim();
  if (!/^[A-Za-z0-9-]{4,40}$/.test(voucher)) throw new AppError("VOUCHER", "凭证号需为 4 到 40 位字母、数字或横线");
  if (!input.comment.trim()) throw new AppError("COMMENT", "请填写财务核对意见");
  const now = nowOf(ctx).toISOString();
  ctx.db.transaction(() => {
    const claim = mustClaim(ctx.db, input.claimId);
    if (Boolean(claim.is_demo) !== (ctx.config.mode === "demo")) throw new AppError("MODE", "不能跨模式结算", 403);
    if (claim.status !== "settlement_pending") throw new AppError("STATE", "只有审批通过并待财务核对的单据可以结算", 409);
    const binding = ctx.db.get<{ external_status: string | null; needs_reconcile: number }>(
      "select external_status, needs_reconcile from approval_bindings where claim_id = ?",
      claim.id,
    );
    if (!binding || binding.external_status !== "APPROVED" || binding.needs_reconcile) {
      throw new AppError("NOT_APPROVED", "审批未通过或仍待对账，禁止结算", 409);
    }
    const dup = ctx.db.get("select id from settlements where claim_id = ?", claim.id);
    if (dup) throw new AppError("DUPLICATE_SETTLEMENT", "该申请已结算", 409);
    ctx.db.run(
      `insert into settlements(id, claim_id, amount_fen, voucher_no, operator_id, comment, status, created_at)
       values (?, ?, ?, ?, ?, ?, 'confirmed', ?)`,
      crypto.randomUUID(),
      claim.id,
      claim.amount_fen,
      voucher,
      actor.id,
      input.comment.trim(),
      now,
    );
    ctx.db.run("update claims set status = 'settled', updated_at = ? where id = ?", now, claim.id);
    audit(ctx, actor, "settle", "claim", claim.id, "settlement_pending", "settled", input.comment.trim());
  });
  return claimDto(ctx.db, mustClaim(ctx.db, input.claimId), actor);
}

export function recordReversal(ctx: Ctx, actor: Actor, claimId: string, comment: string) {
  assertRole(actor, "finance");
  if (!comment.trim()) throw new AppError("COMMENT", "请填写冲正说明");
  const now = nowOf(ctx).toISOString();
  ctx.db.transaction(() => {
    const claim = mustClaim(ctx.db, claimId);
    if (claim.status !== "reversal_required") throw new AppError("STATE", "当前单据不需要登记冲正", 409);
    ctx.db.run(
      "update settlement_reversals set operator_id = ?, comment = ? where claim_id = ?",
      actor.id,
      comment.trim(),
      claim.id,
    );
    ctx.db.run("update claims set status = 'reversal_recorded', updated_at = ? where id = ?", now, claim.id);
    audit(ctx, actor, "reversal", "claim", claim.id, "reversal_required", "reversal_recorded", comment.trim());
  });
  return claimDto(ctx.db, mustClaim(ctx.db, claimId), actor);
}

export async function reconcileClaims(ctx: Ctx, actor: Actor, provider?: ApprovalProvider) {
  assertRole(actor, "admin");
  const registry = approvalRegistry(ctx.config, ctx.db, ctx.http);
  const engine = provider ?? registry.feishu;
  const rows = ctx.db.all<{ id: string; status: string; employee_id: string; approval_provider: string }>(
    `select distinct c.id, c.status, c.employee_id, c.approval_provider
     from claims c
     left join approval_bindings b on b.claim_id = c.id
     left join approval_outbox o on o.claim_id = c.id
     where c.is_demo = ? and (c.status in ('submitting', 'sync_exception', 'hold_exception') or b.needs_reconcile = 1)`,
    ctx.config.mode === "demo" ? 1 : 0,
  );
  const results: Array<{ claimId: string; result: string }> = [];
  for (const row of rows) {
    const outbox = ctx.db.get<{ uuid: string; state: string; payload_json: string }>("select * from approval_outbox where claim_id = ?", row.id);
    const binding = ctx.db.get<{ instance_code: string | null; approval_code: string | null }>(
      "select instance_code, approval_code from approval_bindings where claim_id = ?",
      row.id,
    );
    try {
      if (row.approval_provider === "oa") {
        await rejectOaProvider(registry, "oa", "status", { externalId: row.id });
      }
      if (!binding?.instance_code && outbox && outbox.state !== "conflict" && outbox.state !== "failed") {
        const payload = JSON.parse(outbox.payload_json) as { form: string; openId: string };
        const outcome = await engine.createInstance({ uuid: outbox.uuid, openId: payload.openId, form: payload.form });
        if (outcome.kind === "created") {
          ctx.db.run(
            `insert into approval_bindings(id, claim_id, provider, approval_code, instance_code, uuid, external_status, needs_reconcile, updated_at)
             values (?, ?, 'feishu', ?, ?, ?, 'PENDING', 0, ?)`,
            crypto.randomUUID(),
            row.id,
            ctx.config.feishu.approvalCode || "DEMO-NOT-FEISHU",
            outcome.instanceCode,
            outbox.uuid,
            nowOf(ctx).toISOString(),
          );
          ctx.db.run("update claims set status = 'in_approval', updated_at = ? where id = ?", nowOf(ctx).toISOString(), row.id);
          ctx.db.run("update approval_outbox set state = 'sent', updated_at = ? where claim_id = ?", nowOf(ctx).toISOString(), row.id);
          results.push({ claimId: row.id, result: "created" });
          continue;
        }
        results.push({ claimId: row.id, result: outcome.kind });
        continue;
      }
      if (binding?.instance_code) {
        const employee = ctx.db.get<{ open_id: string | null }>("select open_id from employees where id = ?", row.employee_id);
        const view = await engine.getInstance(binding.instance_code, employee?.open_id ?? undefined);
        const state = applyExternalStatus(ctx.db, {
          instanceCode: binding.instance_code,
          approvalCode: binding.approval_code || "",
          status: view.status,
          operateTime: null,
          type: "approval_instance",
          now: nowOf(ctx),
          source: "reconcile",
          authoritative: true,
        });
        results.push({ claimId: row.id, result: state });
        continue;
      }
      results.push({ claimId: row.id, result: "needs_manual" });
    } catch (error) {
      results.push({ claimId: row.id, result: error instanceof Error ? error.message : "failed" });
    }
  }
  return { mode: ctx.config.mode, liveCall: engine.channel === "live", results };
}

export function listVisibleClaims(ctx: Ctx, actor: Actor, query: { status?: string; q?: string; month?: string }): ClaimDto[] {
  assertDemoFlag(actor, ctx.config);
  const rows = ctx.db.all<ClaimRow>("select * from claims where is_demo = ? order by number desc", ctx.config.mode === "demo" ? 1 : 0).map(hydrateClaim);
  return rows
    .filter((row) => canRead(actor, row))
    .filter((row) => (query.status ? row.status === query.status : true))
    .filter((row) => {
      if (!query.q) return true;
      const name = employeeName(ctx.db, row.employee_id);
      return row.number.includes(query.q) || name.includes(query.q) || row.purpose.includes(query.q);
    })
    .filter((row) => {
      if (!query.month) return true;
      const stamp = row.submitted_at || row.created_at;
      return formatBeijing(new Date(stamp)).startsWith(query.month);
    })
    .map((row) => claimDto(ctx.db, row, actor));
}

export function listMyClaims(ctx: Ctx, actor: Actor): ClaimDto[] {
  assertRole(actor, "employee");
  return listVisibleClaims(ctx, actor, {});
}

export function readClaim(ctx: Ctx, actor: Actor, id: string): ClaimDto & { audits: AuditDto[]; items: TripDto[] } {
  const row = mustClaim(ctx.db, id);
  if (!canRead(actor, row)) throw new AppError("NOT_FOUND", "申请不存在", 404);
  const items = ctx.db.all<{ trip_id: string }>("select trip_id from claim_items where claim_id = ?", id);
  return {
    ...claimDto(ctx.db, row, actor),
    items: items.map((item) => toTrip(ctx.db, ctx.db.get<TripRow>("select * from trips where id = ?", item.trip_id)!)),
    audits: ctx.db.all<AuditDto>(
      "select action, from_status, to_status, comment, source, at from audit_events where object_id = ? order by at asc",
      id,
    ).map((item) => ({ ...item, atBeijing: formatBeijing(new Date(item.at)) })),
  };
}

export function consoleSummary(ctx: Ctx, actor: Actor) {
  assertAny(actor, ["admin", "finance", "approver"]);
  const month = beijingMonthRange(nowOf(ctx));
  const claims = ctx.db.all<ClaimRow>("select * from claims where is_demo = ?", ctx.config.mode === "demo" ? 1 : 0).map(hydrateClaim);
  const visible = claims.filter((row) => canRead(actor, row));
  const pendingApproval = visible.filter((row) => row.status === "in_approval");
  const canSeeFinance = actor.roles.includes("admin") || actor.roles.includes("finance");
  const finance = canSeeFinance ? visible.filter((row) => row.status === "settlement_pending") : [];
  const settled = canSeeFinance
    ? ctx.db.all<{ amount_fen: number }>(
        `select s.amount_fen from settlements s join claims c on c.id = s.claim_id
         where c.is_demo = ? and s.created_at >= ? and s.created_at < ?`,
        ctx.config.mode === "demo" ? 1 : 0,
        month.startIso,
        month.endIso,
      )
    : [];
  return {
    monthLabel: month.label,
    inApprovalCount: pendingApproval.length,
    canSeeFinance,
    financeAmountFen: finance.reduce((sum, row) => sum + row.amount_fen, 0),
    financeCount: finance.length,
    settledAmountFen: settled.reduce((sum, row) => sum + row.amount_fen, 0),
    preview: visible.slice(0, 6).map((row) => claimDto(ctx.db, row, actor)),
  };
}

export function listLedger(ctx: Ctx, actor: Actor): Array<TripDto & { employeeName: string }> {
  assertRole(actor, "admin");
  return ctx.db
    .all<TripRow>("select * from trips where is_demo = ? order by started_at desc", ctx.config.mode === "demo" ? 1 : 0)
    .map((row) => ({ ...toTrip(ctx.db, row), employeeName: employeeName(ctx.db, row.employee_id) }));
}

export function exportClaims(ctx: Ctx, actor: Actor): string {
  assertAny(actor, ["admin", "finance"]);
  const rows = listVisibleClaims(ctx, actor, {}).filter((row) =>
    actor.roles.includes("admin") ? true : ["settlement_pending", "settled", "reversal_required", "reversal_recorded"].includes(row.status),
  );
  audit(ctx, actor, "export", "claim", "export", null, null, `导出 ${rows.length} 行`);
  const header = ["单号", "员工", "状态", "里程公里", "金额元", "费率快照", "提交时间北京", "外部状态", "渠道", "凭证"];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push([
      row.number,
      row.employeeName,
      row.statusLabel,
      row.distanceLabel,
      row.amountLabel,
      row.rateLabel,
      row.submittedAt ?? "",
      row.externalStatus ?? "",
      row.channelLabel,
      row.voucherNo ?? "",
    ].map(csv).join(","));
  }
  return `\uFEFF${lines.join("\n")}\n`;
}

export function employeeSummary(ctx: Ctx, actor: Actor) {
  assertRole(actor, "employee");
  const month = beijingMonthRange(nowOf(ctx));
  const trips = ctx.db.all<TripRow>(
    "select * from trips where employee_id = ? and ended_at >= ? and ended_at < ? order by ended_at desc",
    actor.id,
    month.startIso,
    month.endIso,
  );
  const open = trips.filter((trip) => trip.real_claim_eligible === 1 && !ctx.db.get("select trip_id from trip_occupancy where trip_id = ?", trip.id));
  let available = 0;
  for (const trip of open) {
    const rate = rateForDay(ctx.db, beijingDay(new Date(trip.ended_at)), ctx.config.mode === "demo");
    available += amountFen(trip.distance_m, rate.rate_fen_per_km);
  }
  const distance = open.reduce((sum, trip) => sum + trip.distance_m, 0);
  return {
    greeting: actor.name,
    monthLabel: month.label,
    availableFen: available,
    availableDistanceM: distance,
    availableCount: open.length,
    claims: listMyClaims(ctx, actor).slice(0, 5),
    disclaimer: "浏览器定位需本人授权。离开页面、锁屏或系统回收后不能保证继续记录，轨迹也不能防篡改。",
  };
}

export function periodStats(ctx: Ctx, actor: Actor) {
  assertRole(actor, "employee");
  const now = nowOf(ctx);
  const month = beijingMonthRange(now);
  const quarter = beijingQuarterRange(now);
  const pack = (range: { startIso: string; endIso: string }) => {
    const trips = ctx.db.all<{ distance_m: number }>(
      "select distance_m from trips where employee_id = ? and ended_at >= ? and ended_at < ?",
      actor.id,
      range.startIso,
      range.endIso,
    );
    const claims = ctx.db.all<{ amount_fen: number; status: string }>(
      "select amount_fen, status from claims where employee_id = ? and created_at >= ? and created_at < ?",
      actor.id,
      range.startIso,
      range.endIso,
    );
    return {
      tripCount: trips.length,
      distanceM: trips.reduce((sum, row) => sum + row.distance_m, 0),
      claimFen: claims.reduce((sum, row) => sum + row.amount_fen, 0),
      settledFen: claims.filter((row) => row.status === "settled").reduce((sum, row) => sum + row.amount_fen, 0),
    };
  };
  return { month: { ...pack(month), label: month.label }, quarter: { ...pack(quarter), label: quarter.label } };
}

export function listPeople(ctx: Ctx, actor: Actor) {
  assertRole(actor, "admin");
  const employees = ctx.db.all<{
    id: string;
    name: string;
    employee_no: string | null;
    department: string | null;
    open_id: string | null;
    vehicle_type: string | null;
    displacement: string | null;
    plate_no: string | null;
    status: string;
  }>("select id, name, employee_no, department, open_id, vehicle_type, displacement, plate_no, status from employees where is_demo = ? order by name", ctx.config.mode === "demo" ? 1 : 0);
  const pending = ctx.db.all<{ id: string; name: string; open_id: string; created_at: string }>(
    "select id, name, open_id, created_at from pending_identities where linked_employee_id is null order by created_at desc",
  );
  return {
    employees: employees.map((employee) => ({
      id: employee.id,
      name: employee.name,
      employeeNo: employee.employee_no,
      department: employee.department,
      vehicleType: employee.vehicle_type,
      displacement: employee.displacement,
      plateNo: employee.plate_no,
      status: employee.status,
      openIdMasked: maskOpenId(employee.open_id),
      roles: ctx.db.all<{ role: string }>("select role from employee_roles where employee_id = ?", employee.id).map((row) => requireRole(row.role)),
    })),
    pending: pending.map((item) => ({ id: item.id, name: item.name, openIdMasked: maskOpenId(item.open_id), createdAt: formatBeijing(new Date(item.created_at)) })),
  };
}

export function setRoles(ctx: Ctx, actor: Actor, employeeId: string, roles: Role[]) {
  assertRole(actor, "admin");
  const cleaned = [...new Set(roles.map((role) => requireRole(role, 400)))];
  if (!cleaned.length) throw new AppError("ROLE", "角色无效", 400);
  if (actor.id === employeeId && (cleaned.includes("finance") || cleaned.includes("approver"))) {
    throw new AppError("SELF_GRANT", "管理员不能给自己追加审批或财务权限", 403);
  }
  const employee = ctx.db.get<{ id: string }>("select id from employees where id = ? and is_demo = ?", employeeId, ctx.config.mode === "demo" ? 1 : 0);
  if (!employee) throw new AppError("NOT_FOUND", "人员不存在", 404);
  ctx.db.transaction(() => {
    const current = ctx.db.all<{ role: string }>("select role from employee_roles where employee_id = ?", employeeId).map((row) => requireRole(row.role));
    if (current.includes("admin") && !cleaned.includes("admin")) {
      const admins = ctx.db.get<{ n: number }>("select count(*) as n from employee_roles where role = 'admin'");
      if ((admins?.n ?? 0) <= 1) throw new AppError("LAST_ADMIN", "不能移除最后一位管理员");
    }
    ctx.db.run("delete from employee_roles where employee_id = ?", employeeId);
    for (const role of cleaned) ctx.db.run("insert into employee_roles(employee_id, role) values (?, ?)", employeeId, role);
    audit(ctx, actor, "set_roles", "employee", employeeId, current.join(","), cleaned.join(","), "角色变更");
  });
}

export function mapOpenId(ctx: Ctx, actor: Actor, employeeId: string, openId: string) {
  assertRole(actor, "admin");
  if (!/^ou_[A-Za-z0-9_-]{4,80}$/.test(openId)) throw new AppError("OPEN_ID", "open_id 格式不正确");
  const tenant = ctx.config.mode === "demo" ? "demo-tenant" : ctx.config.feishu.tenantKey;
  if (!tenant) throw new AppError("CONFIG_MISSING", "还没有配置 tenant_key，不能绑定身份", 409);
  ctx.db.transaction(() => {
    const employee = ctx.db.get("select id from employees where id = ?", employeeId);
    if (!employee) throw new AppError("NOT_FOUND", "人员不存在", 404);
    const clash = ctx.db.get<{ id: string }>("select id from employees where tenant_key = ? and open_id = ? and id <> ?", tenant, openId, employeeId);
    if (clash) throw new AppError("OPEN_ID", "该 open_id 已绑定其他员工", 409);
    ctx.db.run("update employees set open_id = ?, tenant_key = ? where id = ?", openId, tenant, employeeId);
    audit(ctx, actor, "map_open_id", "employee", employeeId, null, "mapped", "绑定飞书身份");
  });
}

export function listRates(ctx: Ctx, actor: Actor) {
  assertAny(actor, ["admin", "finance", "employee"]);
  return ctx.db.all<RateRow>("select * from rate_versions where is_demo = ? order by effective_from desc", ctx.config.mode === "demo" ? 1 : 0).map(rateDto);
}

export function createRate(ctx: Ctx, actor: Actor, input: {
  name: string;
  baselinePriceYuan: string;
  previousPriceYuan: string;
  currentPriceYuan: string;
  baselineRateYuan: string;
  effectiveFrom: string;
  effectiveTo: string;
  regionNote: string;
  sourceNote: string;
  notes: string;
  confirmEnterprisePolicy?: boolean;
}) {
  assertRole(actor, "admin");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveTo) || input.effectiveFrom > input.effectiveTo) {
    throw new AppError("RATE", "生效日期无效");
  }
  if (!input.regionNote.trim() || !input.sourceNote.trim() || !input.notes.trim()) {
    throw new AppError("RATE", "地区、油价来源和说明都要填写；未知请写明待确认");
  }
  const baselinePrice = yuanToFenStrict(input.baselinePriceYuan);
  const previous = yuanToFenStrict(input.previousPriceYuan);
  const current = yuanToFenStrict(input.currentPriceYuan);
  const baselineRate = yuanToFenStrict(input.baselineRateYuan);
  const computed = adjustedRate({
    baselineRateFenPerKm: baselineRate,
    previousPriceFenPerLiter: previous,
    currentPriceFenPerLiter: current,
    thresholdFen: 50,
    stepFenPerKm: 5,
  });
  const policy = ctx.config.mode === "demo"
    ? "demo_unconfirmed"
    : input.confirmEnterprisePolicy ? "enterprise_configured" : "";
  if (!policy) throw new AppError("POLICY", "生产环境保存费率前，需要企业确认这不是软件默认政策", 409);
  const now = nowOf(ctx).toISOString();
  const id = crypto.randomUUID();
  ctx.db.transaction(() => {
    const overlap = ctx.db.get(
      "select id from rate_versions where is_demo = ? and effective_from <= ? and effective_to >= ?",
      ctx.config.mode === "demo" ? 1 : 0,
      input.effectiveTo,
      input.effectiveFrom,
    );
    if (overlap) throw new AppError("RATE", "生效区间与已有版本重叠。已冻结的申请不会被改写，请使用不重叠的新区间");
    ctx.db.run(
      `insert into rate_versions(id, name, quarter_label, baseline_price_fen_per_liter, previous_price_fen_per_liter, current_price_fen_per_liter, baseline_rate_fen_per_km, threshold_fen, step_fen_per_km, rounding, policy_status, effective_from, effective_to, region_note, source_note, is_demo, notes, created_at, created_by)
       values (?, ?, ?, ?, ?, ?, ?, 50, 5, 'toward_zero', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.name.trim(),
      `${input.effectiveFrom} 至 ${input.effectiveTo}`,
      baselinePrice,
      previous,
      current,
      baselineRate,
      policy,
      input.effectiveFrom,
      input.effectiveTo,
      input.regionNote.trim(),
      input.sourceNote.trim(),
      ctx.config.mode === "demo" ? 1 : 0,
      input.notes.trim(),
      now,
      actor.id,
    );
    audit(ctx, actor, "create_rate", "rate", id, null, policy, `调整步数 ${computed.steps}，生效费率 ${fenToYuan(computed.rateFenPerKm)} 元/公里`);
  });
  return rateDto(ctx.db.get<RateRow>("select * from rate_versions where id = ?", id)!);
}

export function listAudits(ctx: Ctx, actor: Actor): AuditDto[] {
  assertAny(actor, ["admin", "finance"]);
  const actions = actor.roles.includes("admin")
    ? ctx.db.all<AuditDto>("select action, from_status, to_status, comment, source, at, object_id from audit_events order by at desc limit 80")
    : ctx.db.all<AuditDto>("select action, from_status, to_status, comment, source, at, object_id from audit_events where action in ('settle', 'reversal', 'export') order by at desc limit 80");
  return actions.map((item) => ({ ...item, atBeijing: formatBeijing(new Date(item.at)) }));
}

function assertAny(actor: Actor, roles: Role[]) {
  if (actor.pending || !roles.some((role) => actor.roles.includes(role))) {
    throw new AppError("FORBIDDEN", "当前身份没有此操作权限", 403);
  }
}

function canRead(actor: Actor, claim: ClaimRow): boolean {
  if (actor.roles.includes("admin")) return true;
  if (claim.employee_id === actor.id && actor.roles.includes("employee")) return true;
  if (actor.roles.includes("approver") && claim.assigned_approver_id === actor.id) return true;
  if (actor.roles.includes("finance") && ["settlement_pending", "settled", "reversal_required", "reversal_recorded"].includes(claim.status)) return true;
  return false;
}

function mustClaim(db: AppDb, id: string): ClaimRow {
  const row = db.get<ClaimRow>("select * from claims where id = ?", id);
  if (!row) throw new AppError("NOT_FOUND", "申请不存在", 404);
  return hydrateClaim(row);
}

function hydrateClaim(row: ClaimRow): ClaimRow {
  return {
    ...row,
    status: parseClaimStatus(row.status),
    approval_provider: parseStoredProvider(row.approval_provider),
  };
}

function mustOwnClaim(ctx: Ctx, actor: Actor, id: string): ClaimRow {
  const row = mustClaim(ctx.db, id);
  if (row.employee_id !== actor.id) throw new AppError("NOT_FOUND", "申请不存在", 404);
  return row;
}

function claimDto(db: AppDb, row: ClaimRow, actor: Actor): ClaimDto {
  const binding = db.get<{ external_status: string | null; instance_code: string | null; needs_reconcile: number }>(
    "select external_status, instance_code, needs_reconcile from approval_bindings where claim_id = ?",
    row.id,
  );
  const settlement = db.get<{ voucher_no: string }>("select voucher_no from settlements where claim_id = ?", row.id);
  const snapshot = JSON.parse(row.rule_snapshot_json) as { rateFenPerKm?: number; policyStatus?: string };
  return {
    id: row.id,
    number: row.number,
    employeeId: row.employee_id,
    employeeName: employeeName(db, row.employee_id),
    status: row.status,
    statusLabel: CLAIM_STATUS_LABEL[row.status],
    nextAction: nextActionFor(row.status),
    distanceLabel: formatKm(row.distance_m),
    amountLabel: fenToYuan(row.amount_fen),
    amountFen: row.amount_fen,
    purpose: row.purpose,
    submittedAt: row.submitted_at ? formatBeijing(new Date(row.submitted_at)) : null,
    externalStatus: parseExternalApprovalStatus(binding?.external_status ?? null),
    instanceCode: binding?.instance_code ?? null,
    needsReconcile: Boolean(binding?.needs_reconcile),
    channelLabel: row.runtime_channel === "demo" ? "演示流程 · 未连接飞书" : row.runtime_channel === "sandbox" ? "沙箱 · 飞书" : "生产 · 飞书",
    isDemo: row.is_demo === 1,
    rateLabel: `${fenToYuan(snapshot.rateFenPerKm ?? row.rate_fen_per_km)} 元/公里`,
    policyStatus: snapshot.policyStatus ?? "",
    voucherNo: settlement?.voucher_no ?? null,
    assignedToMe: row.assigned_approver_id === actor.id,
  };
}

function toTrip(db: AppDb, row: TripRow): TripDto {
  const occupied = db.get("select trip_id from trip_occupancy where trip_id = ?", row.id);
  return {
    id: row.id,
    purpose: row.purpose,
    origin: row.origin_text,
    destination: row.dest_text,
    startedAt: formatBeijing(new Date(row.started_at)),
    endedAt: formatBeijing(new Date(row.ended_at)),
    distanceLabel: formatKm(row.distance_m),
    distanceM: row.distance_m,
    source: row.source,
    sourceLabel: SOURCE_LABEL[row.source] ?? row.source,
    trustLabel: "不可当作防篡改里程",
    eligible: row.real_claim_eligible === 1,
    occupied: Boolean(occupied),
    crossQuarter: row.cross_quarter === 1,
    pointCount: row.point_count,
    evidenceNote: row.evidence_note,
  };
}

type RateRow = {
  id: string;
  name: string;
  quarter_label: string;
  baseline_price_fen_per_liter: number;
  previous_price_fen_per_liter: number;
  current_price_fen_per_liter: number;
  baseline_rate_fen_per_km: number;
  threshold_fen: number;
  step_fen_per_km: number;
  rounding: string;
  policy_status: string;
  effective_from: string;
  effective_to: string;
  region_note: string;
  source_note: string;
  notes: string;
  is_demo: number;
};

function rateForDay(db: AppDb, day: string, demo: boolean): RateRow & { rate_fen_per_km: number } {
  const rows = db.all<RateRow>(
    "select * from rate_versions where is_demo = ? and effective_from <= ? and effective_to >= ?",
    demo ? 1 : 0,
    day,
    day,
  );
  if (rows.length !== 1) throw new AppError("RATE", rows.length ? "费率版本重叠，已停止自动计价" : "这一天没有可用费率版本");
  const computed = adjustedRate({
    baselineRateFenPerKm: rows[0].baseline_rate_fen_per_km,
    previousPriceFenPerLiter: rows[0].previous_price_fen_per_liter,
    currentPriceFenPerLiter: rows[0].current_price_fen_per_liter,
    thresholdFen: rows[0].threshold_fen,
    stepFenPerKm: rows[0].step_fen_per_km,
  });
  return { ...rows[0], rate_fen_per_km: computed.rateFenPerKm };
}

function rateSnapshot(row: RateRow) {
  const computed = adjustedRate({
    baselineRateFenPerKm: row.baseline_rate_fen_per_km,
    previousPriceFenPerLiter: row.previous_price_fen_per_liter,
    currentPriceFenPerLiter: row.current_price_fen_per_liter,
    thresholdFen: row.threshold_fen,
    stepFenPerKm: row.step_fen_per_km,
  });
  return {
    rateVersionId: row.id,
    name: row.name,
    baselineRateFenPerKm: row.baseline_rate_fen_per_km,
    rateFenPerKm: computed.rateFenPerKm,
    steps: computed.steps,
    thresholdFen: row.threshold_fen,
    stepFenPerKm: row.step_fen_per_km,
    previousPriceFenPerLiter: row.previous_price_fen_per_liter,
    currentPriceFenPerLiter: row.current_price_fen_per_liter,
    baselinePriceFenPerLiter: row.baseline_price_fen_per_liter,
    rounding: row.rounding,
    policyStatus: row.policy_status,
    note: row.notes,
  };
}

function rateDto(row: RateRow) {
  const computed = adjustedRate({
    baselineRateFenPerKm: row.baseline_rate_fen_per_km,
    previousPriceFenPerLiter: row.previous_price_fen_per_liter,
    currentPriceFenPerLiter: row.current_price_fen_per_liter,
    thresholdFen: row.threshold_fen,
    stepFenPerKm: row.step_fen_per_km,
  });
  return {
    id: row.id,
    name: row.name,
    quarterLabel: row.quarter_label,
    baselinePriceLabel: `${fenToYuan(row.baseline_price_fen_per_liter)} 元/升`,
    previousPriceLabel: `${fenToYuan(row.previous_price_fen_per_liter)} 元/升`,
    currentPriceLabel: `${fenToYuan(row.current_price_fen_per_liter)} 元/升`,
    baselineRateLabel: `${fenToYuan(row.baseline_rate_fen_per_km)} 元/公里`,
    rateLabel: `${fenToYuan(computed.rateFenPerKm)} 元/公里`,
    steps: computed.steps,
    roundingLabel: "向零取整（演示假设，非正式政策）",
    policyStatus: row.policy_status,
    policyLabel: row.policy_status === "demo_unconfirmed" ? "待确认 · 演示值" : "企业已配置",
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    regionNote: row.region_note,
    sourceNote: row.source_note,
    notes: row.notes,
    isDemo: row.is_demo === 1,
  };
}

function nextClaimNumber(db: AppDb, now: Date): string {
  const parts = beijingMonthRange(now).key.replace("-", "");
  const key = `claim-${parts}`;
  const row = db.get<{ value: number }>("select value from counters where name = ?", key);
  const value = (row?.value ?? 0) + 1;
  if (row) db.run("update counters set value = ? where name = ?", value, key);
  else db.run("insert into counters(name, value) values (?, ?)", key, value);
  return `CL-${parts}-${String(value).padStart(3, "0")}`;
}

function buildForm(config: AppConfig, claim: ClaimRow): string {
  if (config.mode === "demo") {
    return JSON.stringify([
      { id: "demo_claim_no", type: "input", value: claim.number },
      { id: "demo_amount", type: "input", value: fenToYuan(claim.amount_fen) },
      { id: "demo_distance", type: "input", value: formatKm(claim.distance_m) },
      { id: "demo_summary", type: "input", value: claim.purpose },
    ]);
  }
  return JSON.stringify([
    { id: config.feishu.widgets.claimNo, type: "input", value: claim.number },
    { id: config.feishu.widgets.amount, type: "input", value: fenToYuan(claim.amount_fen) },
    { id: config.feishu.widgets.distance, type: "input", value: formatKm(claim.distance_m) },
    { id: config.feishu.widgets.summary, type: "input", value: claim.purpose.slice(0, 200) },
  ]);
}

function employeeName(db: AppDb, id: string): string {
  return db.get<{ name: string }>("select name from employees where id = ?", id)?.name ?? "未知";
}

function yuanToFenStrict(input: string): number {
  const value = input.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new AppError("MONEY", "请按元填写，最多两位小数");
  const [whole, frac = ""] = value.split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
}

function csv(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

type AuditDto = {
  action: string;
  from_status: string | null;
  to_status: string | null;
  comment: string | null;
  source: string;
  at: string;
  object_id?: string;
  atBeijing?: string;
};

function audit(ctx: Ctx, actor: Actor | null, action: string, objectType: string, objectId: string, from: string | null, to: string | null, comment: string) {
  ctx.db.run(
    `insert into audit_events(id, actor_id, action, object_type, object_id, from_status, to_status, comment, source, at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    crypto.randomUUID(),
    actor?.id ?? null,
    action,
    objectType,
    objectId,
    from,
    to,
    comment,
    ctx.config.mode,
    nowOf(ctx).toISOString(),
  );
}

function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const radius = 6371000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}
