"use client";

import { useEffect, useState } from "react";
import { api, type Trip } from "@/components/api";
import { Guard } from "@/components/shells";

export default function LedgerPage() {
  return <Guard console allow={(actor) => actor.roles.includes("admin")}>{() => <Body />}</Guard>;
}

function Body() {
  const [trips, setTrips] = useState<Trip[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ trips: Trip[] }>("/api/console/ledger").then((data) => setTrips(data.trips)).catch((reason: Error) => setError(reason.message));
  }, []);
  return (
    <div>
      <h1 className="text-2xl font-semibold">行程台账</h1>
      <p className="mt-2 text-sm text-[#5d6d84]">台账只给管理员。财务看不到全部行程。定位来源都标为不可信，原始轨迹点不在这个列表展开。</p>
      {error ? <p className="mt-3 text-[#e11d48]">{error}</p> : null}
      {!trips ? <p className="mt-4 text-[#5d6d84]">正在读取台账…</p> : null}
      <div className="mt-4 overflow-hidden rounded-[28px] bg-white shadow-sm">
        {trips?.length === 0 ? <p className="p-5 text-sm text-[#5d6d84]">还没有行程。</p> : null}
        {trips?.slice(0, 40).map((trip) => (
          <article key={trip.id} className="grid gap-1 border-t border-[#eef3f8] px-4 py-3 md:grid-cols-[1fr_1fr_0.6fr_0.8fr]">
            <span className="font-medium">{trip.employeeName} · {trip.purpose}</span>
            <span className="text-sm text-[#5d6d84]">{trip.origin} → {trip.destination}</span>
            <span>{trip.distanceLabel} km</span>
            <span className="text-sm text-[#7b8da3]">{trip.sourceLabel} · {trip.trustLabel}</span>
          </article>
        ))}
      </div>
    </div>
  );
}
