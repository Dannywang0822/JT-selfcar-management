"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type Claim } from "@/components/api";
import { money, statusTone } from "@/components/format";
import { Guard } from "@/components/shells";
import { Badge } from "@/components/ui/badge";

type Summary = {
  monthLabel: string;
  inApprovalCount: number;
  canSeeFinance: boolean;
  financeAmountFen: number;
  financeCount: number;
  settledAmountFen: number;
  preview: Claim[];
};

export default function ConsoleHome() {
  return <Guard console allow={(actor) => actor.roles.some((role) => ["admin", "finance", "approver"].includes(role))}>{(actor) => <Body name={actor.name} admin={actor.roles.includes("admin")} demo={actor.isDemo} />}</Guard>;
}

function Body({ name, admin, demo }: { name: string; admin: boolean; demo: boolean }) {
  const [data, setData] = useState<Summary | null>(null);
  const [health, setHealth] = useState<{ feishuOauth: { status: string }; oa: { status: string } } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<Summary>("/api/console/summary").then(setData).catch((reason: Error) => setError(reason.message));
    if (admin) api<typeof health>("/api/integration/health").then(setHealth).catch(() => setHealth(null));
  }, [admin]);
  if (error) return <p className="text-[#e11d48]">{error}</p>;
  if (!data) return <p className="text-[#5d6d84]">正在汇总工作台…</p>;
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold">工作台</h1>
          <p className="mt-2 text-[#5d6d84]">申请、审批、结算，一条链路清晰追踪</p>
        </div>
        {demo ? <Badge>演示数据</Badge> : <Badge className="bg-[#e8eef8] text-[#1d4e89]">真实模式 · 未接通</Badge>}
      </div>
      <section className="mt-5 grid gap-3 lg:grid-cols-3">
        <Card title="审批中" value={`${data.inApprovalCount} 笔`} note="待指定审批人处理" />
        <Card title="财务待结算" value={data.canSeeFinance ? money(data.financeAmountFen) : "仅财务可见"} note={data.canSeeFinance ? `${data.financeCount} 笔已通过申请` : "审批人不能查看结算金额"} />
        <Card title={`${data.monthLabel}已结算`} value={data.canSeeFinance ? money(data.settledAmountFen) : "仅财务可见"} note={data.canSeeFinance ? "确认结算，不是自动付款" : "管理员或财务登录后显示"} />
      </section>
      <section className="mt-5 rounded-[28px] bg-white p-4 shadow-sm md:p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">申请与审批</h2>
          <Link className="text-sm text-[#2563eb]" href="/console/claims">查看全部</Link>
        </div>
        <div className="mt-4 hidden grid-cols-[1.4fr_1fr_0.8fr_0.8fr] gap-3 rounded-2xl bg-[#f4f7fb] px-3 py-2 text-sm text-[#5d6d84] md:grid">
          <span>申请单 / 人员</span><span>里程 / 金额</span><span>审批状态</span><span>下一步</span>
        </div>
        <div className="divide-y divide-[#eef3f8]">
          {data.preview.map((claim) => (
            <Link key={claim.id} href={`/console/claims/${claim.id}`} className="grid gap-1 py-3 md:grid-cols-[1.4fr_1fr_0.8fr_0.8fr] md:items-center">
              <span><span className="block font-medium">{claim.number} · {claim.employeeName}</span><span className="text-xs text-[#7b8da3] md:hidden">{claim.distanceLabel} km / {money(claim.amountFen)}</span></span>
              <span className="hidden md:block">{claim.distanceLabel} km / {money(claim.amountFen)}</span>
              <span className={statusTone(claim.status)}>{claim.statusLabel}</span>
              <span className="text-[#2563eb]">{claim.nextAction}</span>
            </Link>
          ))}
        </div>
      </section>
      {admin && health ? (
        <section className="mt-5 rounded-[28px] bg-white p-5 shadow-sm">
          <h2 className="font-semibold">集成健康</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            <Badge>飞书 · {health.feishuOauth.status}</Badge>
            <Badge>OA · {health.oa.status}</Badge>
          </div>
          <p className="mt-3 text-sm text-[#5d6d84]">登录与审批尚未连接。配置需管理员在部署机密中提供，密钥只留在服务端，本页不回显。</p>
        </section>
      ) : null}
      <p className="mt-5 text-sm text-[#5d6d84]">建议流程：记录行程 → 提交申请 → 权威审批 → 财务核对 → 确认结算。{demo ? "当前人员、金额和单据来自演示库。" : "生产库不会自动灌入演示单据。"}</p>
      <p className="mt-1 text-xs text-[#7b8da3]">当前身份：{name}</p>
    </div>
  );
}

function Card({ title, value, note }: { title: string; value: string; note: string }) {
  return <article className="rounded-[28px] bg-white p-5 shadow-sm"><div className="text-sm text-[#5d6d84]">{title}</div><div className="mt-2 text-3xl font-semibold">{value}</div><div className="mt-2 text-sm text-[#7b8da3]">{note}</div></article>;
}
