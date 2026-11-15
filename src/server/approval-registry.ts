import type { AppConfig } from "./config";
import type { AppDb } from "./db";
import { AppError } from "./errors";
import { createApprovalProvider, type ApprovalProvider, type FeishuHttp } from "./feishu";
import { createDisabledOaAdapter, type OaAdapter } from "./oa";
import { isRequestedApprovalProvider, type RequestedApprovalProvider } from "../lib/states";

export type ApprovalRegistry = {
  feishu: ApprovalProvider;
  oa: OaAdapter;
};

/** 飞书与禁用 OA 都在这条注册表里。提交、对账、回调和付款都从这里分发。 */
export function approvalRegistry(config: AppConfig, db: AppDb, http: FeishuHttp): ApprovalRegistry {
  return {
    feishu: createApprovalProvider(config, db, http),
    oa: createDisabledOaAdapter(),
  };
}

export function requestedProvider(value: string | undefined): RequestedApprovalProvider {
  if (!value || value === "feishu") return "feishu";
  if (isRequestedApprovalProvider(value)) return value;
  throw new AppError("PROVIDER", "未知审批提供方", 400);
}

/**
 * OA 没有活的发送实现。任何发单、回调、查状态或付款都会走禁用适配器并抛 OA_DISABLED。
 * 调用方必须在改单据状态之前调用。
 */
export async function rejectOaProvider(
  registry: ApprovalRegistry,
  provider: RequestedApprovalProvider,
  action: "submit" | "callback" | "status" | "pay",
  payload: { snapshot?: unknown; idempotencyKey?: string; externalId?: string } = {},
): Promise<void> {
  if (provider !== "oa") return;
  const oa = registry.oa;
  const capabilities = oa.capabilities();
  if (oa.enabled || capabilities.enabled || capabilities.canSubmit || capabilities.canCallback || capabilities.canPay) {
    throw new AppError("OA_DISABLED", "OA 适配器不能启用", 500);
  }
  if (action === "submit") {
    await oa.submit(payload.snapshot ?? {}, payload.idempotencyKey ?? "blocked");
  } else if (action === "callback") {
    await oa.verifyAndParseCallback(Buffer.alloc(0), {});
  } else if (action === "status") {
    await oa.getStatus(payload.externalId ?? "");
  } else {
    await oa.cancel(payload.externalId ?? "", "付款不在首期范围");
  }
}
