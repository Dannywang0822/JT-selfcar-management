import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "私车公用 · 里程补贴",
  description: "从行程到结算的企业里程补贴测试版。独立于原 WorkBuddy 站点，未接通飞书生产审批。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
