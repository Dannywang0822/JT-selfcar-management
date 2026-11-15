import crypto from "node:crypto";

export function sha256Hex(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function timingSafeEqualText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** 官方签名：SHA256(timestamp + nonce + encrypt_key + 原始 body 字节)，十六进制。 */
export function feishuSignature(timestamp: string, nonce: string, encryptKey: string, rawBody: Buffer): string {
  const prefix = Buffer.from(`${timestamp}${nonce}${encryptKey}`, "utf8");
  return sha256Hex(Buffer.concat([prefix, rawBody]));
}

/**
 * 官方解密：key = SHA256(Encrypt Key)，密文为 base64(iv + aes-256-cbc)。
 * 仅用于测试夹具和入站事件。
 */
export function decryptFeishu(encryptKey: string, encrypt: string): string {
  const key = crypto.createHash("sha256").update(encryptKey, "utf8").digest();
  const buf = Buffer.from(encrypt, "base64");
  if (buf.length < 17) throw new Error("密文过短");
  const iv = buf.subarray(0, 16);
  const data = buf.subarray(16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function encryptFeishu(encryptKey: string, plain: string): string {
  const key = crypto.createHash("sha256").update(encryptKey, "utf8").digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(plain, "utf8")), cipher.final()]);
  return Buffer.concat([iv, encrypted]).toString("base64");
}

export function pkceChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}
