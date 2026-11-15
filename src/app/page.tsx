"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/components/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const personas = [
  ["zhang", "张示例", "员工，记录行程并申请"],
  ["zhou", "周示例", "审批人，只处理分配给自己的演示单"],
  ["zhao", "赵示例", "财务，核对已通过单据"],
  ["chen", "陈示例", "管理员，不管自动获得付款权"],
] as const;

export default function HomePage() {
  const router = useRouter();
  const [info, setInfo] = useState<{ mode: string; demoAvailable: boolean; feishuLoginReady: boolean; missingOauth: string[] } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<typeof info>("/api/bootstrap").then(setInfo).catch((reason: Error) => setError(reason.message));
  }, []);

  async function enter(persona: string) {
    setError("");
    try {
      await api("/api/demo/enter", { method: "POST", body: JSON.stringify({ persona }) });
      router.push("/home");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "进入失败");
    }
  }

  return (
    <main className="mx-auto min-h-screen max-w-6xl px-4 py-8 md:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-sm text-[#5d6d84]">独立测试版 · 不是 WorkBuddy 升级</div>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">私车公用 · 里程补贴</h1>
          <p className="mt-3 max-w-2xl text-[#4b6078]">从行程到结算，让每一笔补贴有据可查。正式链路是记录行程、提交申请、飞书审批、财务核对、确认结算。首期不自动付款。</p>
        </div>
        <Badge>设计已落地为可点击测试版</Badge>
      </div>
      <section className="mt-8 grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-[28px] bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold">建议流程</h2>
          <ol className="mt-4 grid gap-3 text-sm md:grid-cols-5">
            {["记录行程", "提交申请", "飞书审批", "财务核对", "确认结算"].map((item, index) => (
              <li key={item} className="rounded-2xl bg-[#f4f7fb] px-3 py-4">
                <div className="text-xs text-[#7b8da3]">0{index + 1}</div>
                <div className="mt-1 font-medium">{item}</div>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-sm leading-6 text-[#5d6d84]">飞书是唯一活动审批提供商。OA 只有禁用的适配器契约，不会发单。没有地图服务配置时，不显示智能导航。浏览器定位不能保证后台持续记录，也不能防篡改。演示巡航不能进入报销。</p>
        </div>
        <div className="rounded-[28px] bg-[#0f2744] p-6 text-white">
          <h2 className="text-lg font-semibold">进入方式</h2>
          <p className="mt-2 text-sm text-[#c5d4e6]">不使用工号建档登录。生产身份来自服务端飞书 OAuth 和租户校验，角色由名册映射，不能在页面上自选。</p>
          <Button className="mt-4 w-full" variant="outline" disabled={!info?.feishuLoginReady} onClick={() => { window.location.href = "/api/auth/feishu/start"; }}>
            {info?.feishuLoginReady ? "使用飞书登录" : "飞书登录未配置"}
          </Button>
          {info && !info.feishuLoginReady ? <p className="mt-2 text-xs text-[#9fb0c6]">缺少 {info.missingOauth.join("、") || "部署配置"}。此按钮不会发起真实授权。</p> : null}
        </div>
      </section>
      {info?.demoAvailable ? (
        <section className="mt-6 rounded-[28px] bg-white p-6 shadow-sm">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">演示身份</h2>
            <Badge>非生产</Badge>
          </div>
          <p className="mt-2 text-sm text-[#5d6d84]">以下人员、金额和单据都是演示种子。切换身份不会获得生产权限。</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {personas.map(([id, name, desc]) => (
              <button key={id} className="rounded-3xl border border-[#e3ebf4] p-4 text-left hover:border-[#2563eb]" onClick={() => enter(id)}>
                <div className="font-medium">{name}</div>
                <div className="mt-1 text-sm text-[#5d6d84]">{desc}</div>
              </button>
            ))}
          </div>
        </section>
      ) : null}
      {error ? <p className="mt-4 text-sm text-[#e11d48]">{error}</p> : null}
    </main>
  );
}
