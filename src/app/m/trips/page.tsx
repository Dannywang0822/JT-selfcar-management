"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type Trip } from "@/components/api";
import { Guard } from "@/components/shells";
import { Button } from "@/components/ui/button";

export default function TripsPage() {
  return <Guard allow={(actor) => actor.roles.includes("employee")}>{() => <Body />}</Guard>;
}

function Body() {
  const [trips, setTrips] = useState<Trip[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ trips: Trip[] }>("/api/trips").then((data) => setTrips(data.trips)).catch((reason: Error) => setError(reason.message));
  }, []);
  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">行程</h1>
        <Button asChild size="sm"><Link href="/m/trips/new">记录</Link></Button>
      </div>
      {error ? <p className="mt-4 text-[#e11d48]">{error}</p> : null}
      {!trips ? <p className="mt-4 text-[#5d6d84]">正在读取行程…</p> : null}
      <div className="mt-4 space-y-3">
        {trips?.length === 0 ? <p className="rounded-3xl bg-white p-4 text-sm text-[#5d6d84]">还没有行程。定位记录需要你授权，离开页面后不会在后台继续记。</p> : null}
        {trips?.map((trip) => (
          <article key={trip.id} className="rounded-3xl bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-medium">{trip.purpose}</h2>
              <span className="text-sm text-[#2563eb]">{trip.distanceLabel} km</span>
            </div>
            <p className="mt-1 text-sm text-[#5d6d84]">{trip.origin} → {trip.destination}</p>
            <p className="mt-2 text-xs text-[#7b8da3]">{trip.startedAt} 至 {trip.endedAt} · {trip.sourceLabel} · {trip.trustLabel}</p>
            <p className="mt-1 text-xs text-[#7b8da3]">{trip.occupied ? "已占用" : trip.eligible ? "可申请" : "不可申请"}{trip.evidenceNote ? ` · ${trip.evidenceNote}` : ""}</p>
          </article>
        ))}
      </div>
    </div>
  );
}
