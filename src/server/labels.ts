import type { ClaimStatus } from "../lib/states";

export const CLAIM_STATUS_LABEL: Record<ClaimStatus, string> = {
  draft: "草稿",
  submitting: "提交中",
  in_approval: "审批中",
  rejected: "已驳回",
  canceled: "已撤回",
  settlement_pending: "待财务结算",
  settled: "已结算",
  sync_exception: "同步异常",
  hold_exception: "暂停结算",
  reversal_required: "待冲正",
  reversal_recorded: "已登记冲正",
};

export function nextActionFor(status: ClaimStatus): string {
  switch (status) {
    case "draft":
      return "提交申请";
    case "submitting":
      return "等待对账";
    case "in_approval":
      return "查看进度";
    case "settlement_pending":
      return "核对凭证";
    case "rejected":
      return "查看意见";
    case "canceled":
      return "可修订重提";
    case "settled":
      return "查看回单";
    case "sync_exception":
      return "人工对账";
    case "hold_exception":
      return "暂停结算";
    case "reversal_required":
      return "登记冲正";
    case "reversal_recorded":
      return "查看冲正";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

export const SOURCE_LABEL: Record<string, string> = {
  browser_gps: "浏览器定位",
  manual: "人工补录",
  demo_cruise: "演示巡航",
  demo_seed: "演示种子",
};
