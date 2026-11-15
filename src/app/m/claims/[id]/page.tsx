"use client";

import { useParams } from "next/navigation";
import { ClaimScreen } from "@/components/claim-screen";
import { Guard } from "@/components/shells";

export default function MobileClaimDetail() {
  const params = useParams<{ id: string }>();
  return <Guard allow={(actor) => actor.roles.includes("employee") || actor.roles.includes("approver")}>{() => <ClaimScreen id={params.id} back="/m/claims" />}</Guard>;
}
