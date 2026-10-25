"""The required case list the release gate checks a live report against.

CLI: python -m trackora_evals.manifest [--cases evals/cases/mvp.yaml] [--output evals/cases/required.json]
Regenerate after every change of the case file; a pytest keeps the committed file in sync with it.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import yaml


def cases_sha256(path: str) -> str:
    """SHA-256 of the case file with LF line endings (a Windows checkout hashes the same as CI)."""
    return hashlib.sha256(Path(path).read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def required_manifest(path: str) -> dict:
    cases = yaml.safe_load(Path(path).read_text(encoding="utf-8"))["cases"]
    return {"cases_file": "evals/cases/mvp.yaml", "cases_sha256": cases_sha256(path),
            "cases": [{"id": c["id"], "turns": len(c["turns"]), "scenario": c["scenario"], "lang": c["lang"]} for c in cases]}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--cases", default="evals/cases/mvp.yaml")
    parser.add_argument("--output", default="evals/cases/required.json")
    args = parser.parse_args(argv)
    Path(args.output).write_text(json.dumps(required_manifest(args.cases), ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
