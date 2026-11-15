"use client";

import { useEffect, useState } from "react";
import { api } from "@/components/api";
import { Guard } from "@/components/shells";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type Health = {
  mode: string;
  connected: boolean;
  feishuOauth: { status: string; missing: string[] };
  feishuApproval: { status: string; missing: string[] };
  feishuEvents: { status: string; missing: string[] };
  oa: { status: string; note: string };
  map: { status: string; note: string };
  message: { status: string; note: string };
  lastCheck: { at: string | null; message: string };
  secretsDisplayed: boolean;
};

export default function IntegrationPage() {
  return <Guard console allow={(actor) => actor.roles.includes("admin")}>{() => <Body />}</Guard>;
}

function Body() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  useEffect(() => {
    api<Health>("/api/integration/health").then(setHealth).catch((reason: Error) => setError(reason.message));
  }, []);
  async function reconcile() {
    setError("");
    try {
      const data = await api<{ liveCall: boolean; results: unknown[] }>("/api/integration/reconcile", { method: "POST" });
      setResult(data.liveCall ? `已对真实飞书发起补偿查询，处理 ${data.results.length} 条。` : `演示对账完成，处理 ${data.results.length} 条，没有访问飞书。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "对账失败");
    }
  }
  if (!health) return <p className="text-[#5d6d84]">{error || "正在读取集成状态…"}</p>;
  return (
    <div>
      <h1 className="text-2xl font-semibold">集成设置</h1>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-[#5d6d84]">这里只显示配置是否齐全，不显示、不接收、不回写任何密钥。真实 App、审批模板、租户、回调域名都还没有提供，所以状态保持未配置或待联调，不会显示已接通。</p>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <Panel title="飞书登录" status={health.feishuOauth.status} missing={health.feishuOauth.missing} note="服务端 OAuth。授权码只使用一次，并校验 tenant_key。tenant_access_token 不能代替用户登录。" />
        <Panel title="飞书审批" status={health.feishuApproval.status} missing={health.feishuApproval.missing} note="创建实例使用固定 uuid。超时用原 uuid 重试；60012 只进入对账，不当作新单成功。" />
        <Panel title="事件订阅" status={health.feishuEvents.status} missing={health.feishuEvents.missing} note="先验签再解密。approval_instance 用事件顶层 uuid 去重。签名不通过不会改单据。" />
        <Panel title="OA" status={health.oa.status} missing={[]} note={health.oa.note} />
        <Panel title="地图" status={health.map.status} missing={[]} note={health.map.note} />
        <Panel title="消息" status={health.message.status} missing={[]} note={health.message.note} />
      </div>
      <section className="mt-5 rounded-[28px] bg-white p-5 text-sm leading-6 text-[#4b6078] shadow-sm">
        <h2 className="font-semibold">企业联调时要做的事</h2>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>在飞书开发者后台创建企业自建应用，开通审批权限。原生接入指南写明的 scope 键是 approval:approval；创建实例还接受“原生审批实例”权限，其独立英文键以后台名称为准。</li>
          <li>安全设置里登记精确的 https 回调，和 FEISHU_REDIRECT_URI 一致。</li>
          <li>事件与回调选择“发送到开发者服务器”，地址为部署域名下的 /api/feishu/events，并配置 Encrypt Key 与 Verification Token。</li>
          <li>订阅 approval_instance 后，再调用订阅审批事件接口，路径以专页为准：POST /open-apis/approval/v4/approvals/:approval_code/subscribe。1390007 表示已经订阅过。</li>
          <li>审批模板使用单行文本控件，自定义 ID 填到四个 FEISHU_WIDGET_* 。本测试版不会猜测金额控件的 JSON。</li>
          <li>管理员把已登录用户的 open_id 映射到名册，并单独授予财务或审批角色。</li>
        </ol>
        <p className="mt-3">最近校验：{health.lastCheck.at ? health.lastCheck.message : "从未向飞书发起校验请求"}。connected={String(health.connected)}，secretsDisplayed={String(health.secretsDisplayed)}。</p>
        <Button className="mt-3" variant="outline" onClick={reconcile}>执行补偿对账</Button>
        {result ? <p className="mt-2">{result}</p> : null}
      </section>
      {error ? <p className="mt-3 text-sm text-[#e11d48]">{error}</p> : null}
    </div>
  );
}

function Panel({ title, status, missing, note }: { title: string; status: string; missing: string[]; note: string }) {
  return (
    <article className="rounded-[28px] bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-2"><h2 className="font-semibold">{title}</h2><Badge>{status}</Badge></div>
      <p className="mt-2 text-sm leading-6 text-[#5d6d84]">{note}</p>
      {missing.length ? <p className="mt-2 text-xs text-[#a16207]">缺少 {missing.join("、")}</p> : null}
    </article>
  );
}
