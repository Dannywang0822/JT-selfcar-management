import { AppError } from "./errors";
import {
  isClaimStatus,
  isExternalApprovalStatus,
  isStoredApprovalProvider,
  type ClaimStatus,
  type ExternalApprovalStatus,
  type StoredApprovalProvider,
} from "../lib/states";

export function parseClaimStatus(value: string): ClaimStatus {
  if (!isClaimStatus(value)) throw new AppError("STATUS", "单据状态无效", 500);
  return value;
}

export function parseStoredProvider(value: string): StoredApprovalProvider {
  if (!isStoredApprovalProvider(value)) throw new AppError("PROVIDER", "单据审批提供方无效", 500);
  return value;
}

export function parseExternalApprovalStatus(value: string | null): ExternalApprovalStatus | null {
  if (value == null) return null;
  if (!isExternalApprovalStatus(value)) throw new AppError("STATUS", "外部审批状态无效", 500);
  return value;
}
