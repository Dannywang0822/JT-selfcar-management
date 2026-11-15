"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

function LoginBody() {
  const params = useSearchParams();
  const denied = params.get("error") === "denied";
  return (
    <main className="mx-auto max-w-lg px-4 py-16">
      <div className="rounded-[28px] bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold">飞书登录</h1>
        <p className="mt-3 text-sm leading-6 text-[#5d6d84]">
          {denied ? "你拒绝了授权，没有建立会话。" : "登录必须由服务端用一次性授权码换取用户身份，并核对 tenant_key。工号和姓名不能当作登录凭据。"}
        </p>
        <p className="mt-3 text-sm leading-6 text-[#5d6d84]">当前测试版没有企业应用凭据。未配置时不会跳到飞书，也不会注册账号。</p>
        <Link className="mt-6 inline-block text-[#2563eb]" href="/">返回首页</Link>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return <Suspense><LoginBody /></Suspense>;
}
