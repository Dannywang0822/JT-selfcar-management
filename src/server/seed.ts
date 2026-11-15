import crypto from "node:crypto";
import type { AppDb } from "./db";
import { amountFen } from "./money";
import { beijingParts, beijingQuarter } from "./time";

const RATE_ID = "rate_demo_current";

export function ensureDemoSeed(db: AppDb, now = new Date()): void {
  const existing = db.get<{ value: string }>("select value from meta where key = 'seeded'");
  if (existing?.value === "1") return;
  db.transaction(() => {
    seedDemo(db, now);
    db.run("insert into meta(key, value) values ('seeded', '1')");
  });
}

function seedDemo(db: AppDb, now: Date) {
  const parts = beijingParts(now);
  const quarter = beijingQuarter(now);
  const stamp = (day: number, hour: number, minute = 0) => {
    const safeDay = Math.min(Math.max(day, 1), 28);
    return new Date(
      `${parts.year}-${parts.month}-${String(safeDay).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+08:00`,
    ).toISOString();
  };
  const today = Number(parts.day);
  db.run(
    `insert into rate_versions(
      id, name, quarter_label, baseline_price_fen_per_liter, previous_price_fen_per_liter, current_price_fen_per_liter,
      baseline_rate_fen_per_km, threshold_fen, step_fen_per_km, rounding, policy_status, effective_from, effective_to,
      region_note, source_note, is_demo, notes, created_at, created_by
    ) values (?, ?, ?, 750, 750, 750, 120, 50, 5, 'toward_zero', 'demo_unconfirmed', ?, ?, ?, ?, 1, ?, ?, 'seed')`,
    RATE_ID,
    `${quarter.key} 演示费率`,
    quarter.label,
    quarter.start,
    quarter.end,
    "地区未确认，演示不代表全国或北京正式油价",
    "油价来源未确认，演示基准价 7.50 元/升只为把调整步长算成 0",
    "演示值：基准费率 1.20 元/公里。正式基准油价、基准费率和取整边界都未确认，不能当作企业政策。已知规则只有每 0.50 元/升调整 0.05 元/公里。",
    now.toISOString(),
  );

  const people: Array<[string, string, string, string, string, string, string, string]> = [
    ["emp_zhang", "张示例", "E-示例-01", "市场部", "employee", "轿车", "1.5L", "京A·示例01"],
    ["emp_li", "李示例", "E-示例-02", "交付部", "employee", "轿车", "2.0L", "京A·示例02"],
    ["emp_wang", "王示例", "E-示例-03", "运维部", "employee", "SUV", "1.5L", "京A·示例03"],
    ["emp_zhou", "周示例", "E-示例-04", "综合部", "approver", "轿车", "1.6L", "京A·示例04"],
    ["emp_zhao", "赵示例", "E-示例-05", "财务部", "finance", "轿车", "1.5L", "京A·示例05"],
    ["emp_chen", "陈示例", "E-示例-06", "信息部", "admin", "轿车", "1.8L", "京A·示例06"],
  ];
  const fillerNames = ["钱示例", "孙示例", "吴示例", "郑示例", "冯示例", "褚示例", "卫示例", "蒋示例", "沈示例", "韩示例", "杨示例", "朱示例"];
  fillerNames.forEach((name, index) => {
    people.push([`emp_x${index + 1}`, name, `E-示例-${20 + index}`, "业务部", "employee", "轿车", "1.5L", `京A·示${index + 1}`]);
  });
  for (const [id, name, no, dept, role, vehicle, disp, plate] of people) {
    db.run(
      `insert into employees(id, name, employee_no, department, open_id, tenant_key, vehicle_type, displacement, plate_no, status, is_demo, created_at)
       values (?, ?, ?, ?, ?, 'demo-tenant', ?, ?, ?, 'active', 1, ?)`,
      id,
      name,
      no,
      dept,
      `ou_demo_${id}`,
      vehicle,
      disp,
      plate,
      now.toISOString(),
    );
    db.run("insert into employee_roles(employee_id, role) values (?, ?)", id, role);
    if (role !== "employee") db.run("insert into employee_roles(employee_id, role) values (?, 'employee')", id);
  }

  const rule = ruleSnapshot();
  let seq = 0;
  const nextNo = () => {
    seq += 1;
    return `CL-${parts.year}${parts.month}-${String(seq).padStart(3, "0")}`;
  };
  const add = (input: {
    employeeId: string;
    distanceM: number;
    status: string;
    purpose: string;
    external: string | null;
    occupy: boolean;
    approver?: string | null;
    settle?: boolean;
    day?: number;
  }) => {
    const tripId = crypto.randomUUID();
    const claimId = crypto.randomUUID();
    const number = nextNo();
    const money = amountFen(input.distanceM, 120);
    const day = input.day ?? (seq % 27) + 1;
    const startHour = input.day ? 6 : 8 + (seq % 3);
    const start = stamp(day, startHour);
    const end = stamp(day, startHour + 1);
    db.run(
      `insert into trips(id, employee_id, started_at, ended_at, distance_m, source, purpose, origin_text, dest_text, trust, real_claim_eligible, is_demo, evidence_note, cross_quarter, point_count, created_at)
       values (?, ?, ?, ?, ?, 'demo_seed', ?, '演示出发地', '演示目的地', 'unverified', 1, 1, '演示种子，不是真实轨迹', 0, 0, ?)`,
      tripId,
      input.employeeId,
      start,
      end,
      input.distanceM,
      input.purpose,
      now.toISOString(),
    );
    db.run(
      `insert into claims(id, number, employee_id, status, revision, rate_version_id, distance_m, rate_fen_per_km, amount_fen, rule_snapshot_json, trip_snapshot_json, approval_provider, runtime_channel, is_demo, assigned_approver_id, purpose, submitted_at, created_at, updated_at)
       values (?, ?, ?, ?, 1, ?, ?, 120, ?, ?, ?, 'feishu', 'demo', 1, ?, ?, ?, ?, ?)`,
      claimId,
      number,
      input.employeeId,
      input.status,
      RATE_ID,
      input.distanceM,
      money,
      rule,
      JSON.stringify([{ tripId, distanceM: input.distanceM, source: "demo_seed" }]),
      input.approver ?? null,
      input.purpose,
      now.toISOString(),
      now.toISOString(),
      now.toISOString(),
    );
    db.run(
      "insert into claim_items(id, claim_id, trip_id, distance_m, amount_fen) values (?, ?, ?, ?, ?)",
      crypto.randomUUID(),
      claimId,
      tripId,
      input.distanceM,
      money,
    );
    if (input.occupy) db.run("insert into trip_occupancy(trip_id, claim_id) values (?, ?)", tripId, claimId);
    if (input.external) {
      db.run(
        `insert into approval_bindings(id, claim_id, provider, approval_code, instance_code, uuid, external_status, last_operate_time, needs_reconcile, updated_at)
         values (?, ?, 'demo', 'DEMO-APPROVAL', ?, ?, ?, ?, 0, ?)`,
        crypto.randomUUID(),
        claimId,
        `demo-seed-${number}`,
        crypto.randomUUID(),
        input.external,
        String(now.getTime()),
        now.toISOString(),
      );
    }
    if (input.settle) {
      const voucher = `DEMO-JS-${number.slice(-3)}`;
      db.run(
        `insert into settlements(id, claim_id, amount_fen, voucher_no, operator_id, comment, status, created_at)
         values (?, ?, ?, ?, 'emp_zhao', '演示种子结算，不是银行付款', 'confirmed', ?)`,
        crypto.randomUUID(),
        claimId,
        money,
        voucher,
        now.toISOString(),
      );
      db.run(
        `insert into audit_events(id, actor_id, action, object_type, object_id, from_status, to_status, comment, source, at)
         values (?, 'emp_zhao', 'settle', 'claim', ?, 'settlement_pending', 'settled', '演示种子', 'demo_seed', ?)`,
        crypto.randomUUID(),
        claimId,
        now.toISOString(),
      );
    }
    return money;
  };

  add({ employeeId: "emp_zhang", distanceM: 86200, status: "in_approval", purpose: "客户拜访里程", external: "PENDING", occupy: true, approver: "emp_zhou", day: today });
  add({ employeeId: "emp_li", distanceM: 128000, status: "settlement_pending", purpose: "项目交付往返", external: "APPROVED", occupy: true, day: Math.max(1, today - 1) });
  add({ employeeId: "emp_wang", distanceM: 42500, status: "rejected", purpose: "临时外出", external: "REJECTED", occupy: false, approver: "emp_zhou", day: Math.max(1, today - 2) });

  const approvalDistances = [30000, 42000, 18500, 66000, 25400, 90000, 15000, 48200, 33000, 27500, 54000];
  approvalDistances.forEach((distance, index) => {
    add({
      employeeId: `emp_x${index + 1}`,
      distanceM: distance,
      status: "in_approval",
      purpose: "业务拜访",
      external: "PENDING",
      occupy: true,
      approver: "emp_zhou",
    });
  });
  [360500, 380000, 400000, 350000, 370000, 390000, 360000].forEach((distance, index) => {
    add({
      employeeId: `emp_x${index + 1}`,
      distanceM: distance,
      status: "settlement_pending",
      purpose: "月度客户巡访",
      external: "APPROVED",
      occupy: true,
    });
  });
  [2200000, 2100000, 2000000, 2066000, 2100000].forEach((distance, index) => {
    add({
      employeeId: `emp_x${index + 6}`,
      distanceM: distance,
      status: "settled",
      purpose: "季度服务里程",
      external: "APPROVED",
      occupy: true,
      settle: true,
    });
  });

  const free = [45200, 38600, 22000, 51400, 31300, 25500];
  const purposes = ["门店巡检", "客户回访", "样品送达", "售后上门", "合同签署", "设备点检"];
  free.forEach((distance, index) => {
    const hour = 8 + index * 2;
    db.run(
      `insert into trips(id, employee_id, started_at, ended_at, distance_m, source, purpose, origin_text, dest_text, trust, real_claim_eligible, is_demo, evidence_note, cross_quarter, point_count, created_at)
       values (?, 'emp_zhang', ?, ?, ?, 'manual', ?, '公司', ?, 'unverified', 1, 1, '演示可申请行程，人工补录', 0, 0, ?)`,
      crypto.randomUUID(),
      stamp(today, hour),
      stamp(today, hour + 1),
      distance,
      purposes[index],
      `客户点${index + 1}`,
      now.toISOString(),
    );
  });
  db.run("insert into counters(name, value) values (?, ?)", `claim-${parts.year}${parts.month}`, seq);
}

function ruleSnapshot(): string {
  return JSON.stringify({
    rateVersionId: RATE_ID,
    baselineRateFenPerKm: 120,
    rateFenPerKm: 120,
    steps: 0,
    thresholdFen: 50,
    stepFenPerKm: 5,
    previousPriceFenPerLiter: 750,
    currentPriceFenPerLiter: 750,
    baselinePriceFenPerLiter: 750,
    rounding: "toward_zero",
    policyStatus: "demo_unconfirmed",
    note: "演示值，不是已确认的企业补贴政策",
  });
}
