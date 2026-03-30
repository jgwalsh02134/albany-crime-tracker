#!/usr/bin/env python3
from __future__ import annotations

import csv
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from app.services.source_audit import audit_counts
from app.services.source_audit import audit_entries
from app.services.source_registry import load_source_registry


CSV_COLUMNS = [
    "source_name",
    "organization",
    "category",
    "lane",
    "trust_tier",
    "canonical_url",
    "feed_url",
    "api_url",
    "social_url",
    "implemented_ingestor",
    "validated_live",
    "active_status",
    "duplicate_flag",
    "unsuitable_flag",
    "reason",
]


def write_csv(path: str, rows: list[dict[str, str]]) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=CSV_COLUMNS)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in CSV_COLUMNS})


def write_md(path: str, rows: list[dict[str, str]]) -> None:
    counts = audit_counts(rows)
    lines = [
        "# Source Audit",
        "",
        f"- Total audited sources: **{len(rows)}**",
        "",
        "## Class Counts",
        "",
    ]
    for k, v in counts.items():
        lines.append(f"- `{k}`: {v}")
    lines.extend(
        [
            "",
            "## Reviewed Table",
            "",
            "| source_name | organization | category | lane | trust_tier | canonical_url | feed_url | api_url | social_url | implemented_ingestor | validated_live | active_status | duplicate_flag | unsuitable_flag | reason |",
            "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
        ]
    )
    for r in rows:
        vals = [str(r.get(k, "")).replace("|", "\\|") for k in CSV_COLUMNS]
        lines.append("| " + " | ".join(vals) + " |")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def main() -> int:
    registry = load_source_registry()
    rows = audit_entries(registry)
    rows_sorted = sorted(
        rows,
        key=lambda r: (
            str(r.get("audit_class") or ""),
            str(r.get("category") or ""),
            str(r.get("source_name") or ""),
        ),
    )
    csv_path = os.path.join(ROOT, "source_audit.csv")
    md_path = os.path.join(ROOT, "source_audit.md")
    write_csv(csv_path, rows_sorted)
    write_md(md_path, rows_sorted)
    print(f"Wrote {len(rows_sorted)} audited rows to {csv_path}")
    print(f"Wrote markdown audit to {md_path}")
    print(f"Class counts: {audit_counts(rows_sorted)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
