"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type Claim } from "./api";
import { money, statusTone } from "./format";

export function ClaimList({ hrefBase }: { hrefBase: string }) {
  const [claims, setClaims] = useState<Claim[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ claims: Claim[] }>("/api/claims").then((data) => setClaims(data.claims)).catch((reason: Error) => setError(reason.message));
  }, []);
  if (error) return <p className="text-[#e11d48]">{error}</p>;
  if (!claims) return <p className="text-[#5d6d84]">正在读取申请…</p>;
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">申请</h1>
      {claims.length === 0 ? <p className="rounded-3xl bg-white p-4 text-sm text-[#5d6d84]">还没有申请。</p> : null}
      {claims.map((claim) => (
        <Link key={claim.id} href={`${hrefBase}/${claim.id}`} className="block rounded-3xl bg-white p-4 shadow-sm">
          <div className="font-medium">{claim.number}</div>
          <div className="mt-1 text-sm text-[#5d6d84]">{claim.distanceLabel} km / {money(claim.amountFen)}</div>
          <div className={`mt-2 text-sm ${statusTone(claim.status)}`}>{claim.statusLabel} · {claim.nextAction}</div>
        </Link>
      ))}
    </div>
  );
}
