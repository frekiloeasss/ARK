#!/usr/bin/env python3
import argparse
import base64
import hashlib
import json
import sys
from dataclasses import dataclass
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def decode_message(event: dict) -> str | bytes:
    if event.get("message_type") == "binary" and event.get("base64"):
        return base64.b64decode(event["base64"])
    return event.get("text", "")


@dataclass
class ProtoField:
    number: int
    wire_type: int
    value: int | bytes


def decode_varint(buffer: bytes, offset: int = 0) -> tuple[int, int]:
    value = 0
    shift = 0
    index = offset

    while index < len(buffer):
        current = buffer[index]
        value |= (current & 0x7F) << shift
        index += 1
        if current < 0x80:
            return value, index
        shift += 7
        if shift > 63:
            break

    raise ValueError("Invalid varint payload.")


def parse_proto_fields(buffer: bytes) -> list[ProtoField]:
    fields = []
    offset = 0

    while offset < len(buffer):
        key, offset = decode_varint(buffer, offset)
        field_number = key >> 3
        wire_type = key & 0x07

        if wire_type == 0:
            value, offset = decode_varint(buffer, offset)
            fields.append(ProtoField(field_number, wire_type, value))
            continue

        if wire_type == 2:
            size, offset = decode_varint(buffer, offset)
            end = offset + size
            if end > len(buffer):
                raise ValueError("Length-delimited field exceeds message size.")
            fields.append(ProtoField(field_number, wire_type, buffer[offset:end]))
            offset = end
            continue

        raise ValueError(f"Unsupported wire type: {wire_type}")

    return fields


def get_proto_varint(fields: list[ProtoField], field_number: int) -> int | None:
    for field in fields:
        if field.number == field_number and field.wire_type == 0:
            return int(field.value)
    return None


def get_proto_bytes(fields: list[ProtoField], field_number: int) -> bytes | None:
    for field in fields:
        if field.number == field_number and field.wire_type == 2:
            return bytes(field.value)
    return None


def get_proto_text(fields: list[ProtoField], field_number: int) -> str | None:
    payload = get_proto_bytes(fields, field_number)
    if payload is None:
        return None
    return payload.decode("utf-8")


def get_repeated_proto_bytes(fields: list[ProtoField], field_number: int) -> list[bytes]:
    return [
        bytes(field.value)
        for field in fields
        if field.number == field_number and field.wire_type == 2
    ]


def proto_field_fingerprint(fields: list[ProtoField]) -> list[dict]:
    fingerprint = []
    for field in fields:
        entry = {
            "number": field.number,
            "wire_type": field.wire_type,
        }
        if field.wire_type == 0:
            entry["varint"] = int(field.value)
        elif field.wire_type == 2:
            payload = bytes(field.value)
            entry["size"] = len(payload)
            entry["sha1"] = hashlib.sha1(payload).hexdigest()
        fingerprint.append(entry)
    return fingerprint


def proto_route_shape(payload: bytes) -> list[dict]:
    try:
        fields = parse_proto_fields(payload)
    except ValueError:
        return []
    return [
        {
            "number": field.number,
            "wire_type": field.wire_type,
            "size": len(field.value) if field.wire_type == 2 else None,
        }
        for field in fields
    ]


def classify_field5_request(payload: bytes) -> str:
    try:
        fields = parse_proto_fields(payload)
    except ValueError:
        return "stage_field5_unknown"

    top_numbers = [field.number for field in fields]
    if top_numbers == [6]:
        return "stage_query_assist_summaries"
    if top_numbers == [3]:
        return "stage_battle_start"
    if top_numbers == [4]:
        return "stage_battle_result"
    return "stage_field5_unknown"


def classify_field11_request(payload: bytes) -> str:
    try:
        fields = parse_proto_fields(payload)
    except ValueError:
        return "field11_unknown"

    top_shape = [
        (
            field.number,
            field.wire_type,
            len(field.value) if field.wire_type == 2 else None,
        )
        for field in fields
    ]
    if top_shape == [(1, 2, 0)]:
        return "tavern_open_panel"
    if top_shape == [(2, 2, 2)]:
        return "tavern_draw"
    return "field11_unknown"


def parse_client_message_kind(message: str | bytes) -> dict:
    if not isinstance(message, bytes):
        return {"kind": "text"}

    try:
        fields = parse_proto_fields(message)
    except ValueError as exc:
        return {"kind": "unknown_binary", "error": repr(exc)}

    seq = get_proto_varint(fields, 1)
    if get_proto_bytes(fields, 19) is not None:
        return {"kind": "heartbeat", "seq": seq}

    sdk_login_payload = get_proto_bytes(fields, 3)
    if sdk_login_payload is not None:
        try:
            inner_fields = parse_proto_fields(sdk_login_payload)
            token = get_proto_text(inner_fields, 3)
            svr_id = get_proto_varint(inner_fields, 4)
        except Exception:
            token = None
            svr_id = None
        return {
            "kind": "sdk_login",
            "seq": seq,
            "htoken": token,
            "svr_id": svr_id,
        }

    if get_proto_bytes(fields, 28) is not None:
        return {"kind": "login", "seq": seq}

    if get_proto_bytes(fields, 30) is not None:
        return {"kind": "charge", "seq": seq}

    field11_payload = get_proto_bytes(fields, 11)
    if field11_payload is not None:
        return {"kind": classify_field11_request(field11_payload), "seq": seq}

    field5_payload = get_proto_bytes(fields, 5)
    if field5_payload is not None:
        return {"kind": classify_field5_request(field5_payload), "seq": seq}

    return {"kind": "unknown_binary", "seq": seq}


def request_signature(message: str | bytes) -> dict:
    if isinstance(message, str):
        return {
            "message_type": "text",
            "text": message,
            "size": len(message.encode("utf-8")),
        }

    signature = {
        "message_type": "binary",
        "size": len(message),
        "base64": base64.b64encode(message).decode("ascii"),
    }
    try:
        fields = parse_proto_fields(message)
        parsed = parse_client_message_kind(message)
        signature["kind"] = parsed.get("kind")
        signature["seq"] = parsed.get("seq")
        signature["top_fields"] = [
            {
                "number": field.number,
                "wire_type": field.wire_type,
                "size": len(field.value) if field.wire_type == 2 else None,
            }
            for field in fields
        ]
        signature["proto_fingerprint"] = proto_field_fingerprint(fields)
        for route_field in (3, 5, 19, 28, 30):
            payloads = get_repeated_proto_bytes(fields, route_field)
            if payloads:
                signature["route_field"] = route_field
                signature["route_payload_sizes"] = [len(payload) for payload in payloads]
                signature["route_payload_sha1"] = [
                    hashlib.sha1(payload).hexdigest() for payload in payloads
                ]
                if route_field == 5:
                    signature["route_payload_shapes"] = [
                        proto_route_shape(payload) for payload in payloads
                    ]
                break
    except Exception as exc:
        signature["parse_error"] = repr(exc)
    return signature


def main() -> None:
    parser = argparse.ArgumentParser(description="Analyze captured websocket request kinds.")
    parser.add_argument(
        "--log-file",
        default=str(Path(__file__).resolve().parents[1] / "logs" / "ws-frames.jsonl"),
    )
    parser.add_argument("--unknown-limit", type=int, default=20)
    args = parser.parse_args()

    log_file = Path(args.log_file)
    kind_counts = Counter()
    examples = {}
    unknown = []

    for line in log_file.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        event = json.loads(line)
        if event.get("event") != "frame":
            continue
        direction = event.get("direction") or ""
        if not direction.startswith("client_to_"):
            continue

        message = decode_message(event)
        info = parse_client_message_kind(message)
        signature = request_signature(message)
        kind = info.get("kind") or "none"
        kind_counts[kind] += 1
        examples.setdefault(
            kind,
            {
                "direction": direction,
                "size": event.get("size"),
                "seq": info.get("seq"),
                "signature": signature,
            },
        )
        if kind == "unknown_binary":
            unknown.append(
                {
                    "direction": direction,
                    "size": event.get("size"),
                    "seq": info.get("seq"),
                    "signature": signature,
                }
            )

    print("Request kinds:")
    for kind, count in kind_counts.most_common():
        example = examples[kind]
        print(f"- {kind}: {count} example={example['direction']} size={example['size']} seq={example['seq']}")
        print(json.dumps(example["signature"], ensure_ascii=False, separators=(",", ":"))[:1000])

    print(f"Unknown binary requests: {len(unknown)}")
    for item in unknown[: args.unknown_limit]:
        print(json.dumps(item, ensure_ascii=False, separators=(",", ":"))[:1200])


if __name__ == "__main__":
    main()
