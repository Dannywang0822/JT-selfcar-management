"use client";

import { ClaimList } from "@/components/claim-list";
import { Guard } from "@/components/shells";

export default function ClaimsPage() {
  return <Guard allow={(actor) => actor.roles.includes("employee")}>{() => <ClaimList hrefBase="/m/claims" />}</Guard>;
}
