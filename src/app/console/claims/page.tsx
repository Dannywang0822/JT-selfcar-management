"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type Claim } from "@/components/api";
import { money, statusTone } from "@/components/format";
import { Guard } from "@/components/shells";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const statuses = ["", "in_approval", "settlement_pending", "rejected", "settled", "sync_exception", "hold_exception", "reversal_required"];

export default function ConsoleClaims() {
  return <Guard console allow={(actor) => actor.roles.some((role) => ["admin", "finance", "approver"].includes(role))}>{() => <Body />}</Guard>;
}

function Body() {
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [month, setMonth] = useState("");
  const [claims, setClaims] = useState<Claim[]>([]);
  const [error, setError] = useState("");
  function load(next = { status, q, month }) {
    const params = new URLSearchParams();
    if (next.status) params.set("status", next.status);
    if (next.q) params.set("q", next.q);
    if (next.month) params.set("month", next.month);
    api<{ claims: Claim[] }>(`/api/console/claims?${params.toString()}`).then((data) => setClaims(data.claims)).catch((reason: Error) => setError(reason.message));
  }
  useEffect(() => {
    api<{ claims: Claim[] }>("/api/console/claims").then((data) => setClaims(data.claims)).catch((reason: Error) => setError(reason.message));
  }, []);
  async function download() {
    const response = await fetch("/api/console/claims/export", { headers: { "x-mileage-client": "1" } });
    if (!response.ok) {
      setError("导出失败");
      return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "claims.csv";
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">申请与审批</h1>
        <Button variant="outline" onClick={download}>导出</Button>
      </div>
      <div className="mt-4 grid gap-2 md:grid-cols-[180px_1fr_160px_auto]">
        <select className="h-11 rounded-2xl border border-[#d7e2ef] bg-white px-3" value={status} onChange={(event) => setStatus(event.target.value)}>
          {statuses.map((item) => <option key={item || "all"} value={item}>{item || "全部状态"}</option>)}
        </select>
        <Input placeholder="单号、姓名或事由" value={q} onChange={(event) => setQ(event.target.value)} />
        <Input type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
        <Button onClick={() => load()}>筛选</Button>
      </div>
      {error ? <p className="mt-3 text-sm text-[#e11d48]">{error}</p> : null}
      <div className="mt-4 overflow-hidden rounded-[28px] bg-white shadow-sm">
        {claims.length === 0 ? <p className="p-5 text-sm text-[#5d6d84]">没有符合条件的申请。</p> : null}
        {claims.map((claim) => (
          <Link key={claim.id} href={`/console/claims/${claim.id}`} className="grid gap-1 border-t border-[#eef3f8] px-4 py-3 md:grid-cols-[1.3fr_1fr_0.8fr_0.8fr] md:items-center">
            <span className="font-medium">{claim.number} · {claim.employeeName}</span>
            <span>{claim.distanceLabel} km / {money(claim.amountFen)}</span>
            <span className={statusTone(claim.status)}>{claim.statusLabel}</span>
            <span className="text-[#2563eb]">{claim.nextAction}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
