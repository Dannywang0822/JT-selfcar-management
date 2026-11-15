"use client";

import { api } from "@/components/api";
import { Guard } from "@/components/shells";
import { Button } from "@/components/ui/button";

export default function MePage() {
  return (
    <Guard allow={() => true}>
      {(actor) => (
        <div className="rounded-[28px] bg-white p-5 shadow-sm">
          <h1 className="text-xl font-semibold">{actor.name}</h1>
          <p className="mt-2 text-sm text-[#5d6d84]">角色：{actor.roles.join("、") || "无"}</p>
          <p className="mt-1 text-sm text-[#5d6d84]">运行模式：{actor.isDemo ? "演示" : actor.mode}。身份标识 {actor.openIdMasked}。</p>
          <p className="mt-3 text-sm leading-6 text-[#5d6d84]">页面不保存飞书 token、App Secret 或事件密钥。生产环境不会提供角色切换。</p>
          <Button className="mt-5" variant="outline" onClick={() => api("/api/auth/logout", { method: "POST" }).then(() => { window.location.href = "/"; })}>退出</Button>
        </div>
      )}
    </Guard>
  );
}
