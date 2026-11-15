"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type Claim, type Trip } from "./api";
import { money, statusTone } from "./format";
import { Button } from "./ui/button";

type Detail = Claim & { audits: Array<{ action: string; comment: string | null; atBeijing?: string; source: string; to_status: string | null }>; items: Trip[] };

export function ClaimScreen({ id, back }: { id: string; back: string }) {
  const [claim, setClaim] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [comment, setComment] = useState("演示审批意见");
  const [busy, setBusy] = useState(false);

  function load() {
    api<Detail>(`/api/claims/${id}`).then(setClaim).catch((reason: Error) => setError(reason.message));
  }
  useEffect(load, [id]);

  async function decide(decision: "APPROVED" | "REJECTED") {
    setBusy(true);
    setError("");
    try {
      await api(`/api/demo/claims/${id}/decide`, { method: "POST", body: JSON.stringify({ decision, comment }) });
      load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    const storageKey = `idem-${id}`;
    const key = sessionStorage.getItem(storageKey) || crypto.randomUUID();
    sessionStorage.setItem(storageKey, key);
    setBusy(true);
    try {
      await api(`/api/claims/${id}/submit`, { method: "POST", headers: { "idempotency-key": key } });
      load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "重试失败");
    } finally {
      setBusy(false);
    }
  }

  if (error && !claim) return <p className="text-[#e11d48]">{error}</p>;
  if (!claim) return <p className="text-[#5d6d84]">正在读取申请…</p>;
  return (
    <div className="rounded-[28px] bg-white p-5 shadow-sm">
      <Link className="text-sm text-[#2563eb]" href={back}>返回</Link>
      <h1 className="mt-2 text-xl font-semibold">{claim.number}</h1>
      <p className="mt-1 text-sm text-[#5d6d84]">{claim.employeeName} · {claim.purpose}</p>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <Info label="里程" value={`${claim.distanceLabel} km`} />
        <Info label="金额" value={money(claim.amountFen)} />
        <Info label="费率快照" value={claim.rateLabel} />
        <Info label="状态" value={claim.statusLabel} tone={statusTone(claim.status)} />
      </div>
      <p className="mt-3 text-sm text-[#5d6d84]">{claim.channelLabel}。审批通过不等于已付款。</p>
      {claim.needsReconcile ? <p className="mt-2 text-sm text-[#a16207]">这张单据等待对账，暂停结算。</p> : null}
      <h2 className="mt-5 font-medium">包含行程</h2>
      <ul className="mt-2 space-y-2 text-sm">
        {claim.items.map((trip) => <li key={trip.id} className="rounded-2xl bg-[#f4f7fb] px-3 py-2">{trip.purpose} · {trip.distanceLabel} km · {trip.sourceLabel}</li>)}
      </ul>
      <h2 className="mt-5 font-medium">轨迹</h2>
      <ol className="mt-2 space-y-2 text-sm text-[#4b6078]">
        {claim.audits.length === 0 ? <li>还没有审核记录。</li> : null}
        {claim.audits.map((item, index) => <li key={`${item.atBeijing}-${index}`}>{item.atBeijing} · {item.comment || item.action}</li>)}
      </ol>
      {claim.status === "submitting" || claim.status === "sync_exception" ? <Button className="mt-4" disabled={busy} onClick={retry}>用原提交键重试</Button> : null}
      {claim.assignedToMe && claim.isDemo && claim.status === "in_approval" ? (
        <div className="mt-4 rounded-3xl bg-[#fff7e8] p-4">
          <div className="text-sm font-medium text-[#8a5a20]">演示审批</div>
          <p className="mt-1 text-xs text-[#8a5a20]">只改变演示库，不会调用飞书。</p>
          <input className="mt-3 h-11 w-full rounded-2xl border border-[#efd7a4] px-3" value={comment} onChange={(event) => setComment(event.target.value)} />
          <div className="mt-3 flex gap-2">
            <Button disabled={busy} onClick={() => decide("APPROVED")}>演示通过</Button>
            <Button disabled={busy} variant="outline" onClick={() => decide("REJECTED")}>演示驳回</Button>
          </div>
        </div>
      ) : null}
      {error ? <p className="mt-3 text-sm text-[#e11d48]">{error}</p> : null}
    </div>
  );
}

function Info({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <div className="rounded-2xl bg-[#f4f7fb] p-3"><div className="text-xs text-[#7b8da3]">{label}</div><div className={`mt-1 font-medium ${tone || ""}`}>{value}</div></div>;
}
