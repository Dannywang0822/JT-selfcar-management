"use client";

import { useParams } from "next/navigation";
import { ClaimScreen } from "@/components/claim-screen";
import { Guard } from "@/components/shells";

export default function ConsoleClaimDetail() {
  const params = useParams<{ id: string }>();
  return (
    <Guard console allow={(actor) => actor.roles.some((role) => ["admin", "finance", "approver", "employee"].includes(role))}>
      {() => <ClaimScreen id={params.id} back="/console/claims" />}
    </Guard>
  );
}
