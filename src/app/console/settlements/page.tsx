"use client";

import { useEffect, useState } from "react";
import { api, type Claim } from "@/components/api";
import { money } from "@/components/format";
import { Guard } from "@/components/shells";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Audit = { action: string; comment: string | null; atBeijing?: string; object_id?: string };

export default function SettlementsPage() {
  return <Guard console allow={(actor) => actor.roles.includes("finance") || actor.roles.includes("admin")}>{(actor) => <Body canSettle={actor.roles.includes("finance")} />}</Guard>;
}

function Body({ canSettle }: { canSettle: boolean }) {
  const [claims, setClaims] = useState<Claim[]>([]);
  const [audits, setAudits] = useState<Audit[]>([]);
  const [error, setError] = useState("");
  const [target, setTarget] = useState<Claim | null>(null);
  const [voucher, setVoucher] = useState("DEMO-JS-NEW");
  const [comment, setComment] = useState("财务已核对里程与费率快照，确认结算。此操作不付款。");
  function load() {
    api<{ claims: Claim[] }>("/api/console/claims?status=settlement_pending").then((data) => setClaims(data.claims)).catch((reason: Error) => setError(reason.message));
    api<{ audits: Audit[] }>("/api/console/audits").then((data) => setAudits(data.audits.filter((item) => item.action === "settle" || item.action === "reversal"))).catch(() => setAudits([]));
  }
  useEffect(load, []);
  async function settle() {
    if (!target) return;
    setError("");
    try {
      await api("/api/console/settlements", { method: "POST", body: JSON.stringify({ claimId: target.id, voucherNo: voucher, comment }) });
      setTarget(null);
      load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "结算失败");
    }
  }
  return (
    <div>
      <h1 className="text-2xl font-semibold">财务结算</h1>
      <p className="mt-2 text-sm text-[#5d6d84]">只能结算飞书状态为已通过、且本系统标记为待财务的单据。审批中、驳回、待对账都不能结算。确认后不自动付款。</p>
      <div className="mt-4 space-y-3">
        {claims.length === 0 ? <p className="rounded-[28px] bg-white p-5 text-sm text-[#5d6d84]">当前没有待结算申请。</p> : null}
        {claims.map((claim) => (
          <article key={claim.id} className="rounded-[28px] bg-white p-4 shadow-sm md:flex md:items-center md:justify-between">
            <div>
              <div className="font-medium">{claim.number} · {claim.employeeName}</div>
              <div className="mt-1 text-sm text-[#5d6d84]">{claim.distanceLabel} km / {money(claim.amountFen)} · 外部状态 {claim.externalStatus}</div>
            </div>
            {canSettle ? <Button className="mt-3 md:mt-0" onClick={() => setTarget(claim)}>核对凭证</Button> : <span className="text-sm text-[#7b8da3]">管理员不能直接结算</span>}
          </article>
        ))}
      </div>
      {target ? (
        <div className="mt-4 rounded-[28px] bg-white p-5 shadow-sm">
          <h2 className="font-semibold">确认结算 {target.number}</h2>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <div><Label htmlFor="voucher">凭证号</Label><Input id="voucher" value={voucher} onChange={(event) => setVoucher(event.target.value)} /></div>
            <div><Label htmlFor="comment">核对意见</Label><Input id="comment" value={comment} onChange={(event) => setComment(event.target.value)} /></div>
          </div>
          <div className="mt-4 flex gap-2">
            <Button onClick={settle}>确认结算</Button>
            <Button variant="outline" onClick={() => setTarget(null)}>取消</Button>
          </div>
        </div>
      ) : null}
      {error ? <p className="mt-3 text-sm text-[#e11d48]">{error}</p> : null}
      <section className="mt-6">
        <h2 className="font-semibold">结算审计</h2>
        <div className="mt-3 space-y-2">
          {audits.length === 0 ? <p className="text-sm text-[#5d6d84]">还没有结算审计。</p> : null}
          {audits.map((item, index) => <p key={`${item.atBeijing}-${index}`} className="rounded-2xl bg-white px-4 py-3 text-sm">{item.atBeijing} · {item.comment}</p>)}
        </div>
      </section>
    </div>
  );
}
