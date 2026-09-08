"""Small protobuf-wire helpers used by the AFK WebSocket compatibility layer.

The captured client protocol doesn't ship with complete generated protobuf
classes.  These helpers intentionally support only the wire types observed in
the client traffic (varint and length-delimited fields).
"""

import hashlib
from dataclasses import dataclass
from datetime import datetime, timezone


def encode_varint(value: int) -> bytes:
    if value < 0:
        raise ValueError("Varint cannot encode negative values.")
    encoded = bytearray()
    while value >= 0x80:
        encoded.append((value & 0x7F) | 0x80)
        value >>= 7
    encoded.append(value)
    return bytes(encoded)


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


def encode_varint_field(field_number: int, value: int) -> bytes:
    return encode_varint(field_number << 3) + encode_varint(value)


def encode_length_delimited_field(field_number: int, payload: bytes) -> bytes:
    return encode_varint((field_number << 3) | 2) + encode_varint(len(payload)) + payload


def current_server_timestamp() -> int:
    return int(datetime.now(timezone.utc).timestamp())


@dataclass
class ProtoField:
    number: int
    wire_type: int
    value: int | bytes


def parse_proto_fields(buffer: bytes) -> list[ProtoField]:
    fields: list[ProtoField] = []
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
    return None if payload is None else payload.decode("utf-8")


def decode_proto_text(payload: bytes) -> str:
    return payload.decode("utf-8")


def get_repeated_proto_bytes(fields: list[ProtoField], field_number: int) -> list[bytes]:
    return [
        bytes(field.value)
        for field in fields
        if field.number == field_number and field.wire_type == 2
    ]


def get_repeated_proto_varints(fields: list[ProtoField], field_number: int) -> list[int]:
    return [
        int(field.value)
        for field in fields
        if field.number == field_number and field.wire_type == 0
    ]


def proto_field_fingerprint(fields: list[ProtoField]) -> list[dict]:
    fingerprint = []
    for field in fields:
        entry = {"number": field.number, "wire_type": field.wire_type}
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
    return {
        (1,): "stage_idle_query",
        (2,): "stage_idle_claim",
        (6,): "stage_query_assist_summaries",
        (3,): "stage_battle_start",
        (4,): "stage_battle_result",
        (5,): "stage_quick_idle_claim",
    }.get(tuple(top_numbers), "stage_field5_unknown")


def classify_field11_request(payload: bytes) -> str:
    try:
        fields = parse_proto_fields(payload)
    except ValueError:
        return "field11_unknown"
    top_shape = [
        (field.number, field.wire_type, len(field.value) if field.wire_type == 2 else None)
        for field in fields
    ]
    if top_shape == [(1, 2, 0)]:
        return "tavern_open_panel"
    if top_shape == [(2, 2, 2)]:
        return "tavern_draw"
    return "field11_unknown"


def classify_field13_request(payload: bytes) -> str:
    try:
        fields = parse_proto_fields(payload)
    except ValueError:
        return "field13_unknown"
    numbers = [field.number for field in fields]
    if fields and all(field.number == 7 and field.wire_type == 0 for field in fields):
        return "task_batch_claim"
    if fields and all(field.number == 8 and field.wire_type == 0 for field in fields):
        # The captured 1.182 session used [1,4,5,6] here and the official
        # response identified it as a todo batch. Other field-8 sets follow
        # the recovered schema's batch-chest declaration.
        values = [int(field.value) for field in fields]
        return "task_batch_claim" if values == [1, 4, 5, 6] else "task_batch_chest"
    return {
        (1,): "task_info",
        (2,): "task_chest",
        (3,): "task_claim",
        (4,): "task_line_claim",
        (5,): "task_community",
        (6,): "task_bind",
        (9,): "task_batch_line",
    }.get(tuple(numbers), "field13_unknown")


def replace_top_level_varint_field(buffer: bytes, field_number: int, value: int) -> bytes:
    fields = parse_proto_fields(buffer)
    parts = []
    replaced = False
    for field in fields:
        if field.number == field_number and field.wire_type == 0:
            parts.append(encode_varint_field(field_number, value))
            replaced = True
        elif field.wire_type == 0:
            parts.append(encode_varint_field(field.number, int(field.value)))
        elif field.wire_type == 2:
            parts.append(encode_length_delimited_field(field.number, bytes(field.value)))
        else:
            raise ValueError(f"Unsupported wire type: {field.wire_type}")
    if not replaced:
        parts.insert(0, encode_varint_field(field_number, value))
    return b"".join(parts)


def encode_proto_fields(fields: list[ProtoField]) -> bytes:
    parts = []
    for field in fields:
        if field.wire_type == 0:
            parts.append(encode_varint_field(field.number, int(field.value)))
        elif field.wire_type == 2:
            parts.append(encode_length_delimited_field(field.number, bytes(field.value)))
        else:
            raise ValueError(f"Unsupported wire type: {field.wire_type}")
    return b"".join(parts)


def set_proto_varint(fields: list[ProtoField], field_number: int, value: int) -> list[ProtoField]:
    updated = []
    replaced = False
    for field in fields:
        if field.number == field_number and field.wire_type == 0:
            updated.append(ProtoField(field.number, field.wire_type, int(value)))
            replaced = True
        else:
            updated.append(field)
    if not replaced:
        updated.append(ProtoField(field_number, 0, int(value)))
    return updated


def set_proto_bytes(fields: list[ProtoField], field_number: int, value: bytes) -> list[ProtoField]:
    updated = []
    replaced = False
    for field in fields:
        if field.number == field_number and field.wire_type == 2:
            updated.append(ProtoField(field.number, field.wire_type, value))
            replaced = True
        else:
            updated.append(field)
    if not replaced:
        updated.append(ProtoField(field_number, 2, value))
    return updated


def set_proto_repeated_varints(
    fields: list[ProtoField], field_number: int, values: list[int]
) -> list[ProtoField]:
    updated = []
    inserted = False
    for field in fields:
        if field.number == field_number and field.wire_type == 0:
            if not inserted:
                updated.extend(ProtoField(field_number, 0, int(value)) for value in values)
                inserted = True
            continue
        updated.append(field)
    if not inserted:
        updated.extend(ProtoField(field_number, 0, int(value)) for value in values)
    return updated


def set_proto_repeated_bytes(
    fields: list[ProtoField], field_number: int, values: list[bytes]
) -> list[ProtoField]:
    updated = []
    inserted = False
    for field in fields:
        if field.number == field_number and field.wire_type == 2:
            if not inserted:
                updated.extend(ProtoField(field_number, 2, value) for value in values)
                inserted = True
            continue
        updated.append(field)
    if not inserted:
        updated.extend(ProtoField(field_number, 2, value) for value in values)
    return updated
