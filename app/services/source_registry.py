from __future__ import annotations

import json
import os
from collections import Counter
from typing import Any


def _registry_path() -> str:
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    return os.path.join(root, "source_registry.json")


def load_source_registry() -> list[dict[str, Any]]:
    path = _registry_path()
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
            if isinstance(data, list):
                return [x for x in data if isinstance(x, dict)]
    except Exception:
        return []
    return []


def source_registry_summary(entries: list[dict[str, Any]]) -> dict[str, Any]:
    category_counts = Counter(str(x.get("category") or "unknown") for x in entries)
    active_count = sum(1 for x in entries if bool(x.get("active_status")))
    return {
        "total_sources": len(entries),
        "active_sources": active_count,
        "inactive_sources": max(0, len(entries) - active_count),
        "category_counts": dict(sorted(category_counts.items(), key=lambda kv: (-kv[1], kv[0]))),
    }
