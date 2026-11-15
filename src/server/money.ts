import { AppError } from "./errors";

export function parseYuanToFen(input: string): number {
  const value = input.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(value)) {
    throw new AppError("MONEY", "金额需为最多两位小数的非负数字");
  }
  const [whole, frac = ""] = value.split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
}

export function fenToYuan(fen: number): string {
  const sign = fen < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(fen));
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${sign}${whole}.${String(frac).padStart(2, "0")}`;
}

export function parseKmToMeters(input: string): number {
  const value = input.trim();
  if (!/^\d+(\.\d{1,3})?$/.test(value)) {
    throw new AppError("DISTANCE", "里程需为最多三位小数的非负公里数");
  }
  const [whole, frac = ""] = value.split(".");
  return Number(whole) * 1000 + Number((frac + "000").slice(0, 3));
}

export function formatKm(meters: number): string {
  const neg = meters < 0;
  const abs = Math.abs(Math.trunc(meters));
  const whole = Math.floor(abs / 1000);
  const frac = abs % 1000;
  const fracStr = frac.toString().padStart(3, "0").replace(/0+$/, "");
  const body = fracStr ? `${whole}.${fracStr}` : `${whole}.0`;
  return neg ? `-${body}` : body;
}

/** 整数分。distance_m * rate_fen_per_km / 1000，余数 >= 0.5 分时远离零取整。 */
export function amountFen(distanceM: number, rateFenPerKm: number): number {
  if (!Number.isInteger(distanceM) || !Number.isInteger(rateFenPerKm)) {
    throw new AppError("MONEY", "里程和费率必须是整数");
  }
  const product = distanceM * rateFenPerKm;
  const base = Math.trunc(product / 1000);
  const rem = product % 1000;
  if (Math.abs(rem) * 2 >= 1000) return base + Math.sign(product);
  return base;
}

export function maskOpenId(openId: string | null | undefined): string {
  if (!openId) return "未映射";
  if (openId.length <= 8) return "已映射";
  return `${openId.slice(0, 3)}····${openId.slice(-4)}`;
}
