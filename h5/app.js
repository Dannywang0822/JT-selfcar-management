/**
 * 私车公用员工端的静态演示。
 * 数据只写 localStorage。不请求飞书、OA 或任何后端，不含密钥，也不会付款。
 * 1.20 元/公里是待确认的演示费率，不是正式政策。
 */
(function () {
  const RATE_FEN_PER_KM = 120;
  const RATE_NOTE = "演示值：基准费率 1.20 元/公里。正式基准油价、基准费率和取整边界都未确认，不能当作企业政策。";
  const OA_REASON = "OA 适配器只有类型契约，厂商、文档和凭据都未确认。首期不会向任何 OA 发单、回调或付款。";
  const STORAGE_KEY = "siche-mileage-h5-demo-v1";
  const MAX_TRIP_METERS = 800 * 1000;
  const MIN_TRIP_METERS = 100;

  const PERSONAS = [
    { id: "zhang", name: "张示例", dept: "市场部", no: "E-示例-01", vehicle: "轿车", displacement: "1.5L", plate: "京A·示例01", blurb: "记录行程并申请。预置一条审批中的演示单。" },
    { id: "li", name: "李示例", dept: "交付部", no: "E-示例-02", vehicle: "轿车", displacement: "2.0L", plate: "京A·示例02", blurb: "预置一条待财务结算的演示单，尚未付款。" },
    { id: "wang", name: "王示例", dept: "运维部", no: "E-示例-03", vehicle: "SUV", displacement: "1.5L", plate: "京A·示例03", blurb: "预置一条已驳回的演示单，行程已释放。" },
  ];

  const STATUS_LABEL = {
    draft: "草稿",
    submitting: "提交中",
    in_approval: "审批中",
    rejected: "已驳回",
    canceled: "已撤回",
    settlement_pending: "待财务结算",
    settled: "已结算",
    sync_exception: "同步异常",
    hold_exception: "暂停结算",
    reversal_required: "待冲正",
    reversal_recorded: "已登记冲正",
  };

  const NEXT_ACTION = {
    draft: "提交申请",
    submitting: "等待对账",
    in_approval: "查看进度",
    settlement_pending: "核对凭证",
    rejected: "查看意见",
    canceled: "可修订重提",
    settled: "查看回单",
    sync_exception: "人工对账",
    hold_exception: "暂停结算",
    reversal_required: "登记冲正",
    reversal_recorded: "查看冲正",
  };

  const SOURCE_LABEL = {
    browser_gps: "浏览器定位",
    manual: "人工补录",
    demo_cruise: "演示巡航",
    demo_seed: "演示种子",
  };

  const state = loadState();
  let formMemory = {};
  let pickedIds = [];
  let activePath = "";
  let flash = "";
  let busy = false;
  const gps = { points: [], watching: false, paused: false, watchId: 0 };

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return freshState();
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== 1 || typeof parsed.people !== "object") return freshState();
      return parsed;
    } catch {
      return freshState();
    }
  }

  function freshState() {
    return { version: 1, personaId: null, people: {} };
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      flash = "这台浏览器拒绝保存演示数据。可以换一个非隐私窗口再试。";
    }
  }

  function personaMeta(id) {
    return PERSONAS.find((item) => item.id === id) || null;
  }

  function currentMeta() {
    return personaMeta(state.personaId);
  }

  function bucket() {
    const id = state.personaId;
    if (!id) return null;
    if (!state.people[id]) state.people[id] = seedPerson(id);
    return state.people[id];
  }

  function seedPerson(id) {
    const now = new Date();
    const parts = beijingParts(now);
    const today = Number(parts.day);
    const monthKey = `${parts.year}${parts.month}`;
    const at = (day, hour, minute) => new Date(
      `${parts.year}-${parts.month}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+08:00`,
    ).toISOString();
    const day = Math.min(Math.max(today, 1), 28);
    const data = { seq: 0, trips: [], claims: [] };

    if (id === "zhang") {
      const visit = makeTrip({
        id: "seed_zhang_visit",
        purpose: "客户拜访里程",
        origin: "演示出发地",
        destination: "演示目的地",
        startedAt: at(day, 9, 0),
        endedAt: at(day, 10, 20),
        distanceM: 86200,
        source: "demo_seed",
        eligible: true,
        evidenceNote: "演示种子，不是真实轨迹",
      });
      const open = makeTrip({
        id: "seed_zhang_open",
        purpose: "门店协同",
        origin: "演示出发地 · 国贸",
        destination: "演示目的地 · 中关村",
        startedAt: at(day, 14, 0),
        endedAt: at(day, 15, 10),
        distanceM: 12400,
        source: "demo_seed",
        eligible: true,
        evidenceNote: "演示种子，可用来试提交。不是真实轨迹",
      });
      const cruiseDay = day > 1 ? day - 1 : day;
      const cruise = demoCruiseTrip(at(cruiseDay, 16, 0));
      cruise.id = "seed_zhang_cruise";
      const claim = makeClaim(data, {
        id: "seed_zhang_claim",
        purpose: "客户拜访里程",
        trips: [visit],
        status: "in_approval",
        externalStatus: "PENDING",
        number: `CL-${monthKey}-001`,
      });
      claim.audits.push(
        { at: visit.endedAt, comment: "冻结行程与演示费率快照。1.20 元/公里不是正式政策" },
        { at: now.toISOString(), comment: "演示审批已建立，未调用企业飞书" },
      );
      claim.submittedAt = now.toISOString();
      visit.occupiedBy = claim.id;
      data.seq = 1;
      data.trips = [open, visit, cruise];
      data.claims = [claim];
      return data;
    }

    if (id === "li") {
      const trip = makeTrip({
        id: "seed_li_trip",
        purpose: "项目交付往返",
        origin: "演示出发地",
        destination: "演示目的地",
        startedAt: at(day, 8, 30),
        endedAt: at(day, 11, 0),
        distanceM: 128000,
        source: "demo_seed",
        eligible: true,
        evidenceNote: "演示种子，不是真实轨迹",
      });
      const claim = makeClaim(data, {
        id: "seed_li_claim",
        purpose: "项目交付往返",
        trips: [trip],
        status: "settlement_pending",
        externalStatus: "APPROVED",
        number: `CL-${monthKey}-001`,
      });
      claim.submittedAt = trip.endedAt;
      claim.audits.push(
        { at: trip.endedAt, comment: "演示审批已建立，未调用企业飞书" },
        { at: now.toISOString(), comment: "演示：审批通过，进入财务待结算，尚未付款" },
      );
      trip.occupiedBy = claim.id;
      data.seq = 1;
      data.trips = [trip];
      data.claims = [claim];
      return data;
    }

    const trip = makeTrip({
      id: "seed_wang_trip",
      purpose: "临时外出",
      origin: "演示出发地",
      destination: "演示目的地",
      startedAt: at(day, 13, 0),
      endedAt: at(day, 14, 10),
      distanceM: 42500,
      source: "demo_seed",
      eligible: true,
      evidenceNote: "演示种子。审批驳回后行程已释放，仍不是真实轨迹",
    });
    const claim = makeClaim(data, {
      id: "seed_wang_claim",
      purpose: "临时外出",
      trips: [trip],
      status: "rejected",
      externalStatus: "REJECTED",
      number: `CL-${monthKey}-001`,
    });
    claim.submittedAt = trip.endedAt;
    claim.audits.push(
      { at: trip.endedAt, comment: "演示审批已建立，未调用企业飞书" },
      { at: now.toISOString(), comment: "演示意见：事由不充分（审批驳回，释放行程占用）" },
    );
    data.seq = 1;
    data.trips = [trip];
    data.claims = [claim];
    return data;
  }

  function makeTrip(input) {
    return {
      id: input.id,
      purpose: input.purpose,
      origin: input.origin,
      destination: input.destination,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      distanceM: input.distanceM,
      source: input.source,
      eligible: input.eligible,
      evidenceNote: input.evidenceNote,
      crossQuarter: quarterOfIso(input.startedAt) !== quarterOfIso(input.endedAt),
      occupiedBy: null,
      isDemo: true,
    };
  }

  function makeClaim(data, input) {
    let distance = 0;
    let amount = 0;
    const items = input.trips.map((trip) => {
      const itemAmount = amountFen(trip.distanceM, RATE_FEN_PER_KM);
      distance += trip.distanceM;
      amount += itemAmount;
      return {
        tripId: trip.id,
        purpose: trip.purpose,
        source: trip.source,
        distanceM: trip.distanceM,
        amountFen: itemAmount,
      };
    });
    return {
      id: input.id,
      number: input.number || nextNumber(data, false),
      purpose: input.purpose,
      status: input.status,
      tripIds: input.trips.map((trip) => trip.id),
      items,
      distanceM: distance,
      rateFenPerKm: RATE_FEN_PER_KM,
      amountFen: amount,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      submittedAt: null,
      externalStatus: input.externalStatus || null,
      instanceCode: input.externalStatus ? `demo-local-${input.number || "draft"}` : null,
      needsReconcile: false,
      isDemo: true,
      audits: [],
    };
  }

  function nextNumber(data, increment) {
    if (increment) data.seq += 1;
    const parts = beijingParts(new Date());
    return `CL-${parts.year}${parts.month}-${String(data.seq).padStart(3, "0")}`;
  }

  function demoCruiseTrip(endedAt) {
    const end = new Date(endedAt);
    const points = [0, 1, 2, 3, 4].map((index) => ({
      lat: 39.9 + index * 0.01,
      lng: 116.4 + index * 0.01,
      at: end.getTime() - (5 - index) * 60000,
    }));
    let meters = 0;
    for (let i = 1; i < points.length; i += 1) meters += haversine(points[i - 1], points[i]);
    return makeTrip({
      id: uid("cruise"),
      purpose: "演示巡航",
      origin: "演示起点",
      destination: "演示终点",
      startedAt: new Date(points[0].at).toISOString(),
      endedAt: new Date(points[points.length - 1].at).toISOString(),
      distanceM: Math.max(1, Math.round(meters)),
      source: "demo_cruise",
      eligible: false,
      evidenceNote: "演示巡航不是真实轨迹，不能进入任何补贴申请",
    });
  }

  function amountFen(distanceM, rateFenPerKm) {
    if (!Number.isInteger(distanceM) || !Number.isInteger(rateFenPerKm)) {
      throw new Error("里程和费率必须是整数");
    }
    const product = distanceM * rateFenPerKm;
    const base = Math.trunc(product / 1000);
    const rem = product % 1000;
    if (Math.abs(rem) * 2 >= 1000) return base + Math.sign(product);
    return base;
  }

  function parseKmToMeters(input) {
    const value = String(input ?? "").trim();
    if (!/^\d+(\.\d{1,3})?$/.test(value)) {
      throw new Error("里程需为最多三位小数的非负公里数");
    }
    const [whole, frac = ""] = value.split(".");
    return Number(whole) * 1000 + Number((frac + "000").slice(0, 3));
  }

  function formatKm(meters) {
    const neg = meters < 0;
    const abs = Math.abs(Math.trunc(meters));
    const whole = Math.floor(abs / 1000);
    const frac = abs % 1000;
    const fracStr = String(frac).padStart(3, "0").replace(/0+$/, "");
    const body = fracStr ? `${whole}.${fracStr}` : `${whole}.0`;
    return neg ? `-${body}` : body;
  }

  function money(fen) {
    const negative = fen < 0;
    const abs = Math.abs(Math.trunc(fen));
    const whole = Math.floor(abs / 100).toLocaleString("zh-CN");
    const frac = String(abs % 100).padStart(2, "0");
    return `${negative ? "-" : ""}¥ ${whole}.${frac}`;
  }

  function fenToYuan(fen) {
    const abs = Math.abs(Math.trunc(fen));
    return `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  }

  function haversine(a, b) {
    const radius = 6371000;
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function beijingParts(date) {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const bag = {};
    for (const part of fmt.formatToParts(date)) {
      if (part.type !== "literal") bag[part.type] = part.value;
    }
    return {
      year: bag.year,
      month: bag.month,
      day: bag.day,
      hour: bag.hour === "24" ? "00" : bag.hour,
      minute: bag.minute,
      second: bag.second,
    };
  }

  function formatBeijing(iso) {
    const p = beijingParts(new Date(iso));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  }

  function beijingLocalInput(date) {
    const p = beijingParts(date);
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  }

  function parseBeijingInput(value) {
    const trimmed = String(value || "").trim();
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed) && !/[zZ+]/.test(trimmed)) {
      const withSeconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(trimmed) ? `${trimmed}:00` : trimmed;
      const date = new Date(`${withSeconds}+08:00`);
      if (!Number.isNaN(date.getTime())) return date;
    }
    const date = new Date(trimmed);
    if (Number.isNaN(date.getTime())) throw new Error("时间无法解析");
    return date;
  }

  function quarterOfIso(iso) {
    const p = beijingParts(new Date(iso));
    const q = Math.floor((Number(p.month) - 1) / 3) + 1;
    return `${p.year}Q${q}`;
  }

  function monthRange(date) {
    const p = beijingParts(date);
    const start = new Date(`${p.year}-${p.month}-01T00:00:00+08:00`);
    const month = Number(p.month);
    const year = Number(p.year);
    const next = month === 12 ? `${year + 1}-01-01` : `${p.year}-${String(month + 1).padStart(2, "0")}-01`;
    const end = new Date(`${next}T00:00:00+08:00`);
    return { startIso: start.toISOString(), endIso: end.toISOString(), label: `${p.year}年${month}月` };
  }

  function quarterRange(date) {
    const p = beijingParts(date);
    const q = Math.floor((Number(p.month) - 1) / 3) + 1;
    const startMonth = (q - 1) * 3 + 1;
    const endMonth = startMonth + 2;
    const start = new Date(`${p.year}-${String(startMonth).padStart(2, "0")}-01T00:00:00+08:00`);
    const nextMonth = endMonth === 12 ? 1 : endMonth + 1;
    const nextYear = endMonth === 12 ? Number(p.year) + 1 : Number(p.year);
    const end = new Date(`${nextYear}-${String(nextMonth).padStart(2, "0")}-01T00:00:00+08:00`);
    return { startIso: start.toISOString(), endIso: end.toISOString(), label: `${p.year}年第${q}季度` };
  }

  function inRange(iso, range) {
    return iso >= range.startIso && iso < range.endIso;
  }

  function statusClass(status) {
    if (status === "in_approval" || status === "submitting") return "tone-blue";
    if (status === "settlement_pending") return "tone-amber";
    if (status === "rejected" || status === "sync_exception" || status === "hold_exception" || status === "reversal_required") return "tone-red";
    if (status === "settled" || status === "reversal_recorded") return "tone-green";
    return "tone-slate";
  }

  function sourceLabel(source) {
    return SOURCE_LABEL[source] || source;
  }

  function channelLabel() {
    return "演示流程 · 未连接飞书";
  }

  function rateLabel() {
    return `${fenToYuan(RATE_FEN_PER_KM)} 元/公里`;
  }

  function uid(prefix) {
    const rand = Math.random().toString(36).slice(2, 10);
    return `${prefix}_${rand}${Date.now().toString(36).slice(-4)}`;
  }

  function sortedTrips(data) {
    return [...data.trips].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  }

  function sortedClaims(data) {
    return [...data.claims].sort((a, b) => (a.number < b.number ? 1 : -1));
  }

  function summary(data) {
    const month = monthRange(new Date());
    const trips = data.trips.filter((trip) => inRange(trip.endedAt, month));
    const open = trips.filter((trip) => trip.eligible && !trip.occupiedBy);
    let available = 0;
    for (const trip of open) available += amountFen(trip.distanceM, RATE_FEN_PER_KM);
    return {
      monthLabel: month.label,
      availableFen: available,
      availableDistanceM: open.reduce((sum, trip) => sum + trip.distanceM, 0),
      availableCount: open.length,
      claims: sortedClaims(data).slice(0, 5),
    };
  }

  function periodStats(data) {
    const now = new Date();
    const pack = (range) => {
      const trips = data.trips.filter((trip) => inRange(trip.endedAt, range));
      const claims = data.claims.filter((claim) => inRange(claim.createdAt, range));
      return {
        label: range.label,
        tripCount: trips.length,
        distanceM: trips.reduce((sum, trip) => sum + trip.distanceM, 0),
        claimFen: claims.reduce((sum, claim) => sum + claim.amountFen, 0),
        settledFen: claims.filter((claim) => claim.status === "settled").reduce((sum, claim) => sum + claim.amountFen, 0),
      };
    };
    return { month: pack(monthRange(now)), quarter: pack(quarterRange(now)) };
  }

  function assertDistance(distanceM) {
    if (distanceM < MIN_TRIP_METERS || distanceM > MAX_TRIP_METERS) {
      throw new Error(`里程需在 0.1 至 ${formatKm(MAX_TRIP_METERS)} 公里之间`);
    }
  }

  function assertNoOverlap(data, started, ended, ignoreId) {
    const hit = data.trips.find((trip) => {
      if (trip.id === ignoreId) return false;
      return trip.startedAt < ended.toISOString() && trip.endedAt > started.toISOString();
    });
    if (hit) throw new Error("与本人已有行程时间重叠");
  }

  function addTrip(data, trip) {
    assertDistance(trip.distanceM);
    const started = new Date(trip.startedAt);
    const ended = new Date(trip.endedAt);
    if (Number.isNaN(started.getTime()) || Number.isNaN(ended.getTime()) || ended <= started) {
      throw new Error("结束时间必须晚于开始时间");
    }
    if (!trip.purpose.trim() || !trip.origin.trim() || !trip.destination.trim()) {
      throw new Error("事由、出发地和目的地都要填写");
    }
    assertNoOverlap(data, started, ended);
    data.trips.push(trip);
  }

  function createDraft(data, tripIds, purpose) {
    const ids = [...new Set(tripIds)];
    if (!ids.length) throw new Error("请选择行程");
    if (!String(purpose || "").trim()) throw new Error("请填写申请说明");
    const trips = ids.map((id) => {
      const trip = data.trips.find((item) => item.id === id);
      if (!trip) throw new Error("行程不存在");
      return trip;
    });
    for (const trip of trips) {
      if (trip.source === "demo_cruise" || !trip.eligible) throw new Error("演示巡航不能进入补贴申请");
      if (trip.crossQuarter) throw new Error("跨季度行程的拆分规则未确认，不能自动入账");
      if (trip.occupiedBy) throw new Error("该行程已有有效报销占用");
    }
    const number = nextNumber(data, true);
    const claim = makeClaim(data, {
      id: uid("claim"),
      purpose: String(purpose).trim(),
      trips,
      status: "draft",
      externalStatus: null,
      number,
    });
    claim.audits.push({ at: claim.createdAt, comment: "冻结行程与演示费率快照。1.20 元/公里不是正式政策" });
    for (const trip of trips) trip.occupiedBy = claim.id;
    data.claims.push(claim);
    return claim;
  }

  function submitClaim(data, claimId, provider) {
    const claim = data.claims.find((item) => item.id === claimId);
    if (!claim) throw new Error("申请不存在");
    if (provider === "oa") {
      throw new Error(`${OA_REASON}单据仍是「${STATUS_LABEL[claim.status] || claim.status}」，没有前进。`);
    }
    if (provider !== "feishu") throw new Error("未知审批通道");
    if (claim.status === "in_approval" || claim.status === "settlement_pending" || claim.status === "settled") {
      return claim;
    }
    if (claim.status !== "draft" && claim.status !== "submitting" && claim.status !== "sync_exception") {
      throw new Error("当前状态不能提交");
    }
    const now = new Date().toISOString();
    claim.status = "in_approval";
    claim.externalStatus = "PENDING";
    claim.instanceCode = `demo-local-${claim.number}`;
    claim.submittedAt = claim.submittedAt || now;
    claim.updatedAt = now;
    claim.audits.push({ at: now, comment: "演示审批已建立，未调用企业飞书" });
    return claim;
  }

  function decideDemo(data, claimId, decision, comment) {
    const claim = data.claims.find((item) => item.id === claimId);
    if (!claim) throw new Error("申请不存在");
    if (!String(comment || "").trim()) throw new Error("请填写演示审批意见");
    if (claim.status !== "in_approval" || !claim.instanceCode) throw new Error("演示申请还没有审批实例");
    const now = new Date().toISOString();
    if (decision === "APPROVED") {
      claim.status = "settlement_pending";
      claim.externalStatus = "APPROVED";
      claim.audits.push({ at: now, comment: `演示意见：${String(comment).trim()}（审批通过，进入财务待结算，尚未付款）` });
    } else if (decision === "REJECTED") {
      claim.status = "rejected";
      claim.externalStatus = "REJECTED";
      for (const trip of data.trips) {
        if (trip.occupiedBy === claim.id) trip.occupiedBy = null;
      }
      claim.audits.push({ at: now, comment: `演示意见：${String(comment).trim()}（审批驳回，释放行程占用）` });
    } else {
      throw new Error("未知演示决定");
    }
    claim.updatedAt = now;
    return claim;
  }

  function maskOpenId(openId) {
    if (!openId) return "未映射";
    if (openId.length <= 8) return "已映射";
    return `${openId.slice(0, 3)}····${openId.slice(-4)}`;
  }

  function esc(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function parseRoute() {
    const raw = (location.hash || "#/").replace(/^#/, "");
    const path = raw.split("?")[0] || "/";
    const parts = path.split("/").filter(Boolean);
    return { path: `/${parts.join("/")}`, parts };
  }

  function go(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  }

  function takeFlash() {
    const message = flash;
    flash = "";
    return message;
  }

  function rememberForm(form) {
    const next = {};
    new FormData(form).forEach((value, key) => {
      next[key] = String(value);
    });
    formMemory = { ...formMemory, ...next };
  }

  function field(name, label, type, placeholder, required) {
    const value = formMemory[name] ?? "";
    return `<label class="field"><span>${esc(label)}</span><input name="${esc(name)}" type="${esc(type || "text")}" value="${esc(value)}" ${required === false ? "" : "required"} placeholder="${esc(placeholder || "")}"></label>`;
  }

  function errorBlock(message) {
    return message ? `<p class="err mt-3">${esc(message)}</p>` : "";
  }

  function tripCard(trip) {
    const flag = trip.occupiedBy ? "已占用" : trip.eligible ? "可申请" : "不可申请";
    const note = trip.evidenceNote ? ` · ${trip.evidenceNote}` : "";
    return `<article class="card">
      <div class="between">
        <h2>${esc(trip.purpose)}</h2>
        <span class="km">${esc(formatKm(trip.distanceM))} km</span>
      </div>
      <p class="small muted mt-1">${esc(trip.origin)} → ${esc(trip.destination)}</p>
      <p class="tiny faint mt-2">${esc(formatBeijing(trip.startedAt))} 至 ${esc(formatBeijing(trip.endedAt))} · ${esc(sourceLabel(trip.source))} · 不可当作防篡改里程</p>
      <p class="tiny faint mt-1">${esc(flag)}${esc(note)}</p>
    </article>`;
  }

  function claimCard(claim, href) {
    const inner = `<div style="font-weight:500">${esc(claim.number)}</div>
      <div class="small muted mt-1">${esc(formatKm(claim.distanceM))} km / ${esc(money(claim.amountFen))}</div>
      <div class="small mt-2 ${statusClass(claim.status)}">${esc(STATUS_LABEL[claim.status] || claim.status)} · ${esc(NEXT_ACTION[claim.status] || "")}</div>
      <div class="tiny faint mt-1">${esc(channelLabel())}</div>`;
    if (!href) return `<article class="card">${inner}</article>`;
    return `<a class="card" href="${esc(href)}">${inner}</a>`;
  }

  function homeClaim(claim) {
    return `<a class="card" href="#/m/claims/${esc(claim.id)}">
      <div class="small muted">${esc(claim.purpose)}</div>
      <div class="mt-1" style="font-weight:500">${esc(claim.number)} · ${esc(money(claim.amountFen))}</div>
      <div class="small mt-2 ${statusClass(claim.status)}">${esc(STATUS_LABEL[claim.status] || claim.status)}</div>
      <div class="tiny faint mt-1">${esc(channelLabel())}</div>
    </a>`;
  }

  function statCard(item) {
    return `<section class="card">
      <h2>${esc(item.label)}</h2>
      <p class="small muted mt-2">行程 ${item.tripCount} 次 · ${(item.distanceM / 1000).toFixed(1)} km</p>
      <p class="small muted mt-1">申请 ${esc(money(item.claimFen))} · 已结算 ${esc(money(item.settledFen))}</p>
    </section>`;
  }

  function shell(main, active) {
    const actor = currentMeta();
    const options = PERSONAS.map((item) => `<option value="${esc(item.id)}" ${item.id === actor.id ? "selected" : ""}>${esc(item.name)} · 员工</option>`).join("");
    const tabs = [
      ["/m/trips", "行程"],
      ["/m/claims", "申请"],
      ["/m/progress", "进度"],
      ["/m/me", "我的"],
    ].map(([href, label]) => `<a href="#${href}" class="${active && active.startsWith(href) ? "active" : ""}">${label}</a>`).join("");
    return `<div class="stage"><div class="device">
      <div class="demo-banner">
        <div class="row">
          <div><strong>演示模式</strong><span class="extra"> 种子数据和角色切换只在这台浏览器里，不会调用飞书或 OA，也不会付款。</span></div>
          <label>切换演示身份
            <select data-action="switch-persona" aria-label="切换演示身份">
              ${options}
            </select>
          </label>
        </div>
      </div>
      <header class="top">
        <a class="brand" href="#/m">私车公用</a>
        <span class="badge">演示数据</span>
      </header>
      <main class="main">${main}</main>
      <nav class="tabbar">${tabs}</nav>
    </div></div>`;
  }

  function viewGate(message) {
    const cards = PERSONAS.map((item) => `<button class="persona" type="button" data-action="enter" data-id="${esc(item.id)}">
      <div style="font-weight:500">${esc(item.name)}</div>
      <div class="small muted mt-1">${esc(item.blurb)}</div>
    </button>`).join("");
    return `<div class="stage"><div class="device"><main class="main" style="padding-top:28px">
      <div class="tiny faint">独立测试版 · 静态演示 · 不是 WorkBuddy 升级</div>
      <h1 class="mt-2" style="font-size:28px;letter-spacing:-0.03em">私车公用 · 里程补贴</h1>
      <p class="small mt-3" style="color:#4b6078;line-height:1.6">从行程到结算，让每一笔补贴有据可查。这条手机页只复刻员工端，方便在浏览器里点一遍。正式链路仍是记录行程、提交申请、飞书审批、财务核对、确认结算。首期不自动付款。</p>
      <section class="panel mt-4">
        <h2>建议流程</h2>
        <ol class="steps">
          ${["记录行程", "提交申请", "飞书审批", "财务核对", "确认结算"].map((item, index) => `<li><span class="n">0${index + 1}</span>${esc(item)}</li>`).join("")}
        </ol>
        <p class="tiny faint mt-3">飞书是唯一活动审批方。OA 保持未启用。没有地图服务，不提供路线导航。浏览器定位不能保证后台持续记录，也不能防篡改。演示巡航不能进入报销。${esc(RATE_NOTE)}</p>
      </section>
      <section class="navy mt-4">
        <h2>进入方式</h2>
        <p class="small sub mt-2">不使用工号建档登录。生产身份来自服务端飞书 OAuth。这个静态页没有企业应用凭据。</p>
        <button class="btn btn-outline btn-block btn-lg mt-4" type="button" disabled>飞书登录未配置</button>
        <p class="tiny hint mt-2">此按钮不会发起真实授权，也不会注册账号。</p>
      </section>
      <section class="panel mt-4">
        <div class="between">
          <h2>演示身份</h2>
          <span class="badge">非生产</span>
        </div>
        <p class="small muted mt-2">以下人员、金额和单据都是演示种子，只保存在这台浏览器。切换身份不会获得生产权限。审批、财务和管理端不在这份手机页里。</p>
        <div class="stack mt-4">${cards}</div>
      </section>
      ${errorBlock(message)}
    </main></div></div>`;
  }

  function viewHome(data) {
    const actor = currentMeta();
    const info = summary(data);
    const km = (info.availableDistanceM / 1000).toFixed(1);
    const claims = info.claims.length
      ? info.claims.map(homeClaim).join("")
      : `<p class="card small muted">这个月还没有申请。</p>`;
    return shell(`<div>
      <p class="small muted">你好，${esc(actor.name)}</p>
      <h1 class="mt-1">安全记录 · 合规申请</h1>
      <section class="hero">
        <div class="label">${esc(info.monthLabel)}可申请补贴</div>
        <div class="hero-amount">${esc(money(info.availableFen))}</div>
        <div class="label mt-2">尚未占用 ${esc(km)} km · ${info.availableCount} 次行程</div>
      </section>
      <div class="grid-2 mt-4">
        <a class="btn btn-outline btn-lg" href="#/m/trips/new">记录行程</a>
        <a class="btn btn-lg" href="#/m/claims/new">发起申请</a>
      </div>
      <p class="tiny faint mt-3">浏览器定位需本人授权。离开页面、锁屏或系统回收后不能保证继续记录，轨迹也不能防篡改。补贴基准 1.20 元/公里仍是待确认的演示值，不是正式政策。</p>
      <section class="mt-5">
        <h2>我的申请</h2>
        <div class="stack mt-3">${claims}</div>
      </section>
    </div>`, "");
  }

  function viewTrips(data) {
    const trips = sortedTrips(data);
    const list = trips.length
      ? trips.map(tripCard).join("")
      : `<p class="card small muted">还没有行程。定位记录需要你授权，离开页面后不会在后台继续记。</p>`;
    return shell(`<div>
      <div class="between">
        <h1>行程</h1>
        <a class="btn btn-sm" href="#/m/trips/new">记录</a>
      </div>
      <div class="stack mt-4">${list}</div>
    </div>`, "/m/trips");
  }

  function viewNewTrip(message) {
    const started = formMemory.startedAt || beijingLocalInput(new Date(Date.now() - 60 * 60 * 1000));
    const ended = formMemory.endedAt || beijingLocalInput(new Date());
    const mode = formMemory.mode === "gps" ? "gps" : "manual";
    const manual = `<form class="stack mt-4" data-action="save-manual">
      ${field("purpose", "事由", "text", "")}
      ${field("origin", "出发地", "text", "")}
      ${field("destination", "目的地", "text", "")}
      <label class="field"><span>里程（公里）</span><input name="distanceKm" inputmode="decimal" required placeholder="12.5" value="${esc(formMemory.distanceKm || "")}"></label>
      <label class="field"><span>开始（北京时间）</span><input name="startedAt" type="datetime-local" required value="${esc(started)}"></label>
      <label class="field"><span>结束（北京时间）</span><input name="endedAt" type="datetime-local" required value="${esc(ended)}"></label>
      <label class="field"><span>证据说明</span><input name="evidenceNote" placeholder="例如停车票、行程单，仍需审核" value="${esc(formMemory.evidenceNote || "")}"></label>
      <button class="btn btn-lg btn-block" type="submit" ${busy ? "disabled" : ""}>保存人工补录</button>
    </form>`;
    const hint = gps.paused
      ? "页面离开后已停止，未提交的点只留在这次打开的页面里。"
      : "仅在页面可见时记录。";
    const locating = `<form class="stack mt-4" data-action="save-gps">
      ${field("purpose", "事由", "text", "")}
      ${field("origin", "出发地", "text", "")}
      ${field("destination", "目的地", "text", "")}
      <div class="card small">
        <div data-gps-hint>已采集 <span data-point-count>${gps.points.length}</span> 个点。${esc(hint)}</div>
        <button class="btn btn-outline mt-3" type="button" data-action="gps-start">${gps.watching ? "记录中" : "开始记录"}</button>
      </div>
      <button class="btn btn-lg btn-block" type="submit" data-gps-save ${busy || gps.points.length < 2 ? "disabled" : ""}>结束并保存</button>
    </form>`;
    return shell(`<div>
      <h1>记录行程</h1>
      <p class="small mt-2" style="line-height:1.6;color:#5d6d84">浏览器定位需要你当场授权。锁屏、切走或系统回收页面后，不能保证继续记录，轨迹也可以被伪造，不能当作可信里程。未配置地图服务，这里不提供路线导航。</p>
      <div class="grid-2 mt-4">
        <button class="btn btn-lg ${mode === "manual" ? "" : "btn-outline"}" type="button" data-action="mode" data-mode="manual">人工补录</button>
        <button class="btn btn-lg ${mode === "gps" ? "" : "btn-outline"}" type="button" data-action="mode" data-mode="gps">授权定位</button>
      </div>
      ${mode === "manual" ? manual : locating}
      <div class="callout">
        <div class="small" style="font-weight:500">演示巡航</div>
        <p class="tiny mt-1">生成一条假轨迹，明确标为演示，不能进入任何补贴申请。</p>
        <button class="btn btn-amber mt-3" type="button" data-action="cruise" ${busy ? "disabled" : ""}>生成演示巡航</button>
      </div>
      ${errorBlock(message)}
    </div>`, "/m/trips");
  }

  function viewClaims(data) {
    const claims = sortedClaims(data);
    const list = claims.length
      ? claims.map((claim) => claimCard(claim, `#/m/claims/${claim.id}`)).join("")
      : `<p class="card small muted">还没有申请。</p>`;
    return shell(`<div class="stack">
      <h1>申请</h1>
      ${list}
    </div>`, "/m/claims");
  }

  function viewNewClaim(data, message) {
    const open = sortedTrips(data).filter((trip) => trip.eligible && !trip.occupiedBy);
    const purpose = formMemory.purpose || "本月里程补贴";
    const provider = formMemory.provider || "feishu";
    const rows = open.length
      ? open.map((trip) => `<label class="card trip-check">
          <input type="checkbox" name="trip" value="${esc(trip.id)}" ${pickedIds.includes(trip.id) ? "checked" : ""}>
          <span>
            <span style="font-weight:500">${esc(trip.purpose)} · ${esc(formatKm(trip.distanceM))} km</span>
            <span class="tiny faint" style="display:block">${esc(sourceLabel(trip.source))} · ${esc(formatBeijing(trip.startedAt))}</span>
          </span>
        </label>`).join("")
      : `<p class="card small muted">没有可申请的行程。</p>`;
    const picked = open.filter((trip) => pickedIds.includes(trip.id));
    let preview = 0;
    for (const trip of picked) preview += amountFen(trip.distanceM, RATE_FEN_PER_KM);
    return shell(`<div>
      <h1>发起申请</h1>
      <p class="small muted mt-2">金额按冻结的演示费率以整数分计算。演示巡航不会出现在这里。${esc(RATE_NOTE)}</p>
      <form data-action="create-claim">
        <label class="field mt-4"><span>说明</span><input id="purpose" name="purpose" value="${esc(purpose)}"></label>
        <div class="stack mt-4">${rows}</div>
        <p class="tiny faint mt-3">已选 ${picked.length} 次 · 预估 ${esc(money(preview))}（演示计算，非正式政策）</p>
        <div class="stack mt-4">
          <label class="choice">
            <input type="radio" name="provider" value="feishu" ${provider === "feishu" ? "checked" : ""}>
            <span><b>飞书审批</b><span class="tiny faint" style="display:block">演示。只在这台浏览器里把状态改成审批中，不会连接企业飞书，也不会发单。</span></span>
          </label>
          <label class="choice">
            <input type="radio" name="provider" value="oa" ${provider === "oa" ? "checked" : ""}>
            <span><b>OA</b><span class="tiny faint" style="display:block">未启用。选它只会留下草稿，单据不会前进。</span></span>
          </label>
        </div>
        <button class="btn btn-lg btn-block mt-4" type="submit" ${busy || picked.length === 0 ? "disabled" : ""}>提交申请</button>
      </form>
      ${errorBlock(message)}
    </div>`, "/m/claims");
  }

  function viewClaim(data, id, message) {
    const claim = data.claims.find((item) => item.id === id);
    if (!claim) return shell(`<p class="err">申请不存在</p>`, "/m/claims");
    const actor = currentMeta();
    const items = claim.items.map((item) => `<li class="item">${esc(item.purpose)} · ${esc(formatKm(item.distanceM))} km · ${esc(sourceLabel(item.source))}</li>`).join("");
    const audits = claim.audits.length
      ? claim.audits.map((item) => `<li>${esc(formatBeijing(item.at))} · ${esc(item.comment)}</li>`).join("")
      : `<li>还没有审核记录。</li>`;
    const provider = formMemory.provider || "feishu";
    const draftBox = claim.status === "draft" || claim.status === "submitting" || claim.status === "sync_exception"
      ? `<form class="mt-4" data-action="submit-draft" data-id="${esc(claim.id)}">
          <div class="stack">
            <label class="choice"><input type="radio" name="provider" value="feishu" ${provider === "feishu" ? "checked" : ""}><span><b>飞书审批</b><span class="tiny faint" style="display:block">演示状态会前进到审批中。未连接企业飞书。</span></span></label>
            <label class="choice"><input type="radio" name="provider" value="oa" ${provider === "oa" ? "checked" : ""}><span><b>OA</b><span class="tiny faint" style="display:block">未启用。单据保持当前状态。</span></span></label>
          </div>
          <button class="btn btn-lg btn-block mt-3" type="submit" ${busy ? "disabled" : ""}>${claim.status === "draft" ? "提交申请" : "用原提交键重试"}</button>
        </form>`
      : "";
    const decide = claim.status === "in_approval"
      ? `<div class="callout">
          <div class="small" style="font-weight:500">演示审批</div>
          <p class="tiny mt-1">只改变这台浏览器里的演示数据，不会调用飞书。通过后进入待财务结算，不会自动付款。</p>
          <input class="bare-input mt-3" name="demoComment" data-comment value="${esc(formMemory.demoComment || "演示审批意见")}">
          <div class="grid-2 mt-3">
            <button class="btn" type="button" data-action="decide" data-id="${esc(claim.id)}" data-decision="APPROVED" ${busy ? "disabled" : ""}>演示通过</button>
            <button class="btn btn-outline" type="button" data-action="decide" data-id="${esc(claim.id)}" data-decision="REJECTED" ${busy ? "disabled" : ""}>演示驳回</button>
          </div>
        </div>`
      : "";
    const payNote = claim.status === "settlement_pending"
      ? `<p class="small mt-2 tone-amber">这张演示单在等财务核对。审批通过不等于已付款，这里没有付款按钮。</p>`
      : "";
    return shell(`<div class="panel">
      <a class="link" href="#/m/claims">返回</a>
      <h1 class="mt-2">${esc(claim.number)}</h1>
      <p class="small muted mt-1">${esc(actor.name)} · ${esc(claim.purpose)}</p>
      <div class="info-grid mt-4">
        <div class="info"><div class="k">里程</div><div class="v">${esc(formatKm(claim.distanceM))} km</div></div>
        <div class="info"><div class="k">金额</div><div class="v">${esc(money(claim.amountFen))}</div></div>
        <div class="info"><div class="k">费率快照</div><div class="v">${esc(rateLabel())}</div></div>
        <div class="info"><div class="k">状态</div><div class="v ${statusClass(claim.status)}">${esc(STATUS_LABEL[claim.status] || claim.status)}</div></div>
      </div>
      <p class="tiny faint mt-2">${esc(RATE_NOTE)}</p>
      <p class="small muted mt-3">${esc(channelLabel())}。审批通过不等于已付款。没有连接企业飞书，也不会自动付款。</p>
      ${payNote}
      ${claim.needsReconcile ? `<p class="small mt-2 tone-amber">这张单据等待对账，暂停结算。</p>` : ""}
      <h2 class="mt-5">包含行程</h2>
      <ul class="stack mt-2" style="list-style:none;padding:0">${items}</ul>
      <h2 class="mt-5">轨迹</h2>
      <ol class="audits">${audits}</ol>
      ${draftBox}
      ${decide}
      ${errorBlock(message)}
    </div>`, "/m/claims");
  }

  function viewProgress(data) {
    const stats = periodStats(data);
    const claims = sortedClaims(data);
    const list = claims.length
      ? claims.map((claim) => claimCard(claim, `#/m/claims/${claim.id}`)).join("")
      : `<p class="card small muted">还没有申请。</p>`;
    return shell(`<div>
      <h1>进度</h1>
      <div class="stack mt-4">
        ${statCard(stats.month)}
        ${statCard(stats.quarter)}
      </div>
      <div class="stack mt-5">
        <h1>申请</h1>
        ${list}
      </div>
    </div>`, "/m/progress");
  }

  function viewMe(message) {
    const actor = currentMeta();
    const openId = maskOpenId(`ou_demo_emp_${actor.id}`);
    return shell(`<div class="panel">
      <h1>${esc(actor.name)}</h1>
      <p class="small muted mt-2">角色：员工</p>
      <p class="small muted mt-1">运行模式：演示。身份标识 ${esc(openId)}。</p>
      <p class="small muted mt-1">${esc(actor.dept)} · ${esc(actor.no)} · ${esc(actor.vehicle)} ${esc(actor.displacement)} · ${esc(actor.plate)}</p>
      <p class="small mt-3" style="line-height:1.6;color:#5d6d84">页面不保存飞书 token、App Secret 或事件密钥。生产环境不会提供角色切换。这份页面没有企业飞书，退出只清除当前这台浏览器里的演示身份。</p>
      <p class="tiny faint mt-3">${esc(RATE_NOTE)}</p>
      <button class="btn btn-outline btn-block mt-5" type="button" data-action="logout">退出</button>
      <button class="btn btn-amber btn-block mt-3" type="button" data-action="reset">恢复当前身份的演示种子</button>
      ${message ? `<p class="small muted mt-3">${esc(message)}</p>` : ""}
    </div>`, "/m/me");
  }

  function render() {
    const route = parseRoute();
    if (route.path !== activePath) {
      activePath = route.path;
      formMemory = {};
      pickedIds = [];
      stopWatch(true);
    }
    const root = document.getElementById("app");
    if (!root) return;
    const message = takeFlash();
    if (!state.personaId || route.path === "/" || route.path === "/login") {
      if (state.personaId && (route.path === "/" || route.path === "/login")) {
        go("#/m");
        return;
      }
      root.innerHTML = viewGate(message);
      return;
    }
    const data = bucket();
    if (route.path === "/m") root.innerHTML = viewHome(data);
    else if (route.path === "/m/trips") root.innerHTML = viewTrips(data);
    else if (route.path === "/m/trips/new") root.innerHTML = viewNewTrip(message);
    else if (route.path === "/m/claims") root.innerHTML = viewClaims(data);
    else if (route.path === "/m/claims/new") root.innerHTML = viewNewClaim(data, message);
    else if (route.parts[0] === "m" && route.parts[1] === "claims" && route.parts[2]) root.innerHTML = viewClaim(data, route.parts[2], message);
    else if (route.path === "/m/progress") root.innerHTML = viewProgress(data);
    else if (route.path === "/m/me") root.innerHTML = viewMe(message);
    else root.innerHTML = viewHome(data);
  }

  function stopWatch(clear) {
    if (gps.watchId && navigator.geolocation) navigator.geolocation.clearWatch(gps.watchId);
    gps.watchId = 0;
    gps.watching = false;
    if (clear) {
      gps.points = [];
      gps.paused = false;
    }
  }

  function refreshGpsHint() {
    const count = document.querySelector("[data-point-count]");
    const hint = document.querySelector("[data-gps-hint]");
    const save = document.querySelector("[data-gps-save]");
    if (count) count.textContent = String(gps.points.length);
    if (hint) {
      const tail = gps.paused
        ? "页面离开后已停止，未提交的点只留在这次打开的页面里。"
        : "仅在页面可见时记录。";
      hint.textContent = `已采集 ${gps.points.length} 个点。${tail}`;
    }
    if (save) save.disabled = busy || gps.points.length < 2;
  }

  function startGps() {
    if (!navigator.geolocation) {
      flash = "没有获得定位授权，或当前环境不提供定位。可以改用人工补录。";
      render();
      return;
    }
    gps.paused = false;
    gps.watching = true;
    refreshGpsHint();
    const button = document.querySelector("[data-action='gps-start']");
    if (button) button.textContent = "记录中";
    gps.watchId = navigator.geolocation.watchPosition(
      (position) => {
        gps.points = gps.points.concat([{
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          recordedAt: new Date(position.timestamp).toISOString(),
          accuracyM: position.coords.accuracy,
        }]).slice(-500);
        refreshGpsHint();
      },
      () => {
        gps.watching = false;
        flash = "没有获得定位授权，或当前环境不提供定位。可以改用人工补录。";
        render();
      },
      { enableHighAccuracy: true, maximumAge: 5000 },
    );
  }

  function onClick(event) {
    const el = event.target.closest("[data-action]");
    if (!el || el.closest("form") && el.type === "submit") return;
    const action = el.getAttribute("data-action");
    if (action === "enter") {
      const id = el.getAttribute("data-id");
      if (!personaMeta(id)) return;
      state.personaId = id;
      if (!state.people[id]) state.people[id] = seedPerson(id);
      save();
      go("#/m");
      return;
    }
    if (action === "logout") {
      state.personaId = null;
      save();
      go("#/");
      return;
    }
    if (action === "reset") {
      const id = state.personaId;
      if (id) state.people[id] = seedPerson(id);
      save();
      flash = "已恢复演示种子。这些单据仍然只存在于这台浏览器。";
      render();
      return;
    }
    if (action === "mode") {
      const form = document.querySelector("form");
      if (form) rememberForm(form);
      formMemory.mode = el.getAttribute("data-mode");
      render();
      return;
    }
    if (action === "gps-start") {
      startGps();
      return;
    }
    if (action === "cruise") {
      const data = bucket();
      if (!data) return;
      try {
        const trip = demoCruiseTrip(new Date().toISOString());
        addTrip(data, trip);
        save();
        go("#/m/trips");
      } catch (error) {
        flash = error instanceof Error ? error.message : "演示巡航失败";
        render();
      }
      return;
    }
    if (action === "decide") {
      const data = bucket();
      const commentEl = document.querySelector("[data-comment]");
      const comment = commentEl ? commentEl.value : "";
      formMemory.demoComment = comment;
      try {
        decideDemo(data, el.getAttribute("data-id"), el.getAttribute("data-decision"), comment);
        save();
        render();
      } catch (error) {
        flash = error instanceof Error ? error.message : "操作失败";
        render();
      }
    }
  }

  function onSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const action = form.getAttribute("data-action");
    if (!action) return;
    event.preventDefault();
    rememberForm(form);
    const data = bucket();
    if (!data) return;
    try {
      if (action === "save-manual") {
        const distanceM = parseKmToMeters(formMemory.distanceKm);
        const started = parseBeijingInput(formMemory.startedAt);
        const ended = parseBeijingInput(formMemory.endedAt);
        const trip = makeTrip({
          id: uid("trip"),
          purpose: String(formMemory.purpose || ""),
          origin: String(formMemory.origin || ""),
          destination: String(formMemory.destination || ""),
          startedAt: started.toISOString(),
          endedAt: ended.toISOString(),
          distanceM,
          source: "manual",
          eligible: true,
          evidenceNote: String(formMemory.evidenceNote || "").trim() || "人工补录，需审核",
        });
        addTrip(data, trip);
        save();
        go("#/m/trips");
        return;
      }
      if (action === "save-gps") {
        if (gps.points.length < 2) throw new Error("至少需要两个定位点");
        const points = gps.points.map((point) => ({ ...point, at: new Date(point.recordedAt).getTime() }))
          .sort((a, b) => a.at - b.at);
        let meters = 0;
        for (let i = 1; i < points.length; i += 1) meters += haversine(points[i - 1], points[i]);
        const distanceM = Math.round(meters);
        const hours = (points[points.length - 1].at - points[0].at) / 3600000;
        if (hours <= 0) throw new Error("定位时间没有间隔");
        if (distanceM / hours > 160000) throw new Error("轨迹速度不合理。浏览器定位不可信，请改用人工补录并注明原因");
        const trip = makeTrip({
          id: uid("trip"),
          purpose: String(formMemory.purpose || ""),
          origin: String(formMemory.origin || ""),
          destination: String(formMemory.destination || ""),
          startedAt: new Date(points[0].at).toISOString(),
          endedAt: new Date(points[points.length - 1].at).toISOString(),
          distanceM,
          source: "browser_gps",
          eligible: true,
          evidenceNote: "浏览器定位，不能证明后台持续记录，也不能防篡改",
        });
        addTrip(data, trip);
        save();
        stopWatch(true);
        go("#/m/trips");
        return;
      }
      if (action === "create-claim") {
        const claim = createDraft(data, pickedIds, formMemory.purpose);
        const provider = formMemory.provider || "feishu";
        try {
          submitClaim(data, claim.id, provider);
        } catch (error) {
          save();
          flash = error instanceof Error ? error.message : "提交失败";
          go(`#/m/claims/${claim.id}`);
          return;
        }
        save();
        go(`#/m/claims/${claim.id}`);
        return;
      }
      if (action === "submit-draft") {
        submitClaim(data, form.getAttribute("data-id"), formMemory.provider || "feishu");
        save();
        render();
      }
    } catch (error) {
      flash = error instanceof Error ? error.message : "保存失败";
      render();
    }
  }

  function onChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.getAttribute("data-action") === "switch-persona") {
      const id = target.value;
      if (!personaMeta(id) || id === state.personaId) return;
      state.personaId = id;
      if (!state.people[id]) state.people[id] = seedPerson(id);
      save();
      go("#/m");
      return;
    }
    if (target instanceof HTMLInputElement && target.name === "trip") {
      pickedIds = [...document.querySelectorAll("input[name='trip']:checked")].map((node) => node.value);
      const form = target.form;
      if (form) rememberForm(form);
      render();
    }
    if (target instanceof HTMLInputElement && target.name === "provider" && target.form) {
      rememberForm(target.form);
    }
  }

  const api = {
    amountFen,
    parseKmToMeters,
    formatKm,
    money,
    haversine,
    RATE_FEN_PER_KM,
    OA_REASON,
    RATE_NOTE,
  };
  if (typeof globalThis !== "undefined") globalThis.__sicheH5 = api;

  if (typeof document !== "undefined") {
    document.addEventListener("click", onClick);
    document.addEventListener("submit", onSubmit);
    document.addEventListener("change", onChange);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible" && gps.watching) {
        stopWatch(false);
        gps.paused = true;
        refreshGpsHint();
      }
    });
    window.addEventListener("hashchange", render);
    if (!location.hash) location.hash = "#/";
    render();
  }
})();
