// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("B2 scopes the atomic replacement to the caller, account and statement period", () => {
  const sql = readFileSync("supabase/migrations/20261026100000_statement_money.sql", "utf8");
  expect(sql).toContain("uid uuid := auth.uid()");
  expect(sql).toContain("set search_path = ''");
  expect(sql).toContain("broker_account is not distinct from p_account");
  expect(sql).toContain("executed_at >= p_from and executed_at < p_before");
  expect(sql).toContain("ext_id like 't212:ord:%'");
  expect(sql).toContain("insert into public.transactions");
  expect(sql).toContain("from public, anon");
  expect(sql).toContain("to authenticated");
  expect(sql.replace(/--[^\n]*/g, "")).not.toMatch(/exception when|\bcommit\b/i);
});

it("B4 adds nullable actual dividend amounts without inventing withholding for old data", () => {
  const sql = readFileSync("supabase/migrations/20261026100000_statement_money.sql", "utf8");
  const ddl = sql.slice(0, sql.indexOf("create or replace function"));
  expect(ddl).toContain("add column if not exists gross_amount_usd numeric");
  expect(ddl).toContain("add column if not exists withholding_tax_usd numeric");
  expect(ddl).toContain("add column if not exists original_currency text");
  expect(ddl).not.toMatch(/default|not null|update public.dividends/i);
});

it("B13 renders read errors before deciding the portfolio is empty", () => {
  const source = readFileSync("src/pages/Index.tsx", "utf8");
  expect(source.indexOf("if (p.error)")).toBeLessThan(source.indexOf("if (!hasData)"));
  expect(source).toContain('role="alert"');
});

it("names the JSON rows apart from the PL/pgSQL loop record (a shared `r` made every replacement fail)", () => {
  const sql = readFileSync("supabase/migrations/20261026100000_statement_money.sql", "utf8");
  // Verified against a local Postgres: `as r(...)` beside `declare r record` is "column reference r.ticker is ambiguous".
  expect(sql).not.toMatch(/jsonb_to_recordset\(p_rows\) as r\(/);
  expect(sql).toMatch(/jsonb_to_recordset\(p_rows\) as x\(/);
});
