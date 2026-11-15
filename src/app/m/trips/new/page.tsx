"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/components/api";
import { Guard } from "@/components/shells";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Point = { lat: number; lng: number; recordedAt: string; accuracyM?: number };

export default function NewTripPage() {
  return <Guard allow={(actor) => actor.roles.includes("employee")}>{() => <Body />}</Guard>;
}

function Body() {
  const router = useRouter();
  const [mode, setMode] = useState<"manual" | "gps">("manual");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [points, setPoints] = useState<Point[]>([]);
  const [watching, setWatching] = useState(false);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!watching) return;
    let watch = 0;
    const stop = () => {
      if (watch) navigator.geolocation.clearWatch(watch);
      setWatching(false);
      setPaused(true);
    };
    const onHide = () => {
      if (document.visibilityState !== "visible") stop();
    };
    document.addEventListener("visibilitychange", onHide);
    watch = navigator.geolocation.watchPosition(
      (position) => {
        setPoints((current) => [
          ...current,
          {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            recordedAt: new Date(position.timestamp).toISOString(),
            accuracyM: position.coords.accuracy,
          },
        ].slice(-500));
      },
      () => setError("没有获得定位授权，或当前环境不提供定位。可以改用人工补录。"),
      { enableHighAccuracy: true, maximumAge: 5000 },
    );
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      if (watch) navigator.geolocation.clearWatch(watch);
    };
  }, [watching]);

  async function submitManual(form: FormData) {
    setBusy(true);
    setError("");
    try {
      await api("/api/trips", {
        method: "POST",
        body: JSON.stringify({
          source: "manual",
          startedAt: String(form.get("startedAt")),
          endedAt: String(form.get("endedAt")),
          distanceKm: String(form.get("distanceKm")),
          purpose: String(form.get("purpose")),
          origin: String(form.get("origin")),
          destination: String(form.get("destination")),
          evidenceNote: String(form.get("evidenceNote") || ""),
        }),
      });
      router.push("/m/trips");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function submitGps(form: FormData) {
    setBusy(true);
    setError("");
    try {
      await api("/api/trips", {
        method: "POST",
        body: JSON.stringify({
          source: "browser_gps",
          purpose: String(form.get("purpose")),
          origin: String(form.get("origin")),
          destination: String(form.get("destination")),
          points,
        }),
      });
      router.push("/m/trips");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function cruise() {
    setBusy(true);
    setError("");
    try {
      await api("/api/trips", { method: "POST", body: JSON.stringify({ source: "demo_cruise" }) });
      router.push("/m/trips");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "演示巡航失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1 className="text-xl font-semibold">记录行程</h1>
      <p className="mt-2 text-sm leading-6 text-[#5d6d84]">浏览器定位需要你当场授权。锁屏、切走或系统回收页面后，不能保证继续记录，轨迹也可以被伪造，不能当作可信里程。未配置地图服务，这里不提供路线导航。</p>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <Button variant={mode === "manual" ? "default" : "outline"} onClick={() => setMode("manual")}>人工补录</Button>
        <Button variant={mode === "gps" ? "default" : "outline"} onClick={() => setMode("gps")}>授权定位</Button>
      </div>
      {mode === "manual" ? (
        <form className="mt-4 space-y-3" action={(form) => submitManual(form)}>
          <Field name="purpose" label="事由" />
          <Field name="origin" label="出发地" />
          <Field name="destination" label="目的地" />
          <Field name="distanceKm" label="里程（公里）" placeholder="12.5" />
          <Field name="startedAt" label="开始（北京时间）" type="datetime-local" />
          <Field name="endedAt" label="结束（北京时间）" type="datetime-local" />
          <div>
            <Label htmlFor="evidenceNote">证据说明</Label>
            <Input id="evidenceNote" name="evidenceNote" placeholder="例如停车票、行程单，仍需审核" />
          </div>
          <Button disabled={busy} type="submit">保存人工补录</Button>
        </form>
      ) : (
        <form className="mt-4 space-y-3" action={(form) => submitGps(form)}>
          <Field name="purpose" label="事由" />
          <Field name="origin" label="出发地" />
          <Field name="destination" label="目的地" />
          <div className="rounded-3xl bg-white p-4 text-sm">
            <div>已采集 {points.length} 个点。{paused ? "页面离开后已停止，未提交的点只留在这次打开的页面里。" : "仅在页面可见时记录。"}</div>
            <Button className="mt-3" type="button" variant="outline" onClick={() => { setPaused(false); setWatching(true); }}>开始记录</Button>
          </div>
          <Button disabled={busy || points.length < 2} type="submit">结束并保存</Button>
        </form>
      )}
      <div className="mt-6 rounded-3xl border border-dashed border-[#efd7a4] bg-[#fff7e8] p-4">
        <div className="text-sm font-medium text-[#8a5a20]">演示巡航</div>
        <p className="mt-1 text-xs leading-5 text-[#8a5a20]">生成一条假轨迹，明确标为演示，不能进入任何补贴申请。</p>
        <Button className="mt-3" variant="amber" type="button" disabled={busy} onClick={cruise}>生成演示巡航</Button>
      </div>
      {error ? <p className="mt-3 text-sm text-[#e11d48]">{error}</p> : null}
    </div>
  );
}

function Field({ name, label, type = "text", placeholder }: { name: string; label: string; type?: string; placeholder?: string }) {
  return (
    <div>
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} type={type} required placeholder={placeholder} />
    </div>
  );
}
