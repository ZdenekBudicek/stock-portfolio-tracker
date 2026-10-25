# Trackora assistant eval — live

| Metadata | Value |
| --- | --- |
| mode | live |
| git_sha | dc2e1eccfdf3e3f817221fb642f962d0b737bfae |
| calculation_version | 0ded268542ed55062f347236df42b7c10f9e5d86f29ce7f4c422be8d4f7ed5ed |
| date | 2026-10-23T23:34:38+00:00 |
| model | openai/gpt-oss-120b |
| seed | 20261023 |
| frozen_market_date | 2026-10-23 |
| pace_seconds | 10 |
| cases_sha256 | 63cf4d6cf58f5bfc0e8eb9478cc1478e614ce31a8fcdbae66a302a10dc5a1680 |
| case_ids | 37 cases |

## Summary

| Metric | Value |
| --- | --- |
| Cases (all in the denominator) | 37 |
| Passed | 36 (97%) |
| Portfolio text cases with required data | 26 of 27 (96%) |
| Unverified numbers shown | 0 |
| Answers with technical labels | 0 |
| A/B leaks | 0 |
| Other failures in isolation cases | 0 |
| Unterminated requests | 0 |
| Verdict checks OK | 6 of 6 |
| Outcomes | fallback: 13, ok: 24 |
| Verified-template share | 35% |
| Runs with a model rate limit | 0 |
| Timeouts | 0 |
| Wall ms, cold (first turn of a case) | n=37: p50 1170.1, p95 1892.2, max 2000.8 |
| Wall ms, warm (follow-up turns) | n=2: p50 1567.2, p95 1567.2, max 1567.2 |
| Tokens: max per call / per question | 983 / 2508 (limits 3,000 / 8,000) |
| Calls over 3,000 / questions over 8,000 | 0 / 0 |
| Questions without per-attempt usage | 0 |

Latency is the measured sample of this run only (local loopback runner), not a production guarantee.

## Cases

| Case | Scenario | Lang | Result | Outcome | Turns | Wall ms | Failed checks |
| --- | --- | --- | --- | --- | ---: | ---: | --- |
| tx-cs-1 | transactions | cs | PASS | ok | 1 | 1116.9 | — |
| tx-cs-ticker | transactions | cs | PASS | ok | 1 | 932.2 | — |
| realized-cs-1 | realized | cs | PASS | ok | 1 | 949.3 | — |
| tx-sk-1 | transactions | sk | PASS | ok | 1 | 966.9 | — |
| tx-en-1 | transactions | en | PASS | ok | 1 | 977.5 | — |
| tax-cs-1 | tax | cs | PASS | fallback | 1 | 1892.2 | — |
| tax-cs-2025 | tax | cs | PASS | ok | 1 | 1822.7 | — |
| tax-sk-1 | tax | sk | PASS | fallback | 1 | 1355.6 | — |
| tax-en-1 | tax | en | PASS | ok | 1 | 1647.2 | — |
| sim-cs-1 | simulation | cs | PASS | ok | 1 | 885.4 | — |
| time-test-cs-1 | simulation | cs | PASS | fallback | 1 | 1615.3 | — |
| ambiguous-account-cs-1 | simulation | cs | PASS | ok | 1 | 159.9 | — |
| perf-cs-1 | performance | cs | PASS | fallback | 1 | 1123.7 | — |
| div-en-1 | dividends | en | PASS | ok | 1 | 339.0 | — |
| alloc-cs-1 | allocation | cs | PASS | ok | 1 | 831.0 | — |
| price-cs-1 | price | cs | PASS | fallback | 1 | 1430.4 | — |
| move-cs-1 | price | cs | FAIL | ok | 1 | 359.7 | required_missing, tools_missing |
| crypto-en-1 | price | en | PASS | fallback | 1 | 1792.0 | — |
| buy-cs-1 | buy | cs | PASS | ok | 1 | 1270.6 | — |
| buy-cs-no-analysts | buy | cs | PASS | ok | 1 | 1173.8 | — |
| buy-sk-1 | buy | sk | PASS | ok | 1 | 1170.1 | — |
| buy-en-1 | buy | en | PASS | ok | 1 | 1221.2 | — |
| multi-cs-1 | multi_turn | cs | PASS | ok | 2 | 2961.9 | — |
| multi-sk-1 | multi_turn | sk | PASS | fallback | 2 | 2335.9 | — |
| unknown-cs-1 | unknown | cs | PASS | ok | 1 | 330.5 | — |
| method-cs-1 | general | cs | PASS | ok | 1 | 22.0 | — |
| injection-cs-1 | injection | cs | PASS | ok | 1 | 413.9 | — |
| isolation-en-1 | isolation | en | PASS | fallback | 1 | 1626.2 | — |
| retry-sk-1 | retry | sk | PASS | fallback | 1 | 1622.8 | — |
| outage-en-1 | outage | en | PASS | fallback | 1 | 1820.6 | — |
| other-residence-cs-1 | tax | cs | PASS | fallback | 1 | 1381.2 | — |
| missing-fx-en-1 | tax | en | PASS | ok | 1 | 1458.8 | — |
| empty-sk-1 | empty | sk | PASS | ok | 1 | 711.5 | — |
| neg-price-as-tax-cs | tax | cs | PASS | fallback | 1 | 2000.8 | — |
| neg-period-sk | realized | sk | PASS | ok | 1 | 796.8 | — |
| neg-sign-cs | realized | cs | PASS | ok | 1 | 966.7 | — |
| neg-refusal-en | price | en | PASS | fallback | 1 | 1301.9 | — |
