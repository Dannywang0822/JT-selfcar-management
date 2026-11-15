"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, type Actor } from "./api";
import { Badge } from "./ui/badge";

const personas = [
  ["zhang", "张示例 · 员工"],
  ["li", "李示例 · 员工"],
  ["wang", "王示例 · 员工"],
  ["zhou", "周示例 · 审批人"],
  ["zhao", "赵示例 · 财务"],
  ["chen", "陈示例 · 管理员"],
] as const;

export function useActor() {
  const [actor, setActor] = useState<Actor | null | undefined>(undefined);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ actor: Actor | null }>("/api/session")
      .then((data) => setActor(data.actor))
      .catch((reason: Error) => setError(reason.message));
  }, []);
  return { actor, error };
}

export function DemoBanner({ actor }: { actor: Actor }) {
  const router = useRouter();
  if (!actor.isDemo) return null;
  return (
    <div className="demo-banner border-b border-[#efd7a4] bg-[#fff7e8] px-4 py-2 text-sm text-[#7a5414]">
      <div className="mx-auto flex max-w-[1440px] flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <strong>演示模式</strong>
          <span className="extra ml-2">种子数据和角色切换只用于非生产验收，不会调用飞书或 OA。</span>
        </div>
        <label className="flex items-center gap-2">
          <span className="shrink-0">切换演示身份</span>
          <select
            className="h-9 rounded-full border border-[#efd7a4] bg-white px-3"
            defaultValue=""
            onChange={async (event) => {
              const persona = event.target.value;
              if (!persona) return;
              await api("/api/demo/enter", { method: "POST", body: JSON.stringify({ persona }) });
              router.push("/home");
              router.refresh();
            }}
          >
            <option value="">当前：{actor.name}</option>
            {personas.map(([id, label]) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

const consoleNav = [
  ["/console", "总览工作台"],
  ["/console/claims", "申请与审批"],
  ["/console/settlements", "财务结算"],
  ["/console/ledger", "行程台账"],
  ["/console/people", "人员与权限"],
  ["/console/rates", "费率与油价"],
  ["/console/integration", "集成设置"],
];

export function ConsoleShell({ actor, children }: { actor: Actor; children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="min-h-screen">
      <DemoBanner actor={actor} />
      <div className="mx-auto flex max-w-[1440px] flex-col gap-4 px-3 py-3 md:flex-row md:px-5 md:py-5">
        <aside className="rounded-[28px] bg-[#0f2744] p-4 text-white md:sticky md:top-4 md:h-[calc(100vh-2rem)] md:w-[232px] md:shrink-0">
          <div className="px-2 pb-5">
            <div className="text-lg font-semibold">私车公用</div>
            <div className="mt-1 text-xs text-[#9fb0c6]">企业费用工作台</div>
          </div>
          <nav className="flex gap-2 overflow-auto md:block md:space-y-1">
            {consoleNav.map(([href, label]) => {
              const active = pathname === href;
              return (
                <Link key={href} href={href} className={`block whitespace-nowrap rounded-2xl px-3 py-2.5 text-sm ${active ? "bg-[#1d4e89]" : "text-[#c5d2e2] hover:bg-white/5"}`}>
                  {label}
                </Link>
              );
            })}
          </nav>
          <div className="mt-6 hidden px-2 text-xs text-[#9fb0c6] md:block">
            <div className="text-sm text-white">{actor.name}</div>
            <div className="mt-1">{actor.isDemo ? "演示身份 · 权限按角色隔离" : actor.roles.join(" / ")}</div>
            {actor.roles.includes("employee") ? <Link className="mt-3 inline-block text-[#9cc4ff]" href="/m">打开员工端</Link> : null}
          </div>
        </aside>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}

const mobileNav = [
  ["/m/trips", "行程"],
  ["/m/claims", "申请"],
  ["/m/progress", "进度"],
  ["/m/me", "我的"],
];

export function MobileShell({ actor, children }: { actor: Actor; children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="min-h-screen xl:flex xl:justify-center xl:py-8">
      <div className="mx-auto flex min-h-screen w-full max-w-[860px] flex-col bg-[#f4f7fb] md:max-w-[860px] xl:min-h-[820px] xl:max-w-[390px] xl:overflow-hidden xl:rounded-[36px] xl:border-[10px] xl:border-[#0f2744] xl:shadow-2xl">
        <DemoBanner actor={actor} />
        <header className="flex items-center justify-between px-4 py-4">
          <Link href="/m" className="text-lg font-semibold">私车公用</Link>
          {actor.isDemo ? <Badge>演示数据</Badge> : <Badge className="bg-[#e8eef8] text-[#1d4e89]">{actor.mode}</Badge>}
        </header>
        <main className="mobile-main flex-1 px-4 pb-24">{children}</main>
        <nav className="sticky bottom-0 grid grid-cols-4 border-t border-[#e5edf5] bg-white/95 px-2 py-2 backdrop-blur">
          {mobileNav.map(([href, label]) => (
            <Link key={href} href={href} className={`rounded-2xl py-2 text-center text-sm ${pathname.startsWith(href) ? "bg-[#e8f0ff] font-medium text-[#1d4ed8]" : "text-[#64748b]"}`}>
              {label}
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}

export function Guard({ allow, children, console = false }: { allow: (actor: Actor) => boolean; children: (actor: Actor) => React.ReactNode; console?: boolean }) {
  const { actor, error } = useActor();
  const router = useRouter();
  useEffect(() => {
    if (actor === null) router.replace("/");
  }, [actor, router]);
  if (error) return <p className="p-8 text-[#e11d48]">{error}</p>;
  if (!actor) return <p className="p-8 text-[#5d6d84]">正在读取登录状态…</p>;
  if (actor.pending) {
    router.replace("/pending");
    return null;
  }
  if (!allow(actor)) return <p className="p-8">当前身份不能打开这个页面。</p>;
  const Shell = console ? ConsoleShell : MobileShell;
  return <Shell actor={actor}>{children(actor)}</Shell>;
}
