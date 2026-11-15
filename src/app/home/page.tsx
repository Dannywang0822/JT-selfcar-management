"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useActor } from "@/components/shells";

export default function HomeRouter() {
  const { actor } = useActor();
  const router = useRouter();
  useEffect(() => {
    if (actor === null) router.replace("/");
    if (!actor) return;
    if (actor.pending) router.replace("/pending");
    else if (actor.roles.some((role) => ["admin", "finance", "approver"].includes(role))) router.replace("/console");
    else router.replace("/m");
  }, [actor, router]);
  return <p className="p-8 text-[#5d6d84]">正在进入工作台…</p>;
}
