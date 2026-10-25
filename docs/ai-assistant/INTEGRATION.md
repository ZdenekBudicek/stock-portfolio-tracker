# Integrační důkazy asistenta (aktualizováno Claude 2026-10-24)

Stav ke dni 2026-10-24, vyhodnocený commit `da24c60` (Běh 21c+21d). Lokální Supabase v Dockeru (`npx supabase@2.122.0 start`,
loopback `http://127.0.0.1:54321`, dva syntetičtí uživatelé `agent-a@`/`agent-b@trackora-test.invalid`). **Release je stále NO-GO**:
`edge_cpu` a `prod_migration_history` NOT RUN. SKIP / NOT RUN není PASS.

Strojově čitelný blok čte `scripts/agent-release-check.mjs`. Po skutečném běhu se do něj zapíše
čistý 40znakový SHA vyhodnoceného commitu a stav každé kontroly (`PASS`/`FAIL`/`SKIP`/`NOT RUN`).

```json release-evidence
{
  "sha": "dc2e1eccfdf3e3f817221fb642f962d0b737bfae",
  "checks": {
    "migrations_applied_test": "PASS",
    "real_rls": "PASS",
    "quota_21_way": "PASS",
    "http_ab_jwt": "PASS",
    "deno_http_real_auth": "PASS",
    "edge_cpu": "NOT RUN",
    "prod_migration_history": "NOT RUN"
  }
}
```

| Kontrola | Stav | Důkaz / příkaz | Proč není PASS |
| --- | --- | --- | --- |
| `migrations_applied_test` | PASS | `npx supabase@2.122.0 start` v Dockeru: všech 55 migrací (vč. `20261025100000_ai_assistant.sql`, `20261025100010_ai_market_cache.sql`) se aplikovalo na prázdnou DB bez chyby; `node scripts/agent-test-db.ts --check` PASS | — |
| `real_rls` | PASS | `agent-rls.integration.test.ts` 4/4 + `agent-schema.integration.test.ts` 2/2 proti skutečné Postgres/Auth (opakováno po každém běhu 13–21b) | — |
| `quota_21_way` | PASS | `agent-quota.integration.test.ts` 4/4 (21 souběžných → přesně 20 + 1 quota, B nezávisle 20) + HTTP varianta v `agent-http.integration.test.ts` | — |
| `http_ab_jwt` | PASS | `agent-http.integration.test.ts` 14/14 se skutečnými JWT A/B | — |
| `deno_http_real_auth` | PASS | `scripts/agent-test-edge.ts` (aktualizovaný v Běhu 21c) proti lokální Supabase: skutečné Auth A/B, persistence, vlastní historie, cizí 404, úklid | — |
| gateway (samostatný soubor) | PASS | `docs/ai-assistant/gateway-evidence.json` (SHA da24c60): 401 bez tokenu i s podvrženým, chat A dokončen a uložen, vlákno v seznamu A, cizí vlákno pro B 404, smoke po sobě uklidil | — |
| `edge_cpu` | NOT RUN | CPU hostované funkce nad finálním bundlem (Supabase logs / `x-runtime-cpu`), viz CPU.md Běh 11 | Žádný deploy; lokální měření ≠ Edge CPU |
| `prod_migration_history` | NOT RUN | metadata-only dotazy v RELEASE-DIFF.md, sekce „Produkční historie“ | Produkční metadata nejsou k dispozici tomuto běhu (nečteme produkci) |

## Co je ověřené lokálně (není náhradou výše uvedeného)

- Loopback HTTP nad syntetickými fixture uživateli A/B (in-memory úložiště se sémantikou SQL RPC):
  vlastní historie, retry, eval audit, oddělení A/B, číslované fixture identity — PASS ve Vitestu.
  Dvě fixture instance **nejsou** důkaz izolace v databázi.
- Python harness ve fake režimu: `evals/reports/mvp-fake.md` (30 scénářů, 22 PASS / 8 FAIL;
  0 neověřených čísel, 0 technických labelů, 0 úniků A/B, 0 neukončených dotazů).
- Živý eval: `evals/reports/mvp-live.md` = **NOT RUN** (bez `GROQ_API_KEY` v prostředí procesu).

## Jak doplnit důkazy (needs-claude / Zdeněk)

1. Vybrat testovací DB (TEST-DB.md, varianta A nebo B), doplnit `projectRef` do `test-target.json`,
   aplikovat migrace na test projekt a založit dva syntetické účty.
2. Do prostředí procesu (ne do souboru) dát `TEST_DB_*` a `TEST_USER_*`; spustit
   `npx vitest run src/__tests__/agent-rls.integration.test.ts src/__tests__/agent-quota.integration.test.ts src/__tests__/agent-schema.integration.test.ts src/__tests__/agent-http.integration.test.ts --no-file-parallelism`.
3. Lokální gateway smoke (`supabase functions serve agent`, pak `node --experimental-transform-types scripts/agent-gateway-smoke.ts`
   na čistém commitu → `gateway-evidence.json`); testovací deploy (DEPLOY.md, krok T); změřit Edge CPU.
4. Živý eval (evals/README.md) na **čistém** commitu, s pacingem (`--pace-seconds 12`); report schema 2 musí pokrýt všechna ID z `evals/cases/required.json`.
5. Zapsat stavy a SHA do bloku výše a spustit `node scripts/agent-release-check.mjs --sha=<sha>`.
