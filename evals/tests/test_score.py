from trackora_evals.client import ChatResult
from trackora_evals.score import extract_numbers, parse_localized_number, score_case, summarize

NVDA_GAIN = {"id": "sale:NVDA:gain", "value": 3.35, "unit": "money", "currency": "USD", "ticker": "NVDA", "source": "tax_model", "as_of": "2026-10-23T12:00:00Z"}
RKLB_LOSS = {"id": "sale:RKLB:gain", "value": -3.35, "unit": "money", "currency": "USD", "ticker": "RKLB", "source": "tax_model", "as_of": "2026-10-23T12:00:00Z"}
SELL = {"id": "transactions:all:sell_usd", "value": 300, "unit": "money", "currency": "USD", "source": "transactions", "as_of": "2026-10-23T12:00:00Z"}
COUNT = {"id": "transactions:all:count", "value": 1, "unit": "count", "source": "transactions", "as_of": "2026-10-23T12:00:00Z"}


def case(**over):
    base = {"id": "c1", "lang": "cs", "user": "A", "turns": ["Kolik jsem letos prodal?"], "expect_tools": [], "golden": [],
            "expect_verdict": False, "scenario": "transactions"}
    return {**base, **over}


def result(text, facts=(), terminal="done", tools=(), **over):
    audit = {"metrics": {"outcome": "ok"}, "facts": list(facts), "calculations": [], "toolsUsed": list(tools), "snapshotId": "fixture-A"}
    return ChatResult(events=[], text=text, links=[], terminal=terminal, http_status=200, outcome="ok", error_code=None,
                      persisted=True, ttft_ms=5.0, wall_ms=10.0, tokens={"in": 0, "out": 0}, audit=audit, **{"failure": None, **over})


def test_a_negative_amount_for_one_ticker_does_not_match_a_positive_fact_of_another():
    scored = score_case(case(), result("Prodej RKLB by skončil ztrátou -3,35 USD.", [NVDA_GAIN]), {})
    assert scored["passed"] is False
    assert scored["checks"]["unverified_numbers"] == ["-3,35 USD"]


def test_the_same_value_with_the_wrong_ticker_still_fails():
    flipped = {**NVDA_GAIN, "value": -3.35}
    scored = score_case(case(), result("Prodej RKLB by skončil ztrátou -3,35 USD.", [flipped]), {})
    assert scored["passed"] is False


def test_a_correct_signed_amount_with_its_ticker_passes():
    scored = score_case(case(), result("Prodej RKLB by skončil ztrátou -3,35 USD.", [RKLB_LOSS]), {})
    assert scored["checks"]["unverified_numbers"] == []
    assert scored["passed"] is True


def test_numbers_are_read_by_locale_and_unit_not_universally():
    assert parse_localized_number("98.650", "cs") == 98650
    assert parse_localized_number("98.650", "en") == 98.65
    assert parse_localized_number("98.650", "cs", unit="percent") == 98.65
    assert parse_localized_number("98,65", "cs") == 98.65
    assert parse_localized_number("1 234,56", "cs") == 1234.56
    assert parse_localized_number("1 234,56", "sk") == 1234.56
    assert parse_localized_number("1,234.56", "en") == 1234.56
    assert parse_localized_number("0,00001234", "cs") == 0.00001234


def test_dates_times_and_the_sources_line_are_not_claims():
    text = "Příští výsledky 23. 10. 2026.\n\nZdroje: Trackora – výpočet portfolia (23. 10. 2026 14:00)."
    assert extract_numbers(text, "cs") == []
    assert extract_numbers("Sources: Trackora (Oct 23, 2026, 2:00 PM).", "en") == []


def test_a_technical_label_fails():
    for text in ["Hodnota portfolio:total_value je známá.", "Použil jsem get_quote.", "Data z price_cache."]:
        scored = score_case(case(), result(text), {})
        assert scored["passed"] is False
        assert scored["checks"]["technical"] is True


def test_right_tool_result_with_a_wrong_answer_fails():
    golden = {"transactions:all:sell_usd": SELL}
    scored = score_case(case(golden=[{"tool": "get_transactions", "args": {}, "fact_ids": ["transactions:all:sell_usd"]}]),
                        result("Letos jsi prodal za 3 000,00 USD.", [SELL]), golden)
    assert scored["passed"] is False
    assert scored["checks"]["required_missing"] == ["transactions:all:sell_usd"]
    assert scored["checks"]["unverified_numbers"] == ["3 000,00 USD"]


def test_the_required_golden_value_in_the_answer_passes():
    golden = {"transactions:all:sell_usd": SELL, "transactions:all:count": COUNT}
    scored = score_case(case(golden=[{"tool": "get_transactions", "args": {}, "fact_ids": list(golden)}]),
                        result("• počet obchodů: 1\n• prodáno za: 300,00 USD", [SELL, COUNT]), golden)
    assert scored["checks"]["required_missing"] == []
    assert scored["passed"] is True


def test_refusing_a_buy_analysis_with_complete_data_is_not_a_success():
    buy = case(turns=["Vyplatí se koupit SYNA?"], expect_verdict=True, scenario="buy")
    scored = score_case(buy, result("Nemohu doporučit nákup ani prodej."), {})
    assert scored["passed"] is False
    assert scored["checks"]["verdict"] is False


def test_a_complete_buy_analysis_with_a_verdict_passes_the_verdict_check():
    text = ("Analytici\nÚdaje analytiků teď nejsou k dispozici.\n\nOcenění\nModel vychází výš než cena.\n\nRizika\nPozice je velká.\n\n"
            "Verdikt\nZávěr vychází z poměru férové hodnoty k ceně.\nZávěr: spíš atraktivní. Jistota: střední.\nCo by závěr změnilo: Slabší výsledky.")
    scored = score_case(case(expect_verdict=True, scenario="buy"), result(text), {})
    assert scored["checks"]["verdict"] is True


def test_an_honest_insufficient_verdict_is_required_when_data_are_missing():
    missing = case(expect_verdict=True, expect_insufficient=True, scenario="outage")
    honest = ("Rizika\nTuto akcii zatím nedržíš.\n\nVerdikt\nPro závěr chybí: ocenění.\nZávěr: nedostatek dat. Jistota: nízká.\n"
              "Co by závěr změnilo: Doplnění chybějících údajů.")
    assert score_case(missing, result(honest), {})["checks"]["verdict"] is True
    assert score_case(missing, result(honest.replace("nedostatek dat", "spíš atraktivní")), {})["checks"]["verdict"] is False


def test_a_client_failure_is_scored_as_a_failure_and_stays_in_the_denominator():
    eof = result(None, terminal="eof", failure="stream ended without done")
    scored = [score_case(case(), eof, {}), score_case(case(id="c2"), result("Bez čísel."), {})]
    assert scored[0]["passed"] is False and scored[0]["checks"]["terminated"] is False
    summary = summarize(scored)
    assert summary["cases"] == 2 and summary["passed"] == 1 and summary["unterminated"] == 1
    assert summary["pass_rate"] == 0.5


def test_forbidden_patterns_and_expected_tools_are_checked():
    scored = score_case(case(forbid=["3 050"], expect_tools=["get_portfolio_summary"]), result("Máš 3 050 USD."), {})
    assert scored["checks"]["forbidden"] == ["3 050"]
    assert scored["checks"]["tools_missing"] == ["get_portfolio_summary"]
    assert scored["passed"] is False


# --- Běh 20: meaning, not just a number somewhere among the facts -------------------------------------------------

PRICE = {"id": "quote:SYNA:price", "value": 150, "unit": "money", "currency": "USD", "ticker": "SYNA", "source": "Finnhub", "as_of": "2026-10-23T11:55:00Z"}
PERIOD_26 = {"from": "2026-01-01", "to": "2026-12-31"}
TAX_26 = {"id": "tax:2026:estimated_tax", "value": 0, "unit": "money", "currency": "CZK", "source": "cz_tax_model", "as_of": "2026-10-23T12:00:00Z", "period": PERIOD_26}
TAX_25 = {"id": "tax:2025:estimated_tax", "value": 1200, "unit": "money", "currency": "CZK", "source": "cz_tax_model", "as_of": "2026-10-23T12:00:00Z",
          "period": {"from": "2025-01-01", "to": "2025-12-31"}}
SYNA_LOSS = {"id": "sale:SYNA:gain", "value": -3.35, "unit": "money", "currency": "USD", "ticker": "SYNA", "source": "tax_model", "as_of": "2026-10-23T12:00:00Z"}
TX_PERIOD = {"from": "2026-01-01", "to": "2026-10-23"}
TX = {k: {"id": f"transactions:all:{k}", "value": v, "unit": u, "source": "transactions", "as_of": "2026-10-23T12:00:00Z", "period": TX_PERIOD,
          **({"currency": "USD"} if u == "money" else {})}
      for k, v, u in [("count", 1, "count"), ("buy_count", 0, "count"), ("sell_count", 1, "count"), ("buy_usd", 0, "money"),
                      ("sell_usd", 300, "money"), ("bought_shares", 0, "shares"), ("sold_shares", 2, "shares")]}
TX_GOLDEN = {f["id"]: f for f in TX.values()}
TX_CASE = case(golden=[{"tool": "get_transactions", "args": {}, "fact_ids": list(TX_GOLDEN)}])
TAX_CASE = case(scenario="tax", golden=[{"tool": "get_tax_report", "args": {"year": 2026}, "fact_ids": ["tax:2026:estimated_tax"]}])


def test_a_price_presented_as_tax_is_not_verified_by_the_matching_price():
    scored = score_case(TAX_CASE, result("Odhad daně za rok 2026: 150,00 USD.", [PRICE, TAX_26]), {"tax:2026:estimated_tax": TAX_26})
    assert scored["checks"]["unverified_numbers"] == ["150,00 USD"]
    assert scored["checks"]["required_missing"] == ["tax:2026:estimated_tax"]
    assert scored["passed"] is False


def test_the_same_price_under_its_own_label_is_verified():
    scored = score_case(case(scenario="price"), result("Cena SYNA je 150,00 USD.", [PRICE]), {})
    assert scored["checks"]["unverified_numbers"] == []


def test_a_loss_shown_as_a_profit_has_the_wrong_sign():
    golden = {"sale:SYNA:gain": SYNA_LOSS}
    sim = case(scenario="simulation", golden=[{"tool": "simulate_sale", "args": {}, "fact_ids": ["sale:SYNA:gain"]}])
    scored = score_case(sim, result("Zisk z prodeje SYNA: 3,35 USD.", [SYNA_LOSS]), golden)
    assert scored["checks"]["unverified_numbers"] == ["3,35 USD"]
    assert scored["checks"]["required_missing"] == ["sale:SYNA:gain"]
    # A loss named as a loss may be written without the minus sign.
    assert score_case(sim, result("Ztráta z prodeje SYNA: 3,35 USD.", [SYNA_LOSS]), golden)["passed"] is True
    assert score_case(sim, result("Zisk či ztráta z prodeje SYNA: −3,35 USD.", [SYNA_LOSS]), golden)["passed"] is True


def test_a_value_of_another_period_is_not_verified_by_that_period():
    scored = score_case(TAX_CASE, result("Odhad daně za rok 2026: 1 200 Kč.", [TAX_25, TAX_26]), {"tax:2026:estimated_tax": TAX_26})
    assert scored["checks"]["unverified_numbers"] == ["1 200 Kč"]
    assert scored["checks"]["required_missing"] == ["tax:2026:estimated_tax"]
    # The rendered period after the value counts too.
    ok_text = "• odhad daně: 0,00 Kč (1. 1. 2026 – 31. 12. 2026)"
    assert score_case(TAX_CASE, result(ok_text, [TAX_25, TAX_26]), {"tax:2026:estimated_tax": TAX_26})["passed"] is True
    wrong = "• odhad daně: 1 200 Kč (1. 1. 2026 – 31. 12. 2026)"
    assert score_case(TAX_CASE, result(wrong, [TAX_25, TAX_26]), {"tax:2026:estimated_tax": TAX_26})["checks"]["unverified_numbers"] == ["1 200 Kč"]


def test_refusing_with_complete_data_is_a_refusal_not_an_honest_gap():
    scored = score_case(TX_CASE, result("Tato data teď bohužel nemám k dispozici.", list(TX.values())), TX_GOLDEN)
    assert scored["checks"]["refused"] is True
    assert scored["passed"] is False
    assert "refused" in scored["failures"]


def test_every_required_datum_of_the_intent_must_be_answered():
    text = "• počet obchodů: 1\n• prodáno za: 300,00 USD"
    scored = score_case(TX_CASE, result(text, list(TX.values())), TX_GOLDEN)
    assert sorted(scored["checks"]["required_missing"]) == sorted(["transactions:all:buy_count", "transactions:all:sell_count", "transactions:all:buy_usd",
                                                                   "transactions:all:bought_shares", "transactions:all:sold_shares"])
    full = ("nakoupené kusy: 0\nprodané kusy: 2\nnakoupeno za: 0,00 USD\nprodáno za: 300,00 USD\n"
            "počet obchodů: 1 (1. 1. 2026 – 23. 10. 2026)\npočet nákupů: 0\npočet prodejů: 1")
    assert score_case(TX_CASE, result(full, list(TX.values())), TX_GOLDEN)["passed"] is True


def test_a_required_value_needs_its_own_meaning_not_just_an_equal_number():
    # "2" is the number of shares sold, not the number of trades.
    scored = score_case(TX_CASE, result("Prodal jsi 2 obchody.", list(TX.values())), TX_GOLDEN)
    assert "transactions:all:sold_shares" in scored["checks"]["required_missing"]


def test_golden_evidence_is_never_trusted_as_evidence_of_the_answer():
    golden = {"transactions:all:sell_usd": SELL}
    scored = score_case(case(golden=[{"tool": "get_transactions", "args": {}, "fact_ids": ["transactions:all:sell_usd"]}]),
                        result("• prodáno za: 300,00 USD", []), golden)
    assert scored["checks"]["unverified_numbers"] == ["300,00 USD"]
    assert scored["passed"] is False


def test_the_chat_evidence_must_agree_with_the_golden_tool_result():
    golden = {"transactions:all:sell_usd": SELL}
    other = {**SELL, "value": 310}
    scored = score_case(case(golden=[{"tool": "get_transactions", "args": {}, "fact_ids": ["transactions:all:sell_usd"]}]),
                        result("• prodáno za: 310,00 USD", [other]), golden)
    assert scored["checks"]["golden_disagrees"] == ["transactions:all:sell_usd"]
    assert scored["passed"] is False


FULL_VERDICT = ("Analytici\nPrůměrná cílová cena je vyšší.\n\nOcenění\nModel vychází výš než cena.\n\nRizika\nPozice je velká.\n\n"
                "Verdikt\nZávěr vychází z poměru férové hodnoty k ceně.\nZávěr: spíš atraktivní. Jistota: střední.\n"
                "Co by závěr změnilo: Slabší výsledky.\nRozhodnutí je na tobě – nejde o investiční doporučení.")


def test_a_verdict_is_structural_not_a_keyword():
    buy = case(expect_verdict=True, scenario="buy")
    assert score_case(buy, result(FULL_VERDICT), {})["checks"]["verdict"] is True
    broken = {
        "confidence": FULL_VERDICT.replace(" Jistota: střední.", ""),
        "would_change": FULL_VERDICT.replace("Co by závěr změnilo: Slabší výsledky.\n", ""),
        "risks": FULL_VERDICT.replace("Rizika\nPozice je velká.\n\n", ""),
        "basis": FULL_VERDICT.replace("Závěr vychází z poměru férové hodnoty k ceně.\n", ""),
        "verdict": FULL_VERDICT.replace("Závěr: spíš atraktivní.", "Závěr: kupuj hned."),
    }
    for part, text in broken.items():
        scored = score_case(buy, result(text), {})
        assert scored["checks"]["verdict"] is False, part
        assert part in scored["checks"]["verdict_detail"]["missing"], part


def test_an_insufficient_verdict_with_high_confidence_is_inconsistent():
    outage = case(expect_verdict=True, expect_insufficient=True, scenario="outage")
    text = ("Rizika\nTuto akcii zatím nedržíš.\n\nVerdikt\nPro závěr chybí: ocenění.\nZávěr: nedostatek dat. Jistota: vysoká.\n"
            "Co by závěr změnilo: Doplnění chybějících údajů.")
    scored = score_case(outage, result(text), {})
    assert scored["checks"]["verdict"] is False
    assert "confidence" in scored["checks"]["verdict_detail"]["missing"]


def test_a_verdict_in_english_and_slovak_is_parsed_the_same_way():
    en = ("Analysts\nx y z.\n\nValuation\nThe model is above the price.\n\nRisks\nLarge position.\n\nVerdict\nThe conclusion follows from the ratio.\n"
          "Conclusion: rather expensive. Confidence: low.\nWhat would change it: A lower price.")
    sk = ("Analytici\nx y z.\n\nOcenenie\nModel je nad cenou.\n\nRiziká\nVeľká pozícia.\n\nVerdikt\nZáver vychádza z pomeru.\n"
          "Záver: férovo ocenená. Istota: stredná.\nČo by záver zmenilo: Pokles ceny.")
    assert score_case(case(lang="en", expect_verdict=True, scenario="buy"), result(en), {})["checks"]["verdict"] is True
    assert score_case(case(lang="sk", expect_verdict=True, scenario="buy"), result(sk), {})["checks"]["verdict"] is True


def test_rendered_labels_from_the_real_template_are_read_with_their_meaning():
    lots = {"id": "lots:lot_1:shares", "value": 4, "unit": "shares", "ticker": "SYNA", "source": "tax_model", "as_of": "2026-10-23T12:00:00Z"}
    assert score_case(case(), result("kusy v lotu SYNA (lot 1): 4", [lots]), {})["checks"]["unverified_numbers"] == []
    alloc = {"id": "holding:SYNA:allocation", "value": 49.2, "unit": "percent", "ticker": "SYNA", "source": "portfolio_model", "as_of": "2026-10-23T12:00:00Z"}
    text = "The position is already 49.2% of your portfolio, buying more raises concentration."
    assert score_case(case(lang="en"), result(text, [alloc]), {})["checks"]["unverified_numbers"] == []
    cash = {"id": "portfolio:cash", "value": 100, "unit": "money", "currency": "USD", "source": "portfolio_model", "as_of": "2026-10-23T12:00:00Z"}
    golden = {"portfolio:cash": cash}
    sk = case(lang="sk", golden=[{"tool": "get_portfolio_summary", "args": {}, "fact_ids": ["portfolio:cash"]}])
    assert score_case(sk, result("• hotovosť: 100,00 USD", [cash]), golden)["checks"]["required_missing"] == []


# --- Běh 21d: natural sentences keep the meaning check ------------------------------------------------------------

REALIZED = {k: {"id": f"realized:2026:{k}", "value": v, "unit": "money", "currency": "CZK", "source": "realized_model",
                "as_of": "2026-10-23T12:00:00Z", "period": TX_PERIOD} for k, v in [("net", 1506.95), ("gains", 1506.95), ("losses", 0), ("proceeds", 6221.10)]}
REALIZED_GOLDEN = {f["id"]: f for f in REALIZED.values()}
REALIZED_CASE = case(scenario="realized", golden=[{"tool": "get_realized_pnl", "args": {}, "fact_ids": list(REALIZED_GOLDEN)}])


def test_natural_transaction_sentences_carry_every_required_meaning():
    for lang, text in [
        ("cs", "Letos (1. 1. 2026 – 23. 10. 2026) jsi nic nenakoupil a prodal 2 kusy za 300,00 USD, celkem 1 obchod."),
        ("sk", "Tento rok (1. 1. 2026 – 23. 10. 2026) si nič nenakúpil a predal 2 kusy za 300,00 USD, spolu 1 obchod."),
        ("en", "This year (Jan 1, 2026 – Oct 23, 2026), you did not buy anything and sold 2 units for USD 300.00, 1 trade in total."),
    ]:
        scored = score_case({**TX_CASE, "lang": lang}, result(text, list(TX.values())), TX_GOLDEN)
        assert scored["checks"]["unverified_numbers"] == [], (lang, scored["checks"])
        assert scored["checks"]["required_missing"] == [], (lang, scored["checks"])


def test_both_trade_sides_in_one_sentence_keep_their_own_meaning():
    tx = {**TX, "buy_count": {**TX["buy_count"], "value": 1}, "bought_shares": {**TX["bought_shares"], "value": 5},
          "buy_usd": {**TX["buy_usd"], "value": 500}, "count": {**TX["count"], "value": 2}}
    golden = {f["id"]: f for f in tx.values()}
    text = ("Letos (1. 1. 2026 – 23. 10. 2026) jsi nakoupil 5 kusů za 500,00 USD a prodal 2 kusy za 300,00 USD, "
            "celkem 2 obchody, z toho 1 nákup a 1 prodej.")
    scored = score_case(TX_CASE, result(text, list(tx.values())), golden)
    assert scored["checks"]["unverified_numbers"] == [] and scored["checks"]["required_missing"] == [], scored["checks"]
    # The sums swapped between the sides are wrong meanings, not just other numbers.
    swapped = "Letos (1. 1. 2026 – 23. 10. 2026) jsi nakoupil 5 kusů za 300,00 USD a prodal 2 kusy za 500,00 USD."
    assert sorted(score_case(TX_CASE, result(swapped, list(tx.values())), golden)["checks"]["unverified_numbers"]) == ["300,00 USD", "500,00 USD"]


def test_a_zero_needs_an_explicit_statement_of_that_side():
    # Nothing said about buying: the zero buys are still missing.
    text = "Letos (1. 1. 2026 – 23. 10. 2026) jsi prodal 2 kusy za 300,00 USD, celkem 1 obchod."
    missing = score_case(TX_CASE, result(text, list(TX.values())), TX_GOLDEN)["checks"]["required_missing"]
    assert sorted(missing) == ["transactions:all:bought_shares", "transactions:all:buy_count", "transactions:all:buy_usd"]
    # A "nothing bought" statement never stands for a non-zero value.
    tx = {**TX, "bought_shares": {**TX["bought_shares"], "value": 5}}
    text = "Letos (1. 1. 2026 – 23. 10. 2026) jsi nic nenakoupil a prodal 2 kusy za 300,00 USD, celkem 1 obchod."
    assert "transactions:all:bought_shares" in score_case(TX_CASE, result(text, list(tx.values())), {f["id"]: f for f in tx.values()})["checks"]["required_missing"]


def test_a_numeral_noun_is_the_meaning_of_its_number_only():
    # "2 obchody" are trades, not shares sold, even after a sell verb.
    assert "transactions:all:sold_shares" in score_case(TX_CASE, result("Prodal jsi 2 obchody.", list(TX.values())), TX_GOLDEN)["checks"]["required_missing"]
    # A shares count does not lend its noun to the amount after it: the amount keeps the sentence's verb.
    numbers = extract_numbers("Prodal jsi 2 kusy za 300,00 USD.", "cs")
    assert numbers[0]["tags"] == {"sell", "units"} and numbers[1]["tags"] == {"sell"}
    # A new sentence does not inherit the previous one's meaning.
    assert extract_numbers("Prodal jsi 2 kusy. Za 300,00 USD.", "cs")[1]["tags"] == set()


def test_natural_realized_sentence_with_no_losses_passes_and_a_loss_keeps_its_sign():
    text = "Letos (1. 1. 2026 – 23. 10. 2026) jsi realizoval zisk 1 506,95 Kč. Tržby z prodejů byly 6 221,10 Kč a žádné ztráty jsi neměl."
    scored = score_case(REALIZED_CASE, result(text, list(REALIZED.values())), REALIZED_GOLDEN)
    assert scored["passed"] is True, scored["checks"]
    loss = {**REALIZED["net"], "value": -50}
    flipped = score_case(REALIZED_CASE, result("Letos (1. 1. 2026 – 23. 10. 2026) jsi realizoval zisk 50,00 Kč.", [loss]), {})
    assert flipped["checks"]["unverified_numbers"] == ["50,00 Kč"]
    named = score_case(REALIZED_CASE, result("Letos (1. 1. 2026 – 23. 10. 2026) jsi realizoval ztrátu 50,00 Kč.", [loss]), {})
    assert named["checks"]["unverified_numbers"] == []


def test_slovak_taxable_gain_keeps_its_meaning():
    taxable = {"id": "sale:SYNB:taxable_gain", "value": 565.64, "unit": "money", "currency": "CZK", "ticker": "SYNB", "source": "tax_model", "as_of": "2026-10-23T12:00:00Z"}
    text = "Zisk z predaja by bol 1,00 CZK, zdaniteľný zisk 565,64 CZK a daň navyše 0,00 CZK."
    assert "taxable" in extract_numbers(text, "sk")[1]["tags"]


# Production fix 2026-10-24: today's movers (portfolio and per-position change today) carry the meaning "change".
MOVERS = {
    "portfolio:day_change": {"id": "portfolio:day_change", "value": 25, "unit": "money", "currency": "USD", "source": "portfolio_model", "as_of": "2026-10-23T12:00:00Z"},
    "portfolio:day_change_pct": {"id": "portfolio:day_change_pct", "value": 0.8264, "unit": "percent", "source": "portfolio_model", "as_of": "2026-10-23T12:00:00Z"},
    "holding:SYNA:day_change": {"id": "holding:SYNA:day_change", "value": 20, "unit": "money", "currency": "USD", "ticker": "SYNA", "source": "portfolio_model", "as_of": "2026-10-23T12:00:00Z"},
    "holding:SYNA:day_change_pct": {"id": "holding:SYNA:day_change_pct", "value": 1.3514, "unit": "percent", "ticker": "SYNA", "source": "portfolio_model", "as_of": "2026-10-23T12:00:00Z"},
}
MOVERS_CASE = case(scenario="movers", turns=["Co se dnes děje s mými akciemi?"],
                   golden=[{"tool": "get_holdings", "args": {"dayChange": True}, "fact_ids": list(MOVERS)}])


def test_todays_movers_need_the_change_meaning_and_their_sign():
    text = ("Dnes se hodnota tvého portfolia změnila o +25,00 USD (+0,8 %). Největší dnešní změny:\n"
            "• SYNA: změna +1,4 % (+20,00 USD).")
    scored = score_case(MOVERS_CASE, result(text, list(MOVERS.values())), MOVERS)
    assert scored["passed"] is True, scored["checks"]
    as_value = score_case(MOVERS_CASE, result("Hodnota portfolia je 25,00 USD (0,8 %). Pozice SYNA má hodnotu 20,00 USD (1,4 %).", list(MOVERS.values())), MOVERS)
    assert set(as_value["checks"]["required_missing"]) == set(MOVERS)
    falling = {**MOVERS["holding:SYNA:day_change"], "value": -20}
    flipped = score_case(case(), result("• SYNA: změna +1,4 % (+20,00 USD).", [falling, MOVERS["holding:SYNA:day_change_pct"]]), {})
    assert flipped["checks"]["unverified_numbers"] == ["+20,00 USD"]


MOVE = {
    "history:SYNN:change_pct": {"id": "history:SYNN:change_pct", "value": -17.916666, "unit": "percent", "ticker": "SYNN", "source": "price_history",
                                "as_of": "2026-10-22", "period": {"from": "2026-10-16", "to": "2026-10-22"}},
    "history:SYNN:first_close": {"id": "history:SYNN:first_close", "value": 120, "unit": "money", "currency": "USD", "ticker": "SYNN",
                                 "source": "price_history", "as_of": "2026-10-22", "period": {"from": "2026-10-16", "to": "2026-10-22"}},
    "history:SYNN:last_close": {"id": "history:SYNN:last_close", "value": 98.5, "unit": "money", "currency": "USD", "ticker": "SYNN",
                                "source": "price_history", "as_of": "2026-10-22", "period": {"from": "2026-10-16", "to": "2026-10-22"}},
    "history:SYNN:max_drawdown_pct": {"id": "history:SYNN:max_drawdown_pct", "value": -20.564516, "unit": "percent", "ticker": "SYNN",
                                      "source": "price_history", "as_of": "2026-10-22", "period": {"from": "2026-10-16", "to": "2026-10-22"}},
    "history:SPX:change_pct": {"id": "history:SPX:change_pct", "value": 0.975976, "unit": "percent", "ticker": "SPX", "source": "benchmark_history",
                               "as_of": "2026-10-22", "period": {"from": "2026-10-16", "to": "2026-10-22"}},
    "history:SYNP:change_pct": {"id": "history:SYNP:change_pct", "value": -12.0, "unit": "percent", "ticker": "SYNP", "source": "price_history",
                                "as_of": "2026-10-22", "period": {"from": "2026-10-16", "to": "2026-10-22"}},
}
NEWS = {"id": "news:SYNN:n4", "value": "Business Wire | 2026-10-19 | Synthetic Neocloud prices $2 billion convertible notes offering — The company plans "
        "to raise $2 billion in convertible notes to fund new GPU capacity.", "unit": "text", "ticker": "SYNN", "source": "stock_news", "as_of": "2026-10-19"}
MOVE_CASE = case(id="move-cs-1", scenario="move", golden=[{"tool": "get_price_history", "fact_ids": ["history:SYNN:change_pct", "history:SPX:change_pct",
                                                                                                      "history:SYNN:max_drawdown_pct"]}])
MOVE_TEXT = ("Co se stalo\nOd 16. 10. 2026 do 22. 10. 2026 se cena SYNN změnila o -17,9 % (z 120,00 USD na 98,50 USD).\n"
             "Největší propad od maxima v tomto období byl -20,6 %.\nIndex S&P 500 se za stejné období změnil o +1,0 %.\n"
             "Podobné firmy za stejné období:\n• SYNP: změna -12,0 %")


def test_a_move_answer_needs_change_drawdown_and_index_with_their_meaning():
    scored = score_case(MOVE_CASE, result(MOVE_TEXT, list(MOVE.values())), MOVE)
    assert scored["passed"] is True, scored["checks"]
    # The drawdown said as a plain change, or the index change on the stock's line, is not the required datum.
    swapped = MOVE_TEXT.replace("Největší propad od maxima v tomto období byl", "Cena se pak změnila o")
    assert score_case(MOVE_CASE, result(swapped, list(MOVE.values())), MOVE)["checks"]["required_missing"] == ["history:SYNN:max_drawdown_pct"]
    one_line = MOVE_TEXT.replace("\nIndex S&P 500 se za stejné období změnil o +1,0 %.", "").replace(
        "98,50 USD).", "98,50 USD), index S&P 500 se za stejné období změnil o +1,0 %.")
    assert "history:SPX:change_pct" in score_case(MOVE_CASE, result(one_line, list(MOVE.values())), MOVE)["checks"]["required_missing"]


def test_a_verbatim_quote_of_a_news_item_may_carry_its_own_figure_and_nothing_else_may():
    quoted = MOVE_TEXT + "\n• Podle Business Wire chce firma získat „$2 billion in convertible notes“ (Business Wire, 19. 10. 2026)"
    scored = score_case(MOVE_CASE, result(quoted, [*MOVE.values(), NEWS]), MOVE)
    assert scored["checks"]["unverified_numbers"] == [], scored["checks"]
    invented = MOVE_TEXT + "\n• Podle Business Wire chce firma získat „$3 billion in convertible notes“."
    assert score_case(MOVE_CASE, result(invented, [*MOVE.values(), NEWS]), MOVE)["checks"]["unverified_numbers"] != []
    unquoted = MOVE_TEXT + "\n• Firma chce získat 2 miliardy."
    assert score_case(MOVE_CASE, result(unquoted, [*MOVE.values(), NEWS]), MOVE)["checks"]["unverified_numbers"] == ["2"]


def test_a_long_fallback_extract_of_up_to_320_characters_is_still_a_quote():
    long_news = {**NEWS, "value": NEWS["value"] + " " + "The offering was priced after the close and the company said demand from investors was strong. " * 3}
    extract = long_news["value"].split(" — ", 1)[1][:318].rsplit(" ", 1)[0]
    assert 240 < len(extract) <= 320
    quoted = MOVE_TEXT + f"\n• **Business Wire, 19. 10. 2026:** „{extract}“"
    assert score_case(MOVE_CASE, result(quoted, [*MOVE.values(), long_news]), MOVE)["checks"]["unverified_numbers"] == []


def test_an_analyst_theme_may_state_a_figure_of_the_news_item_it_cites_and_nothing_else():
    theme = MOVE_TEXT + "\n• **Nové dluhopisy:** Podle Business Wire firma vydá dluhopisy za 2 miliardy dolarů. (Zdroj: Business Wire, 19. 10. 2026)"
    assert score_case(MOVE_CASE, result(theme, [*MOVE.values(), NEWS]), MOVE)["checks"]["unverified_numbers"] == []
    invented = theme.replace("za 2 miliardy", "za 3 miliardy")
    assert score_case(MOVE_CASE, result(invented, [*MOVE.values(), NEWS]), MOVE)["checks"]["unverified_numbers"] == ["3"]
    # Without news facts of the run, a cited line is still checked.
    assert score_case(MOVE_CASE, result(theme, list(MOVE.values())), MOVE)["checks"]["unverified_numbers"] == ["2"]


def test_an_analyst_theme_may_round_the_cited_figure_but_not_change_it():
    news = {**NEWS, "value": NEWS["value"] + " Shares are down 20.08% over one week."}
    theme = MOVE_TEXT + "\n• **Týdenní propad:** Podle Business Wire akcie za týden ztratila asi 20 %. (Zdroj: Business Wire, 19. 10. 2026)"
    assert score_case(MOVE_CASE, result(theme, [*MOVE.values(), news]), MOVE)["checks"]["unverified_numbers"] == []
    changed = theme.replace("asi 20 %", "asi 25 %")
    assert score_case(MOVE_CASE, result(changed, [*MOVE.values(), news]), MOVE)["checks"]["unverified_numbers"] == ["25 %"]
