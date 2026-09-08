#!/usr/bin/env python3
"""Print a compact summary of hero records in the latest device login reply."""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from afk_protocol import get_proto_bytes, get_proto_varint, parse_proto_fields  # noqa: E402


def main() -> None:
    log_path = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "logs" / "ws-frames.jsonl"
    latest = None
    with log_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if row.get("direction") != "local_structured_to_client":
                continue
            if row.get("fixture_label") in {"event_4", "login_reply"}:
                latest = row
    if latest is None:
        raise SystemExit("latest_login_reply_not_found")

    outer = parse_proto_fields(base64.b64decode(latest["base64"]))
    login_payload = get_proto_bytes(outer, 4)
    if login_payload is None:
        raise SystemExit("login_payload_missing")
    login_fields = parse_proto_fields(login_payload)
    player_payload = get_proto_bytes(login_fields, 1)
    if player_payload is None:
        raise SystemExit("player_payload_missing")
    player_fields = parse_proto_fields(player_payload)

    heroes = []
    for field in player_fields:
        if field.number != 11 or field.wire_type != 2:
            continue
        hero_fields = parse_proto_fields(bytes(field.value))
        equips = []
        for equip_field in hero_fields:
            if equip_field.number != 7 or equip_field.wire_type != 2:
                continue
            equip_entry = parse_proto_fields(bytes(equip_field.value))
            equip_payload = get_proto_bytes(equip_entry, 2)
            equip = parse_proto_fields(equip_payload) if equip_payload is not None else []
            equips.append({
                "slot": get_proto_varint(equip_entry, 1),
                "id": get_proto_varint(equip, 1),
                "tid": get_proto_varint(equip, 2),
                "enhance_lv": get_proto_varint(equip, 5),
            })
        heroes.append({
            "id": get_proto_varint(hero_fields, 1),
            "tid": get_proto_varint(hero_fields, 2),
            "quality": get_proto_varint(hero_fields, 3),
            "rank": get_proto_varint(hero_fields, 4),
            "level": get_proto_varint(hero_fields, 5),
            "gs": get_proto_varint(hero_fields, 6),
            "equips": equips,
            "field_numbers": sorted({item.number for item in hero_fields}),
        })

    print(json.dumps({
        "ts": latest.get("ts"),
        "session_id": latest.get("session_id"),
        "player_stage": get_proto_varint(player_fields, 28),
        "player_pg_lv": get_proto_varint(player_fields, 44),
        "player_max_pg_lv": get_proto_varint(player_fields, 46),
        "hero_count": len(heroes),
        "heroes": heroes,
    }, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
