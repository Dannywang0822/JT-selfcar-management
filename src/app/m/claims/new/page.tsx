"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, type Claim, type Trip } from "@/components/api";
import { Guard } from "@/components/shells";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

export default function NewClaimPage() {
  return <Guard allow={(actor) => actor.roles.includes("employee")}>{() => <Body />}</Guard>;
}

function Body() {
  const router = useRouter();
  const [trips, setTrips] = useState<Trip[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [purpose, setPurpose] = useState("本月里程补贴");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ trips: Trip[] }>("/api/trips").then((data) => setTrips(data.trips.filter((trip) => trip.eligible && !trip.occupied))).catch((reason: Error) => setError(reason.message));
  }, []);

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const claim = await api<Claim>("/api/claims", { method: "POST", body: JSON.stringify({ tripIds: picked, purpose }) });
      const key = idempotency(claim.id);
      await api(`/api/claims/${claim.id}/submit`, { method: "POST", headers: { "idempotency-key": key } });
      router.push(`/m/claims/${claim.id}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "提交失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1 className="text-xl font-semibold">发起申请</h1>
      <p className="mt-2 text-sm text-[#5d6d84]">金额由服务端按冻结的费率和行程计算。演示巡航不会出现在这里。</p>
      <div className="mt-4">
        <Label htmlFor="purpose">说明</Label>
        <input id="purpose" className="h-11 w-full rounded-2xl border border-[#d7e2ef] px-3" value={purpose} onChange={(event) => setPurpose(event.target.value)} />
      </div>
      <div className="mt-4 space-y-2">
        {trips.length === 0 ? <p className="rounded-3xl bg-white p-4 text-sm text-[#5d6d84]">没有可申请的行程。</p> : null}
        {trips.map((trip) => (
          <label key={trip.id} className="flex gap-3 rounded-3xl bg-white p-4 shadow-sm">
            <input type="checkbox" checked={picked.includes(trip.id)} onChange={(event) => setPicked((current) => event.target.checked ? [...current, trip.id] : current.filter((id) => id !== trip.id))} />
            <span>
              <span className="block font-medium">{trip.purpose} · {trip.distanceLabel} km</span>
              <span className="text-xs text-[#7b8da3]">{trip.sourceLabel} · {trip.startedAt}</span>
            </span>
          </label>
        ))}
      </div>
      <Button className="mt-4" disabled={busy || picked.length === 0} onClick={submit}>提交申请</Button>
      {error ? <p className="mt-3 text-sm text-[#e11d48]">{error}</p> : null}
    </div>
  );
}

function idempotency(claimId: string) {
  const key = `idem-${claimId}`;
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;
  const fresh = crypto.randomUUID();
  sessionStorage.setItem(key, fresh);
  return fresh;
}
