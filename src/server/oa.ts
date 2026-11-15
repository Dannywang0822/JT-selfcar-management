import { AppError } from "./errors";

export type OaCapabilities = {
  provider: "oa";
  enabled: false;
  canSubmit: false;
  canCallback: false;
  canPay: false;
  reason: string;
};

export type OaAdapter = {
  providerId: "oa";
  enabled: false;
  capabilities(): OaCapabilities;
  resolveEmployee(externalRef: string): Promise<never>;
  submit(claimSnapshot: unknown, idempotencyKey: string): Promise<never>;
  getStatus(externalId: string): Promise<never>;
  verifyAndParseCallback(rawBody: Buffer, headers: Record<string, string | undefined>): Promise<never>;
  cancel(externalId: string, reason: string): Promise<never>;
  fetchAuditTrail(externalId: string): Promise<never>;
};

const REASON =
  "OA 适配器只有类型契约，厂商、文档和凭据都未确认。首期不会向任何 OA 发单、回调或付款。";

function disabled(): never {
  throw new AppError("OA_DISABLED", REASON, 409);
}

export function createDisabledOaAdapter(): OaAdapter {
  return {
    providerId: "oa",
    enabled: false,
    capabilities: () => ({
      provider: "oa",
      enabled: false,
      canSubmit: false,
      canCallback: false,
      canPay: false,
      reason: REASON,
    }),
    resolveEmployee: async () => disabled(),
    submit: async () => disabled(),
    getStatus: async () => disabled(),
    verifyAndParseCallback: async () => disabled(),
    cancel: async () => disabled(),
    fetchAuditTrail: async () => disabled(),
  };
}
