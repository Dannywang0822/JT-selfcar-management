export function money(fen: number): string {
  const negative = fen < 0;
  const abs = Math.abs(Math.trunc(fen));
  const whole = Math.floor(abs / 100).toLocaleString("zh-CN");
  const frac = String(abs % 100).padStart(2, "0");
  return `${negative ? "-" : ""}¥ ${whole}.${frac}`;
}

import type { ClaimStatus } from "@/lib/states";

export function statusTone(status: ClaimStatus): string {
  if (status === "in_approval" || status === "submitting") return "text-[#2563eb]";
  if (status === "settlement_pending") return "text-[#a16207]";
  if (status === "rejected" || status === "sync_exception" || status === "hold_exception" || status === "reversal_required") return "text-[#e11d48]";
  if (status === "settled" || status === "reversal_recorded") return "text-[#047857]";
  return "text-[#475569]";
}
