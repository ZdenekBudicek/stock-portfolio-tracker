"""Scoring of one chat answer against its own evidence (eval audit) and the golden tool results.

Independent of the server's grounding code: numbers are read back from the rendered text by locale,
with sign, currency, the tickers of their line, the meaning words in front of them and the years
around them. A number counts as verified only when a fact of this run has the same value AND the
claimed meaning (metric), period, ticker and sign; golden tool results are never trusted as evidence
of the answer, they only say what the answer must contain. A failed or unterminated request is a
failed case and stays in the denominator.
"""

from __future__ import annotations

import re
from typing import Any

from .client import ChatResult

# Same idea as the TypeScript TECHNICAL check, written independently: fact IDs, tool and field names, raw JSON.
TECHNICAL = re.compile(r"(\b[a-z]+:[A-Za-z0-9_.-]+(:|\b)|\bget_[a-z_]+|\bcalculate\b|\bas_of\b|\bfactId\b|[{}\[\]<>]|\b[a-z]+_[a-z_]+\b|price_cache|portfolio_model)")
CURRENCIES = {"USD", "CZK", "EUR", "GBP", "PLN", "USDT"}
SYMBOLS = {"Kč": "CZK", "€": "EUR", "$": "USD"}
NOT_TICKERS = CURRENCIES | {"ETF", "S&P", "SPX", "DCF", "EPS", "CNB", "ČNB", "AI", "OK", "PE"}

NUM = {
    "en": r"\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?",
    "cs": r"\d{1,3}(?:[   ]\d{3})+(?:,\d+)?|\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?",
}
NUM["sk"] = NUM["cs"]
TOKEN = {lang: re.compile(
    r"(?<![\w.,])(?P<sign>[-−+]\s?)?(?P<pre>(?:[A-Z]{3,4}|Kč|€|\$)[  ]?)?(?P<num>" + pattern + r")(?![\w])(?P<post>[   ]?(?:%|Kč|€|[A-Z]{3,4}\b))?")
    for lang, pattern in NUM.items()}
# Full dates carry a year (a period), times and "S&P 500" carry none; none of them is a numeric claim.
DATED = [
    re.compile(r"\b\d{1,2}\.\s?\d{1,2}\.\s?(?P<y>\d{4})(?:,?\s\d{1,2}:\d{2})?"),
    re.compile(r"\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}, (?P<y>\d{4})(?:, \d{1,2}:\d{2}\s?[AP]M)?"),
    re.compile(r"\b(?P<y>\d{4})-\d{2}-\d{2}(?:T[\d:.]+Z?)?"),
]
# Lot ordinals ("(lot 2)") are labels, not amounts.
UNDATED = [re.compile(r"\b\d{1,2}:\d{2}\b"), re.compile(r"S&P 500"), re.compile(r"\(lot \d+\)")]
# A bare year ("za rok 2025") names a period; a year followed by a unit is an amount.
YEAR = re.compile(r"(?<![\d.,])(?<!\d[   ])(?P<y>19[89]\d|20\d\d|2100)(?!\d|[.,]\d|[   ]?(?:%|Kč|€|USD|CZK|EUR|GBP|PLN|USDT|\d))")
SOURCES_LINE = re.compile(r"^(Zdroje|Sources):.*$", re.MULTILINE)

# Meaning words, written independently of the server's labels (cs/sk/en stems).
TAGS = {name: re.compile(pattern, re.IGNORECASE) for name, pattern in {
    "tax": r"\bda[nň]|\btax",
    "base": r"základ|\bbase\b",
    "taxable": r"zdaniteln|zdaniteľn|taxable",
    "dividend": r"dividend",
    "fair": r"férov|fair[ -]value|vnitřní hodnot",
    "target": r"cílov|cieľov|\bcíl|\bcieľ|target",
    "sell": r"\bprod[aáeé]|\bpred[aáeé]|\bsold\b|\bsell|\bsale|příj[em]|príj[em]|proceeds|tržb",
    "buy": r"nakoup|nakúp|nákup|bought|\bbuy",
    "gain": r"zisk|ztrát|ztrat|\bstrat|\bgain|\bloss|profit|výsled|realiz",
    "return": r"výnos|\breturn",
    "change": r"změn|zmen|change|\broste|\bklesá|\bvzrost|\bpokles",
    # Counted things are told apart: pieces held or traded, trades, and other counts (lots, payments, positions).
    "count": r"počet|number of|\blot|výplat|\bpayments?\b",
    "units": r"\bkus|\bks\b|\bunits?\b|\bshares\b",
    "trades": r"obchod|\btrades?\b|nákup|\bprodej|\bpredaj|\bbuys?\b|\bsales?\b|\bsells\b|purchases?",
    "cash": r"hotovos[tť]|\bcash",
    "value": r"hodnot|\bvalue|worth",
    "price": r"\bcen[aeuyěo]|price|zavírac|záverečn|\bclose",
    "fx": r"kurz|exchange rate|\bfx\b",
    "share": r"podíl|podiel|share of|allocation|alokac|tvoří|tvorí|^\W*of (?:your|the) portfolio",
    "fee": r"poplat|\bfees?\b",
    # The largest fall from a high within a period (move explanation, Běh 22).
    "drawdown": r"propad|prepad|drawdown|from (?:a|the|its) high|od maxima|z maxima",
}.items()}
# A bare number's counted noun ("2 kusy", "3 trades") and the sentence boundary that ends a shared phrase.
NUMERAL_NOUN = re.compile(r"[   ]*([^\W\d_]+)")
# Held positions are counted only as a numeral noun ("3 pozice"); "the position is 49 %" is not a count.
POSITIONS = re.compile(r"pozic|pozíci|positions?$", re.IGNORECASE)
BOUNDARY = re.compile(r"[.;!?](?:\s|$)|\n")
LOSS = re.compile(r"ztrát|ztrat|\bstrat|\bloss", re.IGNORECASE)
GAIN = re.compile(r"zisk|\bgain|profit", re.IGNORECASE)

# Which meaning a fact has (by its server key): every listed tag must be present for a required value.
FACT_TAGS: list[tuple[re.Pattern, frozenset]] = [(re.compile(p), frozenset(t)) for p, t in [
    (r"^tax:[^:]+:(tax_base|taxable_base)$", {"tax", "base"}),
    (r"^tax:[^:]+:estimated_tax$", {"tax"}),
    (r"^tax:[^:]+:(proceeds|limit_base)$", {"sell"}),
    (r"^sale:[^:]+:taxable_gain$", {"taxable"}),
    (r"^sale:[^:]+:(tax_delta|extra_tax|estimated_tax_after)$", {"tax"}),
    (r"^sale:[^:]+:gain$", {"gain"}),
    (r"^sale:[^:]+:proceeds$", {"sell"}),
    (r"^sale:[^:]+:(shares|missing_shares)$", {"units"}),
    (r"^sale:[^:]+:price$", {"price"}),
    (r"^sale:[^:]+:fee$", {"fee"}),
    (r"^sale:[^:]+:(sale_fx|assumed_local_fx)$", {"fx"}),
    (r"^realized:[^:]+:(net|gains|losses)$", {"gain"}),
    (r"^realized:[^:]+:proceeds$", {"sell"}),
    (r"^realized:[^:]+:dividends$", {"dividend"}),
    (r"^dividends:withheld$", {"dividend", "tax"}),
    (r"^dividends:count$", {"dividend", "count"}),
    (r"^dividends:", {"dividend"}),
    (r"^transactions:[^:]+:count$", {"trades"}),
    (r"^transactions:[^:]+:buy_count$", {"trades", "buy"}),
    (r"^transactions:[^:]+:sell_count$", {"trades", "sell"}),
    (r"^transactions:[^:]+:bought_shares$", {"units", "buy"}),
    (r"^transactions:[^:]+:sold_shares$", {"units", "sell"}),
    (r"^transactions:[^:]+:buy_usd$", {"buy"}),
    (r"^transactions:[^:]+:sell_usd$", {"sell"}),
    (r"^transactions:[^:]+:fees_usd$", {"fee"}),
    (r"^history:[^:]+:max_drawdown_pct$", {"drawdown"}),
    (r"^(quote:[^:]+:(price|previous_close)|history:[^:]+:(last_close|first_close))$", {"price"}),
    (r"^(quote|history):[^:]+:change_pct$", {"change"}),
    (r"^performance:[^:]+:price_change$", {"change"}),
    (r"^performance:.*return", {"return"}),
    (r"^performance:profit$", {"gain"}),
    (r"^fair_value:[^:]+:(value|sensitivity_low|sensitivity_high)$", {"fair"}),
    (r"^analysts:[^:]+:target_", {"target"}),
    (r"^watchlist:[^:]+:target$", {"target"}),
    (r"^(portfolio|holding:[^:]+):day_change(_pct)?$", {"change"}),
    (r"^(portfolio:total_value|holding:[^:]+:value)$", {"value"}),
    (r"^portfolio:cash$", {"cash"}),
    (r"^(portfolio:(total_profit|unrealized_profit)|holding:[^:]+:profit)$", {"gain"}),
    (r"^portfolio:usd_", {"fx"}),
    (r"^(portfolio:holding_count|lots:[^:]+:count)$", {"count"}),
    (r"^(holding:[^:]+:shares|lots:)", {"units"}),
    (r"^(allocation:|holding:[^:]+:allocation)", {"share"}),
]]

# Structure of a buy verdict (product contract), per language.
SECTIONS = {
    "cs": {"Analytici": "analysts", "Ocenění": "valuation", "Kontext": "context", "Rizika": "risks", "Verdikt": "verdict"},
    "sk": {"Analytici": "analysts", "Ocenenie": "valuation", "Kontext": "context", "Riziká": "risks", "Verdikt": "verdict"},
    "en": {"Analysts": "analysts", "Valuation": "valuation", "Context": "context", "Risks": "risks", "Verdict": "verdict"},
}
VERDICTS = {
    "cs": {"spíš atraktivní": "attractive", "férově oceněná": "fair", "spíš drahá": "expensive", "nedostatek dat": "insufficient"},
    "sk": {"skôr atraktívna": "attractive", "férovo ocenená": "fair", "skôr drahá": "expensive", "nedostatok údajov": "insufficient"},
    "en": {"rather attractive": "attractive", "fairly valued": "fair", "rather expensive": "expensive", "insufficient data": "insufficient"},
}
CONFIDENCE = {"cs": {"nízká": "low", "střední": "medium", "vysoká": "high"}, "sk": {"nízka": "low", "stredná": "medium", "vysoká": "high"},
              "en": {"low": "low", "medium": "medium", "high": "high"}}
CONCLUSION = {"cs": "Závěr", "sk": "Záver", "en": "Conclusion"}
CONFIDENCE_LABEL = {"cs": "Jistota", "sk": "Istota", "en": "Confidence"}
WOULD_CHANGE = {"cs": "Co by závěr změnilo", "sk": "Čo by záver zmenilo", "en": "What would change it"}
DECISION = re.compile(r"Rozhodnutí je na tobě|Rozhodnutie je na tebe|The decision is yours", re.IGNORECASE)
REFUSAL = re.compile(r"nemohu doporučit|nemôžem odporučiť|cannot (?:give|provide|recommend)|can't recommend|not able to recommend", re.IGNORECASE)
# A refusal to answer at all (used only when the data the case needs exist and are missing from the answer).
REFUSED = re.compile(r"nemám k dispozici|nejsou k dispozici|není k dispozici|nie sú k dispozícii|nie je k dispozícii|nemám k dispozícii|"
                     r"not available|unavailable|nemohu|nemôžem|cannot|can't|nepodařilo|nepodarilo|could not|couldn't|nedokážu", re.IGNORECASE)

CALL_TOKEN_LIMIT = 3_000
# The news analyst's call (Běh 23b) may use 5,000; an attempt says which cap admitted it, never more than this.
ANALYST_CALL_TOKEN_LIMIT = 5_000
QUESTION_TOKEN_LIMIT = 8_000


def parse_localized_number(text: str, lang: str, unit: str | None = None) -> float:
    """A number as written in `lang`. In Czech/Slovak "98.650" groups thousands unless the unit
    (percent, ratio) makes a decimal point the only sensible reading; in English "." is decimal."""
    s = text.replace(" ", " ").replace(" ", " ").replace("−", "-").strip()
    if lang == "en":
        return float(s.replace(",", "").replace(" ", ""))
    s = s.replace(" ", "")
    if "," in s:
        return float(s.replace(".", "").replace(",", "."))
    if re.fullmatch(r"-?\d{1,3}(?:\.\d{3})+", s) and unit not in ("percent", "ratio"):
        return float(s.replace(".", ""))
    return float(s)


def _mask(line: str) -> tuple[str, list[tuple[int, int]]]:
    """The line with dates, times and bare years blanked (same length), plus each year's position."""
    years: list[tuple[int, int]] = []
    chars = list(line)

    def blank(start: int, end: int) -> None:
        chars[start:end] = " " * (end - start)

    for pattern in DATED:
        for m in pattern.finditer("".join(chars)):
            years.append((m.start(), int(m.group("y"))))
            blank(m.start(), m.end())
    for pattern in UNDATED:
        for m in pattern.finditer("".join(chars)):
            blank(m.start(), m.end())
    for m in YEAR.finditer("".join(chars)):
        years.append((m.start(), int(m.group("y"))))
        blank(m.start(), m.end())
    return "".join(chars), years


def _tags(text: str) -> set[str]:
    return {name for name, pattern in TAGS.items() if pattern.search(text)}


def extract_numbers(text: str, lang: str) -> list[dict]:
    """Numeric claims of an answer: raw text, value with sign, currency/percent, the tickers of its line,
    the meaning words in front of it (or after it when nothing precedes) and the years around it."""
    out: list[dict] = []
    for line in SOURCES_LINE.sub("", text).split("\n"):
        masked, years = _mask(line)
        tickers = {t for t in re.findall(r"(?<![\w])[A-Z][A-Z0-9]{1,5}(?:\.[A-Z])?(?![\w])", masked) if t not in NOT_TICKERS}
        matches = list(TOKEN.get(lang, TOKEN["cs"]).finditer(masked))
        noun_end, phrase_tags, phrase_loss = 0, set(), False
        for i, m in enumerate(matches):
            pre = (m.group("pre") or "").strip()
            post = (m.group("post") or "").strip()
            if pre and pre not in CURRENCIES and pre not in SYMBOLS:
                pre = ""  # a ticker or word before a number, not its currency
            percent = post == "%"
            currency = SYMBOLS.get(pre, pre) or (SYMBOLS.get(post, post) if post and not percent and (post in CURRENCIES or post in SYMBOLS) else "")
            num = m.group("num")
            value = parse_localized_number(num, lang, "percent" if percent else None)
            if (m.group("sign") or "").strip() in ("-", "−"):
                value = -value
            sep = "." if lang == "en" else ","
            decimals = len(num.split(sep)[1]) if sep in num else 0
            raw = m.group(0).strip()
            if post and not percent and post not in CURRENCIES and post not in SYMBOLS:
                raw = raw[: raw.rfind(post)].strip()
            start = matches[i - 1].end() if i else 0
            end = matches[i + 1].start() if i + 1 < len(matches) else len(line)
            # The counted noun right after the previous bare number ("2 kusy") is that number's, not this one's.
            window = max(start, noun_end)
            before, after = line[window:m.start()], line[m.end():end]
            own, loss_word = _tags(before), bool(LOSS.search(before) and not GAIN.search(before))
            if not own and i and not BOUNDARY.search(masked[window:m.start()]):
                # "prodal 2 kusy za 300 USD": an amount continuing the same phrase keeps that phrase's meaning words.
                own, loss_word = set(phrase_tags), phrase_loss
            phrase_tags, phrase_loss = own, loss_word
            noun: set[str] = set()
            noun_end = 0
            if not currency and not percent:
                word = NUMERAL_NOUN.match(masked, m.end())
                if word:
                    noun, noun_end = _tags(word.group(1)) | ({"count"} if POSITIONS.match(word.group(1)) else set()), word.end()
            tags = (own | noun) or _tags(after)
            out.append({"raw": raw, "value": value, "currency": currency or None, "percent": percent, "decimals": decimals, "tickers": tickers,
                        "tags": tags, "loss_word": loss_word,
                        "years": {y for pos, y in years if start <= pos < end}})
    return out


# An explicit statement that a quantity is zero, by fact key (cs/sk/en); it stands only for a fact whose value IS zero.
ZERO_STATEMENTS: list[tuple[re.Pattern, re.Pattern]] = [(re.compile(k), re.compile(p, re.IGNORECASE)) for k, p in [
    (r"^transactions:", r"žádný obchod|žiadny obchod|\bno trades\b"),
    (r"^transactions:[^:]+:(buy_count|bought_shares|buy_usd)$", r"\bnic\s+(?:jsi\s+)?nenakoupil|\bnič\s+(?:si\s+)?nenakúpil|did not buy anything|bought nothing"),
    (r"^transactions:[^:]+:(sell_count|sold_shares|sell_usd)$", r"\bnic\s+(?:jsi\s+)?neprodal|\bnič\s+(?:si\s+)?nepredal|did not sell anything|sold nothing"),
    (r"^realized:[^:]+:losses$", r"žádné ztráty|žiadne straty|\bno losses\b"),
    (r"^realized:[^:]+:gains$", r"žádné zisky|žiadne zisky|\bno gains\b"),
    (r"^realized:[^:]+:proceeds$", r"žádné tržby|žiadne tržby|\bno sale proceeds\b"),
    (r"^(realized:[^:]+:dividends|dividends:(received|count))$", r"žádné dividendy|žiadne dividendy|\bno dividends\b"),
]]


def zero_stated(fact: dict, text: str) -> bool:
    value = fact.get("value")
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != 0:
        return False
    key = _key(fact)
    return any(k.search(key) and p.search(text) for k, p in ZERO_STATEMENTS)


def _key(fact: dict) -> str:
    return str(fact.get("metric") or fact.get("id") or "").split("#")[0]


def fact_tags(fact: dict) -> frozenset:
    key = _key(fact)
    return next((tags for pattern, tags in FACT_TAGS if pattern.search(key)), frozenset())


def _fact_years(fact: dict) -> set[int] | None:
    period = fact.get("period")
    if isinstance(period, dict) and period.get("from") and period.get("to"):
        return set(range(int(str(period["from"])[:4]), int(str(period["to"])[:4]) + 1))
    m = re.match(r"^[a-z_]+:(\d{4}):", _key(fact))
    return {int(m.group(1))} if m else None


def _value_matches(number: dict, fact: dict) -> bool:
    value = fact.get("value")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    if fact.get("ticker") and number["tickers"] and fact["ticker"] not in number["tickers"]:
        return False
    unit = fact.get("unit")
    if number["percent"]:
        if unit not in ("percent", "ratio"):
            return False
        candidates = [value, value * 100]
    elif number["currency"]:
        if unit != "money" or (fact.get("currency") and fact["currency"] != number["currency"]):
            return False
        candidates = [value]
    else:
        if unit == "money" and fact.get("currency"):
            return False
        candidates = [value, value * 100] if unit == "ratio" else [value]
    tolerance = 0.5 * 10 ** -number["decimals"] + 1e-9
    shown = [number["value"]]
    if number["loss_word"] and number["value"] > 0:
        shown.append(-number["value"])  # "ztráta 3,35 USD" is −3,35 USD
    return any(abs(s - c) <= tolerance for s in shown for c in candidates)


def _period_matches(number: dict, fact: dict) -> bool:
    years = _fact_years(fact)
    return not (years and number["years"]) or number["years"] <= years


def matches(number: dict, fact: dict, *, required: bool = False) -> bool:
    """Same value, ticker, sign and period, and the meaning in the text is the fact's own: for a required
    value every meaning word of the fact must be there; otherwise a contradicting meaning is enough to fail."""
    if not (_value_matches(number, fact) and _period_matches(number, fact)):
        return False
    tags = fact_tags(fact)
    if not tags:
        return True
    if required:
        return tags <= number["tags"]
    return not number["tags"] or bool(tags & number["tags"])


def _trusted_facts(result: ChatResult) -> list[dict]:
    """The run's own evidence only (eval audit facts and calculations); never the golden tool results."""
    audit = result.audit or {}
    calcs = [c.get("result") for c in audit.get("calculations", []) if isinstance(c, dict) and isinstance(c.get("result"), dict)]
    return [f for f in [*audit.get("facts", []), *calcs] if isinstance(f, dict)]


def _same_fact(a: dict, b: dict) -> bool:
    va, vb = a.get("value"), b.get("value")
    if isinstance(va, (int, float)) and isinstance(vb, (int, float)) and not isinstance(va, bool) and not isinstance(vb, bool):
        same_value = abs(va - vb) <= 1e-6 * max(1.0, abs(va), abs(vb))
    else:
        same_value = va == vb
    return same_value and all(a.get(k) == b.get(k) for k in ("unit", "currency", "ticker", "period"))


def _golden_disagrees(facts: list[dict], golden: dict) -> list[str]:
    """Golden values whose chat evidence (same fact key) exists but says something else."""
    out = []
    for fid, g in golden.items():
        mine = [f for f in facts if _key(f) == fid.split("#")[0]]
        if mine and not any(_same_fact(f, g) for f in mine):
            out.append(fid)
    return out


def _sections(text: str, lang: str) -> dict[str, list[str]]:
    headings = SECTIONS.get(lang, SECTIONS["cs"])
    out: dict[str, list[str]] = {}
    current: str | None = None
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped in headings:
            current = headings[stripped]
            out[current] = []
        elif not stripped:
            current = None
        elif current:
            out[current].append(stripped)
    return out


def verdict_check(text: str, lang: str, expect_insufficient: bool) -> dict:
    """Structural verdict: a verdict from the fixed set, its basis, a confidence consistent with it, what
    would change it and the risks; a complete analysis also has its analysts and valuation sections."""
    lang = lang if lang in SECTIONS else "cs"
    sections = _sections(text, lang)
    lines = sections.get("verdict", [])
    conclusion = re.compile(rf"^{re.escape(CONCLUSION[lang])}\s*:\s*(?P<v>[^.\n]+)\.?\s*(?:{re.escape(CONFIDENCE_LABEL[lang])}\s*:\s*(?P<c>[^.\n]+))?",
                            re.IGNORECASE)
    would = re.compile(rf"^{re.escape(WOULD_CHANGE[lang])}\s*:\s*\S.{{2,}}", re.IGNORECASE)
    found = next((m for m in map(conclusion.match, lines) if m), None)
    verdict = VERDICTS[lang].get(found.group("v").strip().lower()) if found else None
    confidence = CONFIDENCE[lang].get((found.group("c") or "").strip().lower()) if found else None
    missing = []
    if verdict is None or (verdict == "insufficient") != bool(expect_insufficient):
        missing.append("verdict")
    if confidence is None or (verdict == "insufficient" and confidence != "low"):
        missing.append("confidence")
    if not any(would.match(line) for line in lines):
        missing.append("would_change")
    if not any(len(line.split()) >= 3 and not conclusion.match(line) and not would.match(line) and not DECISION.search(line) for line in lines):
        missing.append("basis")
    if not sections.get("risks"):
        missing.append("risks")
    if verdict != "insufficient":
        missing += [part for part in ("analysts", "valuation") if not sections.get(part)]
    if REFUSAL.search(text):
        missing.append("refusal")
    return {"ok": not missing, "missing": missing, "verdict": verdict, "confidence": confidence}


# Checks that fail when true (a found problem); every other check fails when false or a non-empty list.
FAIL_WHEN_TRUE = ("technical", "refused")
ISOLATION_LEAK_CHECKS = {"forbidden", "foreign_thread_hidden", "foreign_audit_hidden"}


def failures_of(checks: dict) -> list[str]:
    """Failed check names. Dicts are details, never failures (the release gate recomputes this rule)."""
    return [name for name, value in checks.items()
            if (value is True if name in FAIL_WHEN_TRUE else value is False or (isinstance(value, list) and bool(value)))]


REJECTION_CODES = set("""invalid not_object lang blocks block_invalid unbound_prose empty_selection missing_claim
unused_claim unknown_source intent_incomplete verdict confidence unbound_conclusion would_change
analysis_structure analysis_verdict analysis_confidence analysis_would_change html json markdown url
technical unslotted_number number_word currency_text claim_invalid unknown_fact calculation_unverified
null_fact metric scope quality unit ticker period currency value decimals sign rounds_to_zero
meaning ticker_block ticker_text truncated finish_reason route_schema tool_call_format tool_not_allowed
http http_400 http_401 http_403 http_404 http_413 http_422 http_429 http_500 http_502 http_503 http_504 http_other
invalid_request_error tool_use_failed invalid_api_key model_not_found rate_limit_exceeded server_error provider_error
json_validate_failed param_response_format param_messages param_tool_choice param_tools param_max_completion_tokens
param_max_tokens param_reasoning_effort param_include_reasoning param_stop param_temperature
schema response_size timeout empty provider budget policy config network quota cancelled
input_bound_exceeded usage_exceeded
summary themes theme_invalid watch sentences unbacked_number unattributed_number injection
summary_missing summary_empty summary_type summary_long themes_none themes_missing themes_few themes_many sentences_few sentences_many watch_shape watch_long at_summary at_watch at_theme""".split())


def rejection_codes(values: object) -> list[str]:
    if not isinstance(values, list):
        return ["invalid"]
    codes = [v.split(":")[0] if isinstance(v, str) else "invalid" for v in values]
    return list(dict.fromkeys(c if c in REJECTION_CODES else "invalid" for c in codes))[:10]


def attempt_record(attempt: dict) -> dict:
    """One model attempt from the audit (`metrics.attempts`): charged usage, never a guess."""
    def count(value: Any) -> int:
        return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0 else 0
    return {"phase": attempt.get("phase"), "model": attempt.get("model"),
            "tokens_in": count(attempt.get("chargedInput", attempt.get("tokensIn"))),
            "tokens_out": count(attempt.get("chargedOutput", attempt.get("tokensOut"))),
            "usage_source": attempt.get("usageSource"), "finish_reason": attempt.get("finishReason"), "outcome": attempt.get("outcome"),
            **({"rejection_reasons": rejection_codes(attempt["rejectionReasons"])} if "rejectionReasons" in attempt else {}),
            **({"call_limit": count(attempt["callLimit"])} if "callLimit" in attempt else {})}


def call_limit(attempt: dict) -> int:
    """The cap of one attempt: 3,000, or 5,000 for an answer/repair call admitted under the analyst's cap."""
    if attempt.get("call_limit") == ANALYST_CALL_TOKEN_LIMIT and attempt.get("phase") in ("answer", "repair"):
        return ANALYST_CALL_TOKEN_LIMIT
    return CALL_TOKEN_LIMIT


def turn_record(result: ChatResult, index: int, phase: str, replay: bool = False) -> dict:
    """Evidence of one HTTP request: its end, latency, reported totals and per-attempt usage (None when the
    audit has no per-attempt usage — then token limits are unproven, not zero)."""
    metrics = (result.audit or {}).get("metrics") or {}
    attempts = metrics.get("attempts")
    return {"index": index, "phase": phase, "replay": replay, "request_id": result.request_id, "terminal": result.terminal,
            "http_status": result.http_status, "outcome": result.outcome, "error_code": result.error_code,
            "model": metrics.get("model"), "model_error": metrics.get("errorCode"),
            "wall_ms": round(result.wall_ms, 1), "ttft_ms": None if result.ttft_ms is None else round(result.ttft_ms, 1),
            "tokens": {"in": metrics.get("tokensIn"), "out": metrics.get("tokensOut"), "max_call": metrics.get("maxCallTokens")},
            "attempts": [attempt_record(a) for a in attempts if isinstance(a, dict)] if isinstance(attempts, list) else None}


# A quotation of a news item of this run (its text fact: "publisher | date | title — summary"): figures inside it are the
# publisher's words, attributed, not Trackora claims. Anything quoted that is not verbatim in such a fact stays checked.
# Fallback extracts are up to 320 characters (Běh 23b).
QUOTED = re.compile(r"[„“\"«]([^„“”\"«»\n]{2,340})[“”\"»]")


def _norm_text(value: str) -> str:
    return re.sub(r"\s+", " ", value.lower().replace("’", "'").replace("‘", "'").replace("–", "-").replace("—", "-")).strip()


def mask_news_quotes(text: str, facts: list[dict]) -> str:
    sources = [_norm_text(str(f.get("value"))) for f in facts if f.get("unit") == "text" and _key(f).startswith("news:")]
    if not sources:
        return text

    def blank(m: re.Match) -> str:
        inner = _norm_text(m.group(1)).rstrip(".,;:!?…")
        return " " * len(m.group(0)) if inner and any(inner in source for source in sources) else m.group(0)
    return QUOTED.sub(blank, text)


# A news-analysis theme ends with its sources ("(Zdroj: Reuters, 21. 10. 2026)"); a figure in such a line that is written in
# a news item of this run is that publisher's attributed figure (the server checked it against the cited article), not a
# Trackora claim. The same figure without a source line, or one that no news item of the run contains, stays checked.
CITED_LINE = re.compile(r"\((?:Zdroj|Zdroje|Source|Sources): [^()]*\)\s*$")
NEWS_NUMBER = re.compile(r"\d+(?:[.,]\d+)*")


def _news_number(token: str) -> str:
    plain = token.replace(",", "") if re.fullmatch(r"\d{1,3}(?:,\d{3})+", token) else token.replace(",", ".")
    try:
        return repr(float(plain))
    except ValueError:
        return plain


def _plain_number(token: str) -> str:
    return token.replace(",", "") if re.fullmatch(r"\d{1,3}(?:,\d{3})+", token) else token.replace(",", ".")


def _backed(token: str, backing: set[str]) -> bool:
    """The article's figure, also rounded to fewer decimals ("20" for "20.08"), as the server's analyst check allows."""
    if _news_number(token) in {_news_number(b) for b in backing}:
        return True
    written = _plain_number(token)
    try:
        value = float(written)
    except ValueError:
        return False
    places = len(written.split(".")[1]) if "." in written else 0
    for b in backing:
        plain = _plain_number(b)
        if "." not in plain or len(plain.split(".")[1]) <= places:
            continue
        try:
            if abs(round(float(plain), places) - value) < 1e-9:
                return True
        except ValueError:
            continue
    return False


def mask_attributed_news_numbers(text: str, facts: list[dict]) -> str:
    sources = [str(f.get("value")) for f in facts if f.get("unit") == "text" and _key(f).startswith("news:")]
    backing = {t for s in sources for t in NEWS_NUMBER.findall(s)}
    if not backing:
        return text
    lines = []
    for line in text.split("\n"):
        cited = CITED_LINE.search(line)
        if cited:
            head = NEWS_NUMBER.sub(lambda m: " " * len(m.group(0)) if _backed(m.group(0), backing) else m.group(0), line[:cited.start()])
            line = head + line[cited.start():]
        lines.append(line)
    return "\n".join(lines)


def score_case(case: dict, result: ChatResult, golden: dict, turns: list[dict] | None = None) -> dict:
    text = result.text or ""
    lang = case.get("lang", "cs")
    facts = _trusted_facts(result)
    numbers = extract_numbers(mask_attributed_news_numbers(mask_news_quotes(text, facts), facts), lang)
    unverified = [n["raw"] for n in numbers if not any(matches(n, f) for f in facts)]
    required = [fid for g in case.get("golden", []) for fid in g.get("fact_ids", [])]
    stated = SOURCES_LINE.sub("", text)
    missing = [fid for fid in required if fid not in golden or not (any(matches(n, golden[fid], required=True) for n in numbers)
                                                                     or zero_stated(golden[fid], stated))]
    used = set((result.audit or {}).get("toolsUsed", []))
    checks: dict[str, Any] = {
        "terminated": result.terminal == "done",
        "answered": result.text is not None or bool(case.get("expect_error")),
        "technical": bool(TECHNICAL.search(text)),
        "unverified_numbers": unverified,
        "required_missing": missing,
        "golden_disagrees": _golden_disagrees(facts, golden),
        "refused": bool(required) and bool(missing) and not case.get("expect_insufficient") and bool(REFUSED.search(text)),
        "forbidden": [p for p in case.get("forbid", []) if re.search(p, text, re.IGNORECASE)],
        "required_text_missing": [p for p in case.get("require", []) if not re.search(p, text, re.IGNORECASE)],
        "tools_missing": [t for t in case.get("expect_tools", []) if t not in used],
    }
    if case.get("expect_error"):
        checks["answered"] = result.text is not None or result.error_code is not None
    if case.get("expect_verdict"):
        detail = verdict_check(text, lang, bool(case.get("expect_insufficient")))
        checks["verdict"] = detail.pop("ok")
        checks["verdict_detail"] = detail
    failures = failures_of(checks)
    return {"id": case["id"], "scenario": case.get("scenario"), "lang": lang, "user": case.get("user"), "passed": not failures,
            "failures": failures, "checks": checks, "model": ((result.audit or {}).get("metrics") or {}).get("model"),
            "failure": result.failure, "text": text, "turns": turns if turns is not None else [turn_record(result, 0, "cold")]}


def _p95(values: list[float]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, -(-95 * len(ordered) // 100) - 1)]


def _stats(values: list[float]) -> dict:
    ordered = sorted(values)
    return {"n": len(ordered), "p50": ordered[len(ordered) // 2] if ordered else None, "p95": _p95(ordered), "max": ordered[-1] if ordered else None}


PORTFOLIO_SCENARIOS = {"transactions", "realized", "tax", "simulation", "performance", "dividends", "allocation", "price", "multi_turn", "empty", "movers",
                       "move"}


def token_summary(scored: list[dict]) -> dict:
    """Token limits from per-attempt usage of every question (replays of a finished request are the same question)."""
    max_call = max_question = calls_over = questions_over = without = 0
    for s in scored:
        for t in s["turns"]:
            if t["replay"]:
                continue
            reported = (t["tokens"].get("in") or 0) + (t["tokens"].get("out") or 0)
            if t["attempts"] is None:
                without += 1
                question = reported
            else:
                calls = [a["tokens_in"] + a["tokens_out"] for a in t["attempts"]]
                calls_over += sum(1 for a, c in zip(t["attempts"], calls) if c > call_limit(a))
                max_call = max([max_call, *calls])
                question = max(sum(calls), reported)
            max_call = max(max_call, t["tokens"].get("max_call") or 0)
            questions_over += question > QUESTION_TOKEN_LIMIT
            max_question = max(max_question, question)
    return {"max_call": max_call, "max_question": max_question, "call_limit_violations": calls_over,
            "question_limit_violations": questions_over, "turns_without_attempts": without}


def summarize(scored: list[dict]) -> dict:
    """Totals over every case, failures included, recomputed from the per-case checks and per-turn evidence;
    latency as counted samples split into cold (first request of a case: new identity and thread) and warm
    (follow-up turns), not a guarantee."""
    total = len(scored)
    passed = sum(1 for s in scored if s["passed"])
    portfolio = [s for s in scored if s.get("scenario") in PORTFOLIO_SCENARIOS]
    portfolio_passed = sum(1 for s in portfolio if s["passed"])
    asked = [t for s in scored for t in s["turns"] if not t["replay"]]
    outcomes: dict[str, int] = {}
    for s in scored:
        last = [t for t in s["turns"] if not t["replay"]][-1:] or [{"outcome": None, "terminal": "not_run"}]
        key = last[0]["outcome"] or last[0]["terminal"]
        outcomes[key] = outcomes.get(key, 0) + 1
    return {
        "cases": total, "passed": passed, "pass_rate": round(passed / total, 4) if total else None,
        "portfolio_text_cases": len(portfolio), "portfolio_text_passed": portfolio_passed,
        "portfolio_text_pass_rate": round(portfolio_passed / len(portfolio), 4) if portfolio else None,
        "unverified_numbers": sum(len(s["checks"]["unverified_numbers"]) for s in scored),
        "technical_labels": sum(1 for s in scored if s["checks"]["technical"]),
        "leaks": sum(1 for s in scored if s.get("scenario") == "isolation"
                     and ISOLATION_LEAK_CHECKS.intersection(failures_of(s["checks"]))),
        "isolation_other_failures": sum(1 for s in scored if s.get("scenario") == "isolation"
                                        and set(failures_of(s["checks"])) - ISOLATION_LEAK_CHECKS),
        "unterminated": sum(1 for s in scored if not s["checks"]["terminated"]),
        "verdict_cases": sum(1 for s in scored if "verdict" in s["checks"]),
        "verdict_ok": sum(1 for s in scored if s["checks"].get("verdict") is True),
        "outcomes": outcomes,
        "template_share": round(outcomes.get("fallback", 0) / total, 4) if total else None,
        "rate_limited_runs": sum(1 for s in scored if any(t["model_error"] == "quota" for t in s["turns"])),
        "timeouts": sum(1 for s in scored if any(t["terminal"] == "timeout" or t["outcome"] == "timeout" for t in s["turns"])),
        "wall_ms": {phase: _stats([t["wall_ms"] for t in asked if t["phase"] == phase and t["terminal"] == "done"]) for phase in ("cold", "warm")},
        "tokens": token_summary(scored),
    }
