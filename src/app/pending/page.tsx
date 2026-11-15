"use client";

import { api } from "@/components/api";
import { useActor } from "@/components/shells";
import { Button } from "@/components/ui/button";

export default function PendingPage() {
  const { actor } = useActor();
  return (
    <main className="mx-auto max-w-lg px-4 py-16">
      <div className="rounded-[28px] bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold">已验证飞书身份</h1>
        <p className="mt-3 text-sm leading-6 text-[#5d6d84]">
          {actor?.name || "当前用户"} 已通过租户校验，但还没有被管理员列入名册。首次登录不会自动变成员工或管理员。
        </p>
        <p className="mt-2 text-sm text-[#5d6d84]">身份标识：{actor?.openIdMasked || "未显示"}。密钥和 token 不会出现在这个页面。</p>
        <Button className="mt-6" variant="outline" onClick={() => api("/api/auth/logout", { method: "POST" }).then(() => { window.location.href = "/"; })}>退出</Button>
      </div>
    </main>
  );
}
