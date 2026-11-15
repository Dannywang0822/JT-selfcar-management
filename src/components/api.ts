export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("x-mileage-client", "1");
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...init, headers });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(data.message || "请求失败");
    (error as Error & { missing?: string[] }).missing = data.missing;
    throw error;
  }
  return data as T;
}

export type Actor = {
  name: string;
  roles: string[];
  pending: boolean;
  isDemo: boolean;
  mode: "demo" | "sandbox" | "production";
  openIdMasked: string;
};

import type { ClaimStatus, ExternalApprovalStatus } from "@/lib/states";

export type Claim = {
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
  externalStatus: ExternalApprovalStatus | null;
  instanceCode: string | null;
  needsReconcile: boolean;
  channelLabel: string;
  isDemo: boolean;
  rateLabel: string;
  policyStatus: string;
  voucherNo: string | null;
  assignedToMe: boolean;
};

export type Trip = {
  id: string;
  purpose: string;
  origin: string;
  destination: string;
  startedAt: string;
  endedAt: string;
  distanceLabel: string;
  source: string;
  sourceLabel: string;
  trustLabel: string;
  eligible: boolean;
  occupied: boolean;
  crossQuarter: boolean;
  pointCount: number;
  evidenceNote: string | null;
  employeeName?: string;
};
