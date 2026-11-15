export type BeijingParts = {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
};

export function beijingParts(date: Date): BeijingParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const bag: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== "literal") bag[part.type] = part.value;
  }
  return {
    year: bag.year,
    month: bag.month,
    day: bag.day,
    hour: bag.hour === "24" ? "00" : bag.hour,
    minute: bag.minute,
    second: bag.second,
  };
}

export function formatBeijing(date: Date): string {
  const p = beijingParts(date);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export function beijingDay(date: Date): string {
  const p = beijingParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

export function beijingMonthKey(date: Date): string {
  const p = beijingParts(date);
  return `${p.year}-${p.month}`;
}

export function beijingMonthRange(date: Date): { startIso: string; endIso: string; key: string; label: string } {
  const p = beijingParts(date);
  const start = new Date(`${p.year}-${p.month}-01T00:00:00+08:00`);
  const month = Number(p.month);
  const year = Number(p.year);
  const next = month === 12 ? `${year + 1}-01-01` : `${p.year}-${String(month + 1).padStart(2, "0")}-01`;
  const end = new Date(`${next}T00:00:00+08:00`);
  return {
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    key: `${p.year}-${p.month}`,
    label: `${p.year}年${Number(p.month)}月`,
  };
}

export function beijingQuarterRange(date: Date): { startIso: string; endIso: string; key: string; label: string } {
  const quarter = beijingQuarter(date);
  const start = new Date(`${quarter.start}T00:00:00+08:00`);
  const [year, month] = quarter.end.split("-").map(Number);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const end = new Date(`${nextYear}-${String(nextMonth).padStart(2, "0")}-01T00:00:00+08:00`);
  return { startIso: start.toISOString(), endIso: end.toISOString(), key: quarter.key, label: quarter.label };
}

export function beijingQuarter(date: Date): { key: string; label: string; start: string; end: string } {
  const p = beijingParts(date);
  const month = Number(p.month);
  const q = Math.floor((month - 1) / 3) + 1;
  const startMonth = (q - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  const endDay = new Date(Date.UTC(Number(p.year), endMonth, 0)).getUTCDate();
  return {
    key: `${p.year}Q${q}`,
    label: `${p.year}年第${q}季度`,
    start: `${p.year}-${String(startMonth).padStart(2, "0")}-01`,
    end: `${p.year}-${String(endMonth).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`,
  };
}

export function quarterOfDay(day: string): string {
  const [year, month] = day.split("-");
  const q = Math.floor((Number(month) - 1) / 3) + 1;
  return `${year}Q${q}`;
}

export function parseBeijingInput(value: string): Date {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed) && !/[zZ+]/.test(trimmed)) {
    const withSeconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(trimmed) ? `${trimmed}:00` : trimmed;
    const date = new Date(`${withSeconds}+08:00`);
    if (!Number.isNaN(date.getTime())) return date;
  }
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) throw new Error("时间无法解析");
  return date;
}
