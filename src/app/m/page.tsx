"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type Claim } from "@/components/api";
import { money, statusTone } from "@/components/format";
import { Guard } from "@/components/shells";
import { Button } from "@/components/ui/button";

type Summary = {
  greeting: string;
  monthLabel: string;
  availableFen: number;
  availableDistanceM: number;
  availableCount: number;
  claims: Claim[];
  disclaimer: string;
};

export default function EmployeeHome() {
  return (
    <Guard allow={(actor) => actor.roles.includes("employee")}>
      {() => <HomeBody />}
    </Guard>
  );
}

function HomeBody() {
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<Summary>("/api/me/summary").then(setData).catch((reason: Error) => setError(reason.message));
  }, []);
  if (error) return <p className="text-[#e11d48]">{error}</p>;
  if (!data) return <p className="text-[#5d6d84]">正在汇总本月行程…</p>;
  const km = (data.availableDistanceM / 1000).toFixed(1);
  return (
    <div>
      <p className="text-sm text-[#5d6d84]">你好，{data.greeting}</p>
      <h1 className="mt-1 text-xl font-semibold">安全记录 · 合规申请</h1>
      <section className="hero-card mt-4 rounded-[28px] bg-gradient-to-br from-[#2f6bff] to-[#1d4ed8] p-5 text-white">
        <div className="text-sm text-white/80">{data.monthLabel}可申请补贴</div>
        <div className="hero-amount mt-2 text-4xl font-semibold tracking-tight">{money(data.availableFen)}</div>
        <div className="mt-2 text-sm text-white/80">尚未占用 {km} km · {data.availableCount} 次行程</div>
      </section>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <Button asChild variant="outline" className="h-12"><Link href="/m/trips/new">记录行程</Link></Button>
        <Button asChild className="h-12"><Link href="/m/claims/new">发起申请</Link></Button>
      </div>
      <p className="mt-3 text-xs leading-5 text-[#7b8da3]">{data.disclaimer}</p>
      <section className="mt-5">
        <h2 className="font-medium">我的申请</h2>
        <div className="mt-3 space-y-3">
          {data.claims.length === 0 ? <p className="rounded-3xl bg-white p-4 text-sm text-[#5d6d84]">这个月还没有申请。</p> : null}
          {data.claims.map((claim) => (
            <Link key={claim.id} href={`/m/claims/${claim.id}`} className="block rounded-3xl bg-white p-4 shadow-sm">
              <div className="text-sm text-[#5d6d84]">{claim.purpose}</div>
              <div className="mt-1 font-medium">{claim.number} · {money(claim.amountFen)}</div>
              <div className={`mt-2 text-sm ${statusTone(claim.status)}`}>{claim.statusLabel}</div>
              <div className="mt-1 text-xs text-[#7b8da3]">{claim.channelLabel}</div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
