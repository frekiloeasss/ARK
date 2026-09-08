"""Versioned, evidence-backed behavior for the captured AFK client."""

import json
from pathlib import Path


RULES_PATH = (
    Path(__file__).resolve().parent
    / "data"
    / "official"
    / "v1.182.03.301371.json"
)


def load_official_rules() -> dict:
    return json.loads(RULES_PATH.read_text(encoding="utf-8"))


OFFICIAL_RULES = load_official_rules()
