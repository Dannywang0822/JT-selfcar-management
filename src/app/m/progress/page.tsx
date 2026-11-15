"use client";

import { useEffect, useState } from "react";
import { api } from "@/components/api";
import { money } from "@/components/format";
import { ClaimList } from "@/components/claim-list";
import { Guard } from "@/components/shells";

type Stats = {
  month: { label: string; tripCount: number; distanceM: number; claimFen: number; settledFen: number };
  quarter: { label: string; tripCount: number; distanceM: number; claimFen: number; settledFen: number };
};

export default function ProgressPage() {
  return <Guard allow={(actor) => actor.roles.includes("employee")}>{() => <Body />}</Guard>;
}

function Body() {
  const [stats, setStats] = useState<Stats | null>(null);
  useEffect(() => { api<Stats>("/api/me/stats").then(setStats).catch(() => setStats(null)); }, []);
  return (
    <div>
      <h1 className="text-xl font-semibold">进度</h1>
      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-1">
        {stats ? <Stat title={stats.month.label} item={stats.month} /> : <p className="text-sm text-[#5d6d84]">正在统计…</p>}
        {stats ? <Stat title={stats.quarter.label} item={stats.quarter} /> : null}
      </div>
      <div className="mt-5"><ClaimList hrefBase="/m/claims" /></div>
    </div>
  );
}

function Stat({ title, item }: { title: string; item: Stats["month"] }) {
  return (
    <section className="rounded-3xl bg-white p-4 shadow-sm">
      <h2 className="font-medium">{title}</h2>
      <p className="mt-2 text-sm text-[#5d6d84]">行程 {item.tripCount} 次 · {(item.distanceM / 1000).toFixed(1)} km</p>
      <p className="mt-1 text-sm text-[#5d6d84]">申请 {money(item.claimFen)} · 已结算 {money(item.settledFen)}</p>
    </section>
  );
}
