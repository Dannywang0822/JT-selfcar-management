"use client";

import { useEffect, useState } from "react";
import { api } from "@/components/api";
import { Guard } from "@/components/shells";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Rate = {
  id: string;
  name: string;
  quarterLabel: string;
  baselinePriceLabel: string;
  previousPriceLabel: string;
  currentPriceLabel: string;
  baselineRateLabel: string;
  rateLabel: string;
  steps: number;
  roundingLabel: string;
  policyLabel: string;
  effectiveFrom: string;
  effectiveTo: string;
  regionNote: string;
  sourceNote: string;
  notes: string;
};

export default function RatesPage() {
  return <Guard console allow={(actor) => actor.roles.includes("admin") || actor.roles.includes("finance")}>{(actor) => <Body canEdit={actor.roles.includes("admin")} />}</Guard>;
}

function Body({ canEdit }: { canEdit: boolean }) {
  const [rates, setRates] = useState<Rate[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  function load() {
    api<{ rates: Rate[] }>("/api/console/rates").then((data) => setRates(data.rates)).catch((reason: Error) => setError(reason.message));
  }
  useEffect(load, []);
  async function create(form: FormData) {
    setError("");
    setMessage("");
    try {
      await api("/api/console/rates", {
        method: "POST",
        body: JSON.stringify({
          name: String(form.get("name")),
          baselinePriceYuan: String(form.get("baselinePriceYuan")),
          previousPriceYuan: String(form.get("previousPriceYuan")),
          currentPriceYuan: String(form.get("currentPriceYuan")),
          baselineRateYuan: String(form.get("baselineRateYuan")),
          effectiveFrom: String(form.get("effectiveFrom")),
          effectiveTo: String(form.get("effectiveTo")),
          regionNote: String(form.get("regionNote")),
          sourceNote: String(form.get("sourceNote")),
          notes: String(form.get("notes")),
        }),
      });
      setMessage("已新增版本。旧申请仍使用提交时的快照。");
      load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    }
  }
  return (
    <div>
      <h1 className="text-2xl font-semibold">季度油价与费率</h1>
      <div className="mt-3 rounded-[28px] bg-white p-5 text-sm leading-6 text-[#4b6078] shadow-sm">
        <Badge>待确认规则</Badge>
        <p className="mt-3">已观察到的规则：季度 92 号汽油价格相对上一季度，每变化 0.50 元/升，补贴同向调整 0.05 元/公里；不足 0.50 元/升不调整。</p>
        <p className="mt-2">尚未确认、因此不作为正式政策的部分：基准油价、基准费率、地区、油价来源、季度生效日、涨跌上下限，以及跨季度行程是否拆分。演示取整采用向零取整，只为把规则算清楚。</p>
      </div>
      <div className="mt-4 space-y-3">
        {rates.map((rate) => (
          <article key={rate.id} className="rounded-[28px] bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold">{rate.name}</h2><Badge>{rate.policyLabel}</Badge></div>
            <p className="mt-2 text-sm text-[#5d6d84]">{rate.effectiveFrom} 至 {rate.effectiveTo} · {rate.quarterLabel}</p>
            <p className="mt-2 text-sm">基准价 {rate.baselinePriceLabel}，上季 {rate.previousPriceLabel}，本季 {rate.currentPriceLabel}</p>
            <p className="mt-1 text-sm">基准费率 {rate.baselineRateLabel}，调整 {rate.steps} 档，当前 {rate.rateLabel}</p>
            <p className="mt-1 text-xs text-[#7b8da3]">{rate.roundingLabel}。{rate.regionNote} {rate.sourceNote}</p>
            <p className="mt-2 text-sm">{rate.notes}</p>
          </article>
        ))}
      </div>
      {canEdit ? (
        <form className="mt-5 grid gap-3 rounded-[28px] bg-white p-5 shadow-sm md:grid-cols-2" action={(form) => create(form)}>
          <h2 className="md:col-span-2 font-semibold">新增版本</h2>
          <Text name="name" label="名称" />
          <Text name="baselineRateYuan" label="基准费率（元/公里）" placeholder="1.20" />
          <Text name="baselinePriceYuan" label="基准油价（元/升）" placeholder="7.50" />
          <Text name="previousPriceYuan" label="上季度油价" placeholder="7.50" />
          <Text name="currentPriceYuan" label="本季度油价" placeholder="8.00" />
          <Text name="effectiveFrom" label="生效开始" type="date" />
          <Text name="effectiveTo" label="生效结束" type="date" />
          <Text name="regionNote" label="地区" placeholder="待确认" />
          <div className="md:col-span-2"><Label htmlFor="sourceNote">油价来源</Label><Input id="sourceNote" name="sourceNote" required placeholder="待确认，不要填成已经接入的数据源" /></div>
          <div className="md:col-span-2"><Label htmlFor="notes">说明</Label><Input id="notes" name="notes" required placeholder="写明这是企业确认值，还是仍待确认" /></div>
          <Button className="md:col-span-2" type="submit">保存新版本</Button>
        </form>
      ) : <p className="mt-4 text-sm text-[#5d6d84]">财务可以查看费率，不能修改。</p>}
      {message ? <p className="mt-3 text-sm text-[#047857]">{message}</p> : null}
      {error ? <p className="mt-3 text-sm text-[#e11d48]">{error}</p> : null}
    </div>
  );
}

function Text({ name, label, type = "text", placeholder }: { name: string; label: string; type?: string; placeholder?: string }) {
  return <div><Label htmlFor={name}>{label}</Label><Input id={name} name={name} type={type} required placeholder={placeholder} /></div>;
}
