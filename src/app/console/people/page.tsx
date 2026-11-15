"use client";

import { useEffect, useState } from "react";
import { api } from "@/components/api";
import { Guard } from "@/components/shells";
import { Button } from "@/components/ui/button";

type Person = {
  id: string;
  name: string;
  employeeNo: string | null;
  department: string | null;
  vehicleType: string | null;
  plateNo: string | null;
  openIdMasked: string;
  roles: string[];
};
const roles = ["employee", "approver", "finance", "admin"] as const;

export default function PeoplePage() {
  return <Guard console allow={(actor) => actor.roles.includes("admin")}>{() => <Body />}</Guard>;
}

function Body() {
  const [people, setPeople] = useState<Person[]>([]);
  const [pending, setPending] = useState<Array<{ id: string; name: string; openIdMasked: string }>>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  function load() {
    api<{ employees: Person[]; pending: typeof pending }>("/api/console/people").then((data) => {
      setPeople(data.employees);
      setPending(data.pending);
    }).catch((reason: Error) => setError(reason.message));
  }
  useEffect(load, []);
  async function save(person: Person, next: string[]) {
    setError("");
    setMessage("");
    try {
      await api(`/api/console/people/${person.id}/roles`, { method: "POST", body: JSON.stringify({ roles: next }) });
      setMessage(`${person.name} 的角色已更新。管理员身份本身不带来审批或结算权。`);
      load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    }
  }
  return (
    <div>
      <h1 className="text-2xl font-semibold">人员与权限</h1>
      <p className="mt-2 text-sm text-[#5d6d84]">角色存在服务端名册里。员工只看自己的行程和申请，审批人只看分配给自己的单据，财务只处理已通过单据，管理员不能因此直接结算。</p>
      {pending.length ? <div className="mt-4 rounded-3xl bg-[#fff7e8] p-4 text-sm">待列入名册：{pending.map((item) => `${item.name}（${item.openIdMasked}）`).join("、")}</div> : null}
      <div className="mt-4 space-y-3">
        {people.map((person) => (
          <article key={person.id} className="rounded-[28px] bg-white p-4 shadow-sm">
            <div className="font-medium">{person.name}</div>
            <div className="mt-1 text-sm text-[#5d6d84]">{person.department || "未填部门"} · {person.employeeNo || "无工号"} · {person.vehicleType || "未登记车辆"} {person.plateNo || ""}</div>
            <div className="mt-1 text-xs text-[#7b8da3]">飞书身份 {person.openIdMasked}</div>
            <div className="mt-3 flex flex-wrap gap-3 text-sm">
              {roles.map((role) => (
                <label key={role} className="flex items-center gap-1">
                  <input type="checkbox" checked={person.roles.includes(role)} onChange={(event) => {
                    const next = event.target.checked ? [...person.roles, role] : person.roles.filter((item) => item !== role);
                    setPeople((current) => current.map((item) => item.id === person.id ? { ...item, roles: next } : item));
                  }} />
                  {role === "employee" ? "员工" : role === "approver" ? "审批人" : role === "finance" ? "财务" : "管理员"}
                </label>
              ))}
            </div>
            <Button className="mt-3" size="sm" variant="outline" onClick={() => save(person, person.roles)}>保存角色</Button>
          </article>
        ))}
      </div>
      {message ? <p className="mt-3 text-sm text-[#047857]">{message}</p> : null}
      {error ? <p className="mt-3 text-sm text-[#e11d48]">{error}</p> : null}
    </div>
  );
}
