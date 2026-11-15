import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CLAIM_STATUSES,
  EXTERNAL_APPROVAL_STATUSES,
  ROLES,
  SETTLEMENT_STATUSES,
  STORED_APPROVAL_PROVIDERS,
  sqlLiteralList,
} from "../lib/states";

export type AppDb = {
  path: string;
  exec(sql: string): void;
  get<T>(sql: string, ...params: unknown[]): T | undefined;
  all<T>(sql: string, ...params: unknown[]): T[];
  run(sql: string, ...params: unknown[]): void;
  transaction<T>(fn: () => T): T;
  close(): void;
};

function plain<T>(value: unknown): T | undefined {
  if (value == null) return undefined;
  return { ...(value as Record<string, unknown>) } as T;
}

const ROLE_LIST = sqlLiteralList(ROLES);
const CLAIM_STATUS_LIST = sqlLiteralList(CLAIM_STATUSES);
const SETTLEMENT_STATUS_LIST = sqlLiteralList(SETTLEMENT_STATUSES);
const EXTERNAL_STATUS_LIST = sqlLiteralList(EXTERNAL_APPROVAL_STATUSES);
const STORED_PROVIDER_LIST = sqlLiteralList(STORED_APPROVAL_PROVIDERS);

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 3000;

CREATE TABLE IF NOT EXISTS meta (
  key text primary key,
  value text not null
);
CREATE TABLE IF NOT EXISTS employees (
  id text primary key,
  name text not null,
  employee_no text,
  department text,
  open_id text,
  tenant_key text,
  feishu_user_id text,
  vehicle_type text,
  displacement text,
  plate_no text,
  status text not null default 'active',
  is_demo integer not null default 0,
  created_at text not null
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_emp_openid ON employees(tenant_key, open_id) WHERE open_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS employee_roles (
  employee_id text not null,
  role text not null check (role in (${ROLE_LIST})),
  primary key (employee_id, role),
  foreign key (employee_id) references employees(id) on delete restrict
);
CREATE TABLE IF NOT EXISTS pending_identities (
  id text primary key,
  open_id text not null,
  tenant_key text not null,
  name text not null,
  feishu_user_id text,
  created_at text not null,
  linked_employee_id text,
  unique (tenant_key, open_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  id text primary key,
  employee_id text,
  pending_identity_id text,
  mode text not null,
  expires_at text not null,
  created_at text not null
);
CREATE TABLE IF NOT EXISTS oauth_states (
  state text primary key,
  code_verifier text,
  expires_at text not null,
  used_at text
);
CREATE TABLE IF NOT EXISTS rate_versions (
  id text primary key,
  name text not null,
  quarter_label text not null,
  baseline_price_fen_per_liter integer not null,
  previous_price_fen_per_liter integer not null,
  current_price_fen_per_liter integer not null,
  baseline_rate_fen_per_km integer not null,
  threshold_fen integer not null,
  step_fen_per_km integer not null,
  rounding text not null,
  policy_status text not null,
  effective_from text not null,
  effective_to text not null,
  region_note text not null,
  source_note text not null,
  is_demo integer not null,
  notes text not null,
  created_at text not null,
  created_by text
);
CREATE TABLE IF NOT EXISTS trips (
  id text primary key,
  employee_id text not null,
  started_at text not null,
  ended_at text not null,
  distance_m integer not null,
  source text not null,
  purpose text not null,
  origin_text text not null,
  dest_text text not null,
  trust text not null,
  real_claim_eligible integer not null,
  is_demo integer not null,
  evidence_note text,
  cross_quarter integer not null default 0,
  point_count integer not null default 0,
  created_at text not null
);
CREATE TABLE IF NOT EXISTS trip_points (
  id text primary key,
  trip_id text not null,
  seq integer not null,
  lat real not null,
  lng real not null,
  recorded_at text not null,
  accuracy_m real
);
CREATE TABLE IF NOT EXISTS claims (
  id text primary key,
  number text not null unique,
  employee_id text not null,
  status text not null check (status in (${CLAIM_STATUS_LIST})),
  revision integer not null default 1,
  previous_claim_id text,
  rate_version_id text not null,
  distance_m integer not null,
  rate_fen_per_km integer not null,
  amount_fen integer not null,
  rule_snapshot_json text not null,
  trip_snapshot_json text not null,
  approval_provider text not null check (approval_provider in (${STORED_PROVIDER_LIST})),
  runtime_channel text not null,
  is_demo integer not null,
  assigned_approver_id text,
  idempotency_key text,
  request_hash text,
  purpose text not null,
  submitted_at text,
  created_at text not null,
  updated_at text not null,
  foreign key (employee_id) references employees(id) on delete restrict,
  foreign key (assigned_approver_id) references employees(id) on delete restrict,
  foreign key (rate_version_id) references rate_versions(id) on delete restrict
);
CREATE TABLE IF NOT EXISTS claim_items (
  id text primary key,
  claim_id text not null,
  trip_id text not null,
  distance_m integer not null,
  amount_fen integer not null
);
CREATE TABLE IF NOT EXISTS trip_occupancy (
  trip_id text primary key,
  claim_id text not null
);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  actor_id text not null,
  idem_key text not null,
  request_hash text not null,
  claim_id text not null,
  created_at text not null,
  primary key (actor_id, idem_key)
);
CREATE TABLE IF NOT EXISTS approval_bindings (
  id text primary key,
  claim_id text not null unique,
  provider text not null,
  approval_code text,
  instance_code text,
  uuid text not null unique,
  external_status text check (external_status is null or external_status in (${EXTERNAL_STATUS_LIST})),
  last_operate_time text,
  needs_reconcile integer not null default 0,
  updated_at text not null,
  foreign key (claim_id) references claims(id) on delete restrict
);
CREATE TABLE IF NOT EXISTS approval_outbox (
  id text primary key,
  claim_id text not null unique,
  uuid text not null unique,
  state text not null,
  attempts integer not null default 0,
  last_error text,
  last_log_id text,
  payload_json text not null,
  created_at text not null,
  updated_at text not null
);
CREATE TABLE IF NOT EXISTS callback_inbox (
  id text primary key,
  dedupe_key text not null unique,
  body_sha256 text not null,
  event_uuid text,
  event_type text,
  instance_code text,
  external_status text,
  operate_time text,
  process_state text not null,
  error text,
  received_at text not null,
  processed_at text
);
CREATE TABLE IF NOT EXISTS callback_nonces (
  nonce text primary key,
  body_sha256 text not null,
  received_at text not null
);
CREATE TABLE IF NOT EXISTS settlements (
  id text primary key,
  claim_id text not null unique,
  amount_fen integer not null,
  voucher_no text not null unique,
  operator_id text not null,
  comment text not null,
  status text not null check (status in (${SETTLEMENT_STATUS_LIST})),
  created_at text not null,
  foreign key (claim_id) references claims(id) on delete restrict,
  foreign key (operator_id) references employees(id) on delete restrict
);
CREATE TABLE IF NOT EXISTS settlement_reversals (
  id text primary key,
  claim_id text not null,
  settlement_id text not null,
  reason text not null,
  external_status text not null,
  operator_id text,
  comment text,
  created_at text not null
);
CREATE TABLE IF NOT EXISTS audit_events (
  id text primary key,
  actor_id text,
  action text not null,
  object_type text not null,
  object_id text not null,
  from_status text,
  to_status text,
  comment text,
  source text not null,
  at text not null,
  meta_json text
);
CREATE TABLE IF NOT EXISTS counters (
  name text primary key,
  value integer not null
);
CREATE TABLE IF NOT EXISTS integration_checks (
  id text primary key,
  kind text not null,
  ok integer not null,
  message text not null,
  at text not null
);
`;

function tableSql(raw: DatabaseSync, name: string): string {
  const row = raw.prepare("select sql from sqlite_master where type = 'table' and name = ?").get(name) as { sql?: string } | undefined;
  return row?.sql ?? "";
}

function needsConstraintRebuild(sql: string): boolean {
  return sql.length > 0 && !/check\s*\(/i.test(sql);
}

/** 已有库没有 CHECK/外键时重建这几张表。复制全部行，失败则整段回滚，不丢数据。 */
export function migrateConstraints(raw: DatabaseSync): void {
  const claims = tableSql(raw, "claims");
  const roles = tableSql(raw, "employee_roles");
  const settlements = tableSql(raw, "settlements");
  const bindings = tableSql(raw, "approval_bindings");
  if (![claims, roles, settlements, bindings].some(needsConstraintRebuild)) return;
  raw.exec("PRAGMA foreign_keys = OFF");
  raw.exec("BEGIN");
  try {
    if (needsConstraintRebuild(roles)) {
      raw.exec(`
        CREATE TABLE employee_roles__next (
          employee_id text not null,
          role text not null check (role in (${ROLE_LIST})),
          primary key (employee_id, role),
          foreign key (employee_id) references employees(id) on delete restrict
        );
        INSERT INTO employee_roles__next (employee_id, role) SELECT employee_id, role FROM employee_roles;
        DROP TABLE employee_roles;
        ALTER TABLE employee_roles__next RENAME TO employee_roles;
      `);
    }
    if (needsConstraintRebuild(claims)) {
      raw.exec(`
        CREATE TABLE claims__next (
          id text primary key,
          number text not null unique,
          employee_id text not null,
          status text not null check (status in (${CLAIM_STATUS_LIST})),
          revision integer not null default 1,
          previous_claim_id text,
          rate_version_id text not null,
          distance_m integer not null,
          rate_fen_per_km integer not null,
          amount_fen integer not null,
          rule_snapshot_json text not null,
          trip_snapshot_json text not null,
          approval_provider text not null check (approval_provider in (${STORED_PROVIDER_LIST})),
          runtime_channel text not null,
          is_demo integer not null,
          assigned_approver_id text,
          idempotency_key text,
          request_hash text,
          purpose text not null,
          submitted_at text,
          created_at text not null,
          updated_at text not null,
          foreign key (employee_id) references employees(id) on delete restrict,
          foreign key (assigned_approver_id) references employees(id) on delete restrict,
          foreign key (rate_version_id) references rate_versions(id) on delete restrict
        );
        INSERT INTO claims__next (
          id, number, employee_id, status, revision, previous_claim_id, rate_version_id, distance_m, rate_fen_per_km,
          amount_fen, rule_snapshot_json, trip_snapshot_json, approval_provider, runtime_channel, is_demo,
          assigned_approver_id, idempotency_key, request_hash, purpose, submitted_at, created_at, updated_at
        )
        SELECT
          id, number, employee_id, status, revision, previous_claim_id, rate_version_id, distance_m, rate_fen_per_km,
          amount_fen, rule_snapshot_json, trip_snapshot_json, approval_provider, runtime_channel, is_demo,
          assigned_approver_id, idempotency_key, request_hash, purpose, submitted_at, created_at, updated_at
        FROM claims;
        DROP TABLE claims;
        ALTER TABLE claims__next RENAME TO claims;
      `);
    }
    if (needsConstraintRebuild(settlements)) {
      raw.exec(`
        CREATE TABLE settlements__next (
          id text primary key,
          claim_id text not null unique,
          amount_fen integer not null,
          voucher_no text not null unique,
          operator_id text not null,
          comment text not null,
          status text not null check (status in (${SETTLEMENT_STATUS_LIST})),
          created_at text not null,
          foreign key (claim_id) references claims(id) on delete restrict,
          foreign key (operator_id) references employees(id) on delete restrict
        );
        INSERT INTO settlements__next (id, claim_id, amount_fen, voucher_no, operator_id, comment, status, created_at)
        SELECT id, claim_id, amount_fen, voucher_no, operator_id, comment, status, created_at FROM settlements;
        DROP TABLE settlements;
        ALTER TABLE settlements__next RENAME TO settlements;
      `);
    }
    if (needsConstraintRebuild(bindings)) {
      raw.exec(`
        CREATE TABLE approval_bindings__next (
          id text primary key,
          claim_id text not null unique,
          provider text not null,
          approval_code text,
          instance_code text,
          uuid text not null unique,
          external_status text check (external_status is null or external_status in (${EXTERNAL_STATUS_LIST})),
          last_operate_time text,
          needs_reconcile integer not null default 0,
          updated_at text not null,
          foreign key (claim_id) references claims(id) on delete restrict
        );
        INSERT INTO approval_bindings__next (
          id, claim_id, provider, approval_code, instance_code, uuid, external_status, last_operate_time, needs_reconcile, updated_at
        )
        SELECT id, claim_id, provider, approval_code, instance_code, uuid, external_status, last_operate_time, needs_reconcile, updated_at
        FROM approval_bindings;
        DROP TABLE approval_bindings;
        ALTER TABLE approval_bindings__next RENAME TO approval_bindings;
      `);
    }
    raw.exec("COMMIT");
  } catch (error) {
    try {
      raw.exec("ROLLBACK");
    } catch {
      /* 事务未打开 */
    }
    raw.exec("PRAGMA foreign_keys = ON");
    throw error;
  }
  raw.exec("PRAGMA foreign_keys = ON");
}

export function openDatabase(filePath: string): AppDb {
  if (filePath !== ":memory:") {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  const raw = new DatabaseSync(filePath);
  raw.exec("PRAGMA foreign_keys = ON");
  raw.exec(SCHEMA);
  migrateConstraints(raw);
  raw.exec("PRAGMA foreign_keys = ON");
  let depth = 0;
  const db: AppDb = {
    path: filePath,
    exec(sql) {
      raw.exec(sql);
    },
    get(sql, ...params) {
      return plain(raw.prepare(sql).get(...params));
    },
    all(sql, ...params) {
      return raw.prepare(sql).all(...params).map((row) => plain(row)!) as never[];
    },
    run(sql, ...params) {
      raw.prepare(sql).run(...params);
    },
    transaction(fn) {
      if (depth > 0) return fn();
      depth += 1;
      raw.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        raw.exec("COMMIT");
        depth -= 1;
        return result;
      } catch (error) {
        depth -= 1;
        try {
          raw.exec("ROLLBACK");
        } catch {
          /* already closed */
        }
        throw error;
      }
    },
    close() {
      raw.close();
    },
  };
  return db;
}
