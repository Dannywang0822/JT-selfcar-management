import crypto from "node:crypto";
import type { AppDb } from "./db";

export type ExternalInput = {
  instanceCode: string;
  approvalCode: string;
  status: string;
  operateTime: string | null;
  type: string;
  now: Date;
  source: string;
  /** 补偿拉取得到的权威状态，允许覆盖 needs_reconcile，仍禁止把未通过单据结算。 */
  authoritative?: boolean;
};

const INSTANCE_TYPES = new Set(["approval_instance"]);

export function applyExternalStatus(db: AppDb, input: ExternalInput): string {
  if (!INSTANCE_TYPES.has(input.type)) return "ignored_type";
  if (!input.instanceCode || !input.status) return "ignored_type";
  const binding = db.get<Binding>(
    "select * from approval_bindings where instance_code = ?",
    input.instanceCode,
  );
  if (!binding) return "ignored_unknown";
  if (input.approvalCode && binding.approval_code && input.approvalCode !== binding.approval_code) {
    return "ignored_foreign";
  }
  const claim = db.get<Claim>("select * from claims where id = ?", binding.claim_id);
  if (!claim) return "ignored_unknown";
  if (!input.operateTime && !input.authoritative) {
    db.run("update approval_bindings set needs_reconcile = 1, updated_at = ? where id = ?", input.now.toISOString(), binding.id);
    audit(db, input, claim, claim.status, "事件缺少 operate_time，未改状态");
    return "needs_reconcile";
  }
  if (input.operateTime && binding.last_operate_time) {
    const order = compareTime(input.operateTime, binding.last_operate_time);
    if (order < 0) {
      audit(db, input, claim, claim.status, "较旧事件，未覆盖当前状态");
      return "ignored_stale";
    }
    if (order === 0 && binding.external_status && binding.external_status !== input.status) {
      db.run("update approval_bindings set needs_reconcile = 1, updated_at = ? where id = ?", input.now.toISOString(), binding.id);
      audit(db, input, claim, claim.status, "同一时刻出现不同状态，暂停覆盖并等待对账");
      return "conflict";
    }
  }
  if (input.status === "OVERTIME_RECOVER") {
    db.run(
      "update approval_bindings set needs_reconcile = 1, external_status = ?, last_operate_time = ?, updated_at = ? where id = ?",
      input.status,
      input.operateTime,
      input.now.toISOString(),
      binding.id,
    );
    audit(db, input, claim, claim.status, "超时恢复，不直接视为已通过，等待拉取实例详情");
    return "needs_reconcile";
  }
  const decision = decide(claim.status, input.status);
  if (decision.kind === "ignore") {
    audit(db, input, claim, claim.status, decision.reason);
    return "ignored_nonregress";
  }
  if (decision.kind === "reconcile") {
    db.run("update approval_bindings set needs_reconcile = 1, updated_at = ? where id = ?", input.now.toISOString(), binding.id);
    audit(db, input, claim, claim.status, decision.reason);
    return "needs_reconcile";
  }
  db.transaction(() => {
    if (decision.release) {
      db.run("delete from trip_occupancy where claim_id = ?", claim.id);
    }
    if (decision.reversal) {
      const settlement = db.get<{ id: string }>("select id from settlements where claim_id = ?", claim.id);
      if (settlement) {
        const exists = db.get<{ id: string }>(
          "select id from settlement_reversals where claim_id = ? and external_status = ?",
          claim.id,
          input.status,
        );
        if (!exists) {
          db.run(
            `insert into settlement_reversals(id, claim_id, settlement_id, reason, external_status, created_at)
             values (?, ?, ?, ?, ?, ?)`,
            crypto.randomUUID(),
            claim.id,
            settlement.id,
            "飞书在结算后变更审批状态，保留原结算并登记冲正，不删除历史",
            input.status,
            input.now.toISOString(),
          );
        }
      }
    }
    db.run("update claims set status = ?, updated_at = ? where id = ?", decision.status, input.now.toISOString(), claim.id);
    db.run(
      `update approval_bindings
       set external_status = ?, last_operate_time = coalesce(?, last_operate_time), needs_reconcile = 0, updated_at = ?
       where id = ?`,
      input.status,
      input.operateTime,
      input.now.toISOString(),
      binding.id,
    );
    audit(db, input, claim, decision.status, decision.reason);
  });
  return "applied";
}

type Decision =
  | { kind: "move"; status: string; release: boolean; reversal: boolean; reason: string }
  | { kind: "ignore"; reason: string }
  | { kind: "reconcile"; reason: string };

function decide(current: string, external: string): Decision {
  if (external === "PENDING") {
    if (["draft", "submitting", "sync_exception", "in_approval", "hold_exception"].includes(current)) {
      return { kind: "move", status: "in_approval", release: false, reversal: false, reason: "审批中" };
    }
    return { kind: "ignore", reason: "审批中事件不能把已进入财务或已结束的单据退回" };
  }
  if (external === "APPROVED") {
    if (current === "settled" || current === "reversal_required" || current === "reversal_recorded") {
      return { kind: "ignore", reason: "已结算单据不因重复通过事件改变" };
    }
    if (current === "rejected" || current === "canceled") {
      return { kind: "reconcile", reason: "终态单据收到通过事件，暂停自动改写" };
    }
    return { kind: "move", status: "settlement_pending", release: false, reversal: false, reason: "审批通过，进入财务待结算，尚未付款" };
  }
  if (external === "REJECTED" || external === "CANCELED") {
    if (current === "settled" || current === "reversal_required" || current === "reversal_recorded") {
      return { kind: "move", status: "reversal_required", release: false, reversal: true, reason: "结算后审批被拒绝或撤回，转冲正" };
    }
    return {
      kind: "move",
      status: external === "REJECTED" ? "rejected" : "canceled",
      release: true,
      reversal: false,
      reason: external === "REJECTED" ? "审批驳回，释放行程占用" : "审批撤回，释放行程占用",
    };
  }
  if (external === "DELETED" || external === "REVERTED" || external === "OVERTIME_CLOSE") {
    if (current === "settled" || current === "reversal_required" || current === "reversal_recorded") {
      return { kind: "move", status: "reversal_required", release: false, reversal: true, reason: "结算后审批撤销或关闭，转冲正" };
    }
    return { kind: "move", status: "hold_exception", release: false, reversal: false, reason: "审批异常关闭或撤销，暂停结算" };
  }
  return { kind: "reconcile", reason: `未识别的审批状态 ${external}` };
}

function compareTime(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

type Binding = {
  id: string;
  claim_id: string;
  approval_code: string | null;
  external_status: string | null;
  last_operate_time: string | null;
};

type Claim = { id: string; status: string };

function audit(db: AppDb, input: ExternalInput, claim: Claim, toStatus: string, comment: string) {
  db.run(
    `insert into audit_events(id, actor_id, action, object_type, object_id, from_status, to_status, comment, source, at, meta_json)
     values (?, null, 'approval_status', 'claim', ?, ?, ?, ?, ?, ?, ?)`,
    crypto.randomUUID(),
    claim.id,
    claim.status,
    toStatus,
    comment,
    input.source,
    input.now.toISOString(),
    JSON.stringify({ externalStatus: input.status, instanceCode: input.instanceCode }),
  );
}
