#!/usr/bin/env python3
import argparse
import asyncio
import base64
import contextlib
import hashlib
import json
import os
import re
import ssl
import struct
import time
import zlib
from dataclasses import dataclass
from datetime import datetime, timezone
from itertools import count
from pathlib import Path
from urllib.parse import quote
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from websockets.asyncio.client import connect
from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed

from afk_protocol import (
    ProtoField,
    classify_field13_request,
    classify_field11_request,
    classify_field5_request,
    current_server_timestamp,
    decode_proto_text,
    decode_varint,
    encode_length_delimited_field,
    encode_proto_fields,
    encode_varint,
    encode_varint_field,
    get_proto_bytes,
    get_proto_text,
    get_proto_varint,
    get_repeated_proto_bytes,
    get_repeated_proto_varints,
    parse_proto_fields,
    proto_field_fingerprint,
    proto_route_shape,
    replace_top_level_varint_field,
    set_proto_bytes,
    set_proto_repeated_bytes,
    set_proto_repeated_varints,
    set_proto_varint,
)
from afk_official_rules import OFFICIAL_RULES


NEW_PROTO_MIN_FRAME_SIZE = 23


def _root_proto_fields(path: Path, message_name: str) -> dict[str, int]:
    try:
        source = path.read_text(encoding="utf-8")
    except OSError:
        return {}
    match = re.search(
        rf"\bmessage\s+{re.escape(message_name)}\s*\{{(?P<body>.*?)^\}}",
        source,
        flags=re.MULTILINE | re.DOTALL,
    )
    if not match:
        return {}
    fields = {}
    for field in re.finditer(
        r"^\s*(?:optional|required|repeated)\s+[.\w]+\s+(\w+)\s*=\s*(\d+)",
        match.group("body"),
        flags=re.MULTILINE,
    ):
        fields[field.group(1)] = int(field.group(2))
    return fields


def _build_root_projection_maps() -> tuple[dict[int, int], dict[int, int]]:
    runtime_root = Path(__file__).resolve().parent / "runtime" / "official-updates" / "1.201.01"
    legacy_root = runtime_root / "recovered-client" / "csproto"
    latest_root = runtime_root / "device-proto"
    legacy_up = _root_proto_fields(legacy_root / "up.proto", "up_msg")
    latest_up = _root_proto_fields(latest_root / "up.proto", "up_msg")
    legacy_down = _root_proto_fields(legacy_root / "down.proto", "down_msg")
    latest_down = _root_proto_fields(latest_root / "down.proto", "down_msg")

    request_map = {
        latest_number: legacy_up[name]
        for name, latest_number in latest_up.items()
        if name in legacy_up
    }
    response_map = {
        legacy_number: latest_down[name]
        for name, legacy_number in legacy_down.items()
        if name in latest_down
    }
    # Keep startup usable before the optional recovered artifacts are present.
    request_map.update({2: request_map.get(2, 3), 24: request_map.get(24, 28), 25: request_map.get(25, 29)})
    response_map.update({31: response_map.get(31, 28), 4: response_map.get(4, 4), 35: response_map.get(35, 31)})
    return request_map, response_map


NEW_UP_TO_LEGACY_UP, LEGACY_DOWN_TO_NEW_DOWN = _build_root_projection_maps()


def _load_proto_definitions(paths: list[Path]) -> dict[str, dict]:
    definitions = {}
    message_start = re.compile(r"^\s*message\s+(\w+)\s*\{")
    field_pattern = re.compile(
        r"^\s*(?:(optional|required|repeated)\s+)?(map\s*<[^>]+>|[.\w]+)\s+(\w+)\s*=\s*(\d+)"
    )
    for path in paths:
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        index = 0
        while index < len(lines):
            start = message_start.match(lines[index].split("//", 1)[0])
            if not start:
                index += 1
                continue
            name = start.group(1)
            depth = 0
            fields = []
            while index < len(lines):
                code = lines[index].split("//", 1)[0]
                depth += code.count("{") - code.count("}")
                field = field_pattern.match(code)
                if field and depth == 1:
                    fields.append(
                        {
                            "label": field.group(1) or "optional",
                            "type": re.sub(r"\s+", "", field.group(2)).lstrip("."),
                            "name": field.group(3),
                            "number": int(field.group(4)),
                        }
                    )
                index += 1
                if depth == 0:
                    break
            definitions[name] = {
                "fields": fields,
                "by_number": {field["number"]: field for field in fields},
                "by_name": {field["name"]: field for field in fields},
            }
    return definitions


_OFFICIAL_1201_ROOT = Path(__file__).resolve().parent / "runtime" / "official-updates" / "1.201.01"
LEGACY_PROTO_DEFS = _load_proto_definitions(
    [
        _OFFICIAL_1201_ROOT / "recovered-client" / "csproto" / "common.proto",
        _OFFICIAL_1201_ROOT / "recovered-client" / "csproto" / "up.proto",
        _OFFICIAL_1201_ROOT / "recovered-client" / "csproto" / "down.proto",
    ]
)
NEW_PROTO_DEFS = _load_proto_definitions(
    [
        _OFFICIAL_1201_ROOT / "device-proto" / "common.proto",
        _OFFICIAL_1201_ROOT / "device-proto" / "up.proto",
        _OFFICIAL_1201_ROOT / "device-proto" / "down.proto",
    ]
)

PROTO_STRING_TYPES = {"string", "bytes"}
PROTO_FIXED32_TYPES = {"fixed32", "sfixed32", "float"}
PROTO_FIXED64_TYPES = {"fixed64", "sfixed64", "double"}

# Some HD client models dereference optional login objects unconditionally.
# The production server always sends these objects even though proto2 marks
# them optional, while older Classic login captures legitimately omit them.
PROTO_RUNTIME_REQUIRED_FIELDS = {
    "reply_user": {"pentagram", "reply_udeep_stage"},
    "stage": {"card_quick_idle_cd"},
}

# Repeated records captured from Classic can use table IDs that no longer
# exist in HD. The HD client creates the current daily/weekly task objects from
# its own tables, so omit stale task instances and let those defaults stand.
PROTO_INCOMPATIBLE_REPEATED_FIELDS = {
    "task_info": {"daily_todolists", "weekly_todolists", "line_tasklists"},
}

# Classic has no equivalent for the HD deep-stage idle-reward query. Carry the
# operation through the legacy business loop in a private extension field, then
# replace it with the real HD reply field before writing the framed response.
LEGACY_SYNTHETIC_STAGE_QUERY_IDLE_FIELD = 100
LEGACY_SYNTHETIC_ASSIST_STAGE_REQUEST_FIELD = 200
LEGACY_SYNTHETIC_ASSIST_STAGE_RESPONSE_FIELD = 201
# Generic carrier used for 1.201 HD root modules that have no Classic root
# equivalent.  These fields never leave the local Classic compatibility loop;
# they are replaced with the real HD request/reply root fields at the frame
# boundary.
LEGACY_SYNTHETIC_NATIVE_HD_REQUEST_FIELD = 250
LEGACY_SYNTHETIC_NATIVE_HD_RESPONSE_FIELD = 251


def _canonical_proto_operation(name: str) -> str:
    return re.sub(
        r"_",
        "",
        re.sub(r"^(?:(?:deprecated_)?(?:req|reply)_|(?:get|query)_)", "", name),
    )


def _build_native_hd_routes() -> dict[int, dict]:
    up_root = NEW_PROTO_DEFS.get("up_msg", {})
    down_root = NEW_PROTO_DEFS.get("down_msg", {})
    legacy_names = set(LEGACY_PROTO_DEFS.get("up_msg", {}).get("by_name", {}))
    down_by_type = {
        field["type"]: field
        for field in down_root.get("fields", [])
        if field["type"].startswith("reply_")
    }
    aliases = {
        "act_trial": "trial",
        "activity_travel": "travel",
    }
    routes: dict[int, dict] = {}
    for outer in up_root.get("fields", []):
        if not outer["type"].startswith("req_") or outer["name"] in legacy_names:
            continue
        module = outer["type"][4:]
        if module in {"assist_stage", "deep_stage"}:
            continue
        reply_type = f"reply_{aliases.get(module, module)}"
        reply_outer = down_by_type.get(reply_type)
        if reply_outer is None:
            continue
        request_fields = NEW_PROTO_DEFS.get(outer["type"], {}).get("fields", [])
        reply_fields = NEW_PROTO_DEFS.get(reply_type, {}).get("fields", [])
        operations = {}
        for request_field in request_fields:
            request_name = _canonical_proto_operation(request_field["name"])
            exact = next(
                (
                    field
                    for field in reply_fields
                    if _canonical_proto_operation(field["name"]) == request_name
                ),
                None,
            )
            same_number = next(
                (
                    field
                    for field in reply_fields
                    if field["number"] == request_field["number"]
                ),
                None,
            )
            target = exact or same_number or (reply_fields[0] if reply_fields else None)
            operations[request_field["number"]] = {
                "request_name": request_field["name"],
                "reply_field": target["number"] if target else request_field["number"],
                "reply_name": target["name"] if target else "generic",
                "reply_type": target["type"] if target else "bytes",
            }
        routes[outer["number"]] = {
            "module": module,
            "request_type": outer["type"],
            "reply_outer_field": reply_outer["number"],
            "reply_type": reply_type,
            "operations": operations,
        }
    return routes


NEW_NATIVE_HD_ROUTES = _build_native_hd_routes()


def _required_default_field(
    field: dict,
    definitions: dict[str, dict],
    depth: int,
) -> ProtoField:
    field_type = field["type"]
    if field_type in PROTO_STRING_TYPES:
        return ProtoField(field["number"], 2, b"")
    if field_type in definitions:
        return ProtoField(
            field["number"],
            2,
            synthesize_required_proto_message(field_type, definitions, depth + 1),
        )
    # All remaining scalar/enum fields used by the compatibility login payload
    # are varints. Give enum-like `type` fields their first conventional value.
    value = 1 if field["name"] == "type" or field["name"].endswith("_type") else 0
    return ProtoField(field["number"], 0, value)


def synthesize_required_proto_message(
    message_type: str,
    definitions: dict[str, dict],
    depth: int = 0,
) -> bytes:
    if depth > 32:
        return b""
    definition = definitions.get(message_type)
    if not definition:
        return b""
    return encode_proto_fields(
        [
            _required_default_field(field, definitions, depth)
            for field in definition["fields"]
            if field["label"] == "required"
            and field["type"] not in PROTO_FIXED32_TYPES
            and field["type"] not in PROTO_FIXED64_TYPES
        ]
    )


def project_proto_message(
    payload: bytes,
    source_type: str,
    target_type: str,
    source_defs: dict[str, dict],
    target_defs: dict[str, dict],
    depth: int = 0,
) -> bytes:
    """Project protobuf fields by name, recursively translating message layouts."""
    if depth > 32:
        return payload
    source = source_defs.get(source_type)
    target = target_defs.get(target_type)
    if not source or not target:
        return payload
    try:
        fields = parse_proto_fields(payload)
    except ValueError:
        return payload

    projected = []
    present_names = set()
    for field in fields:
        source_field = source["by_number"].get(field.number)
        if source_field is None:
            continue
        target_field = target["by_name"].get(source_field["name"])
        if target_field is None:
            continue
        if target_field["name"] in PROTO_INCOMPATIBLE_REPEATED_FIELDS.get(
            target_type, set()
        ):
            continue
        if target_field["type"] in target_defs and field.wire_type != 2:
            # A field number can be reused as a scalar in an older wire
            # version. Keeping that scalar when HD expects a nested message
            # makes protobufjs consume subsequent bytes as a bogus length.
            continue
        present_names.add(target_field["name"])
        value = field.value
        if field.wire_type == 2:
            source_nested = source_field["type"]
            target_nested = target_field["type"]
            if source_nested in source_defs and target_nested in target_defs:
                value = project_proto_message(
                    bytes(value),
                    source_nested,
                    target_nested,
                    source_defs,
                    target_defs,
                    depth + 1,
                )
        projected.append(ProtoField(target_field["number"], field.wire_type, value))
    if target_type == "reply_tavern_open_panel":
        # HD 1.201 added this aggregate after the Classic schema.  Its
        # Stargazer lock dialog reads the aggregate directly, so name-based
        # projection cannot obtain it from the older response by itself.
        total_draw_times = target["by_name"].get("total_draw_times")
        if total_draw_times and total_draw_times["name"] not in present_names:
            projected.append(ProtoField(total_draw_times["number"], 0, 999))
            present_names.add(total_draw_times["name"])
    if target_type == "hero":
        # Classic has no trans_quality member.  HD uses it as a battle-side
        # mirror of quality, so synthesize it while projecting by name.
        trans_quality = target["by_name"].get("trans_quality")
        quality = target["by_name"].get("quality")
        if trans_quality and trans_quality["name"] not in present_names and quality:
            quality_field = next(
                (item for item in projected if item.number == quality["number"] and item.wire_type == 0),
                None,
            )
            if quality_field is not None:
                projected.append(ProtoField(trans_quality["number"], 0, int(quality_field.value)))
                present_names.add(trans_quality["name"])
    runtime_required = PROTO_RUNTIME_REQUIRED_FIELDS.get(target_type, set())
    for target_field in target["fields"]:
        if (
            target_field["label"] != "required"
            and target_field["name"] not in runtime_required
        ) or target_field["name"] in present_names:
            continue
        if target_field["type"] in PROTO_FIXED32_TYPES | PROTO_FIXED64_TYPES:
            continue
        default_field = _required_default_field(target_field, target_defs, depth)
        if target_type == "reply_user" and target_field["name"] == "pentagram":
            projected_by_number = {item.number: item for item in projected}
            pg_lv = int(projected_by_number.get(42, ProtoField(42, 0, 0)).value)
            max_pg_lv = int(projected_by_number.get(44, ProtoField(44, 0, pg_lv)).value)
            hero_aid_lv = int(projected_by_number.get(72, ProtoField(72, 0, pg_lv)).value)
            pentagram_def = target_defs.get(target_field["type"], {})
            pentagram_by_name = pentagram_def.get("by_name", {})
            pentagram_fields = []
            for name, value in (
                ("hero_aid_lv", hero_aid_lv),
                ("pg_lv", pg_lv),
                ("max_pg_lv", max(max_pg_lv, pg_lv)),
            ):
                nested = pentagram_by_name.get(name)
                if nested:
                    pentagram_fields.append(ProtoField(nested["number"], 0, value))
            default_field = ProtoField(
                target_field["number"],
                2,
                encode_proto_fields(pentagram_fields),
            )
        elif target_type == "reply_user" and target_field["name"] == "reply_udeep_stage":
            projected_by_number = {item.number: item for item in projected}
            stage_field = projected_by_number.get(11)
            stage_fields = (
                parse_proto_fields(bytes(stage_field.value))
                if stage_field is not None and stage_field.wire_type == 2
                else []
            )
            stage_idle = get_proto_bytes(stage_fields, 2)
            deep_def = target_defs.get(target_field["type"], {})
            deep_by_name = deep_def.get("by_name", {})
            deep_fields = []
            cur_stage_field = deep_by_name.get("cur_stage")
            if cur_stage_field:
                deep_fields.append(ProtoField(cur_stage_field["number"], 0, 1))
            idle_field = deep_by_name.get("idle")
            if idle_field:
                deep_fields.append(
                    ProtoField(
                        idle_field["number"],
                        2,
                        stage_idle
                        if stage_idle is not None
                        else synthesize_required_proto_message(
                            idle_field["type"], target_defs, depth + 1
                        ),
                    )
                )
            hamper_field = deep_by_name.get("reply_hamper_info")
            if hamper_field:
                deep_fields.append(
                    ProtoField(
                        hamper_field["number"],
                        2,
                        synthesize_required_proto_message(
                            hamper_field["type"], target_defs, depth + 1
                        ),
                    )
                )
            default_field = ProtoField(
                target_field["number"],
                2,
                encode_proto_fields(deep_fields),
            )
        elif target_type == "stage" and target_field["name"] == "card_quick_idle_cd":
            # HD models construct a cooldown helper without checking whether
            # this monthly-card slot exists. Reuse the ordinary quick-idle CD
            # schedule while keeping an independent counter payload.
            quick_idle = next(
                (item for item in projected if item.number == 4 and item.wire_type == 2),
                None,
            )
            if quick_idle is not None:
                default_field = ProtoField(
                    target_field["number"],
                    2,
                    bytes(quick_idle.value),
                )
        projected.append(default_field)
    return encode_proto_fields(projected)


@dataclass(frozen=True)
class NewProtoFrame:
    seq: int
    repeat: int
    module_id: int
    sign: bytes
    proto_data: bytes
    extra_data: bytes
    control: int
    crc32: int


def decode_new_proto_frame(message: bytes) -> NewProtoFrame:
    """Decode the CRC framed transport introduced by the 1.201 client.

    Client requests don't always append the optional extra-data length, while
    the JavaScript response decoder always reads it.  Accept both request
    shapes and always emit it from ``encode_new_proto_frame``.
    """
    if len(message) < NEW_PROTO_MIN_FRAME_SIZE:
        raise ValueError("new-proto frame is too short")

    expected_crc = struct.unpack_from(">I", message, 0)[0]
    actual_crc = zlib.crc32(message[4:]) & 0xFFFFFFFF
    if expected_crc != actual_crc:
        raise ValueError(
            f"new-proto CRC mismatch: expected={expected_crc:08x} actual={actual_crc:08x}"
        )

    control = message[4]
    if control not in (0, 1):
        raise ValueError(f"unsupported new-proto control byte: {control}")
    seq, repeat, module_id = struct.unpack_from(">III", message, 5)
    sign_length = struct.unpack_from(">H", message, 17)[0]
    payload_offset = 19 + sign_length
    if payload_offset > len(message):
        raise ValueError("new-proto sign extends beyond the frame")
    sign = message[19:payload_offset]
    payload = message[payload_offset:]
    if control == 1:
        try:
            payload = zlib.decompress(payload)
        except zlib.error as exc:
            raise ValueError(f"invalid compressed new-proto payload: {exc}") from exc
    if len(payload) < 4:
        raise ValueError("new-proto payload length is missing")
    proto_length = struct.unpack_from(">I", payload, 0)[0]
    proto_end = 4 + proto_length
    if proto_end > len(payload):
        raise ValueError("new-proto protobuf payload is truncated")
    proto_data = payload[4:proto_end]

    extra_data = b""
    if len(payload) >= proto_end + 4:
        extra_length = struct.unpack_from(">I", payload, proto_end)[0]
        extra_end = proto_end + 4 + extra_length
        if extra_end > len(payload):
            raise ValueError("new-proto extra payload is truncated")
        extra_data = payload[proto_end + 4:extra_end]
        if extra_end != len(payload):
            raise ValueError("new-proto payload has trailing bytes")
    elif len(payload) != proto_end:
        raise ValueError("new-proto optional extra length is truncated")

    return NewProtoFrame(
        seq=seq,
        repeat=repeat,
        module_id=module_id,
        sign=sign,
        proto_data=proto_data,
        extra_data=extra_data,
        control=control,
        crc32=expected_crc,
    )


def encode_new_proto_frame(
    proto_data: bytes,
    *,
    seq: int,
    module_id: int = 0,
    repeat: int = 0,
    sign: bytes = b"",
    extra_data: bytes = b"",
    compress_threshold: int = 1024,
) -> bytes:
    payload = b"".join(
        (
            struct.pack(">I", len(proto_data)),
            proto_data,
            struct.pack(">I", len(extra_data)),
            extra_data,
        )
    )
    control = 0
    if len(proto_data) >= compress_threshold:
        control = 1
        payload = zlib.compress(payload)
    body = b"".join(
        (
            bytes((control,)),
            struct.pack(">IIIH", int(seq), int(repeat), int(module_id), len(sign)),
            sign,
            payload,
        )
    )
    return struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF) + body


def new_core_request_to_legacy(frame: NewProtoFrame) -> bytes:
    """Project the 1.201 core request root onto the legacy up_msg layout.

    The HD root is compacted independently from the Classic root (for example,
    ``req_sdk_login`` is field 2 instead of field 3). Sequence metadata now
    lives in the frame prefix, so fields are projected by protobuf name.
    """
    if frame.module_id != 0:
        raise ValueError(f"module {frame.module_id} is not a core request")
    projected = [ProtoField(1, 0, frame.seq)]
    if frame.repeat:
        projected.append(ProtoField(2, 0, frame.repeat))
    legacy_root = project_proto_message(
        frame.proto_data,
        "up_msg",
        "up_msg",
        NEW_PROTO_DEFS,
        LEGACY_PROTO_DEFS,
    )
    new_stage_def = NEW_PROTO_DEFS["up_msg"]["by_name"].get("req_stage")
    legacy_stage_def = LEGACY_PROTO_DEFS["up_msg"]["by_name"].get("req_stage")
    if new_stage_def and legacy_stage_def:
        new_root_fields = parse_proto_fields(frame.proto_data)
        new_stage_payload = get_proto_bytes(new_root_fields, new_stage_def["number"])
        if new_stage_payload is not None:
            new_stage_fields = parse_proto_fields(new_stage_payload)
            # HD changed next_chapter from req_msg to t_idle_type. The shared
            # projector rejects this wire-type change, so explicitly convert
            # even the default enum value (0) into Classic's empty req_msg.
            new_next_chapter_def = NEW_PROTO_DEFS["req_stage"]["by_name"].get("next_chapter")
            legacy_next_chapter_def = LEGACY_PROTO_DEFS["req_stage"]["by_name"].get("next_chapter")
            if new_next_chapter_def and legacy_next_chapter_def and any(
                field.number == new_next_chapter_def["number"] for field in new_stage_fields
            ):
                legacy_root_fields = parse_proto_fields(legacy_root)
                legacy_stage_payload = get_proto_bytes(
                    legacy_root_fields, legacy_stage_def["number"]
                ) or b""
                legacy_stage_fields = set_proto_bytes(
                    parse_proto_fields(legacy_stage_payload),
                    legacy_next_chapter_def["number"],
                    b"",
                )
                legacy_root = encode_proto_fields(
                    set_proto_bytes(
                        legacy_root_fields,
                        legacy_stage_def["number"],
                        encode_proto_fields(legacy_stage_fields),
                    )
                )
            query_idle = get_proto_bytes(new_stage_fields, 10)
            if query_idle is not None:
                legacy_root_fields = parse_proto_fields(legacy_root)
                legacy_stage_payload = get_proto_bytes(
                    legacy_root_fields, legacy_stage_def["number"]
                ) or b""
                legacy_stage_fields = set_proto_bytes(
                    parse_proto_fields(legacy_stage_payload),
                    LEGACY_SYNTHETIC_STAGE_QUERY_IDLE_FIELD,
                    query_idle,
                )
                legacy_root = encode_proto_fields(
                    set_proto_bytes(
                        legacy_root_fields,
                        legacy_stage_def["number"],
                        encode_proto_fields(legacy_stage_fields),
                    )
                )
    new_assist_def = NEW_PROTO_DEFS["up_msg"]["by_name"].get("req_assist_stage")
    if new_assist_def:
        new_assist_payload = get_proto_bytes(
            parse_proto_fields(frame.proto_data), new_assist_def["number"]
        )
        if new_assist_payload is not None:
            legacy_root = encode_proto_fields(
                set_proto_bytes(
                    parse_proto_fields(legacy_root),
                    LEGACY_SYNTHETIC_ASSIST_STAGE_REQUEST_FIELD,
                    new_assist_payload,
                )
            )
    new_root_fields = parse_proto_fields(frame.proto_data)
    for field in new_root_fields:
        if field.number not in NEW_NATIVE_HD_ROUTES or field.wire_type != 2:
            continue
        native_wrapper = b"".join(
            (
                encode_varint_field(1, field.number),
                encode_length_delimited_field(2, bytes(field.value)),
            )
        )
        legacy_root = encode_proto_fields(
            set_proto_bytes(
                parse_proto_fields(legacy_root),
                LEGACY_SYNTHETIC_NATIVE_HD_REQUEST_FIELD,
                native_wrapper,
            )
        )
        break
    return encode_proto_fields(projected) + legacy_root


def legacy_core_response_to_new(message: bytes) -> tuple[int, bytes]:
    """Remove reply_seq and project Classic response fields onto the HD root."""
    fields = parse_proto_fields(message)
    reply_seq = int(get_proto_varint(fields, 2) or 0)
    native_query_idle_reply = None
    native_assist_stage_reply = get_proto_bytes(
        fields, LEGACY_SYNTHETIC_ASSIST_STAGE_RESPONSE_FIELD
    )
    native_hd_reply_wrapper = get_proto_bytes(
        fields, LEGACY_SYNTHETIC_NATIVE_HD_RESPONSE_FIELD
    )
    legacy_stage_def = LEGACY_PROTO_DEFS["down_msg"]["by_name"].get("reply_stage")
    legacy_next_chapter = False
    if legacy_stage_def:
        legacy_stage_payload = get_proto_bytes(fields, legacy_stage_def["number"])
        if legacy_stage_payload is not None:
            legacy_stage_fields = parse_proto_fields(legacy_stage_payload)
            native_query_idle_reply = get_proto_bytes(
                legacy_stage_fields,
                LEGACY_SYNTHETIC_STAGE_QUERY_IDLE_FIELD,
            )
            legacy_next_chapter = any(
                field.number == 7 for field in legacy_stage_fields
            )

    projected = project_proto_message(
        message,
        "down_msg",
        "down_msg",
        LEGACY_PROTO_DEFS,
        NEW_PROTO_DEFS,
    )
    if native_query_idle_reply is not None:
        new_stage_def = NEW_PROTO_DEFS["down_msg"]["by_name"]["reply_stage"]
        projected_fields = parse_proto_fields(projected)
        new_stage_payload = get_proto_bytes(
            projected_fields, new_stage_def["number"]
        ) or b""
        new_stage_fields = set_proto_bytes(
            parse_proto_fields(new_stage_payload), 10, native_query_idle_reply
        )
        projected = encode_proto_fields(
            set_proto_bytes(
                projected_fields,
                new_stage_def["number"],
                encode_proto_fields(new_stage_fields),
            )
        )
    if legacy_next_chapter:
        # Classic replies with enum ``result`` (wire 0), but HD changed this
        # same-named field to a ``reward`` message (wire 2). Name projection
        # alone therefore creates an undecodable length. Return a valid empty
        # reward object; concrete chapter rewards remain persisted by the
        # local domain action and can be added here when the table is modeled.
        new_stage_def = NEW_PROTO_DEFS["down_msg"]["by_name"]["reply_stage"]
        projected_fields = parse_proto_fields(projected)
        new_stage_payload = get_proto_bytes(
            projected_fields, new_stage_def["number"]
        ) or b""
        projected = encode_proto_fields(
            set_proto_bytes(
                projected_fields,
                new_stage_def["number"],
                encode_proto_fields(
                    [
                        field
                        for field in parse_proto_fields(new_stage_payload)
                        if field.number != 5
                    ]
                    + [ProtoField(5, 2, b"")]
                ),
            )
        )
    if native_assist_stage_reply is not None:
        new_assist_def = NEW_PROTO_DEFS["down_msg"]["by_name"]["reply_assist_stage"]
        projected = encode_proto_fields(
            set_proto_bytes(
                parse_proto_fields(projected),
                new_assist_def["number"],
                native_assist_stage_reply,
            )
        )
    if native_hd_reply_wrapper is not None:
        wrapper_fields = parse_proto_fields(native_hd_reply_wrapper)
        native_outer_field = get_proto_varint(wrapper_fields, 1)
        native_reply_payload = get_proto_bytes(wrapper_fields, 2)
        if native_outer_field is not None and native_reply_payload is not None:
            projected = encode_proto_fields(
                set_proto_bytes(
                    parse_proto_fields(projected),
                    int(native_outer_field),
                    native_reply_payload,
                )
            )
    return reply_seq, projected


class CompatibleClientConnection:
    """Expose legacy protobuf messages to the existing session implementation."""

    def __init__(self, client: ServerConnection) -> None:
        self.client = client
        self.uses_new_proto: bool | None = None
        self.uses_classic_framed_proto: bool | None = None
        self.request_modules: dict[int, int] = {}

    async def recv(self) -> str | bytes:
        message = await self.client.recv()
        if not isinstance(message, bytes):
            return message

        frame = None
        try:
            frame = decode_new_proto_frame(message)
        except ValueError:
            if self.uses_new_proto:
                raise
        if frame is None:
            if self.uses_new_proto is None:
                self.uses_new_proto = False
            return message

        self.uses_new_proto = True
        self.request_modules[frame.seq] = frame.module_id
        if frame.module_id == 0:
            # Classic 1.201.01 also uses the new CRC/sequence frame, but keeps
            # the Classic core protobuf field numbers. Its first SDK-login
            # request is therefore root field 3. Projecting it through the HD
            # map changes it to field 4 (req_unit) and leaves login waiting
            # forever. Detect the login signature once and retain the Classic
            # core layout for the rest of this connection.
            if self.uses_classic_framed_proto is None:
                root_fields = parse_proto_fields(frame.proto_data)
                sdk_payload = get_proto_bytes(root_fields, 3)
                reconnect_payload = get_proto_bytes(root_fields, 29)
                self.uses_classic_framed_proto = bool(
                    (
                        sdk_payload
                        and (
                            b"local-ticket-" in sdk_payload
                            or b"local-player:" in sdk_payload
                            or b"local-auth:" in sdk_payload
                        )
                    )
                    or (
                        reconnect_payload
                        and looks_like_reconnect_payload(reconnect_payload)
                    )
                )
            if self.uses_classic_framed_proto:
                prefix = [ProtoField(1, 0, frame.seq)]
                if frame.repeat:
                    prefix.append(ProtoField(2, 0, frame.repeat))
                return encode_proto_fields(prefix) + frame.proto_data
            return new_core_request_to_legacy(frame)
        raise ValueError(
            f"new-proto module {frame.module_id} requires a module-specific adapter"
        )

    async def send(self, message: str | bytes) -> None:
        if not self.uses_new_proto or not isinstance(message, bytes):
            await self.client.send(message)
            return

        if self.uses_classic_framed_proto:
            fields = parse_proto_fields(message)
            reply_seq = int(get_proto_varint(fields, 2) or 0)
            proto_data = encode_proto_fields(
                [field for field in fields if field.number != 2]
            )
        else:
            reply_seq, proto_data = legacy_core_response_to_new(message)
        module_id = self.request_modules.pop(reply_seq, 0) if reply_seq else 0
        await self.client.send(
            encode_new_proto_frame(
                proto_data,
                seq=reply_seq,
                module_id=module_id,
            )
        )

BUSINESS_RESPONSE_GENERATORS = {
    "stage_assist_summaries": {
        "fallback_kinds": {"stage_query_assist_summaries"},
        "label": "db_stage_assist_summaries",
        "tables": ["players", "inventory_items", "characters", "stage_progress"],
    },
    "stage_battle_start": {
        "fallback_kinds": {"stage_battle_start"},
        "label": "db_stage_battle_start",
        "tables": ["players", "characters", "stage_progress"],
    },
    "stage_battle_result": {
        "fallback_kinds": {"stage_battle_result"},
        "label": "db_stage_battle_result",
        "tables": ["players", "inventory_items", "characters", "stage_progress"],
    },
    "tavern_draw": {
        "fallback_kinds": {"tavern_draw"},
        "label": "db_tavern_draw",
        "tables": ["players", "inventory_items", "characters"],
    },
}

TAVERN_SINGLE_DRAW_RULE = OFFICIAL_RULES["tavern"]["single_draw"]
TAVERN_DRAW_COST_ITEM_ID = int(TAVERN_SINGLE_DRAW_RULE["cost"]["id"])
TAVERN_DRAW_COST_AMOUNT = int(TAVERN_SINGLE_DRAW_RULE["cost"]["amount"])
TAVERN_DRAW_COST_INVENTORY_KEY = f"item_{TAVERN_DRAW_COST_ITEM_ID}"
HERO_UPGRADE_RULE = OFFICIAL_RULES["hero_upgrade"]["observed_case"]
PROTOCOL_ROUTE_MAP_PATH = Path(
    os.environ.get("AFK_PROTOCOL_ROUTE_MAP")
    or Path(__file__).resolve().parent / "runtime" / "protocol-route-map.json"
)
try:
    PROTOCOL_ROUTE_MAP = json.loads(PROTOCOL_ROUTE_MAP_PATH.read_text(encoding="utf-8"))["modules"]
except Exception:
    PROTOCOL_ROUTE_MAP = {}
PROTOBUF_SCHEMA_PATH = Path(
    os.environ.get("AFK_PROTOBUF_SCHEMA")
    or Path(__file__).resolve().parent / "runtime" / "protobuf-schema.json"
)
try:
    _PROTOBUF_SCHEMA = json.loads(PROTOBUF_SCHEMA_PATH.read_text(encoding="utf-8"))
    PROTOBUF_MESSAGES = _PROTOBUF_SCHEMA.get("messages", {})
    PROTOBUF_ENUMS = _PROTOBUF_SCHEMA.get("enums", {})
except Exception:
    PROTOBUF_MESSAGES = {}
    PROTOBUF_ENUMS = {}
LATEST_PROTOBUF_SCHEMA_PATH = (
    Path(__file__).resolve().parent
    / "runtime"
    / "official-updates"
    / "1.201.01"
    / "protocol"
    / "protobuf-schema.json"
)
try:
    _LATEST_PROTOBUF_SCHEMA = json.loads(
        LATEST_PROTOBUF_SCHEMA_PATH.read_text(encoding="utf-8")
    )
    LATEST_PROTOBUF_MESSAGES = _LATEST_PROTOBUF_SCHEMA.get("messages", {})
    LATEST_PROTOBUF_ENUMS = _LATEST_PROTOBUF_SCHEMA.get("enums", {})
except Exception:
    LATEST_PROTOBUF_MESSAGES = PROTOBUF_MESSAGES
    LATEST_PROTOBUF_ENUMS = PROTOBUF_ENUMS

# The extracted descriptor predates a small set of 1.201 HD-only messages.
# Merge the proto files recovered from the installed APK so those modules get
# their real reply shape instead of an empty bytes placeholder.
HD_RUNTIME_MESSAGES = dict(LATEST_PROTOBUF_MESSAGES)
for _message_name, _message_definition in NEW_PROTO_DEFS.items():
    HD_RUNTIME_MESSAGES.setdefault(_message_name, _message_definition)

DEFAULT_ITEM_PROTO_IDS = {
    "gold": (1, 10000001),
    "hero_exp": (1, 10000004),
    "player_exp": (1, 10000006),
    "diamond": (2, 1),
    TAVERN_DRAW_COST_INVENTORY_KEY: (2, TAVERN_DRAW_COST_ITEM_ID),
}

CURRENCY_PROTO_IDS = {
    "gold": 10000001, "diamond": 10000002, "diamond_charge": 10000003,
    "hero_exp": 10000004, "player_exp": 10000006, "exp": 10000006,
    "guild_coin": 10000007, "maze_coin": 10000008, "friend_coin": 10000011,
    "pentagram_coin": 10000012, "top_arena_coin": 10000013,
    "battle_pass_coin": 10000015, "champion_glory_exp": 10000016,
    "astrolabe_coin": 10000017, "achievement_point": 10000018,
    "homeland_coin": 10000019, "homelandcoin": 10000019,
    "ruby": 10000020, "bind_ruby": 10000021, "ruby_charge": 10000022,
    "crystal_coin": 10000023, "wish_coin": 10000024,
    "race_coin": 10000027, "rog_coin": 10000028,
    # Domain snapshots use the compact API spelling while the HD protobuf
    # enum uses ``pet_coin``.  Encoding an unknown string as zero makes
    # protobufjs expose a numeric tid; the map reward UI then crashes while
    # calling ``toLowerCase`` on it.
    "pet_coin": 10000029, "petcoin": 10000029,
    "monthly_card_exp": 10000030, "pet_mix_coin": 10000031,
    "monster_coin": 10000032, "war_conch": 10000033,
    "war_army": 10000034,
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class JsonlLogger:
    def __init__(self, path: Path, mysql_writer: "MysqlWsWriter | None" = None) -> None:
        self.path = path
        self.mysql_writer = mysql_writer
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = asyncio.Lock()

    async def write(self, payload: dict) -> None:
        line = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        async with self._lock:
            with self.path.open("a", encoding="utf-8") as handle:
                handle.write(line)
                handle.write("\n")
        if self.mysql_writer is not None:
            await self.mysql_writer.write(payload)

    async def close(self) -> None:
        if self.mysql_writer is not None:
            await self.mysql_writer.close()


def local_mock_base_url() -> str:
    host = os.environ.get("AFK_MOCK_HOST", "127.0.0.1")
    port = os.environ.get("AFK_MOCK_PORT", "18080")
    return os.environ.get("AFK_MOCK_INTERNAL_BASE_URL", f"http://{host}:{port}")


def http_json(method: str, path: str, payload: dict | None = None) -> dict:
    url = f"{local_mock_base_url()}{path}"
    body = None
    headers = {"accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        headers["content-type"] = "application/json; charset=utf-8"
    request = Request(url, data=body, headers=headers, method=method)
    with urlopen(request, timeout=5) as response:
        text = response.read().decode("utf-8")
    return json.loads(text) if text else {}


def http_json_with_retry(
    method: str,
    path: str,
    payload: dict | None = None,
    attempts: int = 3,
    delay_seconds: float = 0.1,
) -> dict:
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            return http_json(method, path, payload)
        except Exception as exc:
            last_error = exc
            if attempt < attempts - 1:
                time.sleep(delay_seconds)
    assert last_error is not None
    raise last_error


def http_json_with_application_error(method: str, path: str, payload: dict | None = None) -> dict:
    try:
        return http_json_with_retry(method, path, payload)
    except HTTPError as exc:
        try:
            body = exc.read().decode("utf-8")
            decoded = json.loads(body) if body else {}
        except Exception:
            decoded = {}
        return {"ok": False, "status": int(exc.code), "error": decoded.get("error") or f"http_{exc.code}", **decoded}


class MysqlWsWriter:
    def __init__(self, enabled: bool) -> None:
        self.enabled = enabled
        self._lock = asyncio.Lock()
        self._warned = False

    async def connect(self) -> None:
        return

    async def write(self, payload: dict) -> None:
        if not self.enabled:
            return
        if payload.get("event") != "frame":
            return

        async with self._lock:
            try:
                await asyncio.to_thread(
                    http_json,
                    "POST",
                    "/__afk/internal/ws-frame",
                    payload,
                )
            except Exception as exc:
                if not self._warned:
                    self._warned = True
                    print(f"[mysql] websocket frame HTTP write unavailable: {exc}", flush=True)

    async def close(self) -> None:
        return


class LoginPersistence:
    def __init__(self, enabled: bool) -> None:
        self.enabled = enabled
        self._lock = asyncio.Lock()
        self._warned = False

    async def connect(self) -> None:
        return

    async def persist_structured_login(
        self,
        session_id: int,
        sdk_login_request: dict,
        login_request: dict,
        charge_request: dict,
        business_state: dict | None = None,
    ) -> dict | None:
        if not self.enabled:
            return None

        inventory = []
        if business_state:
            for item in business_state.get("inventory") or []:
                item_id = item.get("item_id")
                if not item_id:
                    continue
                inventory.append(
                    {
                        "item_id": item_id,
                        "quantity": parse_int(item.get("quantity"), 0),
                        "extra": item.get("extra_json") or {},
                    }
                )

        payload = {
            "session_id": session_id,
            "htoken": sdk_login_request.get("htoken"),
            "svr_id": sdk_login_request.get("svr_id"),
            "sdk_login_seq": sdk_login_request.get("seq"),
            "login_seq": login_request.get("seq"),
            "charge_seq": charge_request.get("seq"),
            "inventory": inventory,
        }
        async with self._lock:
            try:
                return await asyncio.to_thread(
                    http_json_with_retry,
                    "POST",
                    "/__afk/internal/structured-login",
                    payload,
                )
            except Exception as exc:
                if not self._warned:
                    self._warned = True
                    print(f"[mysql] login persistence HTTP write unavailable: {exc}", flush=True)
                return None

    async def close(self) -> None:
        return


class BusinessStateProvider:
    def __init__(self, enabled: bool) -> None:
        self.enabled = enabled
        self._lock = asyncio.Lock()
        self._warned = False
        self.player_uid = ""

    def bind_player(self, player_uid: str | None) -> None:
        self.player_uid = str(player_uid or "")

    async def bind_session_token(self, token: str | None) -> dict | None:
        """Resolve an SDK auth token before constructing the native login reply."""
        if not self.enabled or not token:
            return None
        async with self._lock:
            try:
                identity = await asyncio.to_thread(
                    http_json_with_retry,
                    "POST",
                    "/__afk/social/session",
                    {"token": str(token)},
                )
            except Exception as exc:
                if not self._warned:
                    self._warned = True
                    print(f"[mysql] SDK session resolution unavailable: {exc}", flush=True)
                return None
        if identity and identity.get("player_uid"):
            self.bind_player(identity.get("player_uid"))
        return identity

    def _payload(self, payload: dict) -> dict:
        return {**payload, **({"player_uid": self.player_uid} if self.player_uid else {})}

    def _get_path(self, path: str) -> str:
        if not self.player_uid:
            return path
        separator = "&" if "?" in path else "?"
        return f"{path}{separator}player_uid={quote(self.player_uid, safe='')}"

    async def connect(self) -> None:
        return

    async def get_business_state(self) -> dict | None:
        if not self.enabled:
            return None

        async with self._lock:
            try:
                return await asyncio.to_thread(
                    http_json_with_retry,
                    "GET",
                    self._get_path("/__afk/db/business-state"),
                    None,
                )
            except Exception as exc:
                if not self._warned:
                    self._warned = True
                    print(f"[mysql] business state HTTP read unavailable: {exc}", flush=True)
                return None

    async def set_inventory_quantity(
        self,
        item_id: str,
        quantity: int,
        extra: dict | None = None,
    ) -> dict | None:
        if not self.enabled:
            return None

        async with self._lock:
            try:
                return await asyncio.to_thread(
                    http_json_with_retry,
                    "POST",
                    "/__afk/db/inventory",
                    self._payload({
                        "item_id": item_id,
                        "quantity": max(0, int(quantity)),
                        "extra": extra or {},
                    }),
                )
            except Exception as exc:
                if not self._warned:
                    self._warned = True
                    print(f"[mysql] inventory HTTP write unavailable: {exc}", flush=True)
                return None

    async def upsert_character(
        self,
        character_id: str,
        level: int = 1,
        star: int = 1,
        extra: dict | None = None,
    ) -> dict | None:
        if not self.enabled:
            return None

        async with self._lock:
            try:
                return await asyncio.to_thread(
                    http_json_with_retry,
                    "POST",
                    "/__afk/db/characters",
                    self._payload({
                        "character_id": character_id,
                        "level": max(1, int(level)),
                        "star": max(1, int(star)),
                        "extra": extra or {},
                    }),
                )
            except Exception as exc:
                if not self._warned:
                    self._warned = True
                    print(f"[mysql] character HTTP write unavailable: {exc}", flush=True)
                return None

    async def tavern_draw(
        self,
        tavern_id: int,
        count: int = 1,
        request_seq: int | None = None,
        idempotency_key: str | None = None,
    ) -> dict | None:
        if not self.enabled:
            return None

        async with self._lock:
            try:
                return await asyncio.to_thread(
                    http_json_with_application_error,
                    "POST",
                    "/__afk/game/tavern/draw",
                    self._payload({
                        "tavern_id": int(tavern_id),
                        "count": int(count),
                        "request_seq": request_seq,
                        "idempotency_key": idempotency_key,
                    }),
                )
            except Exception as exc:
                if not self._warned:
                    self._warned = True
                    print(f"[mysql] tavern transaction HTTP write unavailable: {exc}", flush=True)
                return None

    async def task_batch_claim(self, ids: list[int], request_seq: int | None = None) -> dict | None:
        if not self.enabled:
            return None
        async with self._lock:
            try:
                return await asyncio.to_thread(
                    http_json_with_retry,
                    "POST",
                    "/__afk/game/tasks/batch-claim",
                    self._payload({"ids": [int(value) for value in ids], "request_seq": request_seq}),
                )
            except Exception as exc:
                if not self._warned:
                    self._warned = True
                    print(f"[mysql] task transaction HTTP write unavailable: {exc}", flush=True)
                return None

    async def hero_upgrade(
        self,
        hero_id: int,
        up_level: int,
        request_seq: int | None = None,
        idempotency_key: str | None = None,
    ) -> dict | None:
        if not self.enabled:
            return None
        async with self._lock:
            try:
                return await asyncio.to_thread(
                    http_json_with_application_error,
                    "POST",
                    "/__afk/game/heroes/upgrade",
                    self._payload({
                        "hero_id": int(hero_id),
                        "up_level": int(up_level),
                        "request_seq": request_seq,
                        "idempotency_key": idempotency_key,
                    }),
                )
            except Exception as exc:
                if not self._warned:
                    self._warned = True
                    print(f"[mysql] hero upgrade transaction HTTP write unavailable: {exc}", flush=True)
                return None

    async def idle_claim(self, quick: bool, request_seq: int | None = None) -> dict | None:
        if not self.enabled:
            return None
        async with self._lock:
            try:
                return await asyncio.to_thread(
                    http_json_with_retry,
                    "POST",
                    "/__afk/game/idle/claim",
                    self._payload({"quick": bool(quick), "request_seq": request_seq}),
                )
            except Exception as exc:
                if not self._warned:
                    self._warned = True
                    print(f"[mysql] idle claim HTTP write unavailable: {exc}", flush=True)
                return None

    async def idle_query(self) -> dict | None:
        if not self.enabled:
            return None
        async with self._lock:
            try:
                return await asyncio.to_thread(
                    http_json_with_retry,
                    "GET",
                    self._get_path("/__afk/game/idle"),
                    None,
                )
            except Exception as exc:
                if not self._warned:
                    self._warned = True
                    print(f"[mysql] idle query HTTP unavailable: {exc}", flush=True)
                return None

    async def campaign_result(
        self, result: str, stage_id: int | None = None, request_seq: int | None = None
    ) -> dict | None:
        if not self.enabled:
            return None
        payload = {"result": result, "request_seq": request_seq}
        if stage_id is not None:
            payload["stage_id"] = int(stage_id)
        payload = self._payload(payload)
        async with self._lock:
            try:
                return await asyncio.to_thread(
                    http_json_with_retry,
                    "POST",
                    "/__afk/game/stages/result",
                    payload,
                )
            except Exception as exc:
                if not self._warned:
                    self._warned = True
                    print(f"[mysql] campaign result HTTP write unavailable: {exc}", flush=True)
                return None

    async def authoritative_battle_start(
        self, mode: str, stage_id: int, lineup_ids: list[int] | None = None,
        request_seq: int | None = None, opponent_uid: int | None = None,
        battle_id: str | None = None, maze_relic_effects: dict | None = None,
        enemy_level_cap: int | None = None,
    ) -> dict | None:
        if not self.enabled:
            return None
        payload = {
            "mode": str(mode), "stage_id": int(stage_id),
            "lineup_ids": [int(value) for value in (lineup_ids or [])],
            "request_seq": request_seq,
        }
        if opponent_uid is not None:
            payload["opponent_uid"] = int(opponent_uid)
        if battle_id:
            payload["battle_id"] = str(battle_id)
        if maze_relic_effects:
            payload["maze_relic_effects"] = dict(maze_relic_effects)
        if enemy_level_cap is not None and int(enemy_level_cap) > 0:
            payload["enemy_level_cap"] = int(enemy_level_cap)
        payload = self._payload(payload)
        async with self._lock:
            try:
                return await asyncio.to_thread(
                    http_json_with_retry, "POST", "/__afk/game/battles/start", payload
                )
            except Exception as exc:
                if not self._warned:
                    self._warned = True
                    print(f"[mysql] authoritative battle start HTTP unavailable: {exc}", flush=True)
                return None

    async def authoritative_battle_finish(
        self, battle_id: str, result: str, mode: str = "maze",
    ) -> dict | None:
        if not self.enabled:
            return None
        payload = self._payload({"battle_id": str(battle_id), "result": str(result), "mode": str(mode)})
        async with self._lock:
            try:
                return await asyncio.to_thread(
                    http_json_with_retry, "POST", "/__afk/game/battles/finish", payload
                )
            except Exception as exc:
                if not self._warned:
                    self._warned = True
                    print(f"[mysql] authoritative battle finish HTTP unavailable: {exc}", flush=True)
                return None

    async def game_action(self, op: str, **kwargs) -> dict | None:
        if not self.enabled:
            return None
        payload = self._payload({"op": op, **kwargs})
        async with self._lock:
            try:
                return await asyncio.to_thread(
                    http_json_with_application_error, "POST", "/__afk/game/action", payload
                )
            except Exception as exc:
                if not self._warned:
                    self._warned = True
                    print(f"[mysql] game action HTTP unavailable: {exc}", flush=True)
                return None

    async def system_action(self, module: str, operation: str, **kwargs) -> dict | None:
        if not self.enabled:
            return None
        payload = self._payload({"module": module, "operation": operation, **kwargs})
        async with self._lock:
            try:
                return await asyncio.to_thread(
                    http_json_with_application_error, "POST", "/__afk/systems/action", payload
                )
            except Exception as exc:
                if not self._warned:
                    self._warned = True
                    print(f"[mysql] universal system action HTTP unavailable: {exc}", flush=True)
                return None

    async def social_friends(self) -> dict | None:
        if not self.enabled:
            return None
        async with self._lock:
            try:
                return await asyncio.to_thread(
                    http_json_with_retry,
                    "GET",
                    self._get_path("/__afk/social/friends"),
                    None,
                )
            except Exception as exc:
                if not self._warned:
                    self._warned = True
                    print(f"[mysql] social friends HTTP unavailable: {exc}", flush=True)
                return None

    async def instant_purchase(
        self, goods_id: int, request_seq: int | None = None,
        idempotency_key: str | None = None,
    ) -> dict | None:
        if not self.enabled:
            return None
        payload = {
            "goods_id": int(goods_id),
            "request_seq": request_seq,
            "idempotency_key": idempotency_key or f"ws:latest:{request_seq}:{goods_id}",
        }
        payload = self._payload(payload)
        async with self._lock:
            try:
                return await asyncio.to_thread(
                    http_json_with_retry, "POST", "/__afk/payments/purchase", payload
                )
            except Exception as exc:
                if not self._warned:
                    self._warned = True
                    print(f"[mysql] instant purchase HTTP unavailable: {exc}", flush=True)
                return None

    async def build_stage_assist_reply(
        self,
        request_info: dict,
        template_message: bytes,
    ) -> bytes | None:
        result = await self.build_response(
            "stage_assist_summaries",
            request_info,
            template_message,
        )
        return result["message"] if result else None

    async def build_response(
        self,
        generator: str,
        request_info: dict,
        template_message: bytes,
    ) -> dict | None:
        if not self.enabled:
            return None

        generator_config = BUSINESS_RESPONSE_GENERATORS.get(generator)
        if generator_config is None:
            return None

        async with self._lock:
            try:
                business_state = await asyncio.to_thread(
                    http_json_with_retry,
                    "GET",
                    self._get_path("/__afk/db/business-state"),
                    None,
                )
                if generator == "stage_assist_summaries":
                    message = self._build_stage_assist_reply(
                        request_info,
                        template_message,
                        business_state,
                    )
                elif generator == "stage_battle_start":
                    message = self._build_stage_battle_start_reply(
                        request_info,
                        template_message,
                        business_state,
                    )
                elif generator == "stage_battle_result":
                    message = self._build_stage_battle_result_reply(
                        request_info,
                        template_message,
                        business_state,
                    )
                else:
                    message = None

                if message is None:
                    return None

                return {
                    "message": message,
                    "generator": generator,
                    "label": generator_config["label"],
                    "tables": generator_config["tables"],
                }
            except Exception as exc:
                if not self._warned:
                    self._warned = True
                    print(f"[mysql] failed to build business response through HTTP: {exc}", flush=True)
                return None

    def _build_stage_assist_reply(
        self,
        request_info: dict,
        template_message: bytes,
        business_state: dict,
    ) -> bytes | None:
        rows = [
            row
            for row in business_state.get("characters") or []
            if isinstance(parse_json_field(row.get("extra_json")), dict)
            and parse_json_field(row.get("extra_json")).get("assist_uid") is not None
        ]
        player = business_state.get("player") or {}
        inventory = business_state.get("inventory") or []
        stages = business_state.get("stages") or []
        if not rows:
            return None

        stage_state = next(
            (
                stage
                for stage in stages
                if stage.get("stage_id") == request_info.get("kind")
                or stage.get("stage_id") == "stage_query_assist_summaries"
            ),
            {},
        )
        stage_extra = parse_json_field(stage_state.get("best_result_json"))
        assist_summary_limit = int(stage_extra.get("assist_summary_limit", 10))
        assist_summary_limit = max(1, min(assist_summary_limit, 10))
        stage_ticket = next(
            (item for item in inventory if item.get("item_id") == "stage_ticket"),
            {},
        )
        stage_ticket_quantity = int(stage_ticket.get("quantity") or 0)

        entries = []
        for row in rows[:assist_summary_limit]:
            extra = parse_json_field(row.get("extra_json"))
            entry = {
                "nickname": player.get("nickname") or "local-player",
                "level": row.get("level") or 1,
                "star": row.get("star") or 1,
                **(extra if isinstance(extra, dict) else {}),
            }
            if stage_ticket_quantity > 0:
                entry.setdefault("borrow_limit", stage_ticket_quantity)
                entry.setdefault("borrow_remaining", stage_ticket_quantity)
            entries.append(build_assist_summary_entry(entry))

        response_fields = parse_proto_fields(template_message)
        nested_payload = get_proto_bytes(response_fields, 6)
        if nested_payload is None:
            return None

        nested_fields = parse_proto_fields(nested_payload)
        assist_payload = encode_proto_fields([ProtoField(3, 2, entry) for entry in entries])
        nested_fields = set_proto_bytes(nested_fields, 6, assist_payload)

        response_fields = set_proto_varint(response_fields, 1, current_server_timestamp())
        if request_info.get("seq") is not None:
            response_fields = set_proto_varint(response_fields, 2, int(request_info["seq"]))
        response_fields = set_proto_bytes(response_fields, 6, encode_proto_fields(nested_fields))

        return encode_proto_fields(response_fields)

    def _build_stage_battle_start_reply(
        self,
        request_info: dict,
        template_message: bytes,
        business_state: dict,
    ) -> bytes | None:
        player = business_state.get("player") or {}
        characters = business_state.get("characters") or []
        stages = business_state.get("stages") or []

        response_fields = parse_proto_fields(template_message)
        if request_info.get("seq") is not None:
            response_fields = set_proto_varint(response_fields, 2, int(request_info["seq"]))
        response_fields = set_proto_varint(response_fields, 1, current_server_timestamp())

        envelope_payload = get_proto_bytes(response_fields, 6)
        if envelope_payload is None:
            return encode_proto_fields(response_fields)

        envelope_fields = parse_proto_fields(envelope_payload)
        battle_payload = get_proto_bytes(envelope_fields, 3)
        if battle_payload is None:
            return encode_proto_fields(response_fields)

        battle_fields = parse_proto_fields(battle_payload)
        stage_summary_template = get_proto_bytes(battle_fields, 1)
        if stage_summary_template is None:
            return encode_proto_fields(response_fields)
        stage_summary = build_stage_summary_payload(
            stage_summary_template,
            player,
            characters,
            stages,
            stage_id=parse_int(
                request_info.get("stage_id"),
                parse_int((request_info.get("battle_transaction") or {}).get("stage_id"), 0),
            ),
            battle_seed=parse_int(
                (request_info.get("battle_transaction") or {}).get("seed"), 0
            ),
            lineup_ids=[
                parse_int(value, 0)
                for value in (request_info.get("lineup_ids") or [])
                if parse_int(value, 0) > 0
            ],
            lineup_teams=[
                [parse_int(value, 0) for value in team if parse_int(value, 0) > 0]
                for team in (request_info.get("lineup_teams") or [])
                if isinstance(team, list)
            ],
        )
        battle_fields = set_proto_bytes(battle_fields, 1, stage_summary)
        envelope_fields = set_proto_bytes(envelope_fields, 3, encode_proto_fields(battle_fields))
        response_fields = set_proto_bytes(response_fields, 6, encode_proto_fields(envelope_fields))
        # The captured fixture also contains one-time daily/weekly todo
        # changes in reply_extra. Replaying those on every new battle makes
        # the client's already-initialized task listener call reset() on a
        # missing transient model. Battle start has no legitimate extra delta.
        response_fields = [field for field in response_fields if field.number != 9]
        return encode_proto_fields(response_fields)

    def _build_stage_battle_result_reply(
        self,
        request_info: dict,
        template_message: bytes,
        business_state: dict,
    ) -> bytes | None:
        player = business_state.get("player") or {}
        inventory = business_state.get("inventory") or []
        stages = business_state.get("stages") or []

        response_fields = parse_proto_fields(template_message)
        if request_info.get("seq") is not None:
            response_fields = set_proto_varint(response_fields, 2, int(request_info["seq"]))
        response_fields = set_proto_varint(response_fields, 1, current_server_timestamp())

        envelope_payload = get_proto_bytes(response_fields, 6)
        if envelope_payload is None:
            return encode_proto_fields(response_fields)

        envelope_fields = parse_proto_fields(envelope_payload)
        result_payload = get_proto_bytes(envelope_fields, 4)
        if result_payload is None:
            return encode_proto_fields(response_fields)

        result_fields = parse_proto_fields(result_payload)
        stage_result_payload = get_proto_bytes(result_fields, 3)
        if stage_result_payload is None:
            return encode_proto_fields(response_fields)

        stage_result_fields = parse_proto_fields(stage_result_payload)
        battle_result = request_info.get("battle_result") or "defeat"
        result_fields = set_proto_varint(result_fields, 1, 1 if battle_result == "victory" else 2)
        campaign_transaction = request_info.get("campaign_transaction") or {}
        if battle_result == "victory":
            result_fields = set_proto_bytes(
                result_fields, 2, build_reward_payload(campaign_transaction.get("assets") or [])
            )
        stage_result_fields = set_proto_varint(
            stage_result_fields,
            1,
            inventory_quantity(inventory, "meta_campaign_cur_stage", 13),
        )

        result_fields = set_proto_bytes(
            result_fields,
            3,
            encode_proto_fields(stage_result_fields),
        )
        envelope_fields = set_proto_bytes(envelope_fields, 4, encode_proto_fields(result_fields))
        response_fields = set_proto_bytes(response_fields, 6, encode_proto_fields(envelope_fields))
        # Rewards are encoded in reply_stage.result above. Do not replay the
        # fixture's unrelated task deltas as a second side effect.
        response_fields = [field for field in response_fields if field.number != 9]
        return encode_proto_fields(response_fields)

    async def close(self) -> None:
        return


def format_message(message: str | bytes) -> dict:
    if isinstance(message, str):
        return {
            "message_type": "text",
            "text": message,
            "size": len(message.encode("utf-8")),
        }

    return {
        "message_type": "binary",
        "base64": base64.b64encode(message).decode("ascii"),
        "size": len(message),
    }


def choose_subprotocol(_: ServerConnection, subprotocols: list[str]) -> str | None:
    return subprotocols[0] if subprotocols else None


def decode_fixture_message(message_type: str, encoded_payload: str) -> str | bytes:
    if message_type == "text":
        return encoded_payload
    if message_type == "binary":
        return base64.b64decode(encoded_payload)
    raise ValueError(f"Unsupported fixture message_type: {message_type}")


def parse_int(value, default: int = 0) -> int:
    try:
        if value is None or value == "":
            return default
        return int(value)
    except (TypeError, ValueError):
        return default


def parse_timestamp(value, default: int = 0) -> int:
    if isinstance(value, (int, float)):
        return int(value)
    if not value:
        return default
    try:
        normalized = str(value).strip().replace("Z", "+00:00")
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return int(parsed.timestamp())
    except (TypeError, ValueError, OverflowError):
        return default


def inventory_quantity(inventory: list[dict], item_id: str, default: int = 0) -> int:
    for item in inventory:
        if item.get("item_id") == item_id:
            return parse_int(item.get("quantity"), default)
    return default


def normalize_campaign_stage_for_client(stage_id: int) -> int:
    """Keep projected campaign progress inside the pinned client's Stage table.

    The exact 1.201 Classic CN split archive ends at enabled stage 3232.  The
    parallel HD snapshot continues beyond it, so a graduated account created
    from the HD table can otherwise project an unknown ID into Classic.  The
    client then shows a mapped chapter label but silently refuses to open the
    formation screen because Stage[stage_id] is missing.
    """
    normalized = max(1, int(stage_id))
    maximum = max(1, parse_int(os.environ.get("AFK_CLIENT_MAX_CAMPAIGN_STAGE"), 3232))
    return min(normalized, maximum)


LOGIN_CURRENCY_KEYS = {
    10000001: "gold",
    10000002: "diamond",
    10000004: "hero_exp",
    10000006: "player_exp",
    10000007: "guild_coin",
    10000008: "maze_coin",
    10000011: "friend_coin",
    10000013: "challenger_coin",
    10000019: "homeland_coin",
    10000024: "wish_coin",
    10000025: "pet_coin",
}


def inventory_quantity_or_none(inventory: list[dict], item_id: str) -> int | None:
    for item in inventory:
        if item.get("item_id") == item_id:
            return parse_int(item.get("quantity"), 0)
    return None


def patch_login_currency_entries(
    player_fields: list[ProtoField],
    inventory: list[dict],
) -> list[ProtoField]:
    patched = []
    present_ids: set[int] = set()
    for field in player_fields:
        if field.number != 8 or field.wire_type != 2:
            patched.append(field)
            continue
        currency_fields = parse_proto_fields(bytes(field.value))
        proto_id = get_proto_varint(currency_fields, 1)
        if proto_id is not None:
            present_ids.add(int(proto_id))
        inventory_key = LOGIN_CURRENCY_KEYS.get(proto_id)
        quantity = (
            inventory_quantity_or_none(inventory, inventory_key)
            if inventory_key is not None
            else None
        )
        if quantity is not None:
            currency_fields = set_proto_varint(currency_fields, 2, quantity)
        patched.append(ProtoField(8, 2, encode_proto_fields(currency_fields)))
    for proto_id, inventory_key in LOGIN_CURRENCY_KEYS.items():
        if proto_id in present_ids:
            continue
        quantity = inventory_quantity_or_none(inventory, inventory_key)
        if quantity is None:
            continue
        patched.append(ProtoField(
            8,
            2,
            encode_proto_fields((
                ProtoField(1, 0, proto_id),
                ProtoField(2, 0, quantity),
            )),
        ))
    return patched


def patch_login_item_entries(
    player_fields: list[ProtoField],
    inventory: list[dict],
) -> list[ProtoField]:
    patched = []
    for field in player_fields:
        if field.number != 9 or field.wire_type != 2:
            patched.append(field)
            continue
        item_fields = parse_proto_fields(bytes(field.value))
        item_id = get_proto_varint(item_fields, 1)
        quantity = (
            inventory_quantity_or_none(inventory, f"item_{item_id}")
            if item_id is not None
            else None
        )
        if quantity is not None:
            item_fields = set_proto_varint(item_fields, 2, quantity)
        patched.append(ProtoField(9, 2, encode_proto_fields(item_fields)))
    return patched


def patch_login_hero_entries(
    player_fields: list[ProtoField],
    characters: list[dict],
) -> list[ProtoField]:
    hero_rows = []
    for row in characters:
        extra = parse_json_field(row.get("extra_json"))
        if not isinstance(extra, dict) or extra.get("assist_uid") is not None:
            continue
        hero_id = parse_int(extra.get("hero_id"), -1)
        if hero_id < 0:
            hero_id = parse_int(row.get("character_id"), -1)
        if hero_id >= 0:
            hero_rows.append((hero_id, row, extra))

    patched = []
    projected_ids: set[int] = set()
    for field in player_fields:
        if field.number != 11 or field.wire_type != 2:
            patched.append(field)
            continue
        hero_fields = parse_proto_fields(bytes(field.value))
        hero_id = get_proto_varint(hero_fields, 1)
        if hero_id is not None:
            projected_ids.add(int(hero_id))
        match = next((entry for entry in hero_rows if entry[0] == hero_id), None)
        if match is not None:
            _, row, _ = match
            patched.append(
                ProtoField(11, 2, build_character_hero_payload(row, int(hero_id)))
            )
            continue
        patched.append(ProtoField(11, 2, encode_proto_fields(hero_fields)))

    # A captured login fixture only contains the heroes owned by the fixture
    # account.  Database-created/drawn heroes must also be projected or a
    # graduated account still appears as the six-hero starter account on a
    # real client.  The seven fields below are the required ``hero`` fields in
    # common.proto; optional equipment/growth structures remain absent until
    # their own domain services populate them.
    for hero_id, row, extra in hero_rows:
        if hero_id in projected_ids:
            continue
        patched.append(ProtoField(
            11,
            2,
            build_character_hero_payload(row, hero_id),
        ))
        projected_ids.add(hero_id)
    return patched


def patch_login_artifact_entries(
    player_fields: list[ProtoField],
    characters: list[dict],
) -> list[ProtoField]:
    """Back every projected hero.artifact with a reply_user artifact."""
    artifact_map: dict[int, dict] = {}
    for row in characters:
        extra = parse_json_field(row.get("extra_json"))
        if not isinstance(extra, dict) or extra.get("assist_uid") is not None:
            continue
        artifact_id = parse_int(extra.get("artifact_id"), 0)
        artifact_tid = parse_int(extra.get("artifact_tid"), artifact_id)
        hero_id = parse_int(extra.get("hero_id"), -1)
        if hero_id < 0:
            hero_id = parse_int(row.get("character_id"), -1)
        if artifact_id <= 0 or artifact_tid <= 0 or hero_id < 0:
            continue
        entry = artifact_map.setdefault(artifact_id, {
            "tid": artifact_tid,
            "awaken_lv": 0,
            "hero_ids": [],
        })
        entry["awaken_lv"] = max(
            entry["awaken_lv"],
            max(0, parse_int(extra.get("artifact_awaken_lv"), 0)),
        )
        if hero_id not in entry["hero_ids"]:
            entry["hero_ids"].append(hero_id)

    # The captured fixture belongs to another account. Preserve no orphaned
    # artifact instances; rebuild this repeated field from authoritative hero
    # state so every hero-side reference resolves during card construction.
    patched = [field for field in player_fields if field.number != 34]
    for artifact_id, entry in sorted(artifact_map.items()):
        artifact = encode_proto_fields([
            ProtoField(1, 0, artifact_id),
            ProtoField(2, 0, entry["tid"]),
            ProtoField(3, 0, entry["awaken_lv"]),
            *[ProtoField(4, 0, hero_id) for hero_id in entry["hero_ids"]],
        ])
        patched.append(ProtoField(34, 2, artifact))
    return patched


def _activity_type_key(value: str) -> str:
    value = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", str(value or ""))
    return re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")


def _encode_string_map_entry(key: str, value: object) -> bytes:
    return b"".join((
        encode_length_delimited_field(1, str(key).encode("utf-8")),
        encode_length_delimited_field(2, str(value).encode("utf-8")),
    ))


def _load_official_activity_projection() -> tuple[list[dict], set[int]]:
    root = Path(__file__).resolve().parent / "runtime" / "official-updates" / "1.201.01" / "decrypted-config" / "en"
    try:
        activity_doc = json.loads((root / "Activity.json").read_text(encoding="utf-8"))
        banner_doc = json.loads((root / "ActivityBanner.json").read_text(encoding="utf-8"))
        activity_table = activity_doc.get("table", activity_doc.get("ed", activity_doc))
        banner_table = banner_doc.get("table", banner_doc.get("ed", banner_doc))
        if isinstance(activity_table, dict) and len(activity_table) == 1:
            activity_table = next(iter(activity_table.values()))
        if isinstance(banner_table, dict) and len(banner_table) == 1:
            banner_table = next(iter(banner_table.values()))
        rows = [row for row in activity_table.values() if isinstance(row, dict)]
        banner_ids = {
            parse_int(row.get("ActivityID"), 0)
            for row in banner_table.values() if isinstance(row, dict) and row.get("IsShow", True)
        }
        return rows, banner_ids
    except (OSError, ValueError, TypeError):
        return [], set()


# The shipped Android package identifies itself as app 1.201, but its HD
# delivery contains the newer 2.301 regional Activity/ActivityBanner shards.
# Sending an activity that is absent from either shard makes
# getAreaActivityIds dereference an undefined banner and prevents every main
# module (including hero_package and tavern) from being constructed.  These
# ids were verified against the exact CN HD shards bundled in the release APK.
# Classic uses its own captured list and is intentionally unaffected.
HD_RELEASE_ACTIVITY_CANDIDATE_IDS = frozenset({
    1659, 1760, 2025, 2262, 2316, 2332,
    2333, 2364, 2392, 2442, 2449, 2450,
})
# Keep the activity sidebar isolated for this delivery until every candidate's
# nested banner/art dependency has also been verified.  The liveops rows remain
# persisted and available to the API; this only controls their login projection.
HD_RELEASE_ACTIVITY_IDS = frozenset()


def patch_login_activity_entries(
    fields: list[ProtoField],
    liveops: list[dict],
    *,
    classic_layout: bool = False,
    compatible_activity_ids: set[int] | frozenset[int] | None = None,
) -> list[ProtoField]:
    """Replace captured activity_info with config-backed current liveops instances."""
    if not liveops:
        return fields
    activity_rows, banner_ids = _load_official_activity_projection()
    enum_values = (
        PROTOBUF_ENUMS.get("t_activity", {})
        if classic_layout
        else LATEST_PROTOBUF_ENUMS.get("t_activity", PROTOBUF_ENUMS.get("t_activity", {}))
    )
    params_field = 4 if classic_layout else 3
    act_data_field = 5 if classic_layout else 4
    aliases = {
        "daily_login": "seven_days_login", "daily_login_act": "seven_days_login",
        "trial": "trial_activity", "act_trial": "trial_activity",
        "world_boss": "activity_rank_boss", "act_rank_boss": "activity_rank_boss",
        "infinite_pve": "infinite", "infinite_inst": "infinite", "infinite_boss": "infinite",
        "hero_return": "backflow_new", "act_backflow": "backflow_new",
        "activity_travel": "travel", "act_invitation": "invitation",
        "act_accel": "activity_accelerate", "act_painting": "activity_painting",
        "act_repl": "hero_replace", "raid_act_detective": "act_detective",
        "raid_care_pet": "act_raid_care_pet", "raid_journey": "act_raid_journey",
        "raid_food": "raid_food", "raid_celebration": "act_celebration",
        "act_guild_zoo": "guild_zoo", "act_pumpkin": "pumpkin",
        "act_pumpkin_craft": "pumpkin", "act_pumpkin_brawl": "pumpkin",
        "side_story": "side_story_challenge", "act_discount_gift": "charge_discount_gift",
        "battle_pass": "display_only", "activity": "display_only",
    }
    prepared = []
    for row in activity_rows:
        row_type = _activity_type_key(row.get("Type"))
        if row_type not in enum_values:
            continue
        row_id = parse_int(row.get("ID"), 0)
        if row_id <= 0:
            continue
        if compatible_activity_ids is not None and row_id not in compatible_activity_ids:
            continue
        code = _activity_type_key(row.get("Code"))
        prepared.append((row, row_id, row_type, code, row_id in banner_ids))
    used_ids: set[int] = set()
    projected: list[ProtoField] = [field for field in fields if field.number != 38]
    for instance in liveops[:256]:
        module = _activity_type_key(instance.get("activity_key"))
        desired = aliases.get(module, module if module in enum_values else "")
        if not desired and module.startswith("act_") and module[4:] in enum_values:
            desired = module[4:]
        compact = module.removeprefix("act_")
        candidates = [entry for entry in prepared if entry[1] not in used_ids]
        matched = [entry for entry in candidates if compact and (compact in entry[3] or entry[3].removeprefix("code_") in module)]
        if desired:
            typed = [entry for entry in candidates if entry[2] == desired]
            matched = [entry for entry in matched if entry[2] == desired] or typed or matched
        matched.sort(key=lambda entry: (entry[4], entry[1]), reverse=True)
        if not matched:
            matched = [entry for entry in candidates if entry[2] == "display_only"] or candidates
        if not matched:
            continue
        row, activity_id, activity_type, _, _ = matched[0]
        used_ids.add(activity_id)
        info = [
            ProtoField(1, 0, activity_id),
            ProtoField(2, 0, int(enum_values[activity_type])),
        ]
        params = {
            "module": module,
            "title": instance.get("title") or row.get("Name") or module,
            "starts_at": instance.get("starts_at") or "",
            "ends_at": instance.get("ends_at") or "",
            "claim_ends_at": instance.get("claim_ends_at") or "",
        }
        for key, value in params.items():
            # activity_info.params is field 3 in the 1.201 device schema.
            # Field 4 is act_data; writing string maps there made activity
            # metadata decode as malformed type-specific state.
            info.append(ProtoField(params_field, 2, _encode_string_map_entry(key, value)))
        if desired == "act_endless_draw":
            endless_state = b"".join((
                encode_varint_field(1, 0),
                encode_varint_field(2, 0),
            ))
            # act_data.act_endless_draw is field 111 in the legacy csproto
            # schema used by the recovered 1.201 JavaScript activity manager.
            act_data = encode_length_delimited_field(111, endless_state)
            info.append(ProtoField(act_data_field, 2, act_data))
        projected.append(ProtoField(38, 2, encode_proto_fields(info)))
    # Keep deterministic device-test entries for two official client modules
    # that are no longer scheduled by the current liveops database.  ID 1461
    # opens the anniversary hundred-draw page; the older duplicate ID 975 is
    # used as the compatibility entrance for the restored Homeland workshop.
    for activity_id in (975, 1461):
        if compatible_activity_ids is not None and activity_id not in compatible_activity_ids:
            continue
        if activity_id in used_ids:
            continue
        match = next((entry for entry in prepared if entry[1] == activity_id), None)
        if match is None:
            continue
        row, _, activity_type, _, _ = match
        info = [
            ProtoField(1, 0, activity_id),
            ProtoField(2, 0, int(enum_values[activity_type])),
            ProtoField(params_field, 2, _encode_string_map_entry("module", "hundred_draw")),
            ProtoField(params_field, 2, _encode_string_map_entry("title", row.get("Name") or "Gloria Spectacular")),
        ]
        projected.append(ProtoField(38, 2, encode_proto_fields(info)))
        used_ids.add(activity_id)
    return projected


def build_login_payload_from_business_state(
    template_payload: bytes,
    business_state: dict | None,
    *,
    classic_layout: bool = False,
) -> bytes:
    if not business_state:
        return patch_login_im_info(template_payload)

    player = business_state.get("player") or {}
    inventory = business_state.get("inventory") or []
    characters = business_state.get("characters") or []
    gold = inventory_quantity(
        inventory,
        "gold",
        parse_int(player.get("gold"), 0),
    )
    diamond = inventory_quantity(
        inventory,
        "diamond",
        parse_int(player.get("diamond"), 0),
    )

    fields = parse_proto_fields(template_payload)
    player_payload = get_proto_bytes(fields, 1)
    if player_payload is None:
        return template_payload

    player_fields = parse_proto_fields(player_payload)
    player_id = parse_int(player.get("id"), 0)
    if player_id > 0:
        # Preserve the captured graduated account's 211123 identity while
        # allocating adjacent, stable native role ids to the other local
        # accounts.  Distinct role ids are required for friend/private-chat
        # UIs to distinguish self from peer when several devices are online.
        player_fields = set_proto_varint(player_fields, 1, 211053 + player_id)
    # The full-coverage QA account must satisfy player-level and resonance
    # gates used by Homeland, Furniture, HyperGacha and late-game activities.
    player_fields = set_proto_varint(player_fields, 3, max(240, parse_int(player.get("level"), 1)))
    player_fields = set_proto_varint(player_fields, 4, max(0, parse_int(player.get("exp"), 0)))
    # ParamOpenCondition.Stargazer uses player.amazing_point through the
    # DrawTimesGreaterThan trigger (550 in the 1.201 client), not the tavern
    # panel's per-pool draw map.
    player_fields = set_proto_varint(player_fields, 49, 999)
    player_fields = set_proto_varint(player_fields, 46, 999)
    # Graduated Classic accounts own the full roster. Keep enough authoritative
    # hero slots for ten-pulls; otherwise the client blocks the request before
    # it ever reaches the gateway (the captured fixture only has 120 slots).
    grid_payload = get_proto_bytes(player_fields, 26)
    grid_fields = parse_proto_fields(grid_payload) if grid_payload is not None else []
    grid_fields = set_proto_varint(grid_fields, 1, 1000)
    player_fields = set_proto_bytes(player_fields, 26, encode_proto_fields(grid_fields))
    profile = parse_json_field(player.get("profile_json"))
    if not isinstance(profile, dict):
        profile = {}
    pentagram_level = max(1, parse_int(profile.get("pentagram_level"), 999))
    max_pentagram_level = max(
        pentagram_level,
        parse_int(profile.get("max_pentagram_level"), pentagram_level),
    )
    hero_aid_level = max(1, parse_int(profile.get("hero_aid_level"), pentagram_level))
    if classic_layout:
        player_fields = set_proto_varint(player_fields, 44, pentagram_level)
        player_fields = set_proto_varint(player_fields, 46, max_pentagram_level)
        player_fields = set_proto_varint(player_fields, 79, hero_aid_level)
    else:
        player_fields = set_proto_varint(player_fields, 42, pentagram_level)
        player_fields = set_proto_varint(player_fields, 44, max_pentagram_level)
        player_fields = set_proto_varint(player_fields, 72, hero_aid_level)
    name_card_payload = get_proto_bytes(player_fields, 2)
    if name_card_payload is not None and player.get("nickname"):
        name_card_fields = parse_proto_fields(name_card_payload)
        name_card_fields = set_proto_bytes(name_card_fields, 1, str(player.get("nickname")).encode("utf-8"))
        player_fields = set_proto_bytes(player_fields, 2, encode_proto_fields(name_card_fields))
    # This private server exposes the complete feature set.  Mark the complete
    # guide id space for every account: on the first connection business state
    # is not bound to a player until after login, so profile/level based gating
    # would leave a fresh install trapped in the captured account's tutorials.
    player_fields = [field for field in player_fields if field.number != 14]
    player_fields.extend(ProtoField(14, 0, guide_id) for guide_id in range(1, 4097))
    if get_proto_varint(player_fields, 6) is not None:
        player_fields = set_proto_varint(player_fields, 6, gold)
    if get_proto_varint(player_fields, 7) is not None:
        player_fields = set_proto_varint(player_fields, 7, diamond)
    created_ts = parse_timestamp(player.get("created_at"), 0)
    if created_ts > 0:
        # Newcomer login rewards are unlocked by the official client from
        # reply_user.create_ts.  Keeping the captured template timestamp here
        # makes a brand-new account appear seven days old.
        player_fields = set_proto_varint(player_fields, 32, created_ts)
    player_fields = patch_login_currency_entries(player_fields, inventory)
    player_fields = patch_login_item_entries(player_fields, inventory)
    # Keep every 1.201-exclusive summon ticket available on the graduated
    # device-test account. 2044 is the HyperGacha/SP ticket; 6000/6001 are
    # the two Draconis pool tickets.
    graduated_item_amounts = {
        47: 999999,
        550: 999999,  # Gloria Spectacular / HundredDraw golden key
        2044: 999999,
        6000: 999999,
        6001: 999999,
    }
    login_item_ids = set()
    for index, field in enumerate(player_fields):
        if field.number != 9 or field.wire_type != 2:
            continue
        item_fields = parse_proto_fields(bytes(field.value))
        item_id = get_proto_varint(item_fields, 1)
        login_item_ids.add(item_id)
        if item_id in graduated_item_amounts:
            player_fields[index] = ProtoField(
                9,
                2,
                encode_proto_fields(
                    set_proto_varint(
                        item_fields, 2, graduated_item_amounts[item_id]
                    )
                ),
            )
    for item_id, amount in graduated_item_amounts.items():
        if item_id in login_item_ids:
            continue
        player_fields.append(
            ProtoField(
                9,
                2,
                encode_proto_fields(
                    [ProtoField(1, 0, item_id), ProtoField(2, 0, amount)]
                ),
            )
        )
    player_fields = patch_login_hero_entries(player_fields, characters)
    player_fields = patch_login_artifact_entries(player_fields, characters)
    # The captured Classic login already contains its native activity list.
    # Current liveops include activity enum/state variants introduced by the
    # HD track; injecting those into Classic can decode successfully but then
    # breaks the Classic activity manager's array assumptions during login.
    if not classic_layout:
        player_fields = patch_login_activity_entries(
            player_fields,
            business_state.get("liveops") or [],
            compatible_activity_ids=HD_RELEASE_ACTIVITY_IDS,
        )
    elif not any(field.number == 38 for field in player_fields):
        # The 1.201 Classic client calls activityModel.initData with
        # ``reply_user.activities || {}``.  With no repeated activity field it
        # therefore supplies an object, while the restored anniversary entry
        # code correctly expects the protocol value to be an array.  Seed one
        # native Classic activity so protobuf-js materialises the repeated
        # field as an array.  ID 1461 is also the restored Hundred Draw entry.
        hundred_draw_type = PROTOBUF_ENUMS.get("t_activity", {}).get(
            "hundred_draw", 89
        )
        player_fields.append(
            ProtoField(
                38,
                2,
                encode_proto_fields(
                    [
                        ProtoField(1, 0, 1461),
                        ProtoField(2, 0, int(hundred_draw_type)),
                    ]
                ),
            )
        )

    stage_payload = get_proto_bytes(player_fields, 12)
    if stage_payload is not None:
        stage_fields = parse_proto_fields(stage_payload)
        projected_stage = normalize_campaign_stage_for_client(
            inventory_quantity(inventory, "meta_campaign_cur_stage", 13)
        )
        stage_fields = set_proto_varint(
            stage_fields, 1, projected_stage
        )
        # The captured login fixture was recorded exactly at a chapter
        # boundary and therefore carries chapter_over=true.  Reusing that bit
        # after replacing cur_stage makes every local account look as if it
        # still has to cross into the next chapter: the main challenge button
        # queries its auxiliary panels but never opens battle formation.
        # Local progression stores the actual next playable stage, so a fresh
        # login must clear this transient client-navigation flag.
        stage_fields = set_proto_varint(stage_fields, 5, 0)
        player_fields = set_proto_bytes(player_fields, 12, encode_proto_fields(stage_fields))

    guild_id = inventory_quantity(inventory, "meta_guild_id", 0)
    if guild_id > 0:
        player_fields = set_proto_varint(player_fields, 23, guild_id)
        player_fields = set_proto_bytes(player_fields, 24, "本地冒险者公会".encode())
        # The domain ranks permissions upward (member=1, officer=2,
        # owner=3), while the official wire enum is chairman=1,
        # leader=2, member=3.
        internal_role = inventory_quantity(inventory, "meta_guild_role", 1)
        player_fields = set_proto_varint(
            player_fields, 25, {3: 1, 2: 2, 1: 3}.get(internal_role, 3)
        )

    fields = set_proto_bytes(fields, 1, encode_proto_fields(player_fields))
    return patch_login_im_info(encode_proto_fields(fields))


def patch_login_im_info(login_payload: bytes) -> bytes:
    """Inject the IM 3.0 environment required by the native social UI."""
    # Supplying an env without api_urls leaves the bottom chat button in the
    # permanent "connecting" state, even though the main game socket is fine.
    # Reuse the already-forwarded public game gateway port. The gateway routes
    # /im to the local IM worker, so phone builds need no additional WAN port.
    fields = parse_proto_fields(login_payload)
    im_public_url = os.environ.get("AFK_IM_PUBLIC_URL", "ws://202.104.24.74:15007/im")
    im_info = b"".join(
        (
            encode_length_delimited_field(1, b"afk-private-cn"),
            encode_length_delimited_field(2, im_public_url.encode("utf-8")),
        )
    )
    return encode_proto_fields(set_proto_bytes(fields, 2, im_info))


def selected_stage_state(stages: list[dict]) -> dict:
    if not stages:
        return {}
    for stage in stages:
        if stage.get("stage_id") in {"stage_battle_start", "stage_battle_result"}:
            return stage
    for stage in stages:
        extra = parse_json_field(stage.get("best_result_json"))
        if isinstance(extra, dict) and (
            extra.get("battle_stage_id") is not None
            or extra.get("stage_number") is not None
            or extra.get("reward_amounts") is not None
        ):
            return stage
    return stages[0]


def selected_stage_extra(stages: list[dict]) -> dict:
    extra = parse_json_field(selected_stage_state(stages).get("best_result_json"))
    return extra if isinstance(extra, dict) else {}


def build_reward_item_payload(item_id: str, quantity: int) -> bytes | None:
    proto_ids = DEFAULT_ITEM_PROTO_IDS.get(item_id)
    if proto_ids is None:
        return None
    item_type, proto_item_id = proto_ids
    return encode_proto_fields(
        [
            ProtoField(1, 0, item_type),
            ProtoField(2, 0, proto_item_id),
            ProtoField(3, 0, max(0, int(quantity))),
        ]
    )


def build_stage_reward_items(
    inventory: list[dict],
    current_items: list[bytes],
) -> list[bytes]:
    generated = []
    for item_id in ("gold", "hero_exp", "player_exp", "diamond"):
        payload = build_reward_item_payload(
            item_id,
            inventory_quantity(inventory, item_id, 0),
        )
        if payload is not None:
            generated.append(payload)

    if not generated:
        return current_items

    if len(generated) < len(current_items):
        generated.extend(current_items[len(generated):])
    return generated


def build_stage_reward_amounts(
    player: dict,
    inventory: list[dict],
    stages: list[dict],
    current_amounts: list[int],
) -> list[int]:
    stage_extra = selected_stage_extra(stages)
    configured_amounts = stage_extra.get("reward_amounts")
    if isinstance(configured_amounts, list) and configured_amounts:
        return [parse_int(value, 0) for value in configured_amounts]

    reward_amounts = list(current_amounts)
    replacements = [
        inventory_quantity(inventory, "gold", parse_int(player.get("gold"), 0)),
        inventory_quantity(inventory, "hero_exp", 0),
        inventory_quantity(inventory, "player_exp", parse_int(player.get("exp"), 0)),
        inventory_quantity(inventory, "diamond", parse_int(player.get("diamond"), 0)),
    ]
    start_index = min(3, len(reward_amounts))
    for index, value in enumerate(replacements, start=start_index):
        if index < len(reward_amounts):
            reward_amounts[index] = max(0, int(value))
        else:
            reward_amounts.append(max(0, int(value)))
    return reward_amounts


def build_stage_result_inventory_delta_payload(
    template_payload: bytes,
    inventory: list[dict],
) -> bytes:
    fields = parse_proto_fields(template_payload)
    current_items = get_repeated_proto_bytes(fields, 1)
    generated_items = build_stage_reward_items(inventory, current_items)
    if generated_items:
        fields = set_proto_repeated_bytes(fields, 1, generated_items)
    return encode_proto_fields(fields)


def build_stage_summary_payload(
    template_payload: bytes,
    player: dict,
    characters: list[dict],
    stages: list[dict],
    *,
    stage_id: int = 0,
    battle_seed: int = 0,
    lineup_ids: list[int] | None = None,
    lineup_teams: list[list[int]] | None = None,
) -> bytes:
    fields = parse_proto_fields(template_payload)
    stage_extra = selected_stage_extra(stages)

    stage_info_payload = get_proto_bytes(fields, 2)
    if stage_info_payload is not None:
        stage_info_fields = parse_proto_fields(stage_info_payload)
        stage_info_fields = set_proto_varint(
            stage_info_fields,
            1,
            battle_seed
            or parse_int(stage_extra.get("battle_seed"), get_proto_varint(stage_info_fields, 1) or 0),
        )
        stage_info_fields = set_proto_varint(
            stage_info_fields,
            2,
            stage_id
            or parse_int(
                stage_extra.get("battle_stage_id", stage_extra.get("stage_number")),
                get_proto_varint(stage_info_fields, 2) or 13,
            ),
        )
        fields = set_proto_bytes(fields, 2, encode_proto_fields(stage_info_fields))

    stage_setup_payload = get_proto_bytes(fields, 3)
    if stage_setup_payload is not None:
        setup_fields = parse_proto_fields(stage_setup_payload)
        setup_fields = set_proto_varint(setup_fields, 4, current_server_timestamp())
        # battle_input field 5 is end_ts and field 6 is repeated
        # battle_stats. Older fixtures didn't use either field. Writing hero
        # and player levels into them makes protobuf-js interpret a scalar as
        # battle_stats and fail with "missing required 'id'" before combat.
        setup_fields = [
            field
            for field in setup_fields
            if not (field.number in (5, 6) and field.wire_type == 0)
        ]
        requested_teams = lineup_teams or ([lineup_ids] if lineup_ids else [])
        if requested_teams:
            characters_by_hero_id: dict[int, dict] = {}
            for character in characters:
                extra = parse_json_field(character.get("extra_json"))
                if not isinstance(extra, dict) or extra.get("assist_uid") is not None:
                    continue
                hero_id = parse_int(extra.get("hero_id"), -1)
                if hero_id < 0:
                    hero_id = parse_int(character.get("character_id"), -1)
                if hero_id >= 0:
                    characters_by_hero_id[hero_id] = character
            encoded_teams = []
            for team_index, team_lineup in enumerate(requested_teams, start=1):
                slot_heroes = []
                for slot, hero_id in enumerate((team_lineup or [])[:5], start=1):
                    character = characters_by_hero_id.get(int(hero_id))
                    if character is None:
                        continue
                    slot_heroes.append(ProtoField(
                        1,
                        2,
                        encode_proto_fields((
                            ProtoField(1, 0, slot),
                            # 16-20 are roster progression markers. Native
                            # combat only has attribute rows through 15.
                            ProtoField(
                                2,
                                2,
                                build_character_hero_payload(
                                    character,
                                    int(hero_id),
                                    quality_cap=15,
                                ),
                            ),
                        )),
                    ))
                if slot_heroes:
                    slot_heroes.append(ProtoField(8, 0, team_index))
                    encoded_teams.append(encode_proto_fields(slot_heroes))
            if encoded_teams:
                setup_fields = set_proto_repeated_bytes(
                    setup_fields,
                    1,
                    encoded_teams,
                )
        fields = set_proto_bytes(fields, 3, encode_proto_fields(setup_fields))

    return encode_proto_fields(fields)


def build_assist_summary_entry(character: dict) -> bytes:
    fields = [
        ProtoField(1, 0, int(character.get("assist_uid", 24000))),
        ProtoField(2, 0, int(character.get("rank", 1))),
        ProtoField(3, 2, str(character.get("nickname", "本地玩家")).encode("utf-8")),
        ProtoField(4, 0, int(character.get("level", 1))),
        ProtoField(6, 2, str(character.get("avatar", "avatar:102")).encode("utf-8")),
        ProtoField(7, 0, int(character.get("camp", 1))),
    ]

    if character.get("title_id") is not None:
        fields.append(ProtoField(10, 0, int(character["title_id"])))
    if character.get("title"):
        fields.append(ProtoField(11, 2, str(character["title"]).encode("utf-8")))
    if character.get("title_quality") is not None:
        fields.append(ProtoField(12, 0, int(character["title_quality"])))

    fields.extend(
        [
            ProtoField(13, 0, int(character.get("power", 10000))),
            ProtoField(14, 0, int(character.get("max_power", character.get("power", 10000)))),
            ProtoField(15, 0, int(character.get("last_active", current_server_timestamp()))),
            ProtoField(16, 0, int(character.get("used", 0))),
            ProtoField(18, 0, int(character.get("hero_id", 20))),
            ProtoField(22, 0, int(character.get("borrow_limit", 1000))),
            ProtoField(23, 0, int(character.get("borrow_remaining", 1000))),
        ]
    )
    if character.get("extra_flag") is not None:
        fields.append(ProtoField(26, 0, int(character["extra_flag"])))

    return encode_proto_fields(fields)


def request_signature(message: str | bytes) -> dict:
    if isinstance(message, str):
        return {
            "message_type": "text",
            "text": message,
            "size": len(message.encode("utf-8")),
        }

    formatted = format_message(message)
    signature = {
        "message_type": "binary",
        "size": formatted["size"],
        "base64": formatted["base64"],
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


def response_signature(message: str | bytes) -> dict:
    if isinstance(message, str):
        return {
            "message_type": "text",
            "text": message,
            "size": len(message.encode("utf-8")),
        }

    formatted = format_message(message)
    signature = {
        "message_type": "binary",
        "size": formatted["size"],
        "base64": formatted["base64"],
    }
    try:
        fields = parse_proto_fields(message)
        signature["server_time"] = get_proto_varint(fields, 1)
        signature["seq"] = get_proto_varint(fields, 2)
        signature["top_fields"] = [
            {
                "number": field.number,
                "wire_type": field.wire_type,
                "size": len(field.value) if field.wire_type == 2 else None,
            }
            for field in fields
        ]
        signature["proto_fingerprint"] = proto_field_fingerprint(fields)
    except Exception as exc:
        signature["parse_error"] = repr(exc)
    return signature


@dataclass
class StructuredMessageTemplate:
    label: str
    payload: bytes
    delay_ms: int


@dataclass
class StructuredLoginTemplates:
    fixture_path: str
    sdk_login_reply: StructuredMessageTemplate
    login_reply: StructuredMessageTemplate
    charge_reply: StructuredMessageTemplate
    post_login_push: StructuredMessageTemplate
    heartbeat_reply_delay_ms: int
    stage_reply: StructuredMessageTemplate
    default_htoken: str
    default_svr_id: int
    login_payload: bytes
    charge_payload: bytes
    charge_has_empty_field9: bool
    push_payload: bytes
    stage_payload: bytes
    stage_has_empty_field9: bool


@dataclass
class InteractionResponseTemplate:
    label: str
    message_type: str
    payload: str
    delay_ms: int
    capture_gap_ms: int
    business_generator: str | None = None
    business_label: str | None = None
    business_tables: list[str] | None = None


@dataclass
class InteractionRule:
    label: str
    match: dict
    request: dict
    responses: list[InteractionResponseTemplate]
    use_count: int = 0


@dataclass
class InteractionFixture:
    fixture_path: str
    rules: list[InteractionRule]
    auto_heartbeat: bool
    unmatched_policy: str


def extract_template_event(replay_fixture: dict, event_index: int) -> StructuredMessageTemplate:
    for event in replay_fixture["events"]:
        if event["index"] != event_index:
            continue
        if event["kind"] != "send_client":
            raise ValueError(f"Fixture event {event_index} must be send_client.")
        payload = decode_fixture_message(event["message_type"], event["payload"])
        if not isinstance(payload, bytes):
            raise ValueError(f"Fixture event {event_index} must be binary.")
        return StructuredMessageTemplate(
            label=event["label"],
            payload=payload,
            delay_ms=int(event.get("delay_ms", 0)),
        )

    raise ValueError(f"Fixture event {event_index} not found.")


def build_structured_login_templates(path: str) -> StructuredLoginTemplates:
    replay_fixture = normalize_replay_fixture(path)
    if replay_fixture is None:
        raise ValueError("Structured login fixture path is required.")

    sdk_login_reply = extract_template_event(replay_fixture, 2)
    login_reply = extract_template_event(replay_fixture, 4)
    charge_reply = extract_template_event(replay_fixture, 6)
    post_login_push = extract_template_event(replay_fixture, 7)
    heartbeat_reply = extract_template_event(replay_fixture, 9)
    stage_reply = extract_template_event(replay_fixture, 11)

    sdk_login_fields = parse_proto_fields(sdk_login_reply.payload)
    sdk_inner = get_proto_bytes(sdk_login_fields, 31)
    if sdk_inner is None:
        raise ValueError("Structured login fixture reply_sdk_login is missing field 31.")
    sdk_inner_fields = parse_proto_fields(sdk_inner)
    default_htoken = get_proto_text(sdk_inner_fields, 1)
    default_svr_id = get_proto_varint(sdk_inner_fields, 2)
    if default_htoken is None or default_svr_id is None:
        raise ValueError("Structured login fixture reply_sdk_login payload is incomplete.")

    login_fields = parse_proto_fields(login_reply.payload)
    login_payload = get_proto_bytes(login_fields, 4)
    if login_payload is None:
        raise ValueError("Structured login fixture reply_login is missing field 4.")

    charge_fields = parse_proto_fields(charge_reply.payload)
    charge_payload = get_proto_bytes(charge_fields, 32)
    if charge_payload is None:
        raise ValueError("Structured login fixture reply_charge is missing field 32.")
    charge_has_empty_field9 = get_proto_bytes(charge_fields, 9) is not None

    push_fields = parse_proto_fields(post_login_push.payload)
    push_payload = get_proto_bytes(push_fields, 9)
    if push_payload is None:
        raise ValueError("Structured login fixture server push is missing field 9.")

    stage_fields = parse_proto_fields(stage_reply.payload)
    stage_payload = get_proto_bytes(stage_fields, 6)
    if stage_payload is None:
        raise ValueError("Structured login fixture stage reply is missing field 6.")
    stage_has_empty_field9 = get_proto_bytes(stage_fields, 9) is not None

    return StructuredLoginTemplates(
        fixture_path=path,
        sdk_login_reply=sdk_login_reply,
        login_reply=login_reply,
        charge_reply=charge_reply,
        post_login_push=post_login_push,
        heartbeat_reply_delay_ms=0,
        stage_reply=stage_reply,
        default_htoken=default_htoken,
        default_svr_id=default_svr_id,
        login_payload=login_payload,
        charge_payload=charge_payload,
        charge_has_empty_field9=charge_has_empty_field9,
        push_payload=push_payload,
        stage_payload=stage_payload,
        stage_has_empty_field9=stage_has_empty_field9,
    )


def normalize_interaction_fixture(path: str | None) -> InteractionFixture | None:
    if not path:
        return None

    fixture = json.loads(Path(path).read_text(encoding="utf-8"))
    rules = []
    for index, rule in enumerate(fixture.get("rules") or [], start=1):
        responses = []
        for response_index, response in enumerate(rule.get("responses") or [], start=1):
            responses.append(
                InteractionResponseTemplate(
                    label=response.get("label") or f"rule_{index}_response_{response_index}",
                    message_type=response["message_type"],
                    payload=response["payload"],
                    delay_ms=int(response.get("delay_ms", response.get("response_delay_ms", 0))),
                    capture_gap_ms=int(response.get("capture_gap_ms", response.get("delay_ms", 0))),
                    business_generator=response.get("business_generator"),
                    business_label=response.get("business_label"),
                    business_tables=response.get("business_tables"),
                )
            )

        if not responses:
            raise ValueError(f"Interaction fixture rule {index} has no responses.")

        rules.append(
            InteractionRule(
                label=rule.get("label") or f"rule_{index}",
                match=rule.get("match") or {},
                request=rule.get("request") or {},
                responses=responses,
            )
        )

    if not rules:
        raise ValueError("Interaction fixture must contain at least one rule.")

    post_replay = fixture.get("post_replay") or {}
    return InteractionFixture(
        fixture_path=path,
        rules=rules,
        auto_heartbeat=post_replay.get("mode") == "auto_heartbeat",
        unmatched_policy=fixture.get("unmatched_policy", "log"),
    )


def parse_json_field(value) -> dict | list:
    if value is None:
        return {}
    if isinstance(value, (dict, list)):
        return value
    return json.loads(value)


def build_interaction_fixture_from_rules(
    rows: list[dict],
    source_label: str,
    unmatched_policy: str,
    auto_heartbeat: bool,
) -> InteractionFixture | None:
    rules = []
    for index, row in enumerate(rows, start=1):
        request_signature_payload = parse_json_field(row.get("request_signature"))
        response_sequence_payload = parse_json_field(row.get("response_sequence"))
        match_payload = request_signature_payload.get("match") or request_signature_payload
        request_payload = request_signature_payload.get("request") or {}

        responses = []
        for response_index, response in enumerate(response_sequence_payload or [], start=1):
            responses.append(
                InteractionResponseTemplate(
                    label=response.get("label")
                    or f"{row.get('rule_name') or f'rule_{index}'}_response_{response_index}",
                    message_type=response["message_type"],
                    payload=response["payload"],
                    delay_ms=int(response.get("delay_ms", response.get("response_delay_ms", 0))),
                    capture_gap_ms=int(response.get("capture_gap_ms", response.get("delay_ms", 0))),
                    business_generator=response.get("business_generator"),
                    business_label=response.get("business_label"),
                    business_tables=response.get("business_tables"),
                )
            )

        if not responses:
            continue

        rules.append(
            InteractionRule(
                label=row.get("rule_name") or f"db_rule_{index}",
                match=match_payload,
                request=request_payload,
                responses=responses,
            )
        )

    if not rules:
        return None

    return InteractionFixture(
        fixture_path=source_label,
        rules=rules,
        auto_heartbeat=auto_heartbeat,
        unmatched_policy=unmatched_policy,
    )


def load_interaction_fixture_from_mysql(
    unmatched_policy: str = "log",
    auto_heartbeat: bool = True,
) -> InteractionFixture | None:
    payload = http_json_with_retry("GET", "/__afk/internal/interaction-rules")
    rows = payload.get("rules") or []

    return build_interaction_fixture_from_rules(
        rows,
        f"{local_mock_base_url()}/__afk/internal/interaction-rules",
        unmatched_policy,
        auto_heartbeat,
    )


def sequence_agnostic_match(rule_match: dict, signature: dict) -> bool:
    control_keys = {"seq", "repeatable", "description"}
    for key, expected in rule_match.items():
        if key in control_keys:
            continue

        actual = signature.get(key)
        if key == "top_fields":
            actual_fields = [
                {
                    "number": item.get("number"),
                    "wire_type": item.get("wire_type"),
                    "size": item.get("size"),
                }
                for item in actual or []
            ]
            expected_fields = [
                {
                    "number": item.get("number"),
                    "wire_type": item.get("wire_type"),
                    "size": item.get("size"),
                }
                for item in expected or []
            ]
            if actual_fields != expected_fields:
                return False
            continue

        if actual != expected:
            return False

    return True


def find_interaction_rule(fixture: InteractionFixture, signature: dict) -> InteractionRule | None:
    matching_rules = [
        rule
        for rule in fixture.rules
        if sequence_agnostic_match(rule.match, signature)
    ]
    if not matching_rules:
        return None

    unused_rules = [rule for rule in matching_rules if rule.use_count == 0]
    if unused_rules:
        return unused_rules[0]

    reusable_rules = [
        rule for rule in matching_rules
        if rule.match.get("repeatable", False)
        or rule.match.get("kind") == "heartbeat"
        or rule.match.get("route_field") == 19
    ]
    if reusable_rules:
        return reusable_rules[0]

    return matching_rules[-1]


def looks_like_reconnect_payload(payload: bytes) -> bool:
    """Recognize reconnect bodies even when an older script uses a shifted route."""
    try:
        fields = parse_proto_fields(payload)
        open_id = get_proto_text(fields, 2) or ""
        htoken = get_proto_text(fields, 5) or ""
        cli_version = get_proto_text(fields, 6) or ""
        md5_rows = get_repeated_proto_bytes(fields, 7)
    except (UnicodeDecodeError, ValueError):
        return False
    return bool(
        len(open_id) >= 6
        and htoken
        and "." in cli_version
        and md5_rows
    )


def build_interaction_response(
    request_signature_payload: dict,
    response: InteractionResponseTemplate,
) -> str | bytes:
    message = decode_fixture_message(response.message_type, response.payload)
    if not isinstance(message, bytes):
        return message

    request_seq = request_signature_payload.get("seq")
    if request_seq is None:
        return message

    try:
        fields = parse_proto_fields(message)
    except ValueError:
        return message

    if get_proto_varint(fields, 2) is None:
        return message

    return replace_top_level_varint_field(message, 2, int(request_seq))


def infer_business_generator(rule: InteractionRule, response: InteractionResponseTemplate) -> str | None:
    if response.business_generator:
        return response.business_generator

    request_kind = rule.match.get("kind")
    for generator, config in BUSINESS_RESPONSE_GENERATORS.items():
        if request_kind in config["fallback_kinds"]:
            return generator

    return None


async def send_interaction_responses(
    client: ServerConnection,
    session_id: int,
    logger: JsonlLogger,
    rule: InteractionRule,
    signature: dict,
    business_state: BusinessStateProvider | None = None,
) -> None:
    rule.use_count += 1

    for response in rule.responses:
        if response.delay_ms > 0:
            await asyncio.sleep(response.delay_ms / 1000)

        business_generator = infer_business_generator(rule, response)
        if business_state is not None and business_generator:
            template_message = decode_fixture_message(response.message_type, response.payload)
            if isinstance(template_message, bytes):
                generated = await business_state.build_response(
                    business_generator,
                    signature,
                    template_message,
                )
            else:
                generated = None

            if generated is not None:
                message = generated["message"]
                tables = response.business_tables or generated["tables"]
                label = response.business_label or generated["label"]
                await logger.write(
                    {
                        "ts": utc_now(),
                        "event": "business_response_generated",
                        "session_id": session_id,
                        "request_kind": signature.get("kind"),
                        "request_seq": signature.get("seq"),
                        "interaction_rule": rule.label,
                        "business_generator": generated["generator"],
                        "source": "mysql",
                        "tables": tables,
                    }
                )
                await logger.write(
                    {
                        "ts": utc_now(),
                        "event": "frame",
                        "session_id": session_id,
                        "direction": "local_interaction_to_client",
                        "fixture_label": label,
                        "interaction_rule": rule.label,
                        "interaction_rule_use_count": rule.use_count,
                        "replay_delay_ms": response.delay_ms,
                        "capture_gap_ms": response.capture_gap_ms,
                        "response_signature": response_signature(message),
                        **format_message(message),
                    }
                )
                await client.send(message)
                continue

        message = build_interaction_response(signature, response)
        await logger.write(
            {
                "ts": utc_now(),
                "event": "frame",
                "session_id": session_id,
                "direction": "local_interaction_to_client",
                "fixture_label": response.label,
                "interaction_rule": rule.label,
                "interaction_rule_use_count": rule.use_count,
                "replay_delay_ms": response.delay_ms,
                "capture_gap_ms": response.capture_gap_ms,
                "response_signature": response_signature(message),
                **format_message(message),
            }
        )
        await client.send(message)


def parse_client_message_kind(message: str | bytes) -> dict:
    if not isinstance(message, bytes):
        return {"kind": "text"}

    try:
        fields = parse_proto_fields(message)
    except ValueError as exc:
        return {"kind": "unknown_binary", "error": repr(exc)}

    seq = get_proto_varint(fields, 1)
    native_hd_wrapper = get_proto_bytes(
        fields, LEGACY_SYNTHETIC_NATIVE_HD_REQUEST_FIELD
    )
    if native_hd_wrapper is not None:
        try:
            wrapper_fields = parse_proto_fields(native_hd_wrapper)
            request_outer_field = int(get_proto_varint(wrapper_fields, 1) or 0)
            request_payload = get_proto_bytes(wrapper_fields, 2) or b""
            route = NEW_NATIVE_HD_ROUTES.get(request_outer_field)
            if route is not None:
                operation_fields = parse_proto_fields(request_payload)
                operation_field = operation_fields[0].number if operation_fields else 0
                if operation_field == 0 and route.get("operations"):
                    operation_field = next(
                        (number for number, entry in route["operations"].items() if "open" in str(entry.get("request_name", ""))),
                        min(route["operations"]),
                    )
                operation = route["operations"].get(operation_field, {})
                operation_payload = {}
                if operation_fields:
                    raw_operation = operation_fields[0]
                    if raw_operation.wire_type == 2:
                        try:
                            operation_payload = proto_fields_to_payload(
                                parse_proto_fields(bytes(raw_operation.value))
                            )
                        except ValueError:
                            operation_payload = {
                                "raw_hex": bytes(raw_operation.value).hex()[:2048]
                            }
                    elif raw_operation.wire_type == 0:
                        operation_payload = {"value": int(raw_operation.value)}
                return {
                    "kind": f"generic_{route['module']}",
                    "seq": seq,
                    "generic_module": route["module"],
                    "generic_operation": operation.get(
                        "request_name", f"operation_{operation_field}"
                    ),
                    "generic_request_outer_field": request_outer_field,
                    "generic_request_operation_field": operation_field,
                    "generic_reply_outer_field": LEGACY_SYNTHETIC_NATIVE_HD_RESPONSE_FIELD,
                    "generic_reply_operation_field": operation.get(
                        "reply_field", operation_field or 1
                    ),
                    "generic_reply_type": operation.get("reply_type", "bytes"),
                    "generic_payload": operation_payload,
                    "native_hd": True,
                    "native_hd_reply_outer_field": route["reply_outer_field"],
                }
        except ValueError:
            return {"kind": "native_hd_invalid", "seq": seq}
    assist_stage_payload = get_proto_bytes(
        fields, LEGACY_SYNTHETIC_ASSIST_STAGE_REQUEST_FIELD
    )
    if assist_stage_payload is not None:
        try:
            assist_fields = parse_proto_fields(assist_stage_payload)
        except ValueError:
            assist_fields = []
        operation_field = assist_fields[0].number if assist_fields else 1
        operation = NEW_PROTO_DEFS["req_assist_stage"]["by_number"].get(
            operation_field, {}
        ).get("name", f"operation_{operation_field}")
        return {
            "kind": "hd_assist_stage",
            "seq": seq,
            "assist_operation": operation,
            "assist_operation_field": operation_field,
        }
    if get_proto_bytes(fields, 19) is not None:
        return {"kind": "heartbeat", "seq": seq}

    reconnect_payload = get_proto_bytes(fields, 29)
    if reconnect_payload is not None:
        reconnect_fields = parse_proto_fields(reconnect_payload)
        return {
            "kind": "reconnect",
            "seq": seq,
            "uid": get_proto_varint(reconnect_fields, 4),
            "htoken": (
                (get_proto_bytes(reconnect_fields, 5) or b"").decode("utf-8", errors="ignore")
                or None
            ),
        }

    # Some Classic 1.201 installations retain an older reconnect sender while
    # loading the newer protobuf table.  The sender places req_reconnect in
    # outer field 34 (req_friend in the current table).  Treat the distinctive
    # reconnect body as authoritative instead of replying with an empty friend
    # payload; otherwise the client waits 20 seconds and reports a misleading
    # gateway connection failure when entering battle.
    for field in fields:
        if field.wire_type != 2 or field.number in (1, 2, 29, 75):
            continue
        if looks_like_reconnect_payload(bytes(field.value)):
            return {
                "kind": "reconnect",
                "seq": seq,
                "reconnect_outer_field": field.number,
            }

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

    charge_payload = get_proto_bytes(fields, 30)
    if charge_payload is not None:
        try:
            charge_fields = parse_proto_fields(charge_payload)
            first = charge_fields[0] if charge_fields else None
            if first is None or first.number == 1:
                return {"kind": "charge", "seq": seq, "charge_operation": "open_panel"}
            operations = {
                2: "exchange_by_bbb", 3: "exchange_free", 4: "exchange_by_excl",
                5: "customize", 6: "refresh", 7: "recv_monthly_card_reward",
                8: "query_gifts", 9: "set_hero_tid", 10: "req_query_hero_ids", 11: "get_gifts",
            }
            result = {
                "kind": "charge_purchase" if first.number in (2, 3, 4, 5) else "generic_charge",
                "seq": seq, "charge_operation": operations.get(first.number, f"operation_{first.number}"),
                "charge_operation_field": first.number,
            }
            if first.wire_type == 2:
                operation_fields = parse_proto_fields(bytes(first.value))
                goods_field = 3 if first.number == 5 else 2
                result["goods_id"] = get_proto_varint(operation_fields, goods_field)
                result["season_id"] = get_proto_varint(operation_fields, 2 if first.number == 5 else 1)
            elif first.wire_type == 0:
                result["goods_id"] = int(first.value)
            if result["kind"] == "generic_charge":
                return parse_generic_protocol_request(message) or result
            return result
        except ValueError:
            return {"kind": "charge", "seq": seq, "charge_operation": "open_panel"}

    altar_payload = get_proto_bytes(fields, 21)
    if altar_payload is not None:
        try:
            altar_fields = parse_proto_fields(altar_payload)
            hero_ids = get_repeated_proto_varints(altar_fields, 1)
            if hero_ids:
                return {"kind": "altar_disband", "seq": seq, "hero_ids": hero_ids}
        except ValueError:
            pass
        return {"kind": "altar_unknown", "seq": seq}

    system_routes = {
        8: ("shop", {1: "shop_open", 2: "shop_buy", 3: "shop_refresh", 4: "shop_buy_many"}),
        10: ("mail", {1: "mail_list", 2: "mail_read", 3: "mail_receive", 4: "mail_receive_all", 5: "mail_delete_read", 6: "mail_extra"}),
        14: ("guild", {1: "guild_open", 2: "guild_create", 3: "guild_edit", 4: "guild_search", 5: "guild_join", 6: "guild_leave", 7: "guild_kick", 8: "guild_approve", 9: "guild_promote", 10: "guild_demote", 11: "guild_transfer", 12: "guild_history", 13: "guild_mail", 14: "guild_disband", 15: "guild_applications", 16: "guild_refresh", 17: "guild_members", 18: "guild_boss_open", 19: "guild_boss_start", 20: "guild_boss_end", 21: "guild_bosses", 22: "guild_boss_records", 23: "guild_boss_final_reward", 24: "guild_member_summaries", 25: "guild_boss_sweep", 26: "guild_recommendations", 27: "guild_set_strong_man", 28: "guild_remove_strong_man", 29: "guild_leave_and_join", 30: "guild_summary"}),
        15: ("arena", {1: "arena_open", 2: "arena_set_defense", 3: "arena_refresh", 4: "arena_query_lineup", 5: "arena_challenge", 7: "arena_open_chest", 8: "arena_records", 10: "arena_buy_ticket"}),
        16: ("tower", {1: "tower_open", 2: "tower_start", 3: "tower_end", 4: "tower_records", 5: "tower_assists", 7: "tower_retry", 8: "tower_unlock_cd"}),
        18: ("item", {1: "item_use", 2: "item_compose", 3: "item_compose_use", 4: "item_choose", 5: "item_sell"}),
        24: ("maze", {1: "maze_open", 2: "maze_query", 3: "maze_move", 4: "maze_start", 5: "maze_end", 6: "maze_use_relic", 7: "maze_transmit", 8: "maze_use_torch", 9: "maze_select_heirloom", 10: "maze_buy", 11: "maze_give_up", 12: "maze_use_item", 13: "maze_receive"}),
    }
    for outer_number, (prefix, inner_routes) in system_routes.items():
        payload = get_proto_bytes(fields, outer_number)
        if payload is None:
            continue
        try:
            inner = parse_proto_fields(payload)
        except ValueError:
            return {"kind": f"{prefix}_unknown", "seq": seq}
        if not inner:
            return {"kind": f"{prefix}_unknown", "seq": seq}
        first = inner[0]
        result = {"kind": inner_routes.get(first.number, f"{prefix}_unknown"), "seq": seq}
        if prefix == "shop":
            if first.number in (1, 3) and first.wire_type == 0:
                result["shop_id"] = int(first.value)
            elif first.number == 2 and first.wire_type == 2:
                buy = parse_proto_fields(bytes(first.value))
                result.update(shop_id=get_proto_varint(buy, 1), index=get_proto_varint(buy, 2), count=get_proto_varint(buy, 3))
        elif prefix == "mail":
            if first.number == 1 and first.wire_type == 2:
                result["ids"] = get_repeated_proto_varints(parse_proto_fields(bytes(first.value)), 1)
            elif first.number in (2, 3, 6) and first.wire_type == 0:
                result["id"] = int(first.value)
        elif prefix == "guild":
            if first.number in (5, 7, 9, 10, 11, 17, 18, 22, 23, 25, 27, 28, 29, 30) and first.wire_type == 0:
                result["id"] = int(first.value)
                if first.number in (7, 9, 10, 11, 27, 28):
                    result["target_uid"] = str(int(first.value))
            elif first.number in (2, 4) and first.wire_type == 2:
                guild_req = parse_proto_fields(bytes(first.value))
                result["id"] = get_proto_varint(guild_req, 1)
                result["name"] = get_proto_text(guild_req, 1 if first.number == 2 else 2)
                if first.number == 2:
                    result["icon"] = get_proto_varint(guild_req, 2)
            elif first.number == 3 and first.wire_type == 2:
                edit = parse_proto_fields(bytes(first.value))
                result.update(name=get_proto_text(edit, 1), icon=get_proto_varint(edit, 2), notice=get_proto_text(edit, 4), require_lv=get_proto_varint(edit, 6), join_type=get_proto_varint(edit, 7))
            elif first.number == 8 and first.wire_type == 2:
                application = parse_proto_fields(bytes(first.value))
                result["handle_type"] = get_proto_varint(application, 1) or 1
                target_uid = get_proto_varint(application, 2)
                if target_uid is not None: result["target_uid"] = str(target_uid)
            elif first.number == 13 and first.wire_type == 2:
                mail = parse_proto_fields(bytes(first.value))
                result["subject"] = get_proto_text(mail, 1) or "公会通知"
                result["message"] = get_proto_text(mail, 2) or ""
            elif first.number == 19 and first.wire_type == 2:
                start = parse_proto_fields(bytes(first.value))
                lineup = parse_proto_fields(get_proto_bytes(start, 2) or b"")
                hero_ids = []
                for slot_payload in get_repeated_proto_bytes(lineup, 2):
                    hero_id = get_proto_varint(parse_proto_fields(slot_payload), 2)
                    if hero_id is not None: hero_ids.append(int(hero_id))
                result.update(id=get_proto_varint(start, 1) or 1, lineup_ids=hero_ids)
            elif first.number == 20 and first.wire_type == 2:
                end = parse_proto_fields(bytes(first.value))
                result["battle_result"] = get_proto_varint(end, 1) or 2
                result["damage"] = get_proto_varint(end, 4) or 0
        elif prefix == "arena":
            if first.number in (4, 5) and first.wire_type == 2:
                arena_req = parse_proto_fields(bytes(first.value))
                result["opponent_uid"] = get_proto_varint(arena_req, 1)
                if first.number == 5:
                    result["is_robot"] = bool(get_proto_varint(arena_req, 5) or 0)
                else:
                    result["is_robot"] = bool(get_proto_varint(arena_req, 2) or 0)
        elif prefix == "tower":
            if first.number in (2, 7) and first.wire_type == 2:
                start = parse_proto_fields(bytes(first.value))
                hero_ids = []
                for team_payload in get_repeated_proto_bytes(start, 4):
                    team = parse_proto_fields(team_payload)
                    for slot_payload in get_repeated_proto_bytes(team, 2):
                        hero_id = get_proto_varint(parse_proto_fields(slot_payload), 2)
                        if hero_id is not None: hero_ids.append(int(hero_id))
                result.update(tower_type=get_proto_varint(start, 1) or 1, floor_id=get_proto_varint(start, 2), lineup_ids=hero_ids)
            elif first.number == 3 and first.wire_type == 2:
                end = parse_proto_fields(bytes(first.value))
                result["battle_result"] = get_proto_varint(end, 1) or 2
        elif prefix == "maze":
            if first.number in (2, 3, 7, 8, 15, 18, 20, 21) and first.wire_type == 0:
                result["cell_id"] = int(first.value)
            elif first.number == 10 and first.wire_type == 0:
                result["index"] = int(first.value)
            elif first.number == 5 and first.wire_type == 2:
                end = parse_proto_fields(bytes(first.value))
                result["battle_result"] = get_proto_varint(end, 1) or 2
            elif first.number == 4 and first.wire_type == 2:
                start = parse_proto_fields(bytes(first.value))
                lineup = parse_proto_fields(get_proto_bytes(start, 1) or b"")
                hero_ids = []
                for slot_payload in get_repeated_proto_bytes(lineup, 2):
                    hero_id = get_proto_varint(parse_proto_fields(slot_payload), 2)
                    if hero_id is not None: hero_ids.append(int(hero_id))
                result.update(enemy_id=get_proto_varint(start, 2), lineup_ids=hero_ids)
            elif first.number in (6, 9) and first.wire_type == 2:
                values = get_repeated_proto_varints(parse_proto_fields(bytes(first.value)), 1)
                if first.number == 6:
                    result["params"] = values
                else:
                    result["heirlooms"] = values
        elif prefix == "item" and first.number == 1 and first.wire_type == 2:
            use = parse_proto_fields(bytes(first.value))
            result.update(item_id=get_proto_varint(use, 1), count=get_proto_varint(use, 2) or 1)
        return result

    unit_payload = get_proto_bytes(fields, 4)
    if unit_payload is not None:
        try:
            unit_fields = parse_proto_fields(unit_payload)
            if get_proto_bytes(unit_fields, 1) is not None:
                up_level_payload = get_proto_bytes(unit_fields, 1)
                up_level_fields = parse_proto_fields(up_level_payload)
                return {
                    "kind": "hero_up_level",
                    "seq": seq,
                    "hero_id": get_proto_varint(up_level_fields, 1),
                    "up_level": get_proto_varint(up_level_fields, 2),
                }
            first = unit_fields[0] if unit_fields else None
            if first is not None and first.number == 2 and first.wire_type == 2:
                quality = parse_proto_fields(bytes(first.value))
                return {"kind": "hero_up_quality", "seq": seq, "hero_id": get_proto_varint(quality, 1), "cost_hero_ids": get_repeated_proto_varints(quality, 2)}
            if first is not None and first.number == 3 and first.wire_type == 2:
                wear = parse_proto_fields(bytes(first.value))
                return {"kind": "hero_wear_equip", "seq": seq, "hero_id": get_proto_varint(wear, 1), "index": get_proto_varint(wear, 2), "equip_id": get_proto_varint(wear, 3)}
            if first is not None and first.number == 4 and first.wire_type == 2:
                remove = parse_proto_fields(bytes(first.value))
                return {"kind": "hero_remove_equip", "seq": seq, "hero_id": get_proto_varint(remove, 1), "index": get_proto_varint(remove, 2)}
            if first is not None and first.number == 5 and first.wire_type == 0:
                return {"kind": "hero_remove_all_equips", "seq": seq, "hero_id": int(first.value)}
            if first is not None and first.number == 6 and first.wire_type == 2:
                wear_best = parse_proto_fields(bytes(first.value))
                return {
                    "kind": "hero_wear_best_equip",
                    "seq": seq,
                    "hero_id": get_proto_varint(wear_best, 1),
                    "tag_first_flag": bool(get_proto_varint(wear_best, 2) or 0),
                }
            if first is not None and first.number in (7, 8) and first.wire_type == 0:
                return {"kind": "hero_lock", "seq": seq, "hero_id": int(first.value), "locked": first.number == 7}
            if first is not None and first.number == 9 and first.wire_type == 2:
                wear = parse_proto_fields(bytes(first.value))
                return {"kind": "hero_wear_artifact", "seq": seq, "hero_id": get_proto_varint(wear, 1), "artifact_id": get_proto_varint(wear, 2) or 0, "from_hero_id": get_proto_varint(wear, 3) or 0}
            if first is not None and first.number == 10 and first.wire_type == 0:
                return {"kind": "hero_remove_artifact", "seq": seq, "hero_id": int(first.value)}
            if first is not None and first.number == 11 and first.wire_type == 2:
                upgrades = [parse_proto_fields(bytes(field.value)) for field in unit_fields if field.number == 11 and field.wire_type == 2]
                quality_upgrades = [
                    {
                        "hero_id": get_proto_varint(value, 1) or 0,
                        "cost_hero_ids": get_repeated_proto_varints(value, 2),
                    }
                    for value in upgrades
                ]
                return {
                    "kind": "hero_quality_one_key", "seq": seq,
                    "hero_ids": [value["hero_id"] for value in quality_upgrades],
                    "cost_hero_ids": [hero_id for value in quality_upgrades for hero_id in value["cost_hero_ids"]],
                    "quality_upgrades": quality_upgrades,
                }
            if first is not None and first.number == 14 and first.wire_type == 2:
                query = parse_proto_fields(bytes(first.value))
                return {"kind": "hero_query", "seq": seq, "user_id": get_proto_varint(query, 1) or 0, "hero_id": get_proto_varint(query, 2) or 0}
            if first is not None and first.number == 16 and first.wire_type == 2:
                assist = parse_proto_fields(bytes(first.value))
                return {"kind": "hero_set_assist", "seq": seq, "hero_id": get_proto_varint(assist, 1) or 0, "assist_hero_id": get_proto_varint(assist, 2) or 0, "lineup_type": get_proto_text(assist, 3) or "normal"}
            if first is not None and first.number in (17, 18) and first.wire_type == 2:
                totem = parse_proto_fields(bytes(first.value))
                return {"kind": "hero_totem_up", "seq": seq, "hero_id": get_proto_varint(totem, 1) or 0, "node": get_proto_varint(totem, 2) or 0, "up_level": get_proto_varint(totem, 3) or get_proto_varint(totem, 2) or 1}
            if first is not None and first.number == 19 and first.wire_type == 2:
                batch = parse_proto_fields(bytes(first.value))
                artifact_reqs = [parse_proto_fields(value) for value in get_repeated_proto_bytes(batch, 1)]
                mitama_reqs = [parse_proto_fields(value) for value in get_repeated_proto_bytes(batch, 2)]
                return {"kind": "hero_batch_artifact_mitama", "seq": seq, "hero_ids": [get_proto_varint(value, 1) or 0 for value in artifact_reqs + mitama_reqs], "artifact_ids": [get_proto_varint(value, 2) or 0 for value in artifact_reqs], "mitama_ids": [get_proto_varint(value, 2) or 0 for value in mitama_reqs]}
            if first is not None and first.number in (20, 21) and first.wire_type == 2:
                mitama = parse_proto_fields(bytes(first.value))
                return {"kind": "hero_wear_mitama" if first.number == 20 else "hero_remove_mitama", "seq": seq, "hero_id": get_proto_varint(mitama, 1) or 0, "mitama_id": get_proto_varint(mitama, 2) or 0, "from_hero_id": get_proto_varint(mitama, 3) or 0}
        except ValueError:
            pass
        # Unsupported unit operations continue through the recovered schema
        # router below instead of being stranded as an unhandled core route.

    field11_payload = get_proto_bytes(fields, 11)
    if field11_payload is not None:
        kind = classify_field11_request(field11_payload)
        result = {"kind": kind, "seq": seq}
        if kind == "tavern_draw":
            try:
                tavern_fields = parse_proto_fields(field11_payload)
                draw_fields = parse_proto_fields(get_proto_bytes(tavern_fields, 2) or b"")
                protocol_tavern_id = int(get_proto_varint(draw_fields, 1) or 1)
                result.update(
                    {
                        "protocol_tavern_id": protocol_tavern_id,
                        "draw_count": 10 if protocol_tavern_id % 2 == 0 else 1,
                    }
                )
            except ValueError:
                result.update({"protocol_tavern_id": 1, "draw_count": 1})
        if kind != "field11_unknown":
            return result

    field13_payload = get_proto_bytes(fields, 13)
    if field13_payload is not None:
        task_kind = classify_field13_request(field13_payload)
        task_fields = parse_proto_fields(field13_payload)
        result = {
            "kind": task_kind,
            "seq": seq,
            "task_ids": get_repeated_proto_varints(
                task_fields,
                7 if task_kind == "task_batch_claim" and get_repeated_proto_varints(task_fields, 7) else 8,
            ),
        }
        if task_kind in ("task_chest", "task_claim"):
            field_number = 2 if task_kind == "task_chest" else 3
            value = get_proto_varint(task_fields, field_number)
            result["task_ids"] = [value] if value is not None else []
        elif task_kind == "task_line_claim":
            line_request = parse_proto_fields(get_proto_bytes(task_fields, 4) or b"")
            result["task_line"] = int(get_proto_varint(line_request, 1) or 0)
            result["task_ids"] = get_repeated_proto_varints(line_request, 2)
        elif task_kind == "task_batch_line":
            requests = []
            for payload in get_repeated_proto_bytes(task_fields, 9):
                line_request = parse_proto_fields(payload)
                requests.append({"line": int(get_proto_varint(line_request, 1) or 0), "ids": get_repeated_proto_varints(line_request, 2)})
            result["task_lines"] = requests
            result["task_ids"] = [task_id for request in requests for task_id in request["ids"]]
        if task_kind != "field13_unknown":
            return result

    field5_payload = get_proto_bytes(fields, 5)
    if field5_payload is not None:
        try:
            stage_fields = parse_proto_fields(field5_payload)
            if get_proto_bytes(
                stage_fields, LEGACY_SYNTHETIC_STAGE_QUERY_IDLE_FIELD
            ) is not None:
                return {"kind": "stage_hd_query_idle_reward", "seq": seq}
        except ValueError:
            pass
        kind = classify_field5_request(field5_payload)
        result = {"kind": kind, "seq": seq}
        try:
            stage_fields = parse_proto_fields(field5_payload)
            if kind == "stage_battle_start":
                start_fields = parse_proto_fields(get_proto_bytes(stage_fields, 3) or b"")
                result["stage_id"] = get_proto_varint(start_fields, 1)
                hero_ids = []
                for team_payload in get_repeated_proto_bytes(start_fields, 3):
                    team = parse_proto_fields(team_payload)
                    for slot_payload in get_repeated_proto_bytes(team, 2):
                        hero_id = get_proto_varint(parse_proto_fields(slot_payload), 2)
                        if hero_id is not None: hero_ids.append(int(hero_id))
                result["lineup_ids"] = hero_ids
            elif kind == "stage_battle_result":
                end_fields = parse_proto_fields(get_proto_bytes(stage_fields, 4) or b"")
                result["battle_result"] = {
                    1: "victory",
                    2: "defeat",
                }.get(get_proto_varint(end_fields, 1), "defeat")
        except ValueError:
            pass
        if kind != "stage_field5_unknown":
            return result

    generic = parse_generic_protocol_request(message)
    if generic is not None:
        return generic

    return {"kind": "unknown_binary", "seq": seq}


def parse_generic_protocol_request(message: str | bytes) -> dict | None:
    if not isinstance(message, bytes):
        return None
    try:
        fields = parse_proto_fields(message)
    except ValueError:
        return None
    seq = get_proto_varint(fields, 1)
    for field in fields:
        route = PROTOCOL_ROUTE_MAP.get(str(field.number))
        if not route or field.wire_type != 2:
            continue
        try:
            inner_fields = parse_proto_fields(bytes(field.value))
        except ValueError:
            inner_fields = []
        operation_field = inner_fields[0].number if inner_fields else 0
        if operation_field == 0 and route.get("operations"):
            operation_field = int(next(
                (number for number, entry in route["operations"].items() if "open" in str(entry.get("request_name", ""))),
                min(route["operations"], key=lambda value: int(value)),
            ))
        operation = route.get("operations", {}).get(str(operation_field), {})
        operation_payload = {}
        if inner_fields:
            raw_operation = inner_fields[0]
            if raw_operation.wire_type == 2:
                try:
                    operation_payload = proto_fields_to_payload(parse_proto_fields(bytes(raw_operation.value)))
                except ValueError:
                    operation_payload = {"raw_hex": bytes(raw_operation.value).hex()[:2048]}
            elif raw_operation.wire_type == 0:
                operation_payload = {"value": int(raw_operation.value)}
        result = {
            "kind": f"generic_{route['module']}", "seq": seq,
            "generic_module": route["module"],
            "generic_operation": operation.get("request_name", f"operation_{operation_field}"),
            "generic_request_outer_field": field.number,
            "generic_request_operation_field": operation_field,
            "generic_reply_outer_field": route["reply_outer_field"],
            "generic_reply_operation_field": operation.get("reply_field", operation_field or 1),
            "generic_reply_type": operation.get("reply_type", "bytes"),
            "generic_payload": operation_payload,
        }
        # Campaign stages switch from start_battle to retry_battle between
        # teams on multi-fight checkpoints. Keep the selected team explicit
        # so the authoritative simulator and native reply use the same lineup.
        if result["generic_module"] == "stage" and result["generic_operation"] == "retry_battle":
            result["stage_id"] = int(operation_payload.get("field_1") or 0)
            result["team_index"] = max(1, int(operation_payload.get("field_5") or 1))
            teams = operation_payload.get("field_3") or []
            if isinstance(teams, dict):
                teams = [teams]
            teams = sorted(
                (team for team in teams if isinstance(team, dict)),
                key=lambda team: int(team.get("field_1") or 0),
            )
            result["lineup_teams"] = []
            for team in teams:
                team_slots = team.get("field_2") or []
                if isinstance(team_slots, dict):
                    team_slots = [team_slots]
                result["lineup_teams"].append([
                    int(slot.get("field_2") or 0)
                    for slot in team_slots
                    if isinstance(slot, dict) and int(slot.get("field_2") or 0) > 0
                ])
            selected_team = next(
                (
                    team for team in teams
                    if isinstance(team, dict)
                    and int(team.get("field_1") or 0) == result["team_index"]
                ),
                teams[-1] if teams else {},
            )
            slots = selected_team.get("field_2") or [] if isinstance(selected_team, dict) else []
            if isinstance(slots, dict):
                slots = [slots]
            result["lineup_ids"] = [
                int(slot.get("field_2") or 0)
                for slot in slots
                if isinstance(slot, dict) and int(slot.get("field_2") or 0) > 0
            ]
        return result
    return None


def proto_fields_to_payload(fields: list[ProtoField], depth: int = 0) -> dict:
    output: dict = {}
    for field in fields[:128]:
        key = f"field_{field.number}"
        if field.wire_type == 0:
            value = int(field.value)
        elif field.wire_type == 2:
            raw = bytes(field.value)
            value = raw.hex()[:2048]
            if depth < 3 and raw:
                try:
                    nested = parse_proto_fields(raw)
                    if nested and encode_proto_fields(nested) == raw:
                        value = proto_fields_to_payload(nested, depth + 1)
                    else:
                        text_value = raw.decode("utf-8")
                        value = text_value if text_value.isprintable() else value
                except (ValueError, UnicodeDecodeError):
                    try:
                        text_value = raw.decode("utf-8")
                        value = text_value if text_value.isprintable() else value
                    except UnicodeDecodeError:
                        pass
        else:
            value = int(field.value) if isinstance(field.value, int) else str(field.value)
        if key in output:
            if not isinstance(output[key], list):
                output[key] = [output[key]]
            output[key].append(value)
        else:
            output[key] = value
    return output


def _enum_value(type_name: str, default_value=None, enums: dict | None = None) -> int:
    values = (enums or PROTOBUF_ENUMS).get(type_name, {})
    if default_value is not None:
        if str(default_value).lstrip("-").isdigit():
            return int(default_value)
        if str(default_value) in values:
            return int(values[str(default_value)])
    for preferred in ("success", "normal", "open", "idle", "none"):
        if preferred in values:
            return int(values[preferred])
    positives = [int(value) for value in values.values() if int(value) >= 0]
    return min(positives) if positives else 0


def _projection_value(name: str, transaction: dict, default_value=None):
    projection = (transaction or {}).get("wire_projection") or {}
    state = (transaction or {}).get("state") or {}
    aliases = {
        "floor": "progress", "floor_id": "progress", "stage": "progress", "stage_id": "progress",
        "point": "score", "damage": "score", "self_rank": "rank", "cur_rank": "rank",
        "pos": "position", "cell_id": "position", "block_id": "position", "times": "attempts",
        "end_ts": "timestamp", "start_ts": "timestamp", "expire_ts": "timestamp", "ts": "timestamp",
        "season_id": "season",
    }
    key = aliases.get(name, name)
    if key in projection:
        value = projection[key]
        if name.endswith("end_ts") or name == "expire_ts":
            return int(value) + 86400
        return value
    if key in state and isinstance(state[key], (str, int, float, bool)):
        return state[key]
    if name in ("result", "ret", "status", "state"):
        return 1
    if name.endswith("_id") or name in ("id", "uid", "gid", "hid", "tid"):
        return 1
    if name.startswith("is_") or name.startswith("has_") or name in ("success", "toggle"):
        return True
    if default_value is not None and str(default_value).lstrip("-").isdigit():
        return int(default_value)
    return 0


def _encode_asset(entry: dict) -> bytes:
    asset_type = str(entry.get("type") or "currency").lower()
    type_id = int(PROTOBUF_ENUMS.get("t_asset", {}).get(asset_type, 1 if asset_type == "currency" else 2))
    raw_id = str(entry.get("id") or "gold")
    asset_id = int(PROTOBUF_ENUMS.get("t_asset_id", {}).get(raw_id, raw_id if raw_id.isdigit() else 1))
    amount = max(0, int(float(entry.get("amount") or 0)))
    return b"".join((encode_varint_field(1, type_id), encode_varint_field(2, asset_id), encode_varint_field(3, amount)))


def _build_pet_open_panel_reply_payload() -> bytes:
    # A graduated account needs concrete pet rows. The HD client dereferences
    # the first pet while constructing the stable, despite the list being
    # declared repeated/optional in protobuf.
    pets = []
    for index, tid in enumerate((6001, 6002, 6003, 6004, 6005, 6006, 6007, 6008), 1):
        job_levels = tuple(
            encode_length_delimited_field(3, b"".join((
                encode_varint_field(1, job_id),
                encode_varint_field(2, 6),
            )))
            for job_id in range(1, 6)
        )
        pets.append(encode_length_delimited_field(1, b"".join((
            encode_varint_field(1, 9_000_000 + index),
            encode_varint_field(2, tid),
            *job_levels,
            encode_varint_field(4, 0),
            encode_varint_field(5, 100_000 + index * 1_000),
            encode_varint_field(6, 18),
            encode_varint_field(7, 6),
            encode_varint_field(9, 6),
        ))))
    pentagram = b"".join((
        encode_varint_field(1, 18),
        *(encode_varint_field(2, 9_000_000 + index) for index in range(1, 6)),
    ))
    return b"".join((*pets, encode_length_delimited_field(2, pentagram)))


def _build_pentagram_open_panel_reply_payload() -> bytes:
    """Build the non-empty resonance-crystal panel required by the HD UI."""
    grid = b"".join((
        encode_varint_field(1, 20),
        encode_varint_field(2, 25),
        encode_varint_field(3, 5),
    ))
    pentagram = b"".join((
        encode_length_delimited_field(1, grid),
        encode_varint_field(2, 999),
        encode_varint_field(5, 999),
        encode_varint_field(6, 999),
        encode_varint_field(7, 999),
    ))
    shop = b"".join((
        encode_varint_field(1, 240),
        encode_varint_field(2, 240),
        encode_varint_field(3, 999),
        encode_varint_field(4, current_server_timestamp() + 86400 * 30),
    ))
    return b"".join((
        encode_length_delimited_field(1, pentagram),
        encode_length_delimited_field(2, shop),
    ))


def _encode_uint_map_entry(key: int, value: int) -> bytes:
    return b"".join((encode_varint_field(1, key), encode_varint_field(2, value)))


def _build_homeland_tavern_reply_payload(
    operation: str,
    transaction: dict,
    request_payload: dict | None = None,
) -> bytes | None:
    """Build furniture-tavern replies including maps omitted by schema parsing."""
    if operation == "open_panel":
        return b"".join((
            encode_varint_field(1, 8),  # TavernPool.FurnitureNormal
            *(encode_length_delimited_field(2, _encode_uint_map_entry(tavern_id, 0)) for tavern_id in (15, 16)),
            *(encode_length_delimited_field(3, _encode_uint_map_entry(slot_id, 1)) for slot_id in range(1, 10)),
            encode_varint_field(4, 999),
            encode_varint_field(5, 0),
            encode_varint_field(6, 1),
        ))
    if operation == "set_desire":
        return encode_varint_field(1, _enum_value("result", "success"))
    if operation == "first_draw":
        furniture = b"".join((
            encode_varint_field(1, current_server_timestamp()),
            encode_varint_field(2, 10001),
            encode_varint_field(3, 0),
        ))
        reward = encode_length_delimited_field(5, furniture)
        return encode_length_delimited_field(1, reward)
    if operation == "draw":
        request_payload = request_payload or {}
        tavern_id = max(1, int(request_payload.get("field_1") or 1))
        batch_count = max(1, int(request_payload.get("field_2") or 1))
        draw_count = max(1, min(100, (10 if tavern_id % 2 == 0 else 1) * batch_count))
        now = current_server_timestamp()
        reward = b"".join(
            encode_length_delimited_field(5, b"".join((
                encode_varint_field(1, now + index),
                encode_varint_field(2, 10001 + index % 9),
                encode_varint_field(3, 0),
            )))
            for index in range(draw_count)
        )
        cost = encode_length_delimited_field(1, _encode_asset({
            "type": "currency",
            "id": "homeland_coin",
            "amount": 300 * draw_count,
        }))
        return b"".join((
            encode_length_delimited_field(1, reward),
            encode_length_delimited_field(2, cost),
            encode_varint_field(3, 999),
            encode_length_delimited_field(4, b""),
            encode_varint_field(5, 1),
        ))
    return None


def _build_dragon_tavern_open_payload(transaction: dict | None = None) -> bytes:
    """Legacy dragon tavern state retained by the 1.201 UI bundle."""
    transaction = transaction or {}
    # Dragon Tavern targets must be Dragon-tag Unit TIDs. 185 is the first
    # highborn Dragon in the exact Classic 1.201 catalogue; the previous
    # starter TID 22 produced faction frames with empty portraits.
    hero_tid = int(transaction.get("dragon_hyper_tid") or 185)
    wish_tids = transaction.get("wish_tids") or {}
    draw_times = transaction.get("draw_times") or {}
    return b"".join((
        *(encode_length_delimited_field(1, _encode_uint_map_entry(slot, hero_tid)) for slot in range(1, 21)),
        *(encode_length_delimited_field(2, _encode_uint_map_entry(pool_id, int(draw_times.get(str(pool_id), 0)))) for pool_id in (14, 15, 25, 26, 27, 28, 29, 30)),
        *(encode_length_delimited_field(3, _encode_uint_map_entry(pool_id, int(wish_tids.get(str(pool_id), hero_tid)))) for pool_id in (14, 15, 25, 26, 27, 28, 29, 30)),
    ))


def _build_tavern_aux_reply_payload(operation: str, transaction: dict | None = None) -> bytes | None:
    transaction = transaction or {}
    if operation == "req_open_stargazer_wanted":
        selected = int(transaction.get("stargazer_id") or 22)
        wishlist = [int(value) for value in (transaction.get("wishlist") or {}).values() if int(value) > 0]
        tids = list(dict.fromkeys([selected, *wishlist]))[:20]
        return b"".join(
            encode_length_delimited_field(1, encode_proto_fields([
                ProtoField(1, 0, tid), ProtoField(2, 0, 1 if tid == selected else 0),
            ]))
            for tid in tids
        )
    if operation in {"req_init_pick_pool", "req_set_pick_pool"}:
        pool = encode_proto_fields([
            ProtoField(1, 0, int(transaction.get("pick_pool") or 22)),
            ProtoField(2, 0, int((transaction.get("draw_times") or {}).get("12", 0))),
            ProtoField(3, 0, current_server_timestamp() + 86400),
        ])
        return encode_length_delimited_field(1, pool)
    if operation == "req_tavern_npc":
        return build_tavern_npc_payload()
    if operation == "req_wish_open_panel":
        return encode_proto_fields([
            ProtoField(1, 0, current_server_timestamp() + 86400),
            ProtoField(3, 0, 1),
        ])
    if operation == "req_recv_share_reward":
        return build_reward_payload(transaction.get("rewards") or [])
    return None


def _build_endless_draw_reply_payload(operation: str, transaction: dict) -> bytes | None:
    default_rewards = [
        # Endless Summons renders this list as summon results, so item assets
        # produce misleading inventory icons.  Use valid hero template IDs.
        {"type": "hero", "id": 17 + index, "amount": 1} for index in range(10)
    ]
    transaction_rewards = (transaction or {}).get("rewards") or []
    # The generic persistence engine may emit a single audit reward.  That is
    # not a valid Endless Summons roll: the client constructs ten result nodes
    # and dereferences every slot's hero quality.
    rewards = transaction_rewards[:10] if len(transaction_rewards) >= 10 else default_rewards
    result = b"".join((
        encode_varint_field(1, 1),
        *(encode_length_delimited_field(2, _encode_asset(entry)) for entry in rewards[:10]),
    ))
    if operation == "open_panel":
        return b"".join((
            encode_length_delimited_field(1, result),
            encode_varint_field(2, 0),
            encode_length_delimited_field(3, result),
        ))
    if operation in ("draw", "save"):
        return result
    if operation == "reward":
        # reward.heroes is field 3; returning the selected results again as
        # asset rows leaves `reward.heroes` undefined and the HD client sorts
        # it immediately after confirmation.
        heroes = []
        for index, entry in enumerate(rewards[:10]):
            heroes.append(encode_length_delimited_field(3, build_tavern_hero_payload({
                "id": 8_200_000 + index,
                "tid": int(entry.get("id") or 17 + index),
                "quality": 3 if index < 3 else 2,
                "rank": 1,
                "level": 1,
                "gs": 797,
            })))
        return b"".join(heroes)
    return None


def _build_hundred_draw_reply_payload(operation: str, transaction: dict) -> bytes | None:
    if operation == "open_panel":
        return b""
    if operation == "req_draw":
        rewards = (transaction or {}).get("rewards") or [
            {"type": "item", "id": 13, "amount": 100}
        ]
        # reply_asset contains a single asset in field 1.
        return encode_length_delimited_field(1, _encode_asset(rewards[0]))
    return None


def _build_activity_calendar_reply_payload(operation: str) -> bytes | None:
    """Return the server-backed activity calendar used by the 1.201 hall.

    The client intersects this list with the activity_info entries from login,
    so it is safe (and faithful to production) to advertise every locally
    configured visible banner here.  Previously the generic synthesizer
    omitted repeated nested messages and the calendar was always empty.
    """
    if operation != "calendar_acts":
        return None
    _, banner_ids = _load_official_activity_projection()
    # Keep compatibility targets whose UI code is present but whose historical
    # banner row may be disabled in the newest English configuration.
    banner_ids.update({975, 1254, 1398, 1461, 1854, 2030, 2032})
    now = current_server_timestamp()
    start_time = max(1, now - 86400)
    end_time = now + 28 * 86400

    def encode_calendar_act(activity_id: int) -> bytes:
        phase = b"".join((
            encode_varint_field(1, start_time),
            encode_varint_field(2, end_time),
        ))
        return b"".join((
            encode_varint_field(1, activity_id),
            encode_varint_field(3, start_time),
            encode_varint_field(4, end_time),
            encode_length_delimited_field(5, phase),
        ))

    return b"".join(
        encode_length_delimited_field(1, encode_calendar_act(activity_id))
        for activity_id in sorted(activity_id for activity_id in banner_ids if activity_id > 0)
    )


def _synthesize_message(
    type_name: str,
    transaction: dict,
    depth: int = 0,
    messages: dict | None = None,
    enums: dict | None = None,
) -> bytes:
    if depth > 6:
        return b""
    messages = messages or PROTOBUF_MESSAGES
    enums = enums or PROTOBUF_ENUMS
    message = messages.get(type_name)
    if message is None:
        return b""
    chunks: list[bytes] = []
    rewards = (transaction or {}).get("rewards") or []
    costs = (transaction or {}).get("costs") or []
    scalar_varints = {"bool", "int32", "int64", "uint32", "uint64", "sint32", "sint64"}
    fixed32 = {"fixed32", "sfixed32", "float"}
    fixed64 = {"fixed64", "sfixed64", "double"}
    semantic_optional = {"result", "status", "state", "level", "progress", "score", "rank", "position", "attempts", "season", "timestamp", "end_ts", "start_ts", "expire_ts", "id", "uid", "gid", "hid", "tid", "point", "damage", "floor", "floor_id", "stage", "stage_id", "cell_id", "block_id", "success", "toggle"}
    for field in message.get("fields", []):
        label, field_type, name, number = field["label"], field["type"], field["name"], int(field["number"])
        if label == "repeated":
            if field_type == "asset" and (name == "assets" or name.endswith("_assets")):
                entries = costs if type_name == "cost" else rewards
                chunks.extend(encode_length_delimited_field(number, _encode_asset(entry)) for entry in entries[:32])
            elif field_type in scalar_varints or field_type in enums:
                projection = (transaction or {}).get("wire_projection") or {}
                state = (transaction or {}).get("state") or {}
                values = projection.get(name, state.get(name, []))
                if not isinstance(values, list):
                    values = []
                for value in values[:128]:
                    encoded = _enum_value(field_type, value, enums) if field_type in enums else int(value)
                    if field_type in ("sint32", "sint64"):
                        encoded = (encoded << 1) ^ (encoded >> 63)
                    chunks.append(encode_varint_field(number, max(0, encoded)))
            continue
        required = label == "required"
        projection = (transaction or {}).get("wire_projection") or {}
        include = required or name in semantic_optional or name in projection or field_type in ("result", "reward", "cost")
        if not include:
            continue
        if field_type in scalar_varints or field_type in enums:
            value = _enum_value(field_type, field.get("default"), enums) if field_type in enums else int(_projection_value(name, transaction, field.get("default")))
            if field_type in ("sint32", "sint64"):
                value = (value << 1) ^ (value >> 63)
            chunks.append(encode_varint_field(number, max(0, value)))
        elif field_type == "string" or field_type == "bytes":
            value = str(_projection_value(name, transaction, field.get("default"))) if name in semantic_optional or name in projection else ""
            chunks.append(encode_length_delimited_field(number, value.encode("utf-8")))
        elif field_type in fixed32:
            value = float(_projection_value(name, transaction, field.get("default")))
            chunks.append(encode_varint((number << 3) | 5) + (struct.pack("<f", value) if field_type == "float" else struct.pack("<I", int(value))))
        elif field_type in fixed64:
            value = float(_projection_value(name, transaction, field.get("default")))
            chunks.append(encode_varint((number << 3) | 1) + (struct.pack("<d", value) if field_type == "double" else struct.pack("<Q", int(value))))
        elif field_type == "reward":
            chunks.append(encode_length_delimited_field(number, _synthesize_message("reward", transaction, depth + 1, messages, enums)))
        elif field_type == "cost":
            chunks.append(encode_length_delimited_field(number, _synthesize_message("cost", transaction, depth + 1, messages, enums)))
        elif required or depth == 0 or name in projection:
            chunks.append(encode_length_delimited_field(number, _synthesize_message(field_type, transaction, depth + 1, messages, enums)))
    return b"".join(chunks)


def _social_uid(entry: dict) -> int:
    for key in ("bot_id", "uid", "friend_uid", "player_id", "account_id"):
        value = entry.get(key)
        if value is not None and str(value).isdigit():
            return int(value)
    digest = hashlib.sha1(str(entry.get("player_uid") or entry.get("nickname") or entry).encode("utf-8")).digest()
    return 800_000_000 + int.from_bytes(digest[:4], "big") % 100_000_000


def _encode_user_summary(entry: dict) -> bytes:
    uid = _social_uid(entry)
    nickname = str(entry.get("nickname") or entry.get("name") or f"Adventurer {uid}")
    avatar = str(entry.get("avatar") or "avatar:102")
    level = max(1, parse_int(entry.get("level"), 1))
    power = max(1, parse_int(entry.get("power", entry.get("rating")), level * 1000))
    chunks = [
        encode_varint_field(1, uid),
        encode_varint_field(2, 1),
        encode_length_delimited_field(3, nickname.encode("utf-8")),
        encode_varint_field(4, level),
        encode_length_delimited_field(6, avatar.encode("utf-8")),
        encode_length_delimited_field(8, b"CN"),
        encode_varint_field(10, max(0, parse_int(entry.get("guild_id"), 0))),
        encode_length_delimited_field(11, str(entry.get("guild_name") or "").encode("utf-8")),
        encode_varint_field(13, power),
        encode_varint_field(14, power),
        encode_varint_field(15, max(0, parse_int(entry.get("last_offline"), 0))),
        encode_varint_field(16, 1),
        encode_varint_field(18, max(1, parse_int(entry.get("cur_stage"), 8))),
    ]
    return b"".join(chunks)


def _encode_friend_info(entry: dict) -> bytes:
    summary = _encode_user_summary(entry)
    friend_entry = b"".join((
        encode_varint_field(1, _social_uid(entry)),
        encode_varint_field(2, 1 if entry.get("can_recv_gift", True) else 0),
    ))
    return b"".join((
        encode_length_delimited_field(1, summary),
        encode_length_delimited_field(2, friend_entry),
    ))


def _build_social_friend_reply_payload(operation: str, transaction: dict) -> bytes | None:
    social = (transaction or {}).get("social_friends")
    if not isinstance(social, dict):
        return None
    if operation == "open_panel":
        entries = [*(social.get("friends") or []), *(social.get("bot_friends") or [])]
        return b"".join(encode_length_delimited_field(1, _encode_friend_info(entry)) for entry in entries[:40])
    if operation == "open_apply_panel":
        return b"".join(encode_length_delimited_field(1, _encode_user_summary(entry)) for entry in (social.get("incoming_requests") or [])[:40])
    if operation == "apply":
        return build_cd_payload(41, 0)
    if operation == "handle_app":
        entries = transaction.get("new_friends") or []
        return b"".join(encode_length_delimited_field(1, _encode_friend_info(entry)) for entry in entries[:40])
    if operation == "remove":
        return b""
    if operation == "present_gift":
        return build_cd_payload(42, 0)
    if operation == "receive_gift":
        received = max(0, parse_int(transaction.get("received"), 0))
        reward = build_reward_payload([{"type": 1, "id": CURRENCY_PROTO_IDS["friend_coin"], "amount": received}])
        return b"".join((encode_length_delimited_field(1, build_cd_payload(43, 0)), encode_length_delimited_field(2, reward)))
    if operation == "gift_one_key":
        reward_count = sum(max(0, parse_int(row.get("quantity"), 0)) for row in (transaction.get("rewards") or []))
        return encode_proto_fields([
            *[ProtoField(1, 0, int(uid)) for uid in (transaction.get("presented_uids") or [])],
            *[ProtoField(2, 0, int(uid)) for uid in (transaction.get("received_uids") or [])],
            ProtoField(3, 2, build_cd_payload(42, 0)), ProtoField(4, 2, build_cd_payload(43, 0)),
            ProtoField(5, 2, build_reward_payload([{"type": 1, "id": CURRENCY_PROTO_IDS["friend_coin"], "amount": reward_count}])),
        ])
    if operation == "query_lineup":
        return b""
    if operation == "query_summaries":
        return b"".join(encode_length_delimited_field(1, _encode_user_summary(entry)) for entry in (transaction.get("summaries") or [])[:100])
    if operation in ("query_rec_friends", "refresh_rec_friends"):
        return b"".join(encode_length_delimited_field(1, _encode_user_summary(entry)) for entry in (social.get("suggestions") or [])[:20])
    if operation == "search":
        return b"".join(encode_length_delimited_field(1, _encode_user_summary(entry)) for entry in (transaction.get("search_results") or [])[:20])
    return None


def _encode_blacklist_change(entry: dict) -> bytes:
    return encode_length_delimited_field(1, _encode_user_summary(entry))


def _build_blacklist_reply_payload(operation: str, transaction: dict) -> bytes | None:
    social = (transaction or {}).get("social_friends") or {}
    if operation == "open_panel":
        return b"".join(encode_length_delimited_field(1, _encode_blacklist_change(entry)) for entry in (social.get("blacklist") or [])[:100])
    if operation == "add":
        entry = transaction.get("blocked")
        return encode_length_delimited_field(1, _encode_blacklist_change(entry)) if isinstance(entry, dict) else b""
    if operation == "remove":
        return b""
    return None


def _numeric_hero_id(value, fallback: int = 1) -> int:
    parsed = parse_int(value, 0)
    if parsed > 0:
        return parsed
    digest = hashlib.sha1(str(value or fallback).encode("utf-8")).digest()
    return 700_000_000 + int.from_bytes(digest[:4], "big") % 100_000_000


def _encode_social_hero(entry: dict) -> bytes:
    hero_id = _numeric_hero_id(entry.get("hero_id") or entry.get("character_id"))
    extra = entry.get("extra_json") if isinstance(entry.get("extra_json"), dict) else {}
    tid = max(1, parse_int(entry.get("tid") or extra.get("tid") or entry.get("hero_tid"), hero_id if hero_id < 10_000_000 else 102))
    quality = max(1, parse_int(entry.get("quality") or entry.get("star"), 1))
    level = max(1, parse_int(entry.get("hero_level") or entry.get("level"), 1))
    power = max(1, parse_int(entry.get("power"), level * 1000))
    return encode_proto_fields([
        ProtoField(1, 0, hero_id), ProtoField(2, 0, tid), ProtoField(3, 0, quality),
        ProtoField(4, 0, 1), ProtoField(5, 0, level), ProtoField(6, 0, power), ProtoField(8, 0, 0),
    ])


def _build_mercenary_reply_payload(operation: str, transaction: dict) -> bytes | None:
    state = (transaction or {}).get("mercenary") or transaction or {}
    if operation == "open_panel":
        lent_by_hero = {}
        for row in state.get("lent") or []:
            lent_by_hero.setdefault(str(row.get("hero_id")), []).append(parse_int(row.get("borrower_player_id"), 0))
        chunks = []
        summary_ids = set()
        for offer in state.get("offers") or []:
            hero_id = _numeric_hero_id(offer.get("hero_id"))
            info = encode_proto_fields([
                ProtoField(1, 0, hero_id), ProtoField(2, 0, parse_timestamp(offer.get("created_at"), current_server_timestamp())),
                *[ProtoField(3, 0, uid) for uid in lent_by_hero.get(str(offer.get("hero_id")), []) if uid > 0],
            ])
            chunks.append(ProtoField(1, 2, info))
        for row in state.get("lent") or []:
            uid = parse_int(row.get("borrower_player_id"), 0)
            if uid and uid not in summary_ids:
                summary_ids.add(uid)
                chunks.append(ProtoField(2, 2, _encode_user_summary({"uid": uid, "nickname": row.get("borrower_nickname") or f"玩家{uid}"})))
        return encode_proto_fields(chunks)
    if operation in ("add", "remove"):
        return b""
    return None


def _encode_apostle_apply(entry: dict) -> bytes:
    return encode_proto_fields([
        ProtoField(1, 0, parse_int(entry.get("borrower_player_id") or entry.get("uid"), 0)),
        ProtoField(2, 0, _numeric_hero_id(entry.get("hero_id"))),
        ProtoField(3, 0, parse_timestamp(entry.get("requested_at"), current_server_timestamp())),
        ProtoField(4, 0, max(1, parse_int(entry.get("tid") or entry.get("hero_tid"), 102))),
    ])


def _build_apostle_reply_payload(operation: str, transaction: dict) -> bytes | None:
    state = (transaction or {}).get("apostle") or {}
    if operation == "open_handle_apply_panel":
        chunks = []
        for row in state.get("lent") or []:
            pair = encode_proto_fields([ProtoField(1, 0, _numeric_hero_id(row.get("hero_id"))), ProtoField(2, 0, parse_int(row.get("borrower_player_id"), 0))])
            chunks.append(ProtoField(1, 2, pair))
        chunks.extend(ProtoField(2, 2, _encode_apostle_apply(row)) for row in state.get("received_applies") or [])
        return encode_proto_fields(chunks)
    if operation == "open_apostle_panel":
        chunks = []
        for row in state.get("applies") or []:
            owner_uid = parse_int(row.get("owner_player_id"), 0)
            apply = encode_proto_fields([
                ProtoField(1, 0, owner_uid), ProtoField(2, 2, _encode_social_hero(row)),
                ProtoField(3, 0, parse_timestamp(row.get("requested_at"), current_server_timestamp())),
            ])
            chunks.append(ProtoField(1, 2, apply))
        for row in state.get("own_heroes") or []:
            summary = encode_proto_fields([
                ProtoField(1, 0, max(1, parse_int(row.get("hero_id") or row.get("tid"), 1))),
                ProtoField(2, 0, max(1, parse_int(row.get("tid"), 1))),
                ProtoField(3, 0, max(1, parse_int(row.get("quality"), 1))),
                ProtoField(6, 0, 1 if row.get("is_lent") else 0),
            ])
            chunks.append(ProtoField(2, 2, summary))
        chunks.append(ProtoField(3, 0, max(0, parse_int(state.get("got_friend_coins"), 0))))
        return encode_proto_fields(chunks)
    if operation == "req_friend_heroes":
        chunks = []
        for row in transaction.get("friend_heroes") or []:
            info = encode_proto_fields([
                ProtoField(1, 0, parse_int(row.get("uid"), 0)), ProtoField(2, 2, _encode_social_hero(row)),
                ProtoField(3, 0, max(0, parse_int(row.get("apply_cnt"), 0))), ProtoField(4, 0, max(0, parse_int(row.get("borrower"), 0))),
            ])
            chunks.append(ProtoField(1, 2, info))
        return encode_proto_fields(chunks)
    if operation in ("apply", "cancel_apply", "return_hero"):
        return b""
    if operation == "handle_apply":
        chunks = []
        for row in transaction.get("lend_heroes") or []:
            pair = encode_proto_fields([ProtoField(1, 0, _numeric_hero_id(row.get("hero_id"))), ProtoField(2, 0, parse_int(row.get("borrower_player_id"), 0))])
            chunks.append(ProtoField(1, 2, pair))
        chunks.append(ProtoField(2, 0, max(0, parse_int(state.get("got_friend_coins"), 0))))
        return encode_proto_fields(chunks)
    return None


def _build_rank_board_reply_payload(transaction: dict) -> bytes:
    chunks = []
    for row in (transaction or {}).get("entries") or []:
        fields = [ProtoField(1, 0, max(1, parse_int(row.get("rank"), 1)))]
        if row.get("guild_id") and not row.get("uid"):
            guild = encode_proto_fields([
                ProtoField(1, 0, parse_int(row.get("guild_id"), 0)), ProtoField(2, 0, 1),
                ProtoField(3, 2, str(row.get("guild_name") or "本地公会").encode("utf-8")),
                ProtoField(4, 0, 1), ProtoField(5, 0, 1), ProtoField(8, 0, max(1, parse_int(row.get("level"), 1))),
                ProtoField(9, 0, 1), ProtoField(10, 0, max(0, parse_int(row.get("member_count"), 0))),
            ])
            fields.append(ProtoField(5, 2, guild))
        else:
            fields.append(ProtoField(2, 2, _encode_user_summary(row)))
        fields.extend((ProtoField(3, 0, max(0, parse_int(row.get("point"), 0))), ProtoField(4, 0, 0)))
        chunks.append(ProtoField(1, 2, encode_proto_fields(fields)))
    chunks.extend((ProtoField(2, 0, max(0, parse_int((transaction or {}).get("self_rank"), 0))), ProtoField(3, 0, max(0, parse_int((transaction or {}).get("self_point"), 0))), ProtoField(4, 0, max(0, parse_int((transaction or {}).get("count"), 0)))))
    return encode_proto_fields(chunks)


def _build_chat_reply_payload(operation: str, transaction: dict) -> bytes | None:
    if operation == "open_panel":
        channels = transaction.get("channels") or [1, 2, 3]
        return encode_proto_fields([
            ProtoField(1, 0, max(1, parse_int(transaction.get("channel"), 1))), ProtoField(2, 0, 1),
            *[ProtoField(3, 2, encode_proto_fields([ProtoField(1, 0, int(channel)), ProtoField(2, 0, 1)])) for channel in channels],
        ])
    return None


def _build_homeland_friend_reply_payload(operation: str, transaction: dict) -> bytes | None:
    """Build the concrete friend/building graph consumed by legacy Homeland UI."""
    social = (transaction or {}).get("social_friends") or {}
    entries = [*(social.get("friends") or []), *(social.get("bot_friends") or [])]
    entry = dict(entries[0]) if entries else {
        "uid": 9_100_001,
        "nickname": "家园访客",
        "avatar": "avatar:102",
        "level": 240,
        "power": 6_548,
        "cur_stage": 3660,
    }
    if _social_uid(entry) <= 0:
        entry["uid"] = 9_100_001

    # homeland_friend: user_summary + relation(friend).
    summary = _encode_user_summary(entry) + encode_length_delimited_field(
        32,
        b"".join((
            encode_varint_field(1, 0),
            encode_varint_field(2, current_server_timestamp()),
        )),
    )
    friend = b"".join((
        encode_length_delimited_field(1, summary),
        encode_varint_field(2, _enum_value("t_social_relation", "friend")),
    ))

    # A non-empty building list is required: the protobuf runtime leaves an
    # absent repeated field undefined and homelandModel.init iterates .length.
    room = b"".join((
        encode_varint_field(1, 1),
        encode_varint_field(2, 1),
        encode_varint_field(3, 3),
        encode_varint_field(7, 0),
        encode_varint_field(8, 0),
    ))
    building = b"".join((
        encode_varint_field(1, 1),
        encode_length_delimited_field(2, room),
    ))

    if operation == "open_panel":
        return b"".join((
            encode_length_delimited_field(1, friend),
            encode_varint_field(2, 0),
        ))
    if operation in ("visit", "view", "look_around"):
        return b"".join((
            encode_length_delimited_field(1, friend),
            encode_length_delimited_field(2, building),
        ))
    if operation == "view_log":
        return b""
    if operation == "open_rank_board":
        return encode_length_delimited_field(1, friend)
    return None


def _build_medal_reply_payload(operation: str) -> bytes | None:
    if operation not in ("open_panel", "query_diy_board"):
        return None
    # The official client always dereferences all four honor counters while
    # constructing the personal profile.  An absent repeated field decodes to
    # an empty list and crashes initHonorPage before the loading view closes.
    # t_medal_honor: avatar=1, frame=3, medal=4, skin=5.
    honors = []
    for honor_type in (1, 3, 4, 5):
        honor = b"".join((
            encode_varint_field(1, honor_type),
            encode_varint_field(2, 0),
        ))
        honors.append(encode_length_delimited_field(3, honor))
    return b"".join(honors)


def _build_account_reply_payload(operation: str, transaction: dict) -> bytes | None:
    if operation != "query_account":
        return None
    projection = transaction.get("wire_projection") or {}
    uid = int(projection.get("uid") or projection.get("user_id") or 10001)
    name = str(projection.get("name") or "本地玩家")
    level = max(1, int(projection.get("level") or 240))
    classic_user = b"".join((
        encode_varint_field(1, uid), encode_varint_field(2, 1),
        encode_length_delimited_field(3, name.encode("utf-8")),
        encode_varint_field(4, level),
        encode_length_delimited_field(7, b"2-1"),
    ))
    classics = b"".join((
        encode_length_delimited_field(1, classic_user), encode_varint_field(2, 1),
        encode_varint_field(3, current_server_timestamp()),
        encode_length_delimited_field(4, b"global"),
    ))
    # Both objects must exist: the official callbacks directly access
    # e.classics.user and e.zd.user without guarding either parent object.
    zd = b"".join((encode_varint_field(2, 1), encode_length_delimited_field(4, b"global")))
    return b"".join((encode_length_delimited_field(1, classics), encode_length_delimited_field(2, zd)))


def _build_guild_manor_reply_payload(operation: str, transaction: dict) -> bytes | None:
    """Build the non-null manor objects dereferenced by the classic client.

    The generated-schema fallback only emitted the required result field for
    open_panel.  The 1.201 client immediately reads both seasonal info objects
    and keeps the RPC/loading gate open when either object is absent.
    """
    guild_action = transaction.get("guild_action") or {}
    action = guild_action if isinstance(guild_action, dict) else {}
    now = current_server_timestamp()
    if operation == "open_panel":
        guild_wrapper = build_guild_info_payload(
            int(action.get("guild_id") or 1), action=action
        )
        guild_info = get_proto_bytes(parse_proto_fields(guild_wrapper), 2) or encode_proto_fields([
            ProtoField(2, 2, b"\xe6\x9c\xac\xe5\x9c\xb0\xe5\x85\xac\xe4\xbc\x9a"),
            ProtoField(11, 0, now), ProtoField(13, 0, 1), ProtoField(14, 0, 0),
            ProtoField(15, 0, 1),
        ])
        members = action.get("members") or list(
            ((action.get("guild_document") or {}).get("members") or {}).values()
        )
        # Put every current member on a valid settleable block.  This is only
        # the manor layout projection; membership remains authoritative in the
        # shared guild document.
        blocks = []
        settleable = (4, 8, 9, 10, 11, 12, 13, 14, 16, 18)
        current_player_uid = str(transaction.get("current_player_uid") or "")
        for index, member in enumerate(members[: len(settleable)]):
            is_current_player = bool(
                current_player_uid and str(member.get("uid") or "") == current_player_uid
            )
            blocks.append(ProtoField(4, 2, encode_proto_fields([
                ProtoField(1, 0, settleable[index]),
                ProtoField(2, 2, build_bot_user_summary({
                    **member,
                    # reply_user.uid in the fixed Classic login template is
                    # 211123.  The local DB uses string UIDs, so project the
                    # active member to that protocol identity and keep hashes
                    # only for the other guild members.
                    "bot_id": 211123 if is_current_player else member.get("uid") or member.get("id") or index + 1,
                    "nickname": member.get("name") or member.get("nickname") or f"Member {index + 1}",
                    "guild_id": int(action.get("guild_id") or 1),
                    "guild_name": str((action.get("guild") or {}).get("name") or "\u672c\u5730\u516c\u4f1a"),
                    "guild_role": protocol_guild_role(member.get("role") or 1),
                })),
                ProtoField(3, 0, 1),
            ])))
        manor_user = encode_proto_fields([
            ProtoField(1, 2, build_cd_payload(31, 3)),
            ProtoField(2, 2, build_cd_payload(32, 3)),
        ])
        inactive_season = encode_proto_fields([
            ProtoField(1, 0, 0), ProtoField(2, 0, 0), ProtoField(3, 0, 0),
        ])
        panel = encode_proto_fields([
            ProtoField(1, 0, 1), ProtoField(2, 2, guild_info),
            ProtoField(3, 2, manor_user), *blocks,
            ProtoField(5, 2, encode_proto_fields([ProtoField(1, 0, 1), ProtoField(2, 0, 1)])),
            ProtoField(5, 2, encode_proto_fields([ProtoField(1, 0, 2), ProtoField(2, 0, 1)])),
            ProtoField(5, 2, encode_proto_fields([ProtoField(1, 0, 3), ProtoField(2, 0, 1)])),
            # These empty-but-present seasonal records are required by
            # gManorNet.req_guild_manor_open_panel in the classic client.
            ProtoField(8, 2, inactive_season), ProtoField(9, 2, inactive_season),
            ProtoField(10, 0, 0), ProtoField(11, 0, int(action.get("joined_at") or now)),
        ])
        return panel
    if operation in ("occupy_block", "exchange_block", "set_glory_statue"):
        return build_cd_payload(31 if operation == "occupy_block" else 32, 2)
    if operation == "query_glory_statue":
        return encode_proto_fields([
            ProtoField(1, 0, 1), ProtoField(2, 0, now),
        ])
    if operation == "visit":
        guild_wrapper = build_guild_info_payload(int(action.get("guild_id") or 1), action=action)
        return encode_proto_fields([
            ProtoField(1, 0, 1),
            ProtoField(2, 2, get_proto_bytes(parse_proto_fields(guild_wrapper), 2) or b""),
            ProtoField(4, 2, encode_proto_fields([ProtoField(1, 0, 1), ProtoField(2, 0, 1)])),
        ])
    return None


def _list_value(value):
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def tavern_game_action_args(request_info: dict) -> dict:
    operation = str(request_info.get("generic_operation") or "")
    payload = request_info.get("generic_payload") or {}
    scalar = int(payload.get("value") or 0)
    op_map = {
        "req_open_panel": "tavern_open",
        "req_his": "tavern_history",
        "req_open_stargazer_wanted": "tavern_open_stargazer_wanted",
        "req_wish_open_panel": "tavern_open_wish",
        "req_open_tavern": "tavern_open_dragon",
        "req_init_pick_pool": "tavern_open",
        "req_set_up_hero": "tavern_set_wishlist",
        "req_set_stargazer_wanted": "tavern_set_stargazer",
        "req_set_stargazer_id": "tavern_set_stargazer",
        "req_set_daily_pool": "tavern_set_daily_pool",
        "req_set_pick_pool": "tavern_set_pick_pool",
        "req_set_tavern_npc": "tavern_set_npc",
        "req_set_hyper_tid": "tavern_set_hyper",
        "req_set_tavern_wish_tid": "tavern_set_wish_tid",
    }
    result: dict = {"op": op_map.get(operation, "tavern_open")}
    if operation == "req_set_up_hero":
        result.update(slot_id=int(payload.get("field_1") or 0), hero_tid=int(payload.get("field_2") or 0))
    elif operation == "req_set_stargazer_wanted":
        wants = [row for row in _list_value(payload.get("field_1")) if isinstance(row, dict)]
        selected = next((row for row in wants if int(row.get("field_2") or 0) > 0), wants[0] if wants else {})
        result["hero_tid"] = int(selected.get("field_1") or 0)
    elif operation in {"req_set_stargazer_id", "req_set_pick_pool", "req_set_hyper_tid"}:
        result["hero_tid"] = scalar
    elif operation == "req_set_daily_pool":
        result["pool_id"] = scalar
    elif operation == "req_set_tavern_npc":
        result["npc_id"] = scalar
    elif operation == "req_set_tavern_wish_tid":
        result.update(pool_id=int(payload.get("field_1") or 0), hero_tid=int(payload.get("field_2") or 0))
    return result


def equip_game_action_args(request_info: dict) -> dict:
    operation = str(request_info.get("generic_operation") or "")
    payload = request_info.get("generic_payload") or {}
    result: dict = {"op": f"equip_{operation}"}
    if operation == "sell":
        result["entries"] = [
            {"id": int(row.get("field_1") or 0), "amount": int(row.get("field_2") or 1)}
            for row in _list_value(payload.get("field_1")) if isinstance(row, dict)
        ]
    elif operation == "enhance":
        result.update(hero_id=int(payload.get("field_1") or 0), index=int(payload.get("field_2") or 0))
        # The 1.201 Classic client uses AssetType=8 for equipment instances in
        # req_equip_enhance.  Older captured schemas used 3, so accept both.
        type_names = {1: "currency", 2: "item", 3: "equip", 4: "hero", 5: "chest", 8: "equip", 15: "battle_pass_exp"}
        result["assets"] = [
            {
                "type": type_names.get(int(row.get("field_1") or 0), str(row.get("field_1") or "item")),
                "id": int(row.get("field_2") or 0),
                "amount": int(row.get("field_3") or 0),
            }
            for row in _list_value(payload.get("field_3")) if isinstance(row, dict)
        ]
    elif operation in {"evolve", "refine"}:
        result.update(hero_id=int(payload.get("field_1") or 0), index=int(payload.get("field_2") or 0))
    elif operation == "confirm_refine":
        result.update(
            hero_id=int(payload.get("field_1") or 0), index=int(payload.get("field_2") or 0),
            is_accept=bool(int(payload.get("field_3") or 0)),
        )
    elif operation in {"open_resonate", "close_resonate"}:
        result.update(
            hero_id=int(payload.get("field_1") or 0),
            indexes=[int(value) for value in _list_value(payload.get("field_2"))],
        )
    elif operation == "resonate_quality":
        result.update(quality=int(payload.get("field_1") or 0), unlock_id=int(payload.get("field_2") or 0))
    elif operation == "resonate_all":
        result["value"] = bool(int(payload.get("value") or 0))
    elif operation == "repl_evolve_cost":
        result["assets"] = payload
    return result


def _build_equip_reply_payload(operation: str, transaction: dict) -> bytes:
    operation = str(operation or "")
    character = transaction.get("character") or {}
    hero_id = int((character.get("extra") or character.get("extra_json") or {}).get("hero_id") or 1)
    hero = build_character_hero_payload(character, hero_id)
    costs = transaction.get("cost") or []
    rewards = transaction.get("rewards") or []
    cost = encode_proto_fields([
        *[
            ProtoField(1, 2, build_asset_payload(row["type"], row["id"], int(row["amount"])))
            for row in costs if row.get("type") != "equip"
        ],
        *[
            ProtoField(2, 0, int(row["id"]))
            for row in costs if row.get("type") == "equip"
            for _ in range(max(1, int(row.get("amount") or 1)))
        ],
    ])
    reward = build_reward_payload(rewards)
    if operation == "sell":
        return encode_proto_fields([ProtoField(1, 2, reward), ProtoField(2, 2, cost)])
    if operation == "enhance":
        return encode_proto_fields([ProtoField(1, 2, hero), ProtoField(2, 2, cost), ProtoField(3, 2, reward)])
    if operation in {"evolve", "refine"}:
        return encode_proto_fields([ProtoField(1, 2, hero), ProtoField(2, 2, cost)])
    if operation == "confirm_refine":
        return encode_length_delimited_field(1, hero)
    if operation in {"open_resonate", "close_resonate"}:
        return hero
    if operation == "resonate_quality":
        heroes = transaction.get("characters") or ([character] if character else [])
        return encode_proto_fields([
            *[ProtoField(1, 2, build_character_hero_payload(row)) for row in heroes],
            ProtoField(2, 0, int(transaction.get("quality") or 0)),
        ])
    if operation == "resonate_all":
        heroes = transaction.get("characters") or []
        packed = encode_proto_fields([
            ProtoField(1, 2, build_character_hero_payload(row)) for row in heroes
        ])
        return zlib.compress(packed)
    if operation == "repl_evolve_cost":
        return encode_proto_fields([ProtoField(1, 2, reward), ProtoField(2, 2, cost)])
    return b""


def build_generic_protocol_reply(request_info: dict, transaction: dict | None = None) -> bytes:
    reply_type = str(request_info.get("generic_reply_type") or "bytes")
    field_number = int(request_info.get("generic_reply_operation_field") or 1)
    scalar_types = {"bool", "int32", "int64", "uint32", "uint64", "sint32", "sint64", "fixed32", "fixed64", "sfixed32", "sfixed64"}
    native_hd = bool(request_info.get("native_hd"))
    schema_messages = HD_RUNTIME_MESSAGES if native_hd else PROTOBUF_MESSAGES
    schema_enums = LATEST_PROTOBUF_ENUMS if native_hd else PROTOBUF_ENUMS
    module = str(request_info.get("generic_module") or "")
    operation = str(request_info.get("generic_operation") or "")
    transaction = dict(transaction or {})
    projection = dict(transaction.get("wire_projection") or {})
    if module == "hero_return":
        projection.update({"hero_return": 1, "pool_id": 1, "guarantee_cnt": 0, "inherit": 0, "is_acc_migrated": 0})
    elif module == "act_endless_draw":
        projection.update({"save_result": 1, "last_draw": 1, "act_id": 1, "draw_cnt": 0, "saved": 0, "reward_id": 0})
    elif module == "hundred_draw":
        projection.update({"act_id": 1, "draw_cnt": 100})
    elif module == "pet":
        projection.update({"pet_pentagram": 1, "level": max(1, int(projection.get("level", 1))), "progress": 0})
    elif module == "homeland":
        projection.update({"rec_hero": 1, "recvd_gift_times": 0, "level": max(1, int(projection.get("level", 1)))})
    elif module == "astrolabe":
        projection.update({"astrolabe": 1, "level": max(1, int(projection.get("level", 1))), "progress": 0})
    elif module in {"furniture", "act_labor_wish"}:
        projection.update({"level": max(1, int(projection.get("level", 1))), "progress": int(projection.get("progress", 0))})
    if projection:
        transaction["wire_projection"] = projection
    social_payload = None
    if request_info.get("generic_module") == "friend":
        social_payload = _build_social_friend_reply_payload(
            operation, transaction
        )
    blacklist_payload = _build_blacklist_reply_payload(operation, transaction) if module == "ublacklist" else None
    mercenary_payload = _build_mercenary_reply_payload(operation, transaction) if module == "mercenary" else None
    apostle_payload = _build_apostle_reply_payload(operation, transaction) if module == "apostle" else None
    rank_board_payload = _build_rank_board_reply_payload(transaction) if module == "rank_board" else None
    chat_payload = _build_chat_reply_payload(operation, transaction) if module == "chat" else None
    homeland_friend_payload = None
    if module == "homeland_friend":
        homeland_friend_payload = _build_homeland_friend_reply_payload(
            operation, transaction
        )
    medal_payload = None
    if request_info.get("generic_module") == "medal":
        medal_payload = _build_medal_reply_payload(
            operation
        )
    pet_payload = None
    if module == "pet" and "open" in operation:
        pet_payload = _build_pet_open_panel_reply_payload()
    pentagram_payload = None
    if module == "pentagram" and "open" in operation:
        pentagram_payload = _build_pentagram_open_panel_reply_payload()
    homeland_tavern_payload = None
    if module == "homeland_tavern":
        homeland_tavern_payload = _build_homeland_tavern_reply_payload(
            operation, transaction, request_info.get("generic_payload") or {}
        )
    dragon_tavern_payload = None
    if module == "tavern" and operation == "req_open_tavern":
        dragon_tavern_payload = _build_dragon_tavern_open_payload(transaction)
    tavern_aux_payload = _build_tavern_aux_reply_payload(operation, transaction) if module == "tavern" else None
    endless_draw_payload = None
    if module == "act_endless_draw":
        endless_draw_payload = _build_endless_draw_reply_payload(operation, transaction)
    hundred_draw_payload = None
    if module == "hundred_draw":
        hundred_draw_payload = _build_hundred_draw_reply_payload(operation, transaction)
    activity_calendar_payload = None
    if module == "activity":
        activity_calendar_payload = _build_activity_calendar_reply_payload(operation)
    account_payload = None
    if module == "acc":
        account_payload = _build_account_reply_payload(operation, transaction)
    guild_manor_payload = None
    if module == "guild_manor":
        guild_manor_payload = _build_guild_manor_reply_payload(operation, transaction)
    equip_payload = _build_equip_reply_payload(operation, transaction) if module == "equip" else None
    if equip_payload is not None:
        inner = encode_length_delimited_field(field_number, equip_payload)
    elif chat_payload is not None:
        inner = encode_length_delimited_field(field_number, chat_payload)
    elif rank_board_payload is not None:
        inner = encode_length_delimited_field(field_number, rank_board_payload)
    elif apostle_payload is not None:
        inner = encode_length_delimited_field(field_number, apostle_payload)
    elif mercenary_payload is not None:
        inner = encode_length_delimited_field(field_number, mercenary_payload)
    elif blacklist_payload is not None:
        inner = encode_length_delimited_field(field_number, blacklist_payload)
    elif guild_manor_payload is not None:
        inner = encode_length_delimited_field(field_number, guild_manor_payload)
    elif account_payload is not None:
        inner = encode_length_delimited_field(field_number, account_payload)
    elif activity_calendar_payload is not None:
        inner = encode_length_delimited_field(field_number, activity_calendar_payload)
    elif dragon_tavern_payload is not None:
        inner = encode_length_delimited_field(field_number, dragon_tavern_payload)
    elif tavern_aux_payload is not None:
        inner = encode_length_delimited_field(field_number, tavern_aux_payload)
    elif endless_draw_payload is not None:
        inner = encode_length_delimited_field(field_number, endless_draw_payload)
    elif hundred_draw_payload is not None:
        inner = encode_length_delimited_field(field_number, hundred_draw_payload)
    elif homeland_tavern_payload is not None:
        inner = encode_length_delimited_field(field_number, homeland_tavern_payload)
    elif pentagram_payload is not None:
        inner = encode_length_delimited_field(field_number, pentagram_payload)
    elif pet_payload is not None:
        inner = encode_length_delimited_field(field_number, pet_payload)
    elif medal_payload is not None:
        inner = encode_length_delimited_field(field_number, medal_payload)
    elif homeland_friend_payload is not None:
        inner = encode_length_delimited_field(field_number, homeland_friend_payload)
    elif social_payload is not None:
        inner = encode_length_delimited_field(field_number, social_payload)
    elif reply_type in scalar_types:
        inner = encode_varint_field(field_number, int(_projection_value("result", transaction or {})))
    elif reply_type in schema_enums or reply_type == "result":
        inner = encode_varint_field(field_number, _enum_value(reply_type, "success", schema_enums))
    else:
        inner = encode_length_delimited_field(
            field_number,
            _synthesize_message(
                reply_type, transaction or {}, messages=schema_messages, enums=schema_enums
            ),
        )
    if native_hd:
        native_wrapper = b"".join(
            (
                encode_varint_field(
                    1, int(request_info.get("native_hd_reply_outer_field") or 0)
                ),
                encode_length_delimited_field(2, inner),
            )
        )
        return b"".join(
            (
                encode_varint_field(1, current_server_timestamp()),
                encode_varint_field(2, int(request_info.get("seq") or 0)),
                encode_length_delimited_field(
                    LEGACY_SYNTHETIC_NATIVE_HD_RESPONSE_FIELD, native_wrapper
                ),
            )
        )
    return b"".join((
        encode_varint_field(1, current_server_timestamp()),
        encode_varint_field(2, int(request_info.get("seq") or 0)),
        encode_length_delimited_field(int(request_info["generic_reply_outer_field"]), inner),
    ))


def build_structured_sdk_login_reply(
    request_info: dict,
    templates: StructuredLoginTemplates,
) -> bytes:
    htoken = request_info.get("htoken") or templates.default_htoken
    svr_id = request_info.get("svr_id") or templates.default_svr_id
    inner_payload = b"".join(
        (
            encode_length_delimited_field(1, htoken.encode("utf-8")),
            encode_varint_field(2, int(svr_id)),
        )
    )
    return b"".join(
        (
            encode_varint_field(1, current_server_timestamp()),
            encode_varint_field(2, int(request_info["seq"])),
            encode_length_delimited_field(31, inner_payload),
        )
    )


def build_structured_reconnect_reply(
    request_info: dict,
    user_payload: bytes | None = None,
) -> bytes:
    # common/down.proto defines field 1 as repeated reply_notify (wire type 2)
    # and field 4 as new_backdoor (bool).  Encoding false in field 1 produces a
    # malformed notify entry; the client appears to reconnect, then drops the
    # socket after its 20-second recovery window.  Keep the empty notify list
    # implicit and explicitly encode new_backdoor=false in its real field.
    reconnect_fields = [ProtoField(4, 0, 0)]
    if user_payload:
        user_fields = parse_proto_fields(user_payload)
        tiny_user_fields = [
            ProtoField(1, 0, get_proto_varint(user_fields, 6) or 0),
            ProtoField(2, 0, get_proto_varint(user_fields, 7) or 0),
            # reply_tiny_user.apostle_heroes is required even when there are
            # no borrowed heroes. An empty nested message is the canonical
            # representation of that state.
            ProtoField(3, 2, b""),
        ]
        rmb_charge = get_proto_varint(user_fields, 64)
        rmb_free = get_proto_varint(user_fields, 65)
        if rmb_charge is not None:
            tiny_user_fields.append(ProtoField(4, 0, rmb_charge))
        if rmb_free is not None:
            tiny_user_fields.append(ProtoField(5, 0, rmb_free))
        reconnect_fields.append(
            ProtoField(2, 2, encode_proto_fields(tiny_user_fields))
        )
        md5_fields = []
        for type_name in ("currency", "item", "equip", "hero"):
            md5_fields.append(ProtoField(1, 2, type_name.encode("utf-8")))
        for source_number, target_number in ((8, 2), (9, 3), (10, 4), (11, 5)):
            md5_fields.extend(
                ProtoField(target_number, 2, bytes(field.value))
                for field in user_fields
                if field.number == source_number and field.wire_type == 2
            )
        reconnect_fields.append(
            ProtoField(3, 2, encode_proto_fields(md5_fields))
        )
    inner_payload = encode_proto_fields(reconnect_fields)
    return b"".join(
        (
            encode_varint_field(1, current_server_timestamp()),
            encode_varint_field(2, int(request_info["seq"])),
            encode_length_delimited_field(35, inner_payload),
        )
    )
def build_structured_login_reply(
    request_info: dict,
    templates: StructuredLoginTemplates,
    business_state: dict | None = None,
    *,
    classic_layout: bool = False,
) -> bytes:
    login_payload = build_login_payload_from_business_state(
        templates.login_payload,
        business_state,
        classic_layout=classic_layout,
    )
    return b"".join(
        (
            encode_varint_field(1, current_server_timestamp()),
            encode_varint_field(2, int(request_info["seq"])),
            encode_length_delimited_field(4, login_payload),
        )
    )


def build_structured_charge_reply(
    request_info: dict,
    templates: StructuredLoginTemplates,
    *,
    classic_layout: bool = False,
) -> bytes:
    parts = [
        encode_varint_field(1, current_server_timestamp()),
        encode_varint_field(2, int(request_info["seq"])),
    ]
    if templates.charge_has_empty_field9:
        parts.append(encode_length_delimited_field(9, b""))
    charge_payload = (
        # The captured fixture predates 1.201 and contains gift goods IDs that
        # no longer exist in ChargeGoods. Classic's initChargeData clones each
        # referenced row before checking it, so one stale ID aborts login and
        # prevents the heartbeat timer from starting. An empty native
        # open_panel is valid and leaves the current shop catalog client-side.
        encode_length_delimited_field(1, b"")
        if classic_layout
        else templates.charge_payload
    )
    parts.append(encode_length_delimited_field(32, charge_payload))
    return b"".join(parts)


def build_structured_server_push(templates: StructuredLoginTemplates) -> bytes:
    return b"".join(
        (
            encode_varint_field(1, current_server_timestamp()),
            encode_varint_field(2, 0),
            encode_length_delimited_field(9, templates.push_payload),
        )
    )


def build_structured_stage_reply(request_info: dict, templates: StructuredLoginTemplates) -> bytes:
    parts = [
        encode_varint_field(1, current_server_timestamp()),
        encode_varint_field(2, int(request_info["seq"])),
        encode_length_delimited_field(6, templates.stage_payload),
    ]
    if templates.stage_has_empty_field9:
        parts.append(encode_length_delimited_field(9, b""))
    return b"".join(parts)


def build_structured_stage_retry_reply(
    request_info: dict,
    generated_start_reply: bytes,
) -> bytes | None:
    """Project a normal campaign battle into reply_stage.retry_battle.

    Both operations carry the same required ``battle`` object, but it lives
    below reply_stage field 3 for the first team and field 9 for subsequent
    teams in this Classic protocol.
    """
    response_fields = parse_proto_fields(generated_start_reply)
    stage_payload = get_proto_bytes(response_fields, 6)
    if stage_payload is None:
        return None
    start_payload = get_proto_bytes(parse_proto_fields(stage_payload), 3)
    if start_payload is None:
        return None
    battle_payload = get_proto_bytes(parse_proto_fields(start_payload), 1)
    if battle_payload is None:
        return None
    retry_payload = encode_length_delimited_field(1, battle_payload)
    return b"".join((
        encode_varint_field(1, current_server_timestamp()),
        encode_varint_field(2, int(request_info.get("seq") or 0)),
        encode_length_delimited_field(
            6,
            encode_length_delimited_field(9, retry_payload),
        ),
    ))


def build_asset_payload(asset_type: str, asset_id: int | str, amount: int) -> bytes:
    type_id = {"currency": 1, "item": 2, "equip": 3, "hero": 4, "chest": 5, "battle_pass_exp": 15}.get(asset_type, parse_int(asset_type, 0))
    if isinstance(asset_id, str):
        asset_id = {**CURRENCY_PROTO_IDS, "vip_exp": 10000009}.get(asset_id, parse_int(asset_id, 0))
    return encode_proto_fields(
        [
            ProtoField(1, 0, type_id),
            ProtoField(2, 0, int(asset_id)),
            ProtoField(3, 0, amount),
        ]
    )


def build_asset_bundle_payload(assets: list[bytes]) -> bytes:
    return encode_proto_fields([ProtoField(1, 2, asset) for asset in assets])


def build_tavern_pool_view_payload(pool_id: int, view_id: int, cost_amount: int) -> bytes:
    return encode_proto_fields(
        [
            ProtoField(1, 0, pool_id),
            ProtoField(2, 0, view_id),
            ProtoField(3, 2, build_asset_payload("currency", "diamond", cost_amount)),
        ]
    )


def build_tavern_daily_pool_time_entries(times: dict[int, int]) -> list[ProtoField]:
    entries = [
        ProtoField(
            1,
            2,
            encode_proto_fields(
                [
                    ProtoField(1, 0, int(pool_id)),
                    ProtoField(2, 0, int(count_value)),
                ]
            ),
        )
        for pool_id, count_value in times.items()
    ]
    return [
        ProtoField(
            11,
            2,
            bytes(entry.value),
        )
        for entry in entries
    ]


def build_tavern_npc_payload() -> bytes:
    npc_entries = [
        encode_proto_fields([ProtoField(1, 0, 1), ProtoField(2, 0, 0)]),
        encode_proto_fields([ProtoField(1, 0, 2), ProtoField(2, 0, 0)]),
    ]
    return encode_proto_fields(
        [
            *[ProtoField(1, 2, npc) for npc in npc_entries],
            ProtoField(2, 0, 1),
        ]
    )


def build_tavern_open_panel_payload(tavern_state: dict | None = None) -> bytes:
    # The captured official 1.182.03 response includes both pool views and the
    # NPC block.  Keep smaller shapes available for protocol experiments, but
    # make the real captured shape the production default so the client can
    # render the summon cards and buttons.
    variant = os.environ.get("AFK_TAVERN_OPEN_PANEL_VARIANT", "full").lower()
    pool_shape = os.environ.get("AFK_TAVERN_POOL_SHAPE", "scalar").lower()
    pool_id_field = int(os.environ.get("AFK_TAVERN_POOL_ID_FIELD", "1"))
    fields: list[ProtoField] = []
    # Include the 1.201-exclusive SP and Draconis pools in addition to the
    # classic, faction, companion and Stargazer entries.
    tavern_state = tavern_state or {}
    draw_times = tavern_state.get("draw_times") or {}
    visible_pool_ids = (1, 6, 7, 5, 12, 14, 15, 23, 24, 25, 26, 27, 28, 29, 30)
    for pool_id in visible_pool_ids:
        if variant == "scalar_pools" or pool_shape == "scalar":
            fields.append(ProtoField(1, 0, pool_id))
        else:
            fields.append(ProtoField(1, 2, encode_proto_fields([ProtoField(pool_id_field, 0, pool_id)])))
    # The HD client unlocks Stargazer by summing completed draws in the normal,
    # faction and choice pools.  Omitting this map renders the counter as 0/550
    # even when the server-side test account is fully graduated.
    for pool_id in visible_pool_ids:
        fields.append(
            ProtoField(
                2,
                2,
                encode_proto_fields(
                    [ProtoField(1, 0, pool_id), ProtoField(2, 0, int(draw_times.get(str(pool_id), 0)))]
                ),
            )
        )
    if variant == "bare":
        fields.extend(
            [
                ProtoField(3, 0, 1),
                ProtoField(4, 0, 0),
            ]
        )
        return encode_proto_fields(fields)
    fields.extend(
        [
            ProtoField(3, 0, 2),
            ProtoField(4, 0, 0),
            ProtoField(7, 0, 5),
            ProtoField(8, 0, int(tavern_state.get("stargazer_id") or 22)),
            ProtoField(9, 0, int(tavern_state.get("amazing_point") or 0)),
            ProtoField(10, 0, int(tavern_state.get("daily_pool") or 5)),
            *build_tavern_daily_pool_time_entries({pool_id: int(draw_times.get(str(pool_id), 0)) for pool_id in visible_pool_ids}),
            ProtoField(15, 0, 1),
            # Classic 1.182 field 16 projects by name to HD 1.201 field 15.
            # A concrete target is required for the HyperGacha/SP page.
            ProtoField(16, 0, int(tavern_state.get("hyper_tid") or 124)),
        ]
    )
    if variant in {"pool", "full"}:
        fields.extend(
            [
                ProtoField(5, 2, build_tavern_pool_view_payload(7, 3, 30000)),
                ProtoField(5, 2, build_tavern_pool_view_payload(7, 4, 30000)),
            ]
        )
    if variant in {"npc", "full"}:
        fields.append(ProtoField(13, 2, build_tavern_npc_payload()))
    return encode_proto_fields(fields)


def build_structured_tavern_open_panel_reply(request_info: dict, tavern_state: dict | None = None) -> bytes:
    return b"".join(
        (
            encode_varint_field(1, current_server_timestamp()),
            encode_varint_field(2, int(request_info["seq"])),
            encode_length_delimited_field(9, b""),
            encode_length_delimited_field(
                13,
                encode_length_delimited_field(1, build_tavern_open_panel_payload(tavern_state)),
            ),
        )
    )


def build_tavern_hero_payload(hero: dict | None = None) -> bytes:
    hero = hero or TAVERN_SINGLE_DRAW_RULE["reward_hero"]
    return encode_proto_fields(
        [
            ProtoField(1, 0, int(hero["id"])),
            ProtoField(2, 0, int(hero["tid"])),
            ProtoField(3, 0, int(hero["quality"])),
            ProtoField(4, 0, int(hero["rank"])),
            ProtoField(5, 0, int(hero["level"])),
            ProtoField(6, 0, int(hero["gs"])),
            ProtoField(8, 0, int(hero.get("artifact_lv", 0))),
            ProtoField(9, 0, int(bool(hero.get("locked", False)))),
            ProtoField(12, 0, int(hero.get("pentagram_lv", 0))),
            ProtoField(19, 0, int(bool(hero.get("cross_key_used", False)))),
        ]
    )


def build_tavern_draw_payload(draw_result: dict | None = None, count: int = 1) -> bytes:
    reply_draw = ((draw_result or {}).get("reply_tavern") or {}).get("draw") or {}
    reply_reward = reply_draw.get("reward") or {}
    heroes = reply_reward.get("heroes")
    if heroes is None:
        heroes = [TAVERN_SINGLE_DRAW_RULE["reward_hero"]]
    assets = reply_reward.get("assets") or []
    reward_payload = encode_proto_fields(
        [
            *[
                ProtoField(
                    1,
                    2,
                    build_asset_payload(
                        str(asset.get("type", "item")),
                        asset.get("id", 0),
                        int(asset.get("amount", 1)),
                    ),
                )
                for asset in assets
            ],
            *[ProtoField(3, 2, build_tavern_hero_payload(hero)) for hero in heroes],
        ]
    )
    cost = ((reply_draw.get("cost") or {}).get("assets") or [
        {
            "type": "item",
            "id": TAVERN_DRAW_COST_ITEM_ID,
            "amount": TAVERN_DRAW_COST_AMOUNT * count,
        }
    ])[0]
    cost_payload = build_asset_bundle_payload(
        [
            build_asset_payload(
                str(cost.get("type", "item")),
                cost.get("id", TAVERN_DRAW_COST_ITEM_ID),
                int(cost.get("amount", TAVERN_DRAW_COST_AMOUNT * count)),
            ),
        ]
    )
    return encode_proto_fields(
        [
            ProtoField(1, 2, reward_payload),
            ProtoField(2, 2, cost_payload),
            ProtoField(3, 0, int(TAVERN_SINGLE_DRAW_RULE["likability"]) * count),
            # reply_tavern_draw field 4 is repeated reply_tavern_his; the
            # cumulative amazing-point counter is field 5 in down.proto.
            ProtoField(5, 0, int(TAVERN_SINGLE_DRAW_RULE["amazing_point"]) * count),
        ]
    )


def build_structured_tavern_draw_reply(request_info: dict, draw_result: dict | None = None) -> bytes:
    count = int(request_info.get("draw_count") or 1)
    return b"".join(
        (
            encode_varint_field(1, current_server_timestamp()),
            encode_varint_field(2, int(request_info["seq"])),
            encode_length_delimited_field(9, b""),
            encode_length_delimited_field(
                13,
                encode_length_delimited_field(2, build_tavern_draw_payload(draw_result, count=count)),
            ),
        )
    )


def build_structured_task_batch_claim_reply(request_info: dict) -> bytes:
    ids = [int(value) for value in request_info.get("task_ids") or []]
    batch_payload = encode_proto_fields(
        [ProtoField(1, 0, 0), *[ProtoField(2, 0, task_id) for task_id in ids]]
    )
    task_payload = encode_length_delimited_field(8, batch_payload)
    return encode_proto_fields(
        [
            ProtoField(1, 0, current_server_timestamp()),
            ProtoField(2, 0, int(request_info["seq"])),
            ProtoField(9, 2, b""),
            ProtoField(13, 2, task_payload),
        ]
    )


def build_structured_hero_upgrade_reply(
    request_info: dict, transaction: dict | None = None
) -> bytes:
    rule = HERO_UPGRADE_RULE
    reply = ((transaction or {}).get("reply_unit") or {}).get("reply_up_level") or {}
    character = reply.get("new_hero") or {}
    extra = character.get("extra") or character.get("extra_json") or {}
    hero_id = int(extra.get("hero_id", request_info.get("hero_id") or rule["hero_id"]))
    hero_payload = encode_proto_fields(
        [
            ProtoField(1, 0, hero_id),
            ProtoField(2, 0, int(extra.get("tid", rule["tid"]))),
            ProtoField(3, 0, int(extra.get("quality", rule["quality"]))),
            ProtoField(4, 0, int(extra.get("rank", rule["rank"]))),
            ProtoField(5, 0, int(character.get("level", rule["to_level"]))),
            ProtoField(6, 0, int(extra.get("gs", rule["gs"]))),
            ProtoField(8, 0, 0),
            ProtoField(9, 0, 0),
            ProtoField(12, 0, 0),
            ProtoField(19, 0, 0),
        ]
    )
    cost_payload = build_asset_bundle_payload(
        [
            build_asset_payload(cost["type"], cost["id"], int(cost["amount"]))
            for cost in ((reply.get("cost") or {}).get("assets") or rule["cost"])
        ]
    )
    up_level_payload = encode_proto_fields(
        [
            ProtoField(1, 2, hero_payload),
            ProtoField(2, 2, b""),
            ProtoField(3, 2, cost_payload),
        ]
    )
    unit_payload = encode_length_delimited_field(1, up_level_payload)
    return encode_proto_fields(
        [
            ProtoField(1, 0, current_server_timestamp()),
            ProtoField(2, 0, int(request_info["seq"])),
            ProtoField(5, 2, unit_payload),
            ProtoField(9, 2, b""),
        ]
    )


def build_character_hero_payload(
    character: dict,
    hero_id: int = 1,
    *,
    quality_cap: int | None = None,
) -> bytes:
    extra = character.get("extra") or character.get("extra_json") or {}
    if not isinstance(extra, dict):
        extra = parse_json_field(extra)
    if not isinstance(extra, dict):
        extra = {}
    quality = int(extra.get("quality", character.get("star", 1)))
    if quality_cap is not None:
        quality = min(quality, max(1, int(quality_cap)))
    fields = [
        ProtoField(1, 0, int(extra.get("hero_id", hero_id))),
        ProtoField(2, 0, int(extra.get("tid", 22))),
        ProtoField(3, 0, quality),
        ProtoField(4, 0, int(extra.get("rank", 1))),
        ProtoField(5, 0, int(character.get("level", 1))),
        ProtoField(6, 0, int(extra.get("gs", 0))),
    ]
    equips = extra.get("equips") or {}
    if isinstance(equips, list):
        equips = {index + 1: value for index, value in enumerate(equips)}
    if not isinstance(equips, dict):
        equips = {}
    for index, equip_value in equips.items():
        equip_data = equip_value if isinstance(equip_value, dict) else {"id": equip_value, "tid": equip_value}
        equip_id = int(equip_data.get("id") or equip_data.get("tid") or 0)
        equip_tid = int(equip_data.get("tid") or equip_id)
        equip_fields = [
            ProtoField(1, 0, equip_id),
            ProtoField(2, 0, equip_tid),
            ProtoField(3, 0, max(1, int(equip_data.get("amount") or 1))),
            ProtoField(5, 0, max(0, int(equip_data.get("enhance_lv") or 0))),
            ProtoField(6, 0, max(0, int(equip_data.get("enhance_exp") or 0))),
        ]
        for attr_key, attr_value in (equip_data.get("attrs") or {}).items():
            attr_entry = encode_proto_fields([
                ProtoField(1, 2, str(attr_key).encode("utf-8")),
                ProtoField(2, 0, int(attr_value)),
            ])
            equip_fields.append(ProtoField(4, 2, attr_entry))
        if equip_data.get("refine_tag") is not None:
            equip_fields.append(ProtoField(7, 0, int(equip_data["refine_tag"])))
        if equip_data.get("resonate_tid") is not None:
            equip_fields.append(ProtoField(9, 0, int(equip_data["resonate_tid"])))
        if equip_data.get("source_tid") is not None:
            equip_fields.append(ProtoField(10, 0, int(equip_data["source_tid"])))
        equip = encode_proto_fields(equip_fields)
        map_entry = encode_proto_fields([ProtoField(1, 0, int(index)), ProtoField(2, 2, equip)])
        fields.append(ProtoField(7, 2, map_entry))
    artifact_id = int(extra.get("artifact_id") or 0)
    if artifact_id > 0:
        artifact = encode_proto_fields([
            ProtoField(1, 0, artifact_id),
            ProtoField(2, 0, int(extra.get("artifact_tid") or artifact_id)),
            ProtoField(3, 0, max(0, int(extra.get("artifact_awaken_lv") or 0))),
            ProtoField(4, 0, int(extra.get("hero_id", hero_id))),
        ])
        fields.append(ProtoField(11, 2, artifact))
    fields.extend([
        ProtoField(8, 0, max(0, int(extra.get("artifact_lv") or 0))),
        ProtoField(9, 0, 1 if extra.get("locked") else 0),
        ProtoField(12, 0, max(0, int(extra.get("pentagram_lv") or 0))),
    ])
    signature_level = max(0, int(extra.get("signature_level") or 0))
    if signature_level > 0:
        fields.append(ProtoField(13, 2, encode_varint_field(1, signature_level)))
    if extra.get("skin") is not None:
        fields.append(ProtoField(15, 0, max(0, int(extra.get("skin") or 0))))
    for furniture_value in extra.get("furnitures") or []:
        furniture_data = furniture_value if isinstance(furniture_value, dict) else {"id": furniture_value, "tid": furniture_value}
        furniture_id = int(furniture_data.get("id") or furniture_data.get("tid") or 0)
        furniture_tid = int(furniture_data.get("tid") or furniture_id)
        fields.append(ProtoField(17, 2, encode_proto_fields([
            ProtoField(1, 0, furniture_id),
            ProtoField(2, 0, furniture_tid),
            ProtoField(3, 0, max(0, int(furniture_data.get("lv") or 0))),
            *([ProtoField(4, 0, int(furniture_data["hero_race_tag"]))] if furniture_data.get("hero_race_tag") is not None else []),
            *([ProtoField(5, 0, int(furniture_data["astrolabe_tag"]))] if furniture_data.get("astrolabe_tag") is not None else []),
            *([ProtoField(6, 0, int(furniture_data["hero_tag"]))] if furniture_data.get("hero_tag") is not None else []),
        ])))
    if extra.get("infinite_amulet") is not None:
        fields.append(ProtoField(23, 0, max(0, int(extra.get("infinite_amulet") or 0))))
    totem_node_lvs = extra.get("totem_node_lvs") or {}
    if isinstance(totem_node_lvs, dict):
        for node_id, node_level in totem_node_lvs.items():
            fields.append(ProtoField(22, 2, encode_proto_fields([
                ProtoField(1, 0, int(node_id)),
                ProtoField(2, 0, max(0, int(node_level))),
            ])))
    return encode_proto_fields(fields)


def build_artifact_payload(artifact_id: int, hero_ids: list[int] | None = None) -> bytes:
    artifact_id = max(1, int(artifact_id or 1))
    return encode_proto_fields([
        ProtoField(1, 0, artifact_id), ProtoField(2, 0, artifact_id), ProtoField(3, 0, 0),
        *[ProtoField(4, 0, int(value)) for value in (hero_ids or []) if int(value) > 0],
    ])


def build_mitama_unit_payload(mitama_id: int, hero_ids: list[int] | None = None) -> bytes:
    mitama_id = max(1, int(mitama_id or 1))
    return encode_proto_fields([
        ProtoField(1, 0, mitama_id), ProtoField(2, 0, mitama_id), ProtoField(3, 0, 1),
        ProtoField(5, 0, 0), ProtoField(6, 0, 0),
        *[ProtoField(7, 0, int(value)) for value in (hero_ids or []) if int(value) > 0],
    ])


def build_extended_hero_reply(request_info: dict, action: dict | None) -> bytes:
    action = action or {}
    kind = str(request_info.get("kind") or "")
    hero_id = int(request_info.get("hero_id") or ((request_info.get("hero_ids") or [1])[0]) or 1)
    hero = build_character_hero_payload(action.get("character") or {}, hero_id)
    artifact_id = int(action.get("artifact_id") or request_info.get("artifact_id") or ((request_info.get("artifact_ids") or [1])[0]) or 1)
    mitama_id = int(request_info.get("mitama_id") or ((request_info.get("mitama_ids") or [1])[0]) or 1)
    if kind == "hero_wear_artifact":
        operation = encode_proto_fields([ProtoField(1, 2, hero), ProtoField(2, 2, build_artifact_payload(artifact_id, [hero_id]))])
        field_number = 9
    elif kind == "hero_remove_artifact":
        operation = encode_proto_fields([ProtoField(1, 2, hero), ProtoField(2, 2, build_artifact_payload(artifact_id))])
        field_number = 10
    elif kind == "hero_quality_one_key":
        cost_hero_ids = action.get("remove_characters") or request_info.get("cost_hero_ids") or []
        cost = encode_proto_fields([
            ProtoField(3, 0, int(value)) for value in cost_hero_ids if str(value).isdigit()
        ])
        operation = encode_proto_fields([ProtoField(1, 2, b""), ProtoField(2, 2, cost)])
        field_number = 11
    elif kind == "hero_query":
        operation = encode_length_delimited_field(1, hero)
        field_number = 14
    elif kind in {"hero_set_assist", "hero_totem_up"}:
        operation = b"".join((encode_length_delimited_field(1, hero), encode_length_delimited_field(2, b""), encode_length_delimited_field(3, b"")))
        field_number = 16 if kind == "hero_set_assist" else 17
    elif kind == "hero_batch_artifact_mitama":
        operation = b"".join((encode_length_delimited_field(1, hero), encode_length_delimited_field(2, build_mitama_unit_payload(mitama_id, [hero_id])), encode_length_delimited_field(3, build_artifact_payload(artifact_id, [hero_id]))))
        field_number = 18
    else:
        operation = b"".join((encode_length_delimited_field(1, hero), encode_length_delimited_field(2, build_mitama_unit_payload(mitama_id, [] if kind == "hero_remove_mitama" else [hero_id]))))
        field_number = 19 if kind == "hero_wear_mitama" else 20
    return build_system_reply(request_info, 5, encode_length_delimited_field(field_number, operation))


def build_hero_growth_reply(request_info: dict, action: dict | None) -> bytes:
    action = action or {}
    hero = build_character_hero_payload(action.get("character") or {}, int(request_info.get("hero_id") or 1))
    cost = encode_proto_fields([ProtoField(3, 0, int(hero_id)) for hero_id in request_info.get("cost_hero_ids") or []])
    unit_info = encode_proto_fields([ProtoField(1, 2, hero), ProtoField(2, 2, b""), ProtoField(3, 2, cost)])
    kind = request_info.get("kind")
    if kind == "hero_up_quality":
        unit_payload = encode_length_delimited_field(2, encode_length_delimited_field(1, unit_info))
    else:
        field_number = {
            "hero_wear_equip": 3,
            "hero_remove_equip": 4,
            "hero_remove_all_equips": 5,
            "hero_wear_best_equip": 6,
            "hero_lock": 7 if bool(request_info.get("locked")) else 8,
        }.get(kind, 3)
        unit_payload = encode_length_delimited_field(field_number, unit_info)
    return build_system_reply(request_info, 5, unit_payload)


def build_structured_quick_idle_reply(request_info: dict, transaction: dict | None = None) -> bytes:
    # reply_stage.quick_idle is declared in the recovered official down.proto:
    # repeated misc_reward rewards=1, required cost cost=2, required cd cd=3.
    assets = (transaction or {}).get("assets") or []
    reward_payload = build_asset_bundle_payload(
        [
            build_asset_payload(asset["type"], asset["id"], int(asset["amount"]))
            for asset in assets
        ]
    )
    misc_reward_payload = encode_proto_fields(
        [ProtoField(1, 0, 1), ProtoField(2, 2, reward_payload)]
    )
    now = current_server_timestamp()
    cd_payload = encode_proto_fields(
        [
            ProtoField(1, 0, 13),
            ProtoField(2, 0, 1),
            ProtoField(3, 0, now),
            ProtoField(4, 0, now),
        ]
    )
    quick_payload = encode_proto_fields(
        [
            ProtoField(1, 2, misc_reward_payload),
            ProtoField(2, 2, b""),
            ProtoField(3, 2, cd_payload),
        ]
    )
    stage_payload = encode_length_delimited_field(5, quick_payload)
    return encode_proto_fields(
        [
            ProtoField(1, 0, current_server_timestamp()),
            ProtoField(2, 0, int(request_info["seq"])),
            ProtoField(6, 2, stage_payload),
            ProtoField(9, 2, b""),
        ]
    )


def build_idle_payload(idle: dict | None = None) -> bytes:
    idle = idle or {}
    now = current_server_timestamp()
    fields = [
        ProtoField(1, 0, int(idle.get("end_ts", now))),
        *[ProtoField(2, 0, int(value)) for value in idle.get("left_secs") or []],
        ProtoField(3, 0, int(idle.get("end_ts", now))),
        *[
            ProtoField(
                4,
                2,
                build_asset_payload(asset["type"], asset["id"], int(asset["amount"])),
            )
            for asset in idle.get("assets") or []
        ],
        ProtoField(5, 0, int(idle.get("start_ts", now))),
        ProtoField(7, 2, b""),
    ]
    return encode_proto_fields(fields)


def build_structured_idle_query_reply(request_info: dict, idle: dict | None = None) -> bytes:
    stage_payload = encode_length_delimited_field(1, build_idle_payload(idle))
    return encode_proto_fields(
        [
            ProtoField(1, 0, current_server_timestamp()),
            ProtoField(2, 0, int(request_info["seq"])),
            ProtoField(6, 2, stage_payload),
            ProtoField(9, 2, b""),
        ]
    )


def build_structured_hd_idle_query_reply(
    request_info: dict, idle: dict | None = None
) -> bytes:
    """Build the HD-only deep-stage idle query through the legacy envelope."""
    # ``chest`` is a server-side reward macro and is explicitly forbidden in a
    # down-protocol asset. Production expands it into concrete item/equip rows;
    # until the local loot table does that, omit the macro so HD's trophy icon
    # factory never receives a non-display asset type.
    hd_idle = dict(idle or {})
    hd_idle["assets"] = [
        asset
        for asset in hd_idle.get("assets") or []
        if asset.get("type") != "chest"
    ]
    new_idle = project_proto_message(
        build_idle_payload(hd_idle),
        "idle",
        "idle",
        LEGACY_PROTO_DEFS,
        NEW_PROTO_DEFS,
    )
    normal_idle = encode_proto_fields(
        set_proto_varint(parse_proto_fields(new_idle), 1, 1)
    )
    deep_idle = encode_proto_fields(
        set_proto_varint(parse_proto_fields(new_idle), 1, 2)
    )
    query_reply = encode_proto_fields(
        [
            ProtoField(1, 2, normal_idle),
            ProtoField(2, 2, deep_idle),
            ProtoField(
                3,
                2,
                synthesize_required_proto_message(
                    "reply_hamper_info", NEW_PROTO_DEFS
                ),
            ),
        ]
    )
    stage_payload = encode_proto_fields(
        [
            ProtoField(
                LEGACY_SYNTHETIC_STAGE_QUERY_IDLE_FIELD,
                2,
                query_reply,
            )
        ]
    )
    return encode_proto_fields(
        [
            ProtoField(1, 0, current_server_timestamp()),
            ProtoField(2, 0, int(request_info["seq"])),
            ProtoField(6, 2, stage_payload),
            ProtoField(9, 2, b""),
        ]
    )


def build_structured_hd_assist_stage_reply(request_info: dict) -> bytes:
    operation_field = int(request_info.get("assist_operation_field") or 1)
    reply_definition = NEW_PROTO_DEFS["reply_assist_stage"]
    reply_field = reply_definition["by_number"].get(operation_field)
    if reply_field is None:
        operation_field = 1
        reply_field = reply_definition["by_number"][operation_field]
    reply_type = reply_field["type"]
    if reply_type in NEW_PROTO_DEFS:
        operation_payload = ProtoField(
            operation_field,
            2,
            synthesize_required_proto_message(reply_type, NEW_PROTO_DEFS),
        )
    else:
        operation_payload = ProtoField(operation_field, 0, 1)
    return encode_proto_fields(
        [
            ProtoField(1, 0, current_server_timestamp()),
            ProtoField(2, 0, int(request_info["seq"])),
            ProtoField(
                LEGACY_SYNTHETIC_ASSIST_STAGE_RESPONSE_FIELD,
                2,
                encode_proto_fields([operation_payload]),
            ),
            ProtoField(9, 2, b""),
        ]
    )


def build_structured_idle_claim_reply(
    request_info: dict, transaction: dict | None = None
) -> bytes:
    transaction = transaction or {}
    misc_rewards = []
    for asset in transaction.get("assets") or []:
        reward = build_asset_bundle_payload(
            [build_asset_payload(asset["type"], asset["id"], int(asset["amount"]))]
        )
        misc_rewards.append(
            ProtoField(
                1,
                2,
                encode_proto_fields([ProtoField(1, 0, 1), ProtoField(2, 2, reward)]),
            )
        )
    now = current_server_timestamp()
    idle = {
        "start_ts": now,
        "end_ts": now,
        "assets": [],
    }
    draw_payload = encode_proto_fields(
        [*misc_rewards, ProtoField(2, 2, build_idle_payload(idle))]
    )
    stage_payload = encode_length_delimited_field(2, draw_payload)
    return encode_proto_fields(
        [
            ProtoField(1, 0, now),
            ProtoField(2, 0, int(request_info["seq"])),
            ProtoField(6, 2, stage_payload),
            ProtoField(9, 2, b""),
        ]
    )


def build_system_reply(request_info: dict, outer_field: int, payload: bytes) -> bytes:
    return encode_proto_fields(
        [
            ProtoField(1, 0, current_server_timestamp()),
            ProtoField(2, 0, int(request_info["seq"])),
            ProtoField(outer_field, 2, payload),
            ProtoField(9, 2, b""),
        ]
    )


def build_error_reply(request_info: dict, error: str) -> bytes:
    localized_errors = {
        "no_friend_request_created": "对方已在黑名单中，或好友申请已存在",
        "social_interaction_blocked": "对方已在黑名单中",
        "friend_not_accepted": "对方还不是你的好友",
        "friend_gift_already_sent": "今日已经赠送过友情点",
        "friend_gift_not_available": "当前没有可领取的友情点",
        "mercenary_already_requested_this_week": "本周已经申请过该佣兵",
        "mercenary_use_limit": "该佣兵本周使用次数已用完",
    }
    message = localized_errors.get(str(error), str(error or "请求失败"))
    return encode_proto_fields([
        ProtoField(1, 0, current_server_timestamp()),
        ProtoField(2, 0, int(request_info.get("seq") or 0)),
        ProtoField(3, 2, encode_length_delimited_field(1, message.encode("utf-8"))),
        ProtoField(9, 2, b""),
    ])


def build_reward_payload(assets: list[dict] | None = None) -> bytes:
    return build_asset_bundle_payload(
        [build_asset_payload(row["type"], row["id"], int(row["amount"])) for row in (assets or [])]
    )


def build_misc_reward_payload(assets: list[dict] | None = None, reward_type: int = 1) -> bytes:
    """Encode common.proto misc_reward, not its nested reward directly."""
    return encode_proto_fields(
        [ProtoField(1, 0, int(reward_type)), ProtoField(2, 2, build_reward_payload(assets))]
    )


def build_cd_payload(cd_id: int, cur_point: int = 0) -> bytes:
    now = current_server_timestamp()
    return encode_proto_fields(
        [ProtoField(1, 0, cd_id), ProtoField(2, 0, cur_point), ProtoField(3, 0, now), ProtoField(4, 0, now)]
    )


def build_task_system_reply(request_info: dict, action: dict | None) -> bytes:
    action = action or {}
    kind = request_info.get("kind")
    if kind == "task_info":
        info = action.get("task_info") or {}
        task_info = encode_proto_fields(
            [
                ProtoField(1, 0, int(info.get("daily_point", 0))),
                ProtoField(2, 0, int(info.get("weekly_point", 0))),
                *[ProtoField(3, 0, int(value)) for value in info.get("daily_recved_chests") or []],
                *[ProtoField(4, 0, int(value)) for value in info.get("weekly_recved_chests") or []],
                *[
                    ProtoField(5, 2, encode_proto_fields([ProtoField(1, 0, int(row["id"])), ProtoField(2, 0, int(row.get("target_progress", 0)))]))
                    for row in info.get("daily_todolists") or []
                ],
                *[
                    ProtoField(6, 2, encode_proto_fields([ProtoField(1, 0, int(row["id"])), ProtoField(2, 0, int(row.get("target_progress", 0)))]))
                    for row in info.get("weekly_todolists") or []
                ],
                *[ProtoField(8, 0, int(value)) for value in info.get("recent_daily_points") or []],
                ProtoField(9, 0, 0),
            ]
        )
        task = encode_length_delimited_field(1, task_info)
    elif kind in ("task_chest", "task_batch_chest"):
        ids = action.get("chest_ids") or request_info.get("task_ids") or []
        misc = encode_proto_fields([ProtoField(1, 0, 1), ProtoField(2, 2, build_reward_payload(action.get("rewards")))])
        chest = encode_proto_fields(
            [ProtoField(1, 0, 0 if len(ids) > 1 else int(ids[0] if ids else 0)), ProtoField(2, 2, misc), *[ProtoField(3, 0, int(value)) for value in ids]]
        )
        task = encode_length_delimited_field(8 if kind == "task_batch_chest" else 2, chest)
    elif kind in ("task_line_claim", "task_batch_line"):
        ids = action.get("ids") or request_info.get("task_ids") or []
        line = int(request_info.get("task_line") or ((request_info.get("task_lines") or [{}])[0].get("line") or 0))
        reward = encode_proto_fields(
            [ProtoField(1, 0, 0 if len(ids) > 1 else int(ids[0] if ids else 0)), ProtoField(2, 0, line), ProtoField(3, 2, build_reward_payload(action.get("rewards"))), *[ProtoField(5, 0, int(value)) for value in ids]]
        )
        if kind == "task_batch_line":
            task = b"".join(encode_length_delimited_field(9, reward) for _ in (request_info.get("task_lines") or [{}]))
        else:
            task = encode_length_delimited_field(4, reward)
    else:
        ids = action.get("ids") or request_info.get("task_ids") or []
        reward = encode_proto_fields(
            [ProtoField(1, 0, 0 if len(ids) > 1 else int(ids[0] if ids else 0)), ProtoField(3, 2, build_reward_payload(action.get("rewards"))), *[ProtoField(5, 0, int(value)) for value in ids]]
        )
        field_number = 7 if kind == "task_batch_claim" else 3
        task = encode_length_delimited_field(field_number, reward)
    return build_system_reply(request_info, 15, task)


def build_instant_charge_reply(request_info: dict, transaction: dict | None) -> bytes:
    operation_field = int(request_info.get("charge_operation_field") or 3)
    rewards = (transaction or {}).get("rewards") or []
    reward_payload = build_reward_payload(rewards)
    if operation_field in (2, 3):
        operation_payload = encode_proto_fields([ProtoField(1, 2, reward_payload), ProtoField(2, 2, b""), ProtoField(3, 0, 0)])
    elif operation_field == 4:
        operation_payload = encode_proto_fields([ProtoField(1, 0, 0), ProtoField(2, 2, reward_payload), ProtoField(3, 2, b"")])
    else:
        operation_payload = encode_proto_fields([ProtoField(1, 0, 0)])
    return build_system_reply(request_info, 32, encode_length_delimited_field(operation_field, operation_payload))


def build_sell_good_payload(row: dict) -> bytes:
    good = row.get("good") or {"type": "item", "id": 1, "amount": 1}
    cost = row.get("cost") or {"id": "gold", "amount": 0}
    currency_id = CURRENCY_PROTO_IDS.get(str(cost.get("id")), parse_int(cost.get("id"), 0))
    currency = encode_proto_fields([ProtoField(1, 0, currency_id), ProtoField(2, 0, int(cost.get("amount", 0)))])
    return encode_proto_fields(
        [
            ProtoField(1, 0, int(row.get("index", 0))),
            ProtoField(2, 2, build_asset_payload(good["type"], good["id"], int(good["amount"]))),
            ProtoField(3, 2, currency),
            ProtoField(4, 0, 0), ProtoField(5, 0, 1 if row.get("is_sold") else 0),
            ProtoField(6, 0, int(row.get("discount_pct", 100))),
            ProtoField(10, 0, int(row.get("group_tid", 0))),
        ]
    )


def build_shop_system_reply(request_info: dict, action: dict | None) -> bytes:
    action = action or {}
    kind = request_info.get("kind")
    if kind in ("shop_open", "shop_refresh"):
        shop = encode_proto_fields(
            [
                ProtoField(1, 0, int(action.get("shop_id") or request_info.get("shop_id") or 1)),
                *[ProtoField(2, 2, build_sell_good_payload(row)) for row in action.get("goods") or []],
                ProtoField(3, 2, build_cd_payload(11, 0)),
                ProtoField(4, 0, int(action.get("refresh_times", 0))),
            ]
        )
        reply = encode_length_delimited_field(3 if kind == "shop_refresh" else 1, encode_length_delimited_field(1, shop) if kind == "shop_open" else shop)
    else:
        buy = encode_proto_fields(
            [
                ProtoField(1, 2, build_reward_payload(action.get("rewards"))),
                ProtoField(2, 2, build_reward_payload(action.get("cost"))),
                ProtoField(3, 2, build_sell_good_payload(action.get("sell_good") or {})),
            ]
        )
        reply = encode_length_delimited_field(2, buy)
    return build_system_reply(request_info, 10, reply)


def build_mail_payload(row: dict) -> bytes:
    now = current_server_timestamp()
    text = encode_proto_fields(
        [
            ProtoField(1, 2, str(row.get("from", "系统")).encode()),
            ProtoField(2, 2, str(row.get("title", "邮件")).encode()),
            ProtoField(3, 2, str(row.get("body", "")).encode()),
        ]
    )
    content = encode_length_delimited_field(1, text)
    return encode_proto_fields(
        [
            ProtoField(1, 0, int(row.get("id", 0))), ProtoField(2, 0, now - 60), ProtoField(3, 0, now + 86400 * 30),
            ProtoField(4, 2, content), ProtoField(5, 0, int(row.get("status", 1))), ProtoField(6, 0, int(row.get("type_id", 0))),
            *[ProtoField(7, 2, build_asset_payload(a["type"], a["id"], int(a["amount"]))) for a in row.get("assets") or []],
            ProtoField(8, 0, 1 if row.get("is_assets_rcvd") else 0),
        ]
    )


def build_mail_system_reply(request_info: dict, action: dict | None) -> bytes:
    action = action or {}
    kind = request_info.get("kind")
    if kind == "mail_list":
        mails = action.get("mails") or []
        body = encode_proto_fields([*[ProtoField(1, 0, int(row["id"])) for row in mails], *[ProtoField(2, 2, build_mail_payload(row)) for row in mails]])
        reply = encode_length_delimited_field(1, body)
    elif kind == "mail_read":
        reply = encode_length_delimited_field(2, encode_varint_field(1, 1))
    elif kind == "mail_receive_all":
        rewards = [
            ProtoField(1, 2, encode_proto_fields([ProtoField(1, 0, int(mail["id"])), ProtoField(2, 2, build_reward_payload(mail.get("assets")))]))
            for mail in action.get("mails") or []
        ]
        reply = encode_length_delimited_field(4, encode_proto_fields(rewards))
    else:
        mail = (action.get("mails") or [{"id": request_info.get("id", 0), "assets": action.get("rewards") or []}])[0]
        reward = encode_proto_fields([ProtoField(1, 0, int(mail["id"])), ProtoField(2, 2, build_reward_payload(mail.get("assets")))])
        reply = encode_length_delimited_field(3, reward)
    return build_system_reply(request_info, 12, reply)


def _battle_numeric_hero_id(value, fallback: int) -> int:
    try:
        return max(1, int(value))
    except (TypeError, ValueError):
        return int(fallback)


def build_battle_team_from_authority(rows: list[dict] | None, id_base: int = 8_000_000) -> bytes:
    slot_heroes = []
    for index, row in enumerate(rows or [], 1):
        hero_id = _battle_numeric_hero_id(row.get("id"), id_base + index)
        hero = encode_proto_fields([
            ProtoField(1, 0, hero_id), ProtoField(2, 0, max(1, int(row.get("tid") or 1))),
            ProtoField(3, 0, max(1, int(row.get("quality") or 1))), ProtoField(4, 0, max(1, int(row.get("rank") or 1))),
            ProtoField(5, 0, max(1, int(row.get("level") or 1))),
            ProtoField(6, 0, max(1, int(float(row.get("hp") or 1) + float(row.get("atk") or 1) * 10))),
            ProtoField(8, 0, 0),
        ])
        slot_heroes.append(ProtoField(1, 2, encode_proto_fields([
            ProtoField(1, 0, max(1, int(row.get("slot") or index))), ProtoField(2, 2, hero),
        ])))
    return encode_proto_fields(slot_heroes)


def build_battle_payload(battle_type: int, param: int = 0, transaction: dict | None = None) -> bytes:
    transaction = transaction or {}
    seed = int(transaction.get("seed") or (int(time.time()) & 0xFFFFFFFF))
    common = encode_proto_fields([ProtoField(1, 0, seed), ProtoField(2, 0, int(param))])
    fields = [ProtoField(1, 0, battle_type), ProtoField(2, 2, common)]
    self_team = transaction.get("self_team") or []
    enemy_team = transaction.get("enemy_team") or []
    if self_team or enemy_team:
        battle_input = encode_proto_fields([
            *([ProtoField(1, 2, build_battle_team_from_authority(self_team, 7_000_000))] if self_team else []),
            *([ProtoField(2, 2, build_battle_team_from_authority(enemy_team, 8_000_000))] if enemy_team else []),
            ProtoField(4, 0, current_server_timestamp()),
        ])
        fields.append(ProtoField(3, 2, battle_input))
    return encode_proto_fields(fields)


def protocol_numeric_uid(value, fallback: int = 90000001) -> int:
    try:
        parsed = int(value)
        if parsed > 0: return parsed
    except (TypeError, ValueError):
        pass
    text = str(value or "")
    if not text: return int(fallback)
    return 10_000_000 + int.from_bytes(hashlib.sha256(text.encode()).digest()[:6], "little") % 9_000_000_000


def protocol_guild_role(internal_role) -> int:
    return {3: 1, 2: 2, 1: 3}.get(int(internal_role or 1), 3)


def build_bot_user_summary(bot: dict) -> bytes:
    return encode_proto_fields([
        ProtoField(1, 0, protocol_numeric_uid(bot.get("bot_id") or bot.get("opponent_uid") or bot.get("uid") or bot.get("id"))),
        ProtoField(2, 0, 1), ProtoField(3, 2, str(bot.get("nickname") or bot.get("opponent_name") or bot.get("name") or "伊索米亚守卫").encode()),
        ProtoField(4, 0, int(bot.get("level") or 1)), ProtoField(6, 2, str(bot.get("avatar") or "avatar:1").encode()),
        ProtoField(8, 2, b"CN"), ProtoField(10, 0, int(bot.get("guild_id") or 0)),
        ProtoField(11, 2, str(bot.get("guild_name") or "").encode()), ProtoField(13, 0, int(bot.get("power") or bot.get("opponent_power") or 997)),
        ProtoField(14, 0, int(bot.get("power") or bot.get("opponent_power") or 997)), ProtoField(15, 0, 0),
        ProtoField(16, 0, 1), ProtoField(18, 0, max(1, int(bot.get("level") or 1) * 5)), ProtoField(12, 0, max(1, int(bot.get("guild_role") or bot.get("role") or 3))),
        ProtoField(22, 0, int(bot.get("power") or bot.get("opponent_power") or 997)),
    ])


def build_local_arena_user(bot: dict) -> bytes:
    return encode_proto_fields([
        ProtoField(1, 2, build_bot_user_summary(bot)), ProtoField(2, 0, int(bot.get("rank") or 100)),
        ProtoField(3, 0, int(bot.get("point") or bot.get("rating") or 1000)), ProtoField(4, 0, 1),
    ])


def build_bot_lineup(bot: dict) -> bytes:
    slots = []
    for index, row in enumerate((bot or {}).get("lineup") or []):
        hero_id = int(bot.get("bot_id") or 90000001) * 10 + index + 1
        hero = encode_proto_fields([
            ProtoField(1, 0, hero_id), ProtoField(2, 0, int(row.get("tid") or 1)),
            ProtoField(3, 0, int(row.get("quality") or 1)), ProtoField(4, 0, int(row.get("rank") or 1)),
            ProtoField(5, 0, int(row.get("level") or 1)), ProtoField(6, 0, int(bot.get("power") or 997) // max(1, len(bot.get("lineup") or []))),
            ProtoField(8, 0, 0),
        ])
        slots.append(ProtoField(1, 2, encode_proto_fields([ProtoField(1, 0, int(row.get("slot") or index + 1)), ProtoField(2, 2, hero)])))
    return encode_proto_fields(slots)


def build_arena_system_reply(request_info: dict, action: dict | None) -> bytes:
    action = action or {}
    kind = request_info.get("kind")
    now = current_server_timestamp()
    if kind in ("arena_open", "arena_refresh"):
        if kind == "arena_open":
            season = encode_proto_fields([ProtoField(1, 0, 1), ProtoField(2, 0, now + 86400 * 7)])
            rankboard = [ProtoField(4, 2, build_local_arena_user(bot)) for bot in action.get("opponents") or []]
            panel = encode_proto_fields(
                [ProtoField(1, 0, int(action.get("rank", 100))), ProtoField(2, 0, int(action.get("point", 1000))), ProtoField(3, 0, 997),
                 *rankboard, ProtoField(5, 2, build_cd_payload(2, int(action.get("ticket", 5)))), ProtoField(6, 2, season), ProtoField(9, 0, 1), ProtoField(10, 0, now + 86400)]
            )
            reply = encode_length_delimited_field(1, panel)
        else:
            reply = encode_length_delimited_field(3, encode_proto_fields([ProtoField(1, 2, build_local_arena_user(bot)) for bot in action.get("opponents") or []]))
    elif kind == "arena_query_lineup":
        reply = encode_length_delimited_field(4, build_bot_lineup(action.get("opponent") or {}))
    elif kind == "arena_challenge":
        result = encode_proto_fields(
            [ProtoField(1, 0, int(action.get("battle_result", 1))), ProtoField(3, 0, int(action.get("old_point", 1000))),
             ProtoField(4, 0, int(action.get("old_rank", 100))), ProtoField(5, 0, int(action.get("point", 1010))), ProtoField(6, 0, int(action.get("rank", 99))),
             ProtoField(7, 0, 1000), ProtoField(8, 0, 990)]
        )
        challenge = encode_proto_fields([ProtoField(1, 2, build_battle_payload(3, 1)), ProtoField(2, 2, build_cd_payload(2, 4)), ProtoField(4, 2, result)])
        reply = encode_length_delimited_field(5, challenge)
    elif kind == "arena_records":
        records = [ProtoField(1, 2, encode_proto_fields([
            ProtoField(1, 0, int(row.get("timestamp") or now)), ProtoField(2, 2, build_bot_user_summary(row)),
            ProtoField(3, 0, int(row.get("opponent_power") or 997)), ProtoField(4, 0, int(row.get("result", 1))),
            ProtoField(5, 0, int(row.get("point_delta", 0))), ProtoField(6, 0, int(row.get("replay_id") or row.get("id", 1))),
            ProtoField(7, 0, 1), ProtoField(9, 0, 1),
        ])) for row in action.get("records") or []]
        reply = encode_length_delimited_field(8, encode_proto_fields(records))
    elif kind == "arena_buy_ticket":
        reply = encode_length_delimited_field(10, encode_proto_fields([
            ProtoField(1, 2, build_reward_payload(action.get("cost"))),
            ProtoField(2, 2, build_reward_payload(action.get("rewards"))),
        ]))
    else:
        reply = encode_length_delimited_field({"arena_set_defense": 2, "arena_open_chest": 7}.get(kind, 2), encode_varint_field(1, 1))
    return build_system_reply(request_info, 17, reply)


def build_tower_system_reply(request_info: dict, action: dict | None) -> bytes:
    action = action or {}
    kind = request_info.get("kind")
    tower_info = encode_proto_fields([ProtoField(1, 0, int(action.get("floor_id", 1))), ProtoField(3, 0, int(action.get("type", 1)))])
    if kind == "tower_open":
        reply = encode_length_delimited_field(1, tower_info)
    elif kind in ("tower_start", "tower_retry"):
        start = encode_length_delimited_field(1, build_battle_payload(2, int(request_info.get("floor_id") or action.get("floor_id", 1))))
        reply = encode_length_delimited_field(7 if kind == "tower_retry" else 2, start)
    elif kind == "tower_records":
        reply = encode_length_delimited_field(4, b"")
    elif kind == "tower_assists":
        reply = encode_length_delimited_field(5, b"")
    else:
        end = encode_proto_fields([ProtoField(1, 0, int(action.get("battle_result", 1))), ProtoField(2, 2, tower_info), ProtoField(3, 2, build_reward_payload(action.get("rewards")))])
        reply = encode_length_delimited_field(3, end)
    return build_system_reply(request_info, 18, reply)


def build_maze_shop_payload(shop: dict | None) -> bytes:
    shop = shop or {}
    return encode_proto_fields([
        ProtoField(1, 0, int(shop.get("id") or 1)),
        *[ProtoField(2, 2, build_sell_good_payload(good)) for good in shop.get("goods") or []],
        ProtoField(3, 2, build_cd_payload(11, 0)),
        ProtoField(4, 0, int(shop.get("refresh_times") or 0)),
    ])


def build_maze_enemy_payload(enemy_id: int, transaction: dict | None = None, defeated: bool = False) -> bytes:
    transaction = transaction or {}
    fields = [ProtoField(1, 0, max(1, int(enemy_id or 1)))]
    team = transaction.get("enemy_team") or []
    if team:
        team_payload = parse_proto_fields(build_battle_team_from_authority(team, 8_000_000))
        fields.extend(ProtoField(2, 2, bytes(field.value)) for field in team_payload if field.number == 1 and field.wire_type == 2)
    if defeated:
        fields.append(ProtoField(4, 0, 1))
    return encode_proto_fields(fields)


def build_maze_assist_hero_payload(hero: dict | None) -> bytes:
    hero = hero or {}
    hero_id = max(1, int(hero.get("id") or hero.get("hero_id") or 1))
    return encode_proto_fields([
        ProtoField(1, 0, hero_id),
        ProtoField(2, 0, max(1, int(hero.get("tid") or 22))),
        ProtoField(3, 0, max(1, int(hero.get("quality") or 8))),
        ProtoField(4, 0, max(1, int(hero.get("rank") or 10))),
        ProtoField(5, 0, max(1, int(hero.get("level") or 240))),
        ProtoField(6, 0, max(1, int(hero.get("gs") or 120000))),
        ProtoField(8, 0, max(0, int(hero.get("artifact_lv") or 0))),
    ])


def build_maze_cell_payload(cell_or_id, status: int = 0, rewards: list[dict] | None = None, transaction: dict | None = None) -> bytes:
    cell = cell_or_id if isinstance(cell_or_id, dict) else {"id": int(cell_or_id), "status": status, "assets": rewards or []}
    cell_id = int(cell.get("id") or 1)
    cell_type = int(cell.get("type_id", 5 if cell_id == 1 else 0))
    fields = [
        ProtoField(1, 0, cell_id), ProtoField(2, 0, cell_type), ProtoField(3, 0, int(cell.get("status", status))),
        *[ProtoField(4, 2, build_asset_payload(a["type"], a["id"], int(a["amount"]))) for a in (cell.get("assets") or rewards or [])],
    ]
    if cell.get("shop"):
        fields.append(ProtoField(7, 2, build_maze_shop_payload(cell.get("shop"))))
    fields.extend(ProtoField(8, 0, int(value)) for value in cell.get("heirloom_pool") or [])
    fields.extend(ProtoField(9, 0, int(value)) for value in cell.get("picked_heirlooms") or [])
    fields.extend(ProtoField(10, 2, build_maze_assist_hero_payload(hero)) for hero in cell.get("assist_heroes") or [])
    if cell.get("special_reward"):
        fields.append(ProtoField(11, 0, 1))
    if transaction and (transaction.get("enemy_team") or []):
        fields.append(ProtoField(13, 2, build_maze_enemy_payload(cell_id, transaction)))
    return encode_proto_fields(fields)


def build_maze_system_reply(request_info: dict, action: dict | None) -> bytes:
    action = action or {}
    kind = request_info.get("kind")
    now = current_server_timestamp()
    cell_id = int(action.get("cell_id", request_info.get("cell_id") or 1))
    run = action.get("maze") or {}
    cell = action.get("cell") or next((row for row in run.get("cells") or [] if int(row.get("id") or 0) == cell_id), {"id": cell_id})
    battle_transaction = request_info.get("battle_transaction") or action.get("authoritative_battle") or {}
    if kind == "maze_open":
        end_time = int(action.get("reset_at") or run.get("reset_at") or now + 86400 * 2)
        maze = encode_proto_fields([
            ProtoField(1, 0, int(run.get("uid") or 1)), ProtoField(2, 0, int(run.get("id") or 1)),
            ProtoField(3, 0, int(action.get("floor_id", run.get("floor_id") or 1))), ProtoField(4, 0, cell_id),
            ProtoField(5, 0, int(run.get("gs") or 6000)),
            # Draw upper/future rooms first and the player's nearer rooms last.
            # The classic client keeps hit targets in repeated-field insertion
            # order; an always-visible carriage two rows ahead can otherwise
            # cover the adjacent guard and make a valid route untappable.
            *[ProtoField(6, 2, build_maze_cell_payload(row)) for row in sorted(
                run.get("cells") or [cell], key=lambda item: int(item.get("id") or 0), reverse=True
            )],
            *[ProtoField(8, 0, int(value)) for value in action.get("heirlooms") or run.get("heirlooms") or []],
            *[ProtoField(9, 0, int(value)) for value in run.get("path") or []],
            ProtoField(10, 0, end_time),
            *[ProtoField(12, 2, build_maze_assist_hero_payload(hero)) for hero in run.get("assist_heroes") or []],
            ProtoField(13, 0, int(run.get("counter") or 0)),
            ProtoField(15, 0, int(action.get("map_id", run.get("map_id") or 1))), ProtoField(17, 0, 1),
            ProtoField(25, 0, int(run.get("battle_victory_times") or 0)),
        ])
        panel = encode_proto_fields([ProtoField(1, 0, 1), ProtoField(2, 2, maze), ProtoField(5, 0, end_time), ProtoField(7, 0, int(action.get("passed_times") or 0)), ProtoField(14, 0, 1)])
        reply = encode_length_delimited_field(1, panel)
    elif kind in ("maze_move", "maze_query"):
        payload = build_maze_cell_payload(cell, transaction=battle_transaction)
        if kind == "maze_query":
            preview_reward = encode_proto_fields([
                ProtoField(1, 0, 1),
                ProtoField(2, 2, build_reward_payload(action.get("rewards") or cell.get("assets") or [])),
            ])
            payload = encode_proto_fields([
                ProtoField(1, 2, payload),
                ProtoField(2, 2, preview_reward),
            ])
        reply = encode_length_delimited_field(3 if kind == "maze_move" else 2, payload)
    elif kind == "maze_start":
        reply = encode_length_delimited_field(4, encode_length_delimited_field(1, build_battle_payload(5, cell_id, battle_transaction)))
    elif kind == "maze_end":
        cell_payload = build_maze_cell_payload(cell)
        if int(action.get("battle_result", 1)) == 1:
            cell_fields = parse_proto_fields(cell_payload)
            cell_fields.append(ProtoField(13, 2, build_maze_enemy_payload(cell_id, defeated=True)))
            cell_payload = encode_proto_fields(cell_fields)
        end = encode_proto_fields([ProtoField(1, 0, int(action.get("battle_result", 1))), ProtoField(3, 2, cell_payload), *[ProtoField(4, 2, encode_proto_fields([ProtoField(1, 0, 1), ProtoField(2, 2, build_reward_payload([reward]))])) for reward in action.get("rewards") or []]])
        reply = encode_length_delimited_field(5, end)
    elif kind in ("maze_use_relic", "maze_select_heirloom"):
        relic_payload = build_maze_cell_payload(cell)
        if kind == "maze_use_relic":
            relic_fields = [ProtoField(1, 2, relic_payload)]
            if action.get("assist_hero"):
                relic_fields.append(ProtoField(3, 2, build_maze_assist_hero_payload(action.get("assist_hero"))))
            relic_payload = encode_proto_fields(relic_fields)
        reply = encode_length_delimited_field(6 if kind == "maze_use_relic" else 9, relic_payload)
    elif kind == "maze_buy":
        bought = encode_proto_fields([ProtoField(1, 2, build_maze_cell_payload(cell)), ProtoField(2, 2, build_reward_payload(action.get("rewards"))), ProtoField(3, 2, build_reward_payload(action.get("cost")))])
        reply = encode_length_delimited_field(10, bought)
    elif kind == "maze_give_up":
        reply = encode_length_delimited_field(11, build_maze_cell_payload(cell))
    elif kind == "maze_receive":
        received = encode_proto_fields([ProtoField(1, 2, build_maze_cell_payload(cell)), ProtoField(2, 2, build_reward_payload(action.get("rewards")))])
        reply = encode_length_delimited_field(13, received)
    elif kind == "maze_transmit":
        maze = encode_proto_fields([
            ProtoField(1, 0, int(run.get("uid") or 1)), ProtoField(2, 0, int(run.get("id") or 1)), ProtoField(3, 0, int(run.get("floor_id") or 1)),
            ProtoField(4, 0, int(run.get("cell_id") or cell_id)), ProtoField(5, 0, int(run.get("gs") or 6000)),
            *[ProtoField(6, 2, build_maze_cell_payload(row)) for row in sorted(
                run.get("cells") or [], key=lambda item: int(item.get("id") or 0), reverse=True
            )],
            *[ProtoField(8, 0, int(value)) for value in run.get("heirlooms") or []], *[ProtoField(9, 0, int(value)) for value in run.get("path") or []],
            ProtoField(10, 0, int(run.get("reset_at") or now + 86400 * 2)),
            *[ProtoField(12, 2, build_maze_assist_hero_payload(hero)) for hero in run.get("assist_heroes") or []],
            ProtoField(15, 0, int(run.get("map_id") or 1)), ProtoField(17, 0, 1),
        ])
        reply = encode_length_delimited_field(7, maze)
    else:
        reply = encode_length_delimited_field(3, build_maze_cell_payload(cell))
    return build_system_reply(request_info, 27, reply)


def build_guild_member_payload(row: dict, guild: dict | None = None) -> bytes:
    guild = guild or {}
    summary = build_bot_user_summary({
        **row, "bot_id": row.get("bot_id") or row.get("uid") or row.get("id"),
        "nickname": row.get("nickname") or row.get("name"), "guild_id": guild.get("guild_id") or row.get("guild_id") or 0,
        "guild_name": guild.get("name") or row.get("guild_name") or "",
        "guild_role": protocol_guild_role(row.get("role") or 1),
    })
    return encode_proto_fields([
        ProtoField(1, 2, summary), ProtoField(2, 0, int(row.get("weekly_contribution") or row.get("contribution") or 0)),
        ProtoField(3, 0, int(row.get("joined_at") or current_server_timestamp())),
    ])


def build_guild_info_payload(guild_id: int = 1, name: str = "本地冒险者公会", action: dict | None = None) -> bytes:
    action = action or {}
    guild = action.get("guild") or {}
    guild_id = int(guild.get("guild_id") or guild_id)
    name = str(guild.get("name") or name)
    now = current_server_timestamp()
    document = action.get("guild_document") or {}
    members = action.get("members") or list((document.get("members") or {}).values())
    owner_uid = document.get("owner_uid") or 1
    info = encode_proto_fields([
        ProtoField(1, 0, 1), ProtoField(2, 2, name.encode()), ProtoField(3, 0, int(guild.get("icon") or 1)),
        ProtoField(6, 0, int(guild.get("active_point") or 0)), ProtoField(7, 2, str(guild.get("notice") or "共同建设伊索米亚").encode()),
        ProtoField(9, 0, protocol_numeric_uid(owner_uid, 1)), ProtoField(10, 0, int(document.get("created_at") or now)),
        ProtoField(11, 0, int(document.get("updated_at") or now)), ProtoField(12, 0, int(guild.get("join_type") or 1)),
        ProtoField(13, 0, int(guild.get("level") or 1)), ProtoField(14, 0, int(guild.get("exp") or 0)), ProtoField(15, 0, int(guild.get("require_lv") or 1)),
    ])
    return encode_proto_fields([
        ProtoField(1, 0, guild_id), ProtoField(2, 2, info),
        *[ProtoField(3, 2, build_guild_member_payload(row, {**guild, "guild_id": guild_id})) for row in members],
        ProtoField(4, 2, encode_varint_field(1, 0)),
    ])


def build_guild_summary_payload(guild_id: int = 1, name: str = "本地冒险者公会", member_count: int = 1) -> bytes:
    return encode_proto_fields([
        ProtoField(1, 0, int(guild_id)), ProtoField(2, 0, 1), ProtoField(3, 2, str(name).encode()),
        ProtoField(4, 0, 1), ProtoField(7, 0, 1), ProtoField(8, 0, 1), ProtoField(9, 0, 1),
        ProtoField(10, 0, int(member_count)), ProtoField(11, 0, 100), ProtoField(15, 0, 1),
    ])


def build_guild_system_reply(request_info: dict, action: dict | None) -> bytes:
    action = action or {}
    kind = request_info.get("kind")
    guild_id = int(action.get("guild_id") or request_info.get("id") or 1)
    if kind == "guild_open":
        if action.get("joined"):
            open_payload = encode_length_delimited_field(1, build_guild_info_payload(guild_id, action=action))
        else:
            recommendations = encode_proto_fields([ProtoField(1, 2, build_guild_summary_payload(int(row.get("guild_id", 1)), str(row.get("name", "本地冒险者公会")), int(row.get("member_count", 0)))) for row in action.get("guilds") or [{"guild_id": 1}]])
            open_payload = encode_length_delimited_field(2, recommendations)
        reply = encode_length_delimited_field(2, open_payload)
    elif kind in ("guild_create", "guild_join", "guild_leave_and_join"):
        field = {"guild_create": 3, "guild_join": 6, "guild_leave_and_join": 30}[kind]
        reply = encode_length_delimited_field(field, build_guild_info_payload(guild_id, action=action))
    elif kind == "guild_edit":
        reply = encode_length_delimited_field(4, get_proto_bytes(parse_proto_fields(build_guild_info_payload(guild_id, action=action)), 2) or b"")
    elif kind == "guild_search":
        summaries = [ProtoField(1, 2, build_guild_summary_payload(int(row.get("guild_id", 1)), str(row.get("name", "本地冒险者公会")), int(row.get("member_count", 0)))) for row in action.get("guilds") or []]
        reply = encode_length_delimited_field(5, encode_proto_fields(summaries))
    elif kind == "guild_leave":
        reply = encode_length_delimited_field(7, encode_varint_field(1, 1))
    elif kind in ("guild_kick", "guild_approve", "guild_promote", "guild_demote", "guild_transfer"):
        field = {"guild_kick": 8, "guild_approve": 9, "guild_promote": 10, "guild_demote": 11, "guild_transfer": 12}[kind]
        reply = encode_length_delimited_field(field, build_guild_info_payload(guild_id, action=action))
    elif kind == "guild_history":
        content_ids = {"create": 1, "join": 2, "leave": 3, "kick": 4, "promote": 5, "demote": 6, "transfer": 7, "edit": 8, "disband": 9}
        history = [ProtoField(1, 2, encode_proto_fields([ProtoField(1, 0, int(row.get("at") or current_server_timestamp())), ProtoField(2, 0, content_ids.get(str(row.get("type")), 1))])) for row in (action.get("guild_document") or {}).get("history") or []]
        reply = encode_length_delimited_field(13, encode_proto_fields(history))
    elif kind == "guild_mail":
        reply = encode_length_delimited_field(14, build_cd_payload(1, 0))
    elif kind == "guild_disband":
        reply = encode_length_delimited_field(15, encode_varint_field(1, 1))
    elif kind == "guild_applications":
        applications = [ProtoField(1, 2, build_bot_user_summary({**row, "bot_id": row.get("uid"), "nickname": row.get("name")})) for row in action.get("applications") or []]
        reply = encode_length_delimited_field(16, encode_proto_fields(applications))
    elif kind in ("guild_refresh", "guild_recommendations"):
        summaries = [ProtoField(1, 2, build_guild_summary_payload(int(row.get("guild_id", 1)), str(row.get("name", "本地冒险者公会")), int(row.get("member_count", 0)))) for row in action.get("guilds") or []]
        reply = encode_length_delimited_field(17 if kind == "guild_refresh" else 27, encode_proto_fields(summaries))
    elif kind == "guild_members":
        members = []
        for bot in action.get("members") or []:
            member = build_guild_member_payload(bot, action.get("guild") or {})
            members.append(ProtoField(1, 2, member))
        reply = encode_length_delimited_field(18, encode_proto_fields(members))
    elif kind in ("guild_boss_open", "guild_bosses"):
        # reply_guild_boss.attack_times is the number already consumed; the
        # guild domain exposes attempts remaining.
        attack_times = max(0, 2 - int(action.get("attempts", 2)))
        boss = encode_proto_fields([ProtoField(1, 0, int(action.get("boss_id", 1))), ProtoField(2, 0, current_server_timestamp() + 86400), ProtoField(3, 0, attack_times), ProtoField(4, 0, int(action.get("total_damage", 0)))])
        payload = encode_length_delimited_field(1, boss) if kind == "guild_boss_open" else encode_proto_fields([ProtoField(1, 2, boss), ProtoField(2, 0, 0)])
        reply = encode_length_delimited_field(19 if kind == "guild_boss_open" else 22, payload)
    elif kind == "guild_boss_start":
        reply = encode_length_delimited_field(20, encode_proto_fields([ProtoField(1, 2, build_battle_payload(4, int(action.get("boss_id", 1)), request_info.get("battle_transaction") or {})), ProtoField(2, 2, b"")]))
    elif kind == "guild_boss_end":
        attack_times = max(0, 2 - int(action.get("attempts", 1)))
        boss = encode_proto_fields([ProtoField(1, 0, 1), ProtoField(2, 0, current_server_timestamp() + 86400), ProtoField(3, 0, attack_times), ProtoField(4, 0, int(action.get("total_damage", 0)))])
        reply = encode_length_delimited_field(21, encode_proto_fields([*[ProtoField(1, 2, build_misc_reward_payload([reward])) for reward in action.get("rewards") or []], ProtoField(2, 2, boss), ProtoField(3, 0, protocol_numeric_uid(action.get("battle_id"), 1))]))
    elif kind == "guild_boss_records":
        records = []
        for row in action.get("records") or []:
            user = build_bot_user_summary({"uid": row.get("uid"), "name": row.get("name"), "level": 1, "guild_id": guild_id})
            records.append(ProtoField(1, 2, encode_proto_fields([ProtoField(1, 2, user), ProtoField(2, 0, int(row.get("damage") or 0)), ProtoField(3, 0, protocol_numeric_uid(row.get("battle_id"), 1)), ProtoField(4, 0, int(row.get("at") or current_server_timestamp()))])))
        reply = encode_length_delimited_field(23, encode_proto_fields(records))
    elif kind == "guild_boss_final_reward":
        payload = encode_proto_fields([ProtoField(1, 0, int(action.get("boss_id") or 1)), ProtoField(3, 0, int(action.get("total_damage") or 0)), ProtoField(4, 0, 1000), ProtoField(5, 0, 1000)])
        reply = encode_length_delimited_field(24, payload)
    elif kind == "guild_boss_sweep":
        attack_times = max(0, 2 - int(action.get("attempts", 1)))
        boss = encode_proto_fields([ProtoField(1, 0, int(action.get("boss_id", 1))), ProtoField(2, 0, current_server_timestamp() + 86400), ProtoField(3, 0, attack_times), ProtoField(4, 0, int(action.get("total_damage", 0)))])
        sweep = encode_proto_fields([*[ProtoField(1, 2, build_reward_payload([reward])) for reward in action.get("rewards") or []], ProtoField(2, 2, boss), ProtoField(3, 2, b"")])
        reply = encode_length_delimited_field(26, sweep)
    elif kind == "guild_member_summaries":
        summaries = [ProtoField(1, 2, build_bot_user_summary({**row, "bot_id": row.get("uid"), "nickname": row.get("name"), "guild_id": guild_id})) for row in action.get("members") or []]
        reply = encode_length_delimited_field(25, encode_proto_fields(summaries))
    elif kind in ("guild_set_strong_man", "guild_remove_strong_man"):
        reply = encode_length_delimited_field(28 if kind == "guild_set_strong_man" else 29, encode_varint_field(1, 1))
    elif kind == "guild_summary":
        reply = encode_length_delimited_field(31, encode_length_delimited_field(1, build_guild_summary_payload(guild_id, str((action.get("guild") or {}).get("name") or "本地冒险者公会"), int((action.get("guild") or {}).get("member_count") or 1))))
    else:
        reply = encode_varint_field(1, 1)
    return build_system_reply(request_info, 16, reply)


def build_item_system_reply(request_info: dict, action: dict | None) -> bytes:
    action = action or {}
    reply_asset = encode_proto_fields(
        [
            ProtoField(1, 2, build_reward_payload(action.get("rewards"))),
            ProtoField(2, 2, build_reward_payload(action.get("cost"))),
        ]
    )
    field_number = {"item_use": 1, "item_compose": 2, "item_compose_use": 3, "item_choose": 4, "item_sell": 5}.get(request_info.get("kind"), 1)
    return build_system_reply(request_info, 20, encode_length_delimited_field(field_number, reply_asset))


def build_altar_system_reply(request_info: dict, action: dict | None) -> bytes:
    action = action or {}
    # reply_altar_info: result=1, optional reward=2. reply_altar is down_msg field 24.
    info_fields = [ProtoField(1, 0, 1)]
    rewards = action.get("rewards") or []
    if rewards:
        info_fields.append(ProtoField(2, 2, build_reward_payload(rewards)))
    altar_reply = encode_length_delimited_field(1, encode_proto_fields(info_fields))
    return build_system_reply(request_info, 24, altar_reply)


def try_build_heartbeat_reply(message: str | bytes) -> bytes | None:
    if not isinstance(message, bytes):
        return None

    if len(message) < 8 or len(message) > 256:
        return None

    try:
        fields = parse_proto_fields(message)
        seq = get_proto_varint(fields, 1)
        nested_payload = get_proto_bytes(fields, 19)
    except ValueError:
        return None
    if seq is None or nested_payload is None:
        return None

    server_ts = int(datetime.now(timezone.utc).timestamp())
    return b"".join(
        (
            b"\x08",
            encode_varint(server_ts),
            b"\x10",
            encode_varint(seq),
            b"\xAA\x01\x02\x08\x00",
        )
    )


def normalize_replay_fixture(path: str | None) -> dict | None:
    if not path:
        return None

    fixture = json.loads(Path(path).read_text(encoding="utf-8"))
    events = fixture.get("events")
    if isinstance(events, list) and events:
        normalized_events = []
        for index, event in enumerate(events, start=1):
            kind = event.get("kind")
            if kind not in {"expect_client", "send_client"}:
                raise ValueError(f"Unsupported replay event kind: {kind}")
            normalized_events.append(
                {
                    "index": index,
                    "label": event.get("label") or f"event_{index}",
                    "kind": kind,
                    "message_type": event["message_type"],
                    "payload": event["payload"],
                    "delay_ms": int(event.get("delay_ms", 0)),
                    "capture_gap_ms": int(event.get("capture_gap_ms", event.get("delay_ms", 0))),
                    "captured_direction": event.get("captured_direction"),
                }
            )

        post_replay = fixture.get("post_replay") or {}
        return {
            "fixture_path": path,
            "events": normalized_events,
            "auto_heartbeat": post_replay.get("mode") == "auto_heartbeat",
        }

    steps = fixture.get("steps")
    if isinstance(steps, list) and steps:
        normalized_events = []
        for index, step in enumerate(steps, start=1):
            normalized_events.append(
                {
                    "index": len(normalized_events) + 1,
                    "label": step.get("label") or f"step_{index}_request",
                    "kind": "expect_client",
                    "message_type": step["request_message_type"],
                    "payload": step["request_payload"],
                    "delay_ms": 0,
                    "capture_gap_ms": 0,
                    "captured_direction": "client_to_upstream",
                }
            )
            normalized_events.append(
                {
                    "index": len(normalized_events) + 1,
                    "label": step.get("label") or f"step_{index}_response",
                    "kind": "send_client",
                    "message_type": step["response_message_type"],
                    "payload": step["response_payload"],
                    "delay_ms": int(step.get("response_delay_ms", 0)),
                    "capture_gap_ms": int(step.get("response_delay_ms", 0)),
                    "captured_direction": "upstream_to_client",
                }
            )

        return {
            "fixture_path": path,
            "events": normalized_events,
            "auto_heartbeat": False,
        }

    raise ValueError("Replay fixture must contain either a non-empty events array or steps array.")


async def relay_messages(
    source,
    target,
    direction: str,
    session_id: int,
    logger: JsonlLogger,
) -> None:
    try:
        async for message in source:
            await logger.write(
                {
                    "ts": utc_now(),
                    "event": "frame",
                    "session_id": session_id,
                    "direction": direction,
                    **format_message(message),
                }
            )
            await target.send(message)
    except ConnectionClosed as exc:
        await logger.write(
            {
                "ts": utc_now(),
                "event": "relay_closed",
                "session_id": session_id,
                "direction": direction,
                "code": exc.code,
                "reason": exc.reason,
            }
        )
        raise


async def run_replay_session(
    client: ServerConnection,
    session_id: int,
    logger: JsonlLogger,
    replay_fixture: dict,
) -> None:
    replay_events = replay_fixture["events"]
    for event in replay_events:
        if event["kind"] == "expect_client":
            request_message = await client.recv()
            formatted_request = format_message(request_message)
            request_matches = (
                event["message_type"] == formatted_request["message_type"]
                and event["payload"] in (formatted_request.get("text"), formatted_request.get("base64"))
            )

            await logger.write(
                {
                    "ts": utc_now(),
                    "event": "frame",
                    "session_id": session_id,
                    "direction": "client_to_local_replay",
                    "event_index": event["index"],
                    "fixture_label": event["label"],
                    "request_matches_fixture": request_matches,
                    "capture_gap_ms": event["capture_gap_ms"],
                    **formatted_request,
                }
            )
            continue

        delay_ms = int(event.get("delay_ms", 0))
        if delay_ms > 0:
            await asyncio.sleep(delay_ms / 1000)

        response_message = decode_fixture_message(event["message_type"], event["payload"])
        await logger.write(
            {
                "ts": utc_now(),
                "event": "frame",
                "session_id": session_id,
                "direction": "local_replay_to_client",
                "event_index": event["index"],
                "fixture_label": event["label"],
                "replay_delay_ms": delay_ms,
                "capture_gap_ms": event["capture_gap_ms"],
                **format_message(response_message),
            }
        )
        await client.send(response_message)

    await logger.write(
        {
            "ts": utc_now(),
            "event": "replay_exhausted",
            "session_id": session_id,
            "events_served": len(replay_events),
            "auto_heartbeat": replay_fixture.get("auto_heartbeat", False),
        }
    )

    if not replay_fixture.get("auto_heartbeat"):
        with contextlib.suppress(ConnectionClosed):
            await client.wait_closed()
        return

    while True:
        heartbeat_request = await client.recv()
        formatted_request = format_message(heartbeat_request)
        heartbeat_reply = try_build_heartbeat_reply(heartbeat_request)

        await logger.write(
            {
                "ts": utc_now(),
                "event": "frame",
                "session_id": session_id,
                "direction": "client_to_local_replay",
                "fixture_label": "post_replay_auto_heartbeat",
                "request_matches_fixture": heartbeat_reply is not None,
                **formatted_request,
            }
        )

        if heartbeat_reply is None:
            await logger.write(
                {
                    "ts": utc_now(),
                    "event": "unexpected_post_replay_message",
                    "session_id": session_id,
                    "message_type": formatted_request["message_type"],
                    "size": formatted_request["size"],
                }
            )
            continue

        await logger.write(
            {
                "ts": utc_now(),
                "event": "frame",
                "session_id": session_id,
                "direction": "local_replay_to_client",
                "fixture_label": "post_replay_auto_heartbeat",
                **format_message(heartbeat_reply),
            }
        )
        await client.send(heartbeat_reply)


async def log_structured_frame(
    logger: JsonlLogger,
    session_id: int,
    direction: str,
    label: str,
    message: str | bytes,
    request_info: dict | None = None,
    replay_delay_ms: int | None = None,
) -> None:
    payload = {
        "ts": utc_now(),
        "event": "frame",
        "session_id": session_id,
        "direction": direction,
        "fixture_label": label,
        **format_message(message),
    }
    if request_info is not None:
        payload["request_kind"] = request_info.get("kind")
        if request_info.get("seq") is not None:
            payload["request_seq"] = request_info["seq"]
    if replay_delay_ms is not None:
        payload["replay_delay_ms"] = replay_delay_ms
    await logger.write(payload)


async def run_structured_login_session(
    client: ServerConnection,
    session_id: int,
    logger: JsonlLogger,
    templates: StructuredLoginTemplates,
    interaction_fixture: InteractionFixture | None = None,
    login_persistence: LoginPersistence | None = None,
    business_state: BusinessStateProvider | None = None,
) -> None:
    await logger.write(
        {
            "ts": utc_now(),
            "event": "structured_login_started",
            "session_id": session_id,
            "fixture_path": templates.fixture_path,
        }
    )

    async def reply_bootstrap_generic(request_info: dict) -> None:
        bootstrap_reply = build_generic_protocol_reply(
            request_info,
            {
                "ok": True,
                "wire_projection": {
                    "result": 1,
                    "timestamp": current_server_timestamp(),
                },
            },
        )
        await log_structured_frame(
            logger,
            session_id,
            "local_structured_to_client",
            f"{request_info.get('generic_module')}_bootstrap_reply",
            bootstrap_reply,
            request_info=request_info,
            replay_delay_ms=0,
        )
        await client.send(bootstrap_reply)

    async def receive_expected_request(expected_kind: str, label: str) -> tuple[str | bytes, dict]:
        while True:
            request_message = await client.recv()
            request_info = parse_client_message_kind(request_message)
            await log_structured_frame(
                logger,
                session_id,
                "client_to_local_structured",
                label,
                request_message,
                request_info=request_info,
            )
            if request_info.get("kind") == expected_kind:
                return request_message, request_info

            if expected_kind != "heartbeat" and request_info.get("kind") == "heartbeat":
                heartbeat_reply = try_build_heartbeat_reply(request_message)
                if heartbeat_reply is None:
                    continue
                await log_structured_frame(
                    logger,
                    session_id,
                    "local_structured_to_client",
                    "unexpected_prelogin_heartbeat",
                    heartbeat_reply,
                    request_info=request_info,
                )
                await client.send(heartbeat_reply)
                continue

            if str(request_info.get("kind") or "").startswith("generic_"):
                # The HD client may query native bootstrap modules (notably
                # svr_list) before SDK login.  They cannot be persisted yet
                # because no player exists, but still require an exact HD
                # protobuf reply or login remains blocked.
                await reply_bootstrap_generic(request_info)
                continue

            await logger.write(
                {
                    "ts": utc_now(),
                    "event": "structured_login_unexpected_request",
                    "session_id": session_id,
                    "expected_kind": expected_kind,
                    "request_kind": request_info.get("kind"),
                    "request_seq": request_info.get("seq"),
                }
            )

    first_message = await client.recv()
    first_request = parse_client_message_kind(first_message)
    await log_structured_frame(
        logger,
        session_id,
        "client_to_local_structured",
        "expect_sdk_login_or_reconnect",
        first_message,
        request_info=first_request,
    )
    if first_request.get("kind") == "reconnect":
        reconnect_user_payload = None
        if business_state is not None:
            await business_state.bind_session_token(first_request.get("htoken"))
            reconnect_state = await business_state.get_business_state()
            if reconnect_state:
                reconnect_login = build_login_payload_from_business_state(
                    templates.login_payload,
                    reconnect_state,
                    classic_layout=bool(getattr(client, "uses_classic_framed_proto", False)),
                )
                reconnect_user_payload = get_proto_bytes(
                    parse_proto_fields(reconnect_login), 1
                )
        reconnect_reply = build_structured_reconnect_reply(
            first_request,
            reconnect_user_payload,
        )
        await log_structured_frame(
            logger,
            session_id,
            "local_structured_to_client",
            "reconnect_reply",
            reconnect_reply,
            request_info=first_request,
            replay_delay_ms=0,
        )
        await client.send(reconnect_reply)
        await run_structured_post_login_loop(
            client,
            session_id,
            logger,
            templates,
            interaction_fixture,
            business_state,
        )
        return

    async def receive_sdk_login_after_first() -> tuple[str | bytes, dict]:
        if first_request.get("kind") == "sdk_login":
            return first_message, first_request
        if str(first_request.get("kind") or "").startswith("generic_"):
            # Reconnecting 1.201 clients can create the new socket with a
            # red-dot/bootstrap request before repeating SDK login. Reply to
            # that first frame as well; otherwise both sides wait until the
            # client reports a misleading gateway connection failure.
            await reply_bootstrap_generic(first_request)
        return await receive_expected_request("sdk_login", "expect_sdk_login")

    _, sdk_login_request = await receive_sdk_login_after_first()
    if business_state is not None:
        await business_state.bind_session_token(sdk_login_request.get("htoken"))
    if templates.sdk_login_reply.delay_ms > 0:
        await asyncio.sleep(templates.sdk_login_reply.delay_ms / 1000)
    sdk_login_reply = build_structured_sdk_login_reply(sdk_login_request, templates)
    await log_structured_frame(
        logger,
        session_id,
        "local_structured_to_client",
        templates.sdk_login_reply.label,
        sdk_login_reply,
        request_info=sdk_login_request,
        replay_delay_ms=templates.sdk_login_reply.delay_ms,
    )
    await client.send(sdk_login_reply)

    _, login_request = await receive_expected_request("login", "expect_login")
    if templates.login_reply.delay_ms > 0:
        await asyncio.sleep(templates.login_reply.delay_ms / 1000)
    login_business_state = (
        await business_state.get_business_state()
        if business_state is not None
        else None
    )
    login_reply = build_structured_login_reply(
        login_request,
        templates,
        business_state=login_business_state,
        classic_layout=bool(client.uses_classic_framed_proto),
    )
    await log_structured_frame(
        logger,
        session_id,
        "local_structured_to_client",
        templates.login_reply.label,
        login_reply,
        request_info=login_request,
        replay_delay_ms=templates.login_reply.delay_ms,
    )
    await client.send(login_reply)

    _, charge_request = await receive_expected_request("charge", "expect_charge")
    if templates.charge_reply.delay_ms > 0:
        await asyncio.sleep(templates.charge_reply.delay_ms / 1000)
    charge_reply = build_structured_charge_reply(
        charge_request,
        templates,
        classic_layout=bool(client.uses_classic_framed_proto),
    )
    await log_structured_frame(
        logger,
        session_id,
        "local_structured_to_client",
        templates.charge_reply.label,
        charge_reply,
        request_info=charge_request,
        replay_delay_ms=templates.charge_reply.delay_ms,
    )
    await client.send(charge_reply)

    if login_persistence is not None:
        persisted_login = await login_persistence.persist_structured_login(
            session_id,
            sdk_login_request,
            login_request,
            charge_request,
            login_business_state,
        )
        if business_state is not None and persisted_login is not None:
            business_state.bind_player(persisted_login.get("player_uid"))
        await logger.write(
            {
                "ts": utc_now(),
                "event": "structured_login_persisted",
                "session_id": session_id,
                "account_id": persisted_login.get("account_id") if persisted_login else None,
                "player_uid": persisted_login.get("player_uid") if persisted_login else None,
                "db_session_id": persisted_login.get("session_id") if persisted_login else None,
                "persisted": persisted_login is not None,
            }
        )

    if templates.post_login_push.delay_ms > 0:
        await asyncio.sleep(templates.post_login_push.delay_ms / 1000)
    server_push = build_structured_server_push(templates)
    await log_structured_frame(
        logger,
        session_id,
        "local_structured_to_client",
        templates.post_login_push.label,
        server_push,
        replay_delay_ms=templates.post_login_push.delay_ms,
    )
    await client.send(server_push)

    await run_structured_post_login_loop(
        client,
        session_id,
        logger,
        templates,
        interaction_fixture,
        business_state,
    )


async def run_structured_post_login_loop(
    client: ServerConnection,
    session_id: int,
    logger: JsonlLogger,
    templates: StructuredLoginTemplates,
    interaction_fixture: InteractionFixture | None,
    business_state: BusinessStateProvider | None,
) -> None:
    active_maze_battle_id: str | None = None
    active_guild_battle_id: str | None = None
    async def classic_preload_keepalive() -> None:
        # Classic performs a long synchronous first-entry resource preload and
        # doesn't start its own application heartbeat until that work ends.
        # Keep its receive timestamp fresh so the client doesn't close a
        # healthy gateway while assets are still downloading.
        while True:
            await asyncio.sleep(8)
            pulse = b"".join(
                (
                    encode_varint_field(1, current_server_timestamp()),
                    encode_varint_field(2, 0),
                    encode_length_delimited_field(21, encode_varint_field(1, 0)),
                )
            )
            try:
                await client.send(pulse)
            except ConnectionClosed:
                return

    if getattr(client, "uses_classic_framed_proto", False):
        asyncio.create_task(classic_preload_keepalive())
    while True:
        request_message = await client.recv()
        request_info = parse_client_message_kind(request_message)
        signature = request_signature(request_message)
        await log_structured_frame(
            logger,
            session_id,
            "client_to_local_structured",
            "post_login",
            request_message,
            request_info=request_info,
        )

        request_kind = request_info.get("kind")
        if request_kind == "heartbeat":
            heartbeat_reply = try_build_heartbeat_reply(request_message)
            if heartbeat_reply is None:
                continue
            delay_ms = templates.heartbeat_reply_delay_ms
            if delay_ms > 0:
                await asyncio.sleep(delay_ms / 1000)
            await log_structured_frame(
                logger,
                session_id,
                "local_structured_to_client",
                "heartbeat_reply",
                heartbeat_reply,
                request_info=request_info,
                replay_delay_ms=delay_ms,
            )
            await client.send(heartbeat_reply)
            continue

        if request_kind == "charge":
            # The client repeats req_charge after login when a recharge/shop
            # surface refreshes. Rebuild the captured official reply with the
            # current sequence instead of silently leaving the request open.
            charge_reply = build_structured_charge_reply(
                request_info,
                templates,
                classic_layout=bool(
                    getattr(client, "uses_classic_framed_proto", False)
                ),
            )
            await log_structured_frame(
                logger,
                session_id,
                "local_structured_to_client",
                "post_login_charge_reply",
                charge_reply,
                request_info=request_info,
                replay_delay_ms=0,
            )
            await client.send(charge_reply)
            continue

        if request_kind == "charge_purchase":
            transaction = None
            if business_state is not None and request_info.get("goods_id") is not None:
                transaction = await business_state.instant_purchase(
                    int(request_info["goods_id"]), request_info.get("seq")
                )
            if business_state is not None and not (transaction or {}).get("ok"):
                await logger.write({"ts": utc_now(), "event": "instant_charge_rejected", "session_id": session_id, "request_seq": request_info.get("seq"), "transaction": transaction})
                continue
            reply = build_instant_charge_reply(request_info, transaction)
            await log_structured_frame(logger, session_id, "local_structured_to_client", "instant_charge_grant_reply", reply, request_info=request_info, replay_delay_ms=0)
            await logger.write({"ts": utc_now(), "event": "instant_charge_granted", "session_id": session_id, "request_seq": request_info.get("seq"), "goods_id": request_info.get("goods_id"), "rewards": (transaction or {}).get("rewards") or []})
            await client.send(reply)
            continue

        if request_kind == "tavern_open_panel":
            tavern_state = await business_state.game_action("tavern_open") if business_state is not None else None
            tavern_reply = build_structured_tavern_open_panel_reply(request_info, tavern_state)
            await log_structured_frame(
                logger,
                session_id,
                "local_structured_to_client",
                "tavern_open_panel_reply",
                tavern_reply,
                request_info=request_info,
                replay_delay_ms=0,
            )
            await client.send(tavern_reply)
            continue

        if request_kind == "tavern_draw":
            cost_before = None
            cost_after = None
            draw_count = int(request_info.get("draw_count") or 1)
            draw_result = None
            if business_state is not None:
                draw_result = await business_state.tavern_draw(
                    int(request_info.get("protocol_tavern_id") or TAVERN_SINGLE_DRAW_RULE["tavern_id"]),
                    count=draw_count,
                    request_seq=request_info.get("seq"),
                    idempotency_key=f"ws:{session_id}:{request_info.get('seq')}:tavern_draw",
                )
                if not (draw_result or {}).get("ok"):
                    await logger.write({
                        "ts": utc_now(), "event": "tavern_draw_rejected",
                        "session_id": session_id, "request_seq": request_info.get("seq"),
                        "transaction": draw_result,
                    })
                    await client.send(build_error_reply(request_info, str((draw_result or {}).get("error") or "tavern_draw_rejected")))
                    continue
                state_payload = (draw_result or {}).get("businessState") or {}
                inventory = state_payload.get("inventory") or []
                cost_after = inventory_quantity(inventory, TAVERN_DRAW_COST_INVENTORY_KEY, 0)
                cost_before = cost_after + (TAVERN_DRAW_COST_AMOUNT * draw_count)

            tavern_reply = build_structured_tavern_draw_reply(request_info, draw_result)
            await log_structured_frame(
                logger,
                session_id,
                "local_structured_to_client",
                "tavern_draw_reply",
                tavern_reply,
                request_info=request_info,
                replay_delay_ms=0,
            )
            if business_state is not None:
                await logger.write(
                    {
                        "ts": utc_now(),
                        "event": "business_response_generated",
                        "session_id": session_id,
                        "request_kind": request_kind,
                        "request_seq": request_info.get("seq"),
                        "business_generator": "tavern_draw",
                        "source": "mysql",
                        "tables": ["players", "inventory_items", "characters"],
                        "cost_item_id": TAVERN_DRAW_COST_ITEM_ID,
                        "cost_before": cost_before,
                        "cost_after": cost_after,
                        "draw_count": draw_count,
                        "protocol_tavern_id": request_info.get("protocol_tavern_id"),
                        "cost_amount": TAVERN_DRAW_COST_AMOUNT * draw_count,
                    }
                )
            await client.send(tavern_reply)
            continue

        if request_kind in {
            "task_info", "task_claim", "task_batch_claim", "task_chest", "task_batch_chest", "task_line_claim", "task_batch_line"
        }:
            action = None
            if business_state is not None:
                op = "task_info"
                if request_kind in ("task_claim", "task_batch_claim", "task_line_claim", "task_batch_line"):
                    op = "task_claim"
                elif request_kind in ("task_chest", "task_batch_chest"):
                    op = "task_chest"
                action = await business_state.game_action(
                    op, ids=request_info.get("task_ids") or []
                )
            if business_state is not None and not (action or {}).get("ok"):
                await logger.write({"ts": utc_now(), "event": "task_action_rejected", "session_id": session_id, "request_seq": request_info.get("seq"), "transaction": action})
                continue
            task_reply = build_task_system_reply(request_info, action)
            await log_structured_frame(
                logger, session_id, "local_structured_to_client",
                f"{request_kind}_reply", task_reply,
                request_info=request_info, replay_delay_ms=0,
            )
            await client.send(task_reply)
            continue

        if request_kind in {"shop_open", "shop_refresh", "shop_buy"}:
            action = None
            if business_state is not None:
                action = await business_state.game_action(
                    request_kind,
                    shop_id=int(request_info.get("shop_id") or 1),
                    index=int(request_info.get("index") or 0),
                    count=int(request_info.get("count") or 1),
                )
            if business_state is not None and not (action or {}).get("ok"):
                await logger.write({"ts": utc_now(), "event": "shop_action_rejected", "session_id": session_id, "request_seq": request_info.get("seq"), "transaction": action})
                continue
            reply = build_shop_system_reply(request_info, action)
            await log_structured_frame(logger, session_id, "local_structured_to_client", f"{request_kind}_reply", reply, request_info=request_info, replay_delay_ms=0)
            await client.send(reply)
            continue

        if request_kind in {"mail_list", "mail_read", "mail_receive", "mail_receive_all"}:
            action = None
            if business_state is not None:
                action = await business_state.game_action(
                    request_kind,
                    ids=request_info.get("ids") or [],
                    id=int(request_info.get("id") or 0),
                )
            if business_state is not None and not (action or {}).get("ok"):
                await logger.write({"ts": utc_now(), "event": "mail_action_rejected", "session_id": session_id, "request_seq": request_info.get("seq"), "transaction": action})
                continue
            reply = build_mail_system_reply(request_info, action)
            await log_structured_frame(logger, session_id, "local_structured_to_client", f"{request_kind}_reply", reply, request_info=request_info, replay_delay_ms=0)
            await client.send(reply)
            continue

        if request_kind == "item_use":
            action = await business_state.game_action("item_use", item_id=int(request_info.get("item_id") or 0), count=int(request_info.get("count") or 1)) if business_state is not None else None
            if business_state is not None and not (action or {}).get("ok"):
                await logger.write({"ts": utc_now(), "event": "item_action_rejected", "session_id": session_id, "request_seq": request_info.get("seq"), "transaction": action})
                continue
            reply = build_item_system_reply(request_info, action)
            await log_structured_frame(logger, session_id, "local_structured_to_client", "item_use_reply", reply, request_info=request_info, replay_delay_ms=0)
            await client.send(reply)
            continue

        if request_kind == "altar_disband":
            action = await business_state.game_action(
                "altar_disband", hero_ids=request_info.get("hero_ids") or []
            ) if business_state is not None else {"ok": True, "rewards": []}
            if business_state is not None and not (action or {}).get("ok"):
                await logger.write({"ts": utc_now(), "event": "altar_action_rejected", "session_id": session_id, "request_seq": request_info.get("seq"), "transaction": action})
                continue
            reply = build_altar_system_reply(request_info, action)
            await log_structured_frame(logger, session_id, "local_structured_to_client", "altar_disband_reply", reply, request_info=request_info, replay_delay_ms=0)
            await client.send(reply)
            continue

        if request_kind in {"arena_open", "arena_refresh", "arena_query_lineup", "arena_challenge", "arena_set_defense", "arena_open_chest", "arena_records", "arena_buy_ticket"}:
            action = None
            if business_state is not None:
                op = request_kind if request_kind in {"arena_open", "arena_refresh", "arena_query_lineup", "arena_challenge", "arena_records", "arena_buy_ticket"} else "arena_open"
                kwargs = {"opponent_uid": int(request_info.get("opponent_uid") or 0)} if op in {"arena_query_lineup", "arena_challenge"} else {}
                action = await business_state.game_action(op, **kwargs)
            reply = build_arena_system_reply(request_info, action)
            await log_structured_frame(logger, session_id, "local_structured_to_client", f"{request_kind}_reply", reply, request_info=request_info, replay_delay_ms=0)
            await client.send(reply)
            continue

        if request_kind in {"tower_open", "tower_start", "tower_retry", "tower_end", "tower_records", "tower_assists"}:
            action = None
            if business_state is not None:
                if request_kind == "tower_end" and int(request_info.get("battle_result") or 2) == 1:
                    action = await business_state.game_action("tower_win")
                else:
                    action = await business_state.game_action("tower_open")
                if request_kind in {"tower_start", "tower_retry"}:
                    request_info["battle_transaction"] = await business_state.authoritative_battle_start(
                        "tower", int(request_info.get("floor_id") or action.get("floor_id", 1)),
                        request_info.get("lineup_ids") or [], request_info.get("seq"),
                    ) or {}
            reply = build_tower_system_reply(request_info, action)
            await log_structured_frame(logger, session_id, "local_structured_to_client", f"{request_kind}_reply", reply, request_info=request_info, replay_delay_ms=0)
            await client.send(reply)
            continue

        if request_kind in {"maze_open", "maze_query", "maze_move", "maze_start", "maze_end", "maze_transmit", "maze_select_heirloom", "maze_receive", "maze_use_relic", "maze_buy", "maze_give_up", "maze_use_item", "maze_use_torch"}:
            action = None
            if business_state is not None:
                if request_kind == "maze_open":
                    action = await business_state.game_action("maze_open")
                    stored_active = ((action or {}).get("maze") or {}).get("active_battle") or {}
                    active_maze_battle_id = stored_active.get("battle_id") or active_maze_battle_id
                elif request_kind == "maze_query":
                    action = await business_state.game_action("maze_query", cell_id=int(request_info.get("cell_id") or 0))
                elif request_kind == "maze_move":
                    action = await business_state.game_action("maze_move", cell_id=int(request_info.get("cell_id") or 1))
                elif request_kind == "maze_start":
                    battle_id = f"maze-{session_id}-{int(request_info.get('seq') or 0)}-{current_server_timestamp()}"
                    action = await business_state.game_action("maze_start", battle_id=battle_id, lineup_ids=request_info.get("lineup_ids") or [])
                    if (action or {}).get("ok"):
                        active_maze_battle_id = str((action or {}).get("battle_id") or battle_id)
                        request_info["battle_transaction"] = await business_state.authoritative_battle_start(
                            "maze", int((action or {}).get("enemy_stage_id") or (action or {}).get("cell_id") or 1),
                            request_info.get("lineup_ids") or [], request_info.get("seq"),
                            battle_id=active_maze_battle_id, maze_relic_effects=(action or {}).get("relic_effects") or {},
                        ) or {}
                        if not request_info["battle_transaction"].get("ok"):
                            action = await business_state.game_action("maze_end", battle_id=active_maze_battle_id, authoritative_result="defeat")
                elif request_kind == "maze_end":
                    if not active_maze_battle_id:
                        opened = await business_state.game_action("maze_open")
                        active_maze_battle_id = ((((opened or {}).get("maze") or {}).get("active_battle") or {}).get("battle_id"))
                    reported = "victory" if int(request_info.get("battle_result") or 2) == 1 else "defeat"
                    verification = await business_state.authoritative_battle_finish(active_maze_battle_id or "", reported, "maze")
                    authoritative_result = (verification or {}).get("result") or "defeat"
                    action = await business_state.game_action("maze_end", battle_id=active_maze_battle_id or "", authoritative_result=authoritative_result)
                    if (action or {}).get("ok"):
                        action["battle_verification"] = verification or {}
                        active_maze_battle_id = None
                elif request_kind == "maze_select_heirloom":
                    action = await business_state.game_action("maze_select_heirloom", heirlooms=request_info.get("heirlooms") or [])
                elif request_kind == "maze_use_relic":
                    action = await business_state.game_action("maze_use_relic", params=request_info.get("params") or [])
                elif request_kind == "maze_buy":
                    action = await business_state.game_action("maze_buy", index=int(request_info.get("index") or 1))
                elif request_kind == "maze_give_up":
                    action = await business_state.game_action("maze_give_up")
                elif request_kind == "maze_receive":
                    action = await business_state.game_action("maze_receive")
                elif request_kind == "maze_transmit":
                    action = await business_state.game_action("maze_transmit", cell_id=int(request_info.get("cell_id") or 0))
                elif request_kind in {"maze_use_item", "maze_use_torch"}:
                    action = await business_state.game_action("maze_open")
                else:
                    action = await business_state.game_action("maze_open")
            if business_state is not None and not (action or {}).get("ok"):
                await logger.write({"ts": utc_now(), "event": "maze_action_rejected", "session_id": session_id, "request_seq": request_info.get("seq"), "transaction": action})
                error_reply = build_error_reply(request_info, (action or {}).get("error") or "maze_action_rejected")
                await client.send(error_reply)
                continue
            reply = build_maze_system_reply(request_info, action)
            await log_structured_frame(logger, session_id, "local_structured_to_client", f"{request_kind}_reply", reply, request_info=request_info, replay_delay_ms=0)
            await client.send(reply)
            continue

        if request_kind in {"guild_open", "guild_create", "guild_edit", "guild_search", "guild_join", "guild_leave", "guild_kick", "guild_approve", "guild_promote", "guild_demote", "guild_transfer", "guild_history", "guild_mail", "guild_disband", "guild_applications", "guild_refresh", "guild_members", "guild_boss_open", "guild_boss_start", "guild_boss_end", "guild_bosses", "guild_boss_records", "guild_boss_final_reward", "guild_member_summaries", "guild_boss_sweep", "guild_recommendations", "guild_set_strong_man", "guild_remove_strong_man", "guild_leave_and_join", "guild_summary"}:
            action = None
            if business_state is not None:
                aliases = {
                    "guild_bosses": "guild_boss_open", "guild_boss_records": "guild_boss_open",
                    "guild_member_summaries": "guild_members", "guild_summary": "guild_open",
                    "guild_refresh": "guild_search", "guild_recommendations": "guild_search",
                    "guild_set_strong_man": "guild_promote", "guild_remove_strong_man": "guild_demote",
                    "guild_mail": "guild_chat",
                }
                op = aliases.get(request_kind, request_kind)
                common = {
                    "name": request_info.get("name"),
                    "notice": request_info.get("notice"), "icon": request_info.get("icon"),
                    "require_lv": request_info.get("require_lv"), "join_type": request_info.get("join_type"),
                    "target_uid": request_info.get("target_uid"), "message": request_info.get("message"),
                    "damage": int(request_info.get("damage") or 0), "lineup_ids": request_info.get("lineup_ids") or [],
                }
                common = {key: value for key, value in common.items() if value is not None}
                # Most guild request ids are operation-local ids (for example a
                # boss id), not the player's guild id.  Let the API resolve the
                # authoritative membership except for operations that really do
                # select a destination guild.
                if request_kind in {"guild_join", "guild_leave_and_join"}:
                    common["guild_id"] = int(request_info.get("id") or 0)
                if request_kind.startswith("guild_boss"):
                    common["boss_id"] = int(request_info.get("id") or 1)
                if request_kind == "guild_boss_start":
                    battle_id = f"guild-{session_id}-{int(request_info.get('seq') or 0)}-{current_server_timestamp()}"
                    battle_transaction = await business_state.authoritative_battle_start(
                        "guild", int(request_info.get("id") or 1), request_info.get("lineup_ids") or [], request_info.get("seq"), battle_id=battle_id,
                    ) or {}
                    if battle_transaction.get("ok"):
                        request_info["battle_transaction"] = battle_transaction
                        common["battle_id"] = battle_id
                        action = await business_state.game_action(op, **common)
                        if (action or {}).get("ok"):
                            active_guild_battle_id = str((action or {}).get("battle_id") or battle_id)
                    else:
                        action = battle_transaction
                elif request_kind == "guild_boss_end":
                    if not active_guild_battle_id:
                        opened = await business_state.game_action("guild_boss_open")
                        stored_active = (opened or {}).get("active_battle") or {}
                        active_guild_battle_id = stored_active.get("battle_id") or None
                    verification = await business_state.authoritative_battle_finish(
                        active_guild_battle_id or "", "victory" if int(request_info.get("battle_result") or 2) == 1 else "defeat", "guild",
                    )
                    simulation = (verification or {}).get("simulation") or {}
                    server_damage = sum(max(0, int(row.get("max_hp") or 0) - int(row.get("hp") or 0)) for row in simulation.get("final_units") or [] if row.get("side") == "enemy")
                    common.update(battle_id=active_guild_battle_id or "", damage=server_damage)
                    action = await business_state.game_action(op, **common)
                    if (action or {}).get("ok"):
                        action["battle_verification"] = verification or {}
                        active_guild_battle_id = None
                elif request_kind == "guild_boss_sweep":
                    panel = await business_state.game_action("guild_boss_open", **common)
                    records = (panel or {}).get("records") or []
                    sweep_damage = max([int(row.get("damage") or 0) for row in records] or [10000])
                    sweep_id = f"guild-sweep-{session_id}-{int(request_info.get('seq') or 0)}"
                    started = await business_state.game_action("guild_boss_start", **{**common, "battle_id": sweep_id})
                    action = await business_state.game_action("guild_boss_end", **{**common, "battle_id": sweep_id, "damage": sweep_damage}) if (started or {}).get("ok") else started
                elif request_kind == "guild_leave_and_join":
                    action = await business_state.game_action("guild_leave")
                    if (action or {}).get("ok"):
                        action = await business_state.game_action("guild_join", guild_id=int(request_info.get("id") or 1))
                else:
                    action = await business_state.game_action(op, **common)
            if business_state is not None and not (action or {}).get("ok"):
                await logger.write({"ts": utc_now(), "event": "guild_action_rejected", "session_id": session_id, "request_seq": request_info.get("seq"), "transaction": action})
                await client.send(build_error_reply(request_info, (action or {}).get("error") or "guild_action_rejected"))
                continue
            reply = build_guild_system_reply(request_info, action)
            await log_structured_frame(logger, session_id, "local_structured_to_client", f"{request_kind}_reply", reply, request_info=request_info, replay_delay_ms=0)
            await client.send(reply)
            continue

        if request_kind == "stage_idle_query":
            idle = None
            if business_state is not None:
                idle = await business_state.idle_query()
            idle_reply = build_structured_idle_query_reply(request_info, idle)
            await log_structured_frame(
                logger, session_id, "local_structured_to_client",
                "idle_query_reply", idle_reply,
                request_info=request_info, replay_delay_ms=0,
            )
            await client.send(idle_reply)
            continue

        if request_kind == "stage_hd_query_idle_reward":
            idle = None
            if business_state is not None:
                idle = await business_state.idle_query()
            idle_reply = build_structured_hd_idle_query_reply(request_info, idle)
            await log_structured_frame(
                logger, session_id, "local_structured_to_client",
                "hd_idle_query_reply", idle_reply,
                request_info=request_info, replay_delay_ms=0,
            )
            await client.send(idle_reply)
            continue

        if request_kind == "hd_assist_stage":
            assist_reply = build_structured_hd_assist_stage_reply(request_info)
            await log_structured_frame(
                logger, session_id, "local_structured_to_client",
                f"hd_assist_stage_{request_info.get('assist_operation')}_reply",
                assist_reply, request_info=request_info, replay_delay_ms=0,
            )
            await client.send(assist_reply)
            continue

        if request_kind == "stage_idle_claim":
            transaction = None
            if business_state is not None:
                transaction = await business_state.idle_claim(
                    False, request_info.get("seq")
                )
            if business_state is not None and not (transaction or {}).get("ok"):
                await logger.write(
                    {
                        "ts": utc_now(),
                        "event": "idle_claim_rejected",
                        "session_id": session_id,
                        "request_seq": request_info.get("seq"),
                        "transaction": transaction,
                    }
                )
                await client.send(build_error_reply(request_info, str((transaction or {}).get("error") or "idle_claim_rejected")))
                continue
            idle_reply = build_structured_idle_claim_reply(request_info, transaction)
            await log_structured_frame(
                logger, session_id, "local_structured_to_client",
                "idle_claim_reply", idle_reply,
                request_info=request_info, replay_delay_ms=0,
            )
            await client.send(idle_reply)
            continue

        if request_kind == "stage_quick_idle_claim":
            transaction = None
            if business_state is not None:
                transaction = await business_state.idle_claim(
                    True, request_info.get("seq")
                )
            if business_state is not None and not (transaction or {}).get("ok"):
                await logger.write(
                    {
                        "ts": utc_now(),
                        "event": "quick_idle_rejected",
                        "session_id": session_id,
                        "request_seq": request_info.get("seq"),
                        "transaction": transaction,
                    }
                )
                await client.send(build_error_reply(request_info, str((transaction or {}).get("error") or "quick_idle_rejected")))
                continue
            idle_reply = build_structured_quick_idle_reply(request_info, transaction)
            await log_structured_frame(
                logger, session_id, "local_structured_to_client",
                "quick_idle_reply", idle_reply,
                request_info=request_info, replay_delay_ms=0,
            )
            await client.send(idle_reply)
            continue

        if request_kind == "hero_up_level":
            transaction = None
            if business_state is not None:
                transaction = await business_state.hero_upgrade(
                    int(request_info.get("hero_id") or 0),
                    int(request_info.get("up_level") or 0),
                    request_info.get("seq"),
                    f"ws:{session_id}:{request_info.get('seq')}:hero_upgrade",
                )
            if business_state is not None and not (transaction or {}).get("ok"):
                await logger.write(
                    {
                        "ts": utc_now(),
                        "event": "hero_upgrade_rejected",
                        "session_id": session_id,
                        "request_seq": request_info.get("seq"),
                        "hero_id": request_info.get("hero_id"),
                        "up_level": request_info.get("up_level"),
                        "transaction": transaction,
                    }
                )
                await client.send(build_error_reply(request_info, str((transaction or {}).get("error") or "hero_upgrade_rejected")))
                continue
            hero_reply = build_structured_hero_upgrade_reply(request_info, transaction)
            await log_structured_frame(
                logger, session_id, "local_structured_to_client",
                "hero_up_level_reply", hero_reply,
                request_info=request_info, replay_delay_ms=0,
            )
            await client.send(hero_reply)
            continue

        if request_kind in {
            "hero_up_quality", "hero_wear_equip", "hero_remove_equip",
            "hero_remove_all_equips", "hero_wear_best_equip", "hero_lock",
        }:
            action = None
            if business_state is not None:
                op = {
                    "hero_up_quality": "hero_quality",
                    "hero_wear_equip": "hero_wear_equip",
                    "hero_remove_equip": "hero_remove_equip",
                    "hero_remove_all_equips": "hero_remove_all_equips",
                    "hero_wear_best_equip": "hero_wear_best_equip",
                    "hero_lock": "hero_lock",
                }[request_kind]
                action = await business_state.game_action(
                    op,
                    request_seq=request_info.get("seq"),
                    idempotency_key=f"ws:{session_id}:{request_info.get('seq')}:{op}",
                    hero_id=int(request_info.get("hero_id") or 0),
                    cost_hero_ids=request_info.get("cost_hero_ids") or [],
                    index=int(request_info.get("index") or 0),
                    equip_id=int(request_info.get("equip_id") or 0),
                    tag_first_flag=bool(request_info.get("tag_first_flag")),
                    locked=bool(request_info.get("locked")),
                )
            if business_state is not None and not (action or {}).get("ok"):
                await logger.write({"ts": utc_now(), "event": "hero_growth_rejected", "session_id": session_id, "request_seq": request_info.get("seq"), "transaction": action})
                await client.send(build_error_reply(request_info, str((action or {}).get("error") or "hero_growth_rejected")))
                continue
            reply = build_hero_growth_reply(request_info, action)
            await log_structured_frame(logger, session_id, "local_structured_to_client", f"{request_kind}_reply", reply, request_info=request_info, replay_delay_ms=0)
            await client.send(reply)
            continue

        if request_kind in {
            "hero_wear_artifact", "hero_remove_artifact", "hero_quality_one_key",
            "hero_query", "hero_set_assist", "hero_totem_up",
            "hero_batch_artifact_mitama", "hero_wear_mitama", "hero_remove_mitama",
        }:
            action = None
            if business_state is not None:
                action = await business_state.game_action(
                    request_kind,
                    request_seq=request_info.get("seq"),
                    idempotency_key=f"ws:{session_id}:{request_info.get('seq')}:{request_kind}",
                    hero_id=int(request_info.get("hero_id") or ((request_info.get("hero_ids") or [0])[0]) or 0),
                    hero_ids=request_info.get("hero_ids") or [],
                    artifact_id=int(request_info.get("artifact_id") or ((request_info.get("artifact_ids") or [0])[0]) or 0),
                    assist_hero_id=int(request_info.get("assist_hero_id") or 0),
                    lineup_type=request_info.get("lineup_type") or "normal",
                    node=int(request_info.get("node") or 0),
                    up_level=int(request_info.get("up_level") or 1),
                    cost_hero_ids=request_info.get("cost_hero_ids") or [],
                    quality_upgrades=request_info.get("quality_upgrades") or [],
                )
            if business_state is not None and not (action or {}).get("ok"):
                await logger.write({"ts": utc_now(), "event": "extended_hero_action_rejected", "session_id": session_id, "request_seq": request_info.get("seq"), "request_kind": request_kind, "transaction": action})
                await client.send(build_error_reply(request_info, str((action or {}).get("error") or "hero_action_rejected")))
                continue
            reply = build_extended_hero_reply(request_info, action)
            await log_structured_frame(logger, session_id, "local_structured_to_client", f"{request_kind}_reply", reply, request_info=request_info, replay_delay_ms=0)
            await client.send(reply)
            continue

        if request_kind == "stage_query_assist_summaries":
            delay_ms = templates.stage_reply.delay_ms
            if delay_ms > 0:
                await asyncio.sleep(delay_ms / 1000)
            stage_reply = None
            generated_from_db = False
            if business_state is not None:
                stage_reply = await business_state.build_stage_assist_reply(
                    request_info,
                    templates.stage_reply.payload,
                )
                generated_from_db = stage_reply is not None
            if stage_reply is None:
                stage_reply = build_structured_stage_reply(request_info, templates)
            await log_structured_frame(
                logger,
                session_id,
                "local_structured_to_client",
                "db_stage_assist_summaries" if generated_from_db else templates.stage_reply.label,
                stage_reply,
                request_info=request_info,
                replay_delay_ms=delay_ms,
            )
            if generated_from_db:
                await logger.write(
                    {
                        "ts": utc_now(),
                        "event": "business_response_generated",
                        "session_id": session_id,
                        "request_kind": request_kind,
                        "request_seq": request_info.get("seq"),
                        "business_generator": "stage_assist_summaries",
                        "source": "mysql",
                        "tables": ["players", "inventory_items", "characters", "stage_progress"],
                    }
                )
            await client.send(stage_reply)
            continue

        if request_kind == "stage_battle_start" and business_state is not None:
            battle_transaction = await business_state.authoritative_battle_start(
                "campaign", int(request_info.get("stage_id") or 1),
                request_info.get("lineup_ids") or [], request_info.get("seq"),
                # MuMu1's downloaded Classic stage table renders the 61-59
                # LevelList as native level 1004. The newer recovered server
                # catalogue uses 12730 for that same stage. Keep authority on
                # the actual installed-client scale until that resource set is
                # migrated as one versioned bundle.
                enemy_level_cap=int(os.getenv("AFK_CLASSIC_CAMPAIGN_ENEMY_LEVEL_CAP", "1004")),
            )
            request_info["battle_transaction"] = battle_transaction or {}

        if request_kind == "stage_battle_result" and business_state is not None:
            campaign_transaction = await business_state.campaign_result(
                request_info.get("battle_result") or "defeat",
                request_info.get("stage_id"),
                request_info.get("seq"),
            )
            request_info["campaign_transaction"] = campaign_transaction or {}

        if (
            request_kind in {"stage_battle_start", "stage_battle_result"}
            and interaction_fixture is not None
            and business_state is not None
        ):
            generator = request_kind
            template_response = None
            template_rule = None
            for candidate_rule in interaction_fixture.rules:
                if candidate_rule.match.get("kind") != request_kind:
                    continue
                for candidate_response in candidate_rule.responses:
                    if infer_business_generator(candidate_rule, candidate_response) == generator:
                        template_response = candidate_response
                        template_rule = candidate_rule
                        break
                if template_response is not None:
                    break
            if template_response is not None:
                template_message = decode_fixture_message(
                    template_response.message_type, template_response.payload
                )
                generated = (
                    await business_state.build_response(
                        generator, request_info, template_message
                    )
                    if isinstance(template_message, bytes)
                    else None
                )
                if generated is not None:
                    reply = generated["message"]
                    await log_structured_frame(
                        logger,
                        session_id,
                        "local_structured_to_client",
                        generated["label"],
                        reply,
                        request_info=request_info,
                        replay_delay_ms=0,
                    )
                    await logger.write(
                        {
                            "ts": utc_now(),
                            "event": "business_response_generated",
                            "session_id": session_id,
                            "request_kind": request_kind,
                            "request_seq": request_info.get("seq"),
                            "interaction_rule": template_rule.label,
                            "business_generator": generated["generator"],
                            "source": "mysql",
                            "tables": generated["tables"],
                            "signature_policy": "kind_fallback",
                        }
                    )
                    await client.send(reply)
                    continue

        if interaction_fixture:
            rule = find_interaction_rule(interaction_fixture, signature)
            if rule:
                await logger.write(
                    {
                        "ts": utc_now(),
                        "event": "interaction_rule_matched",
                        "session_id": session_id,
                        "interaction_rule": rule.label,
                        "request_kind": request_kind,
                        "request_seq": request_info.get("seq"),
                    }
                )
                await send_interaction_responses(
                    client,
                    session_id,
                    logger,
                    rule,
                    signature,
                    business_state=business_state,
                )
                continue

        if str(request_kind).startswith("generic_"):
            # The 1.201 Classic client can encode req_stage.query_reward as an
            # empty req_stage message after the HD/Classic transport adapter.
            # The generic schema synthesizer produces a parseable `idle`, but
            # not the full reward/timestamp projection consumed by the main
            # campaign screen. Reuse the authoritative dedicated stage reply
            # so the client can continue from Challenge into formation.
            if (
                request_info.get("generic_module") == "stage"
                and request_info.get("generic_operation") == "query_reward"
            ):
                idle = await business_state.idle_query() if business_state is not None else None
                reply = build_structured_idle_query_reply(request_info, idle)
                await log_structured_frame(
                    logger, session_id, "local_structured_to_client",
                    "stage_query_reward_dedicated_reply", reply,
                    request_info=request_info, replay_delay_ms=0,
                )
                await client.send(reply)
                continue
            if (
                request_info.get("generic_module") == "stage"
                and request_info.get("generic_operation") == "retry_battle"
                and business_state is not None
                and interaction_fixture is not None
            ):
                battle_transaction = await business_state.authoritative_battle_start(
                    "campaign",
                    int(request_info.get("stage_id") or 1),
                    request_info.get("lineup_ids") or [],
                    request_info.get("seq"),
                    enemy_level_cap=int(
                        os.getenv("AFK_CLASSIC_CAMPAIGN_ENEMY_LEVEL_CAP", "1004")
                    ),
                )
                request_info["battle_transaction"] = battle_transaction or {}
                start_template = None
                for candidate_rule in interaction_fixture.rules:
                    if candidate_rule.match.get("kind") != "stage_battle_start":
                        continue
                    for candidate_response in candidate_rule.responses:
                        if infer_business_generator(candidate_rule, candidate_response) == "stage_battle_start":
                            decoded = decode_fixture_message(
                                candidate_response.message_type,
                                candidate_response.payload,
                            )
                            if isinstance(decoded, bytes):
                                start_template = decoded
                                break
                    if start_template is not None:
                        break
                generated = (
                    await business_state.build_response(
                        "stage_battle_start", request_info, start_template
                    )
                    if start_template is not None
                    else None
                )
                reply = (
                    build_structured_stage_retry_reply(
                        request_info, generated["message"]
                    )
                    if generated is not None
                    else None
                )
                if reply is not None:
                    await log_structured_frame(
                        logger,
                        session_id,
                        "local_structured_to_client",
                        "db_stage_retry_battle",
                        reply,
                        request_info=request_info,
                        replay_delay_ms=0,
                    )
                    await logger.write({
                        "ts": utc_now(),
                        "event": "business_response_generated",
                        "session_id": session_id,
                        "request_kind": request_kind,
                        "request_seq": request_info.get("seq"),
                        "business_generator": "stage_retry_battle",
                        "source": "mysql",
                        "tables": ["players", "characters", "stage_progress", "battle_records"],
                        "team_index": request_info.get("team_index"),
                    })
                    await client.send(reply)
                    continue
            transaction = None
            if business_state is not None:
                if request_info.get("generic_module") == "equip":
                    equip_args = equip_game_action_args(request_info)
                    transaction = await business_state.game_action(
                        equip_args.pop("op"), **equip_args,
                        request_seq=request_info.get("seq"),
                        idempotency_key=f"ws:{session_id}:{request_info.get('seq')}:equip:{request_info.get('generic_operation')}",
                    )
                elif request_info.get("generic_module") == "tavern":
                    tavern_args = tavern_game_action_args(request_info)
                    transaction = await business_state.game_action(
                        tavern_args.pop("op"), **tavern_args,
                        request_seq=request_info.get("seq"),
                        idempotency_key=f"ws:{session_id}:{request_info.get('seq')}:tavern:{request_info.get('generic_operation')}",
                    )
                elif request_info.get("generic_module") == "guild_manor":
                    guild_action = await business_state.game_action("guild_open")
                    transaction = {
                        "ok": bool((guild_action or {}).get("ok")),
                        "guild_action": guild_action or {},
                        "current_player_uid": business_state.player_uid,
                    }
                else:
                    transaction = await business_state.system_action(
                        request_info.get("generic_module", "unknown"),
                        request_info.get("generic_operation", "info"),
                        request_seq=request_info.get("seq"),
                        idempotency_key=f"ws:{session_id}:{request_info.get('seq')}:{request_info.get('generic_module')}:{request_info.get('generic_operation')}",
                        payload=request_info.get("generic_payload") or {},
                        include_config=False,
                    )
                if request_info.get("generic_module") in ("friend", "homeland_friend"):
                    social_friends = await business_state.social_friends()
                    transaction = {**(transaction or {}), "social_friends": social_friends or {}}
            if transaction is not None and transaction.get("ok") is False:
                reply = build_error_reply(request_info, str(transaction.get("error") or "request_rejected"))
            else:
                reply = build_generic_protocol_reply(request_info, transaction)
            await log_structured_frame(
                logger, session_id, "local_structured_to_client",
                f"{request_info.get('generic_module')}_{request_info.get('generic_operation')}_generic_reply",
                reply, request_info=request_info, replay_delay_ms=0,
            )
            await logger.write({
                "ts": utc_now(), "event": "generic_protocol_route_served",
                "session_id": session_id, "request_seq": request_info.get("seq"),
                "module": request_info.get("generic_module"),
                "operation": request_info.get("generic_operation"),
                "persisted": bool((transaction or {}).get("ok")),
                "evidence_level": "official_proto_schema_and_config_local_domain_engine",
            })
            await client.send(reply)
            continue

        fallback = parse_generic_protocol_request(request_message)
        if fallback is not None:
            transaction = None
            if business_state is not None:
                if fallback.get("generic_module") == "equip":
                    equip_args = equip_game_action_args(fallback)
                    transaction = await business_state.game_action(
                        equip_args.pop("op"), **equip_args,
                        request_seq=fallback.get("seq"),
                        idempotency_key=f"ws:{session_id}:{fallback.get('seq')}:equip:{fallback.get('generic_operation')}",
                    )
                elif fallback.get("generic_module") == "tavern":
                    tavern_args = tavern_game_action_args(fallback)
                    transaction = await business_state.game_action(
                        tavern_args.pop("op"), **tavern_args,
                        request_seq=fallback.get("seq"),
                        idempotency_key=f"ws:{session_id}:{fallback.get('seq')}:tavern:{fallback.get('generic_operation')}",
                    )
                elif fallback.get("generic_module") == "guild_manor":
                    guild_action = await business_state.game_action("guild_open")
                    transaction = {
                        "ok": bool((guild_action or {}).get("ok")),
                        "guild_action": guild_action or {},
                        "current_player_uid": business_state.player_uid,
                    }
                else:
                    transaction = await business_state.system_action(
                        fallback.get("generic_module", "unknown"),
                        fallback.get("generic_operation", "info"),
                        request_seq=fallback.get("seq"),
                        idempotency_key=f"ws:{session_id}:{fallback.get('seq')}:{fallback.get('generic_module')}:{fallback.get('generic_operation')}",
                        payload=fallback.get("generic_payload") or {},
                        include_config=False,
                    )
                if fallback.get("generic_module") in ("friend", "homeland_friend"):
                    social_friends = await business_state.social_friends()
                    transaction = {**(transaction or {}), "social_friends": social_friends or {}}
            if transaction is not None and transaction.get("ok") is False:
                reply = build_error_reply(fallback, str(transaction.get("error") or "request_rejected"))
            else:
                reply = build_generic_protocol_reply(fallback, transaction)
            await log_structured_frame(
                logger, session_id, "local_structured_to_client",
                f"{fallback.get('generic_module')}_{fallback.get('generic_operation')}_domain_fallback_reply",
                reply, request_info=fallback, replay_delay_ms=0,
            )
            await logger.write({
                "ts": utc_now(), "event": "specialized_route_domain_fallback",
                "session_id": session_id, "request_seq": fallback.get("seq"),
                "original_kind": request_kind, "module": fallback.get("generic_module"),
                "operation": fallback.get("generic_operation"),
                "persisted": bool((transaction or {}).get("ok")),
            })
            await client.send(reply)
            continue

        await logger.write(
            {
                "ts": utc_now(),
                "event": "structured_login_unhandled_post_login_request",
                "session_id": session_id,
                "request_kind": request_kind,
                "request_seq": request_info.get("seq"),
                "request_signature": signature,
                "message_type": format_message(request_message)["message_type"],
                "size": format_message(request_message)["size"],
            }
        )


async def run_interaction_session(
    client: ServerConnection,
    session_id: int,
    logger: JsonlLogger,
    interaction_fixture: InteractionFixture,
    business_state: BusinessStateProvider | None = None,
) -> None:
    await logger.write(
        {
            "ts": utc_now(),
            "event": "interaction_started",
            "session_id": session_id,
            "rule_count": len(interaction_fixture.rules),
            "auto_heartbeat": interaction_fixture.auto_heartbeat,
            "unmatched_policy": interaction_fixture.unmatched_policy,
            "fixture_path": interaction_fixture.fixture_path,
        }
    )

    while True:
        request_message = await client.recv()
        signature = request_signature(request_message)
        request_info = parse_client_message_kind(request_message)
        await logger.write(
            {
                "ts": utc_now(),
                "event": "frame",
                "session_id": session_id,
                "direction": "client_to_local_interaction",
                "request_kind": request_info.get("kind"),
                "request_seq": request_info.get("seq"),
                "request_signature": signature,
                **format_message(request_message),
            }
        )

        if interaction_fixture.auto_heartbeat and request_info.get("kind") == "heartbeat":
            heartbeat_reply = try_build_heartbeat_reply(request_message)
            if heartbeat_reply is not None:
                await log_structured_frame(
                    logger,
                    session_id,
                    "local_interaction_to_client",
                    "auto_heartbeat",
                    heartbeat_reply,
                    request_info=request_info,
                )
                await client.send(heartbeat_reply)
                continue

        rule = find_interaction_rule(interaction_fixture, signature)
        if rule is None:
            await logger.write(
                {
                    "ts": utc_now(),
                    "event": "interaction_unmatched_request",
                    "session_id": session_id,
                    "request_kind": request_info.get("kind"),
                    "request_seq": request_info.get("seq"),
                    "unmatched_policy": interaction_fixture.unmatched_policy,
                    "request_signature": signature,
                }
            )
            if interaction_fixture.unmatched_policy == "close":
                await client.close(code=1008, reason="unmatched local interaction")
                return
            continue

        await logger.write(
            {
                "ts": utc_now(),
                "event": "interaction_rule_matched",
                "session_id": session_id,
                "interaction_rule": rule.label,
                "request_kind": request_info.get("kind"),
                "request_seq": request_info.get("seq"),
            }
        )
        await send_interaction_responses(
            client,
            session_id,
            logger,
            rule,
            signature,
            business_state=business_state,
        )


async def run_proxy(args: argparse.Namespace) -> None:
    mysql_writer = MysqlWsWriter(enabled=not args.no_mysql)
    await mysql_writer.connect()
    login_persistence = LoginPersistence(enabled=not args.no_login_mysql)
    await login_persistence.connect()
    logger = JsonlLogger(Path(args.log_file), mysql_writer=mysql_writer)
    session_counter = count(1)
    replay_fixture = normalize_replay_fixture(args.replay_fixture)
    interaction_fixture = (
        load_interaction_fixture_from_mysql(
            unmatched_policy=args.interaction_db_unmatched_policy,
            auto_heartbeat=not args.interaction_db_no_auto_heartbeat,
        )
        if args.interaction_db
        else normalize_interaction_fixture(args.interaction_fixture)
    )
    structured_login_templates = (
        build_structured_login_templates(args.structured_login_fixture)
        if args.structured_login_fixture
        else None
    )

    if args.interaction_db and interaction_fixture is None:
        raise ValueError("No enabled interaction rules found in MySQL ws_interaction_rules.")

    async def handler(client: ServerConnection) -> None:
        session_id = next(session_counter)
        business_state = BusinessStateProvider(enabled=not args.no_business_mysql)
        await business_state.connect()
        request = getattr(client, "request", None)
        client_path = getattr(request, "path", None)
        request_headers = dict(request.headers) if request else {}

        await logger.write(
            {
                "ts": utc_now(),
                "event": "client_connected",
                "session_id": session_id,
                "client_path": client_path,
                "client_subprotocol": client.subprotocol,
                "request_headers": request_headers,
            }
        )
        compatible_client = CompatibleClientConnection(client)

        try:
            if client_path and str(client_path).split("?", 1)[0] == "/im":
                async with connect(
                    args.im_upstream_url,
                    open_timeout=args.open_timeout,
                    ping_interval=None,
                    ping_timeout=None,
                    max_size=None,
                    max_queue=None,
                    compression=None,
                    proxy=None,
                ) as im_upstream:
                    relay_up = asyncio.create_task(
                        relay_messages(client, im_upstream, "client_to_im", session_id, logger)
                    )
                    relay_down = asyncio.create_task(
                        relay_messages(im_upstream, client, "im_to_client", session_id, logger)
                    )
                    done, pending = await asyncio.wait(
                        {relay_up, relay_down}, return_when=asyncio.FIRST_EXCEPTION
                    )
                    for task in pending:
                        task.cancel()
                    await asyncio.gather(*pending, return_exceptions=True)
                    for task in done:
                        task.result()
                return
            if structured_login_templates:
                await run_structured_login_session(
                    compatible_client,
                    session_id,
                    logger,
                    structured_login_templates,
                    interaction_fixture=interaction_fixture,
                    login_persistence=login_persistence,
                    business_state=business_state,
                )
            elif replay_fixture:
                await logger.write(
                    {
                        "ts": utc_now(),
                        "event": "replay_started",
                        "session_id": session_id,
                        "event_count": len(replay_fixture["events"]),
                        "auto_heartbeat": replay_fixture.get("auto_heartbeat", False),
                        "fixture_path": args.replay_fixture,
                    }
                )
                await run_replay_session(compatible_client, session_id, logger, replay_fixture)
            elif interaction_fixture:
                await run_interaction_session(
                    compatible_client,
                    session_id,
                    logger,
                    interaction_fixture,
                    business_state=business_state,
                )
            else:
                connect_kwargs = {
                    "open_timeout": args.open_timeout,
                    "ping_interval": None,
                    "ping_timeout": None,
                    "max_size": None,
                    "max_queue": None,
                    "compression": None,
                    "proxy": None,
                }

                if client.subprotocol:
                    connect_kwargs["subprotocols"] = [client.subprotocol]

                async with connect(args.upstream_url, **connect_kwargs) as upstream:
                    await logger.write(
                        {
                            "ts": utc_now(),
                            "event": "upstream_connected",
                            "session_id": session_id,
                            "upstream_url": args.upstream_url,
                            "upstream_subprotocol": upstream.subprotocol,
                        }
                    )

                    relay_up = asyncio.create_task(
                        relay_messages(client, upstream, "client_to_upstream", session_id, logger)
                    )
                    relay_down = asyncio.create_task(
                        relay_messages(upstream, client, "upstream_to_client", session_id, logger)
                    )

                    done, pending = await asyncio.wait(
                        {relay_up, relay_down},
                        return_when=asyncio.FIRST_EXCEPTION,
                    )

                    for task in pending:
                        task.cancel()

                    await asyncio.gather(*pending, return_exceptions=True)

                    for task in done:
                        task.result()
        except ConnectionClosed as exc:
            await logger.write(
                {
                    "ts": utc_now(),
                    "event": "client_closed",
                    "session_id": session_id,
                    "code": exc.code,
                    "reason": exc.reason,
                }
            )
        except Exception as exc:
            await logger.write(
                {
                    "ts": utc_now(),
                    "event": "proxy_error",
                    "session_id": session_id,
                    "error": repr(exc),
                }
            )
            try:
                await client.close(code=1011, reason="upstream connect failed")
            except Exception:
                pass
            raise
        finally:
            await business_state.close()
            await logger.write(
                {
                    "ts": utc_now(),
                    "event": "session_closed",
                    "session_id": session_id,
                }
            )

    server_options = {
        "select_subprotocol": choose_subprotocol,
        "compression": None,
        "ping_interval": None,
        "ping_timeout": None,
        "max_size": None,
        "max_queue": None,
        "server_header": None,
    }
    async with contextlib.AsyncExitStack() as server_stack:
        await server_stack.enter_async_context(
            serve(handler, args.listen_host, args.listen_port, **server_options)
        )
        if args.tls_listen_port:
            if not args.tls_cert_file or not args.tls_key_file:
                raise ValueError("TLS websocket listener requires --tls-cert-file and --tls-key-file")
            tls_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            tls_context.load_cert_chain(args.tls_cert_file, args.tls_key_file)
            await server_stack.enter_async_context(
                serve(
                    handler,
                    args.listen_host,
                    args.tls_listen_port,
                    ssl=tls_context,
                    **server_options,
                )
            )
        try:
            print(
                f"WebSocket proxy listening on ws://{args.listen_host}:{args.listen_port} -> {args.upstream_url}",
                flush=True,
            )
            if args.tls_listen_port:
                print(
                    f"WebSocket proxy listening on wss://{args.listen_host}:{args.tls_listen_port}",
                    flush=True,
                )
            await asyncio.Future()
        finally:
            await logger.close()
            await login_persistence.close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Transparent websocket proxy/logger for AFK game login traffic.")
    parser.add_argument("--listen-host", default="127.0.0.1")
    parser.add_argument("--listen-port", type=int, default=15007)
    parser.add_argument("--tls-listen-port", type=int, default=0)
    parser.add_argument("--tls-cert-file")
    parser.add_argument("--tls-key-file")
    parser.add_argument("--upstream-url", default="ws://148.178.21.210:15007")
    parser.add_argument("--im-upstream-url", default="ws://127.0.0.1:15008")
    parser.add_argument("--log-file", default=str(Path(__file__).resolve().parent / "logs" / "ws-frames.jsonl"))
    parser.add_argument("--replay-fixture")
    parser.add_argument("--structured-login-fixture")
    parser.add_argument("--interaction-fixture")
    parser.add_argument(
        "--interaction-db",
        action="store_true",
        help="Load enabled interaction rules from MySQL ws_interaction_rules.",
    )
    parser.add_argument(
        "--interaction-db-unmatched-policy",
        choices=("log", "close"),
        default=os.environ.get("AFK_WS_INTERACTION_DB_UNMATCHED_POLICY", "log"),
        help="Policy for unmatched requests when using --interaction-db.",
    )
    parser.add_argument(
        "--interaction-db-no-auto-heartbeat",
        action="store_true",
        default=(os.environ.get("AFK_WS_INTERACTION_DB_AUTO_HEARTBEAT", "1") == "0"),
        help="Disable auto heartbeat replies when using --interaction-db.",
    )
    parser.add_argument(
        "--no-mysql",
        action="store_true",
        default=(os.environ.get("AFK_WS_DB_ENABLED", "1") == "0"),
        help="Disable direct writes to MySQL ws_frame_logs.",
    )
    parser.add_argument(
        "--no-login-mysql",
        action="store_true",
        default=(os.environ.get("AFK_LOGIN_DB_ENABLED", "1") == "0"),
        help="Disable structured login writes to MySQL accounts/sessions/players.",
    )
    parser.add_argument(
        "--no-business-mysql",
        action="store_true",
        default=(os.environ.get("AFK_BUSINESS_DB_ENABLED", "1") == "0"),
        help="Disable DB-generated business responses from inventory/characters/stage state.",
    )
    parser.add_argument("--open-timeout", type=float, default=10.0)
    args = parser.parse_args()
    if args.replay_fixture and args.structured_login_fixture:
        parser.error("--replay-fixture and --structured-login-fixture cannot be used together.")
    if args.replay_fixture and args.interaction_fixture:
        parser.error("--replay-fixture and --interaction-fixture cannot be used together.")
    if args.interaction_fixture and args.interaction_db:
        parser.error("--interaction-fixture and --interaction-db cannot be used together.")
    if args.replay_fixture and args.interaction_db:
        parser.error("--replay-fixture and --interaction-db cannot be used together.")
    return args


if __name__ == "__main__":
    asyncio.run(run_proxy(parse_args()))
