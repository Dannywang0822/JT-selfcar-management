/** 单据、角色和外部审批状态。数据库 CHECK 与这里保持同一份取值。 */

export const ROLES = ["employee", "approver", "finance", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const CLAIM_STATUSES = [
  "draft",
  "submitting",
  "in_approval",
  "sync_exception",
  "settlement_pending",
  "settled",
  "rejected",
  "canceled",
  "hold_exception",
  "reversal_required",
  "reversal_recorded",
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const SETTLEMENT_STATUSES = ["confirmed"] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

export const EXTERNAL_APPROVAL_STATUSES = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "CANCELED",
  "DELETED",
  "REVERTED",
  "OVERTIME_CLOSE",
  "OVERTIME_RECOVER",
] as const;
export type ExternalApprovalStatus = (typeof EXTERNAL_APPROVAL_STATUSES)[number];

/** 库里只保存飞书。OA 只能出现在请求入口，并且会被拒绝。 */
export const STORED_APPROVAL_PROVIDERS = ["feishu"] as const;
export type StoredApprovalProvider = (typeof STORED_APPROVAL_PROVIDERS)[number];

export const REQUESTED_APPROVAL_PROVIDERS = ["feishu", "oa"] as const;
export type RequestedApprovalProvider = (typeof REQUESTED_APPROVAL_PROVIDERS)[number];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function isClaimStatus(value: string): value is ClaimStatus {
  return (CLAIM_STATUSES as readonly string[]).includes(value);
}

export function isSettlementStatus(value: string): value is SettlementStatus {
  return (SETTLEMENT_STATUSES as readonly string[]).includes(value);
}

export function isExternalApprovalStatus(value: string): value is ExternalApprovalStatus {
  return (EXTERNAL_APPROVAL_STATUSES as readonly string[]).includes(value);
}

export function isStoredApprovalProvider(value: string): value is StoredApprovalProvider {
  return (STORED_APPROVAL_PROVIDERS as readonly string[]).includes(value);
}

export function isRequestedApprovalProvider(value: string): value is RequestedApprovalProvider {
  return (REQUESTED_APPROVAL_PROVIDERS as readonly string[]).includes(value);
}

export function sqlLiteralList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}
