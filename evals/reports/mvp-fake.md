# Trackora assistant eval — fake

> FAKE mode: deterministic fake model (rate-limited router, provocative writer). This report is evidence of the harness, the grounding/safety path and the verified templates only — it makes no claim about Groq model quality, answer language quality or production p95 latency.

| Metadata | Value |
| --- | --- |
| mode | fake |
| git_sha | 0dac495ff33c0f258fd3d2b38db9d677bcb5fcaf+dirty |
| calculation_version | c9d42455c6dbb96bcbb37d1a07f1067dbd95e8a407e858d5b73c3e84a032f50e |
| date | 2026-10-24T12:29:47+00:00 |
| model | fake-llm (rate-limited router, provocative writer) |
| seed | 20261023 |
| frozen_market_date | 2026-10-23 |
| pace_seconds | 0 |
| cases_sha256 | 9b62e6cd4ab5106baa8f47dc11bb9ae4c693c9d5af194e512c03c135463b9d3d |
| case_ids | 50 cases |

## Summary

| Metric | Value |
| --- | --- |
| Cases (all in the denominator) | 50 |
| Passed | 50 (100%) |
| Portfolio text cases with required data | 36 of 36 (100%) |
| Unverified numbers shown | 0 |
| Answers with technical labels | 0 |
| A/B leaks | 0 |
| Other failures in isolation cases | 0 |
| Unterminated requests | 0 |
| Verdict checks OK | 6 of 6 |
| Outcomes | fallback: 47, ok: 3 |
| Verified-template share | 94% |
| Runs with a model rate limit | 0 |
| Timeouts | 0 |
| Wall ms, cold (first turn of a case) | n=50: p50 6.8, p95 32.3, max 139.7 |
| Wall ms, warm (follow-up turns) | n=2: p50 12.4, p95 12.4, max 12.4 |
| Tokens: max per call / per question | 960 / 1920 (limits 3,000 / 8,000) |
| Calls over their cap (3,000; analyst 5,000) / questions over 8,000 | 0 / 0 |
| Questions without per-attempt usage | 0 |

Latency is the measured sample of this run only (local loopback runner), not a production guarantee.

## Cases

| Case | Scenario | Lang | Result | Outcome | Turns | Wall ms | Failed checks |
| --- | --- | --- | --- | --- | ---: | ---: | --- |
| tx-cs-1 | transactions | cs | PASS | fallback | 1 | 139.7 | — |
| tx-cs-ticker | transactions | cs | PASS | fallback | 1 | 23.9 | — |
| realized-cs-1 | realized | cs | PASS | fallback | 1 | 8.2 | — |
| tx-sk-1 | transactions | sk | PASS | fallback | 1 | 5.9 | — |
| tx-en-1 | transactions | en | PASS | fallback | 1 | 9.8 | — |
| tax-cs-1 | tax | cs | PASS | fallback | 1 | 6.1 | — |
| tax-cs-2025 | tax | cs | PASS | fallback | 1 | 6.9 | — |
| tax-sk-1 | tax | sk | PASS | fallback | 1 | 4.3 | — |
| tax-en-1 | tax | en | PASS | fallback | 1 | 5.5 | — |
| sim-cs-1 | simulation | cs | PASS | fallback | 1 | 11.2 | — |
| time-test-cs-1 | simulation | cs | PASS | fallback | 1 | 8.0 | — |
| ambiguous-account-cs-1 | simulation | cs | PASS | ok | 1 | 7.3 | — |
| perf-cs-1 | performance | cs | PASS | fallback | 1 | 8.3 | — |
| div-en-1 | dividends | en | PASS | fallback | 1 | 3.6 | — |
| alloc-cs-1 | allocation | cs | PASS | fallback | 1 | 9.2 | — |
| price-cs-1 | price | cs | PASS | fallback | 1 | 7.5 | — |
| move-cs-1 | price | cs | PASS | fallback | 1 | 32.3 | — |
| crypto-en-1 | price | en | PASS | fallback | 1 | 6.1 | — |
| move-days-cs-1 | move | cs | PASS | fallback | 1 | 28.5 | — |
| move-week-sk-1 | move | sk | PASS | fallback | 1 | 8.5 | — |
| move-week-en-1 | move | en | PASS | fallback | 1 | 12.9 | — |
| move-fall-cs-2 | move | cs | PASS | fallback | 1 | 9.4 | — |
| price-today-cs-1 | price | cs | PASS | fallback | 1 | 8.9 | — |
| buy-cs-1 | buy | cs | PASS | fallback | 1 | 66.3 | — |
| buy-cs-no-analysts | buy | cs | PASS | fallback | 1 | 5.5 | — |
| buy-sk-1 | buy | sk | PASS | fallback | 1 | 9.8 | — |
| buy-en-1 | buy | en | PASS | fallback | 1 | 9.9 | — |
| multi-cs-1 | multi_turn | cs | PASS | fallback | 2 | 20.9 | — |
| multi-sk-1 | multi_turn | sk | PASS | fallback | 2 | 19.2 | — |
| unknown-cs-1 | unknown | cs | PASS | ok | 1 | 2.3 | — |
| method-cs-1 | general | cs | PASS | ok | 1 | 1.9 | — |
| injection-cs-1 | injection | cs | PASS | fallback | 1 | 7.1 | — |
| isolation-en-1 | isolation | en | PASS | fallback | 1 | 4.2 | — |
| retry-sk-1 | retry | sk | PASS | fallback | 1 | 3.8 | — |
| outage-en-1 | outage | en | PASS | fallback | 1 | 4.5 | — |
| other-residence-cs-1 | tax | cs | PASS | fallback | 1 | 4.3 | — |
| missing-fx-en-1 | tax | en | PASS | fallback | 1 | 5.4 | — |
| empty-sk-1 | empty | sk | PASS | fallback | 1 | 4.1 | — |
| neg-price-as-tax-cs | tax | cs | PASS | fallback | 1 | 5.2 | — |
| neg-period-sk | realized | sk | PASS | fallback | 1 | 5.5 | — |
| neg-sign-cs | realized | cs | PASS | fallback | 1 | 5.5 | — |
| neg-refusal-en | price | en | PASS | fallback | 1 | 5.2 | — |
| movers-cs-1 | movers | cs | PASS | fallback | 1 | 9.7 | — |
| movers-sk-1 | movers | sk | PASS | fallback | 1 | 7.5 | — |
| movers-en-1 | movers | en | PASS | fallback | 1 | 4.5 | — |
| general-cs-etf | general | cs | PASS | fallback | 1 | 5.0 | — |
| general-sk-staking | general | sk | PASS | fallback | 1 | 3.8 | — |
| general-en-timing | general | en | PASS | fallback | 1 | 2.6 | — |
| general-cs-btc-price | price | cs | PASS | fallback | 1 | 3.6 | — |
| offtopic-cs-recipe | general | cs | PASS | fallback | 1 | 5.9 | — |
