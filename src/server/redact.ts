export function redactText(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  const unique = [...new Set(secrets.filter((item): item is string => Boolean(item && item.length >= 4)))];
  unique.sort((a, b) => b.length - a.length);
  for (const secret of unique) {
    out = out.split(secret).join("[redacted]");
  }
  return out;
}
