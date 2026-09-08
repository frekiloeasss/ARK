#!/usr/bin/env python3
"""Summarize the latest real-device stage start request and reply."""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from afk_protocol import (  # noqa: E402
    get_proto_bytes,
    get_proto_varint,
    get_repeated_proto_bytes,
    parse_proto_fields,
)
from websocket_proxy import parse_client_message_kind  # noqa: E402


def main() -> None:
    log_path = ROOT / "logs" / "ws-frames.jsonl"
    request = None
    reply = None
    with log_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if row.get("request_kind") != "stage_battle_start":
                continue
            if row.get("direction") == "client_to_local_structured":
                request = row
            elif row.get("direction") == "local_structured_to_client":
                reply = row
    if not request or not reply:
        raise SystemExit("stage_battle_start_pair_not_found")

    request_bytes = base64.b64decode(request["base64"])
    reply_fields = parse_proto_fields(base64.b64decode(reply["base64"]))
    extra_payload = get_proto_bytes(reply_fields, 9)
    stage_module = parse_proto_fields(get_proto_bytes(reply_fields, 6) or b"")
    start_reply = parse_proto_fields(get_proto_bytes(stage_module, 3) or b"")
    battle = parse_proto_fields(get_proto_bytes(start_reply, 1) or b"")
    common = parse_proto_fields(get_proto_bytes(battle, 2) or b"")
    battle_input = parse_proto_fields(get_proto_bytes(battle, 3) or b"")
    def decode_teams(field_number: int) -> list[list[dict]]:
        teams = []
        for team_payload in get_repeated_proto_bytes(battle_input, field_number):
            team = parse_proto_fields(team_payload)
            slots = []
            for slot_payload in get_repeated_proto_bytes(team, 1):
                slot = parse_proto_fields(slot_payload)
                hero = parse_proto_fields(get_proto_bytes(slot, 2) or b"")
                equipment_tids = []
                for equip_payload in get_repeated_proto_bytes(hero, 7):
                    equip_entry = parse_proto_fields(equip_payload)
                    equip = parse_proto_fields(get_proto_bytes(equip_entry, 2) or b"")
                    equipment_tids.append(get_proto_varint(equip, 2))
                slots.append({
                    "slot": get_proto_varint(slot, 1),
                    "id": get_proto_varint(hero, 1),
                    "tid": get_proto_varint(hero, 2),
                    "quality": get_proto_varint(hero, 3),
                    "rank": get_proto_varint(hero, 4),
                    "level": get_proto_varint(hero, 5),
                    "gs": get_proto_varint(hero, 6),
                    "equipment_tids": equipment_tids,
                    "artifact_tid": get_proto_varint(parse_proto_fields(get_proto_bytes(hero, 11) or b""), 2),
                    "pentagram_lv": get_proto_varint(hero, 12),
                    "signature_lv": get_proto_varint(parse_proto_fields(get_proto_bytes(hero, 13) or b""), 1),
                    "furniture_count": len(get_repeated_proto_bytes(hero, 17)),
                })
            teams.append(slots)
        return teams

    self_teams = decode_teams(1)
    opponent_teams = decode_teams(2)
    print(json.dumps({
        "request": parse_client_message_kind(request_bytes),
        "reply": {
            "seed": get_proto_varint(common, 1),
            "stage": get_proto_varint(common, 2),
            "common_varints": {
                str(field.number): field.value
                for field in common
                if field.wire_type == 0
            },
            "self_teams": self_teams,
            "opponent_teams": opponent_teams,
            "extra_size": len(extra_payload or b""),
            "extra_fields": sorted({field.number for field in parse_proto_fields(extra_payload or b"")}),
        },
    }, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
