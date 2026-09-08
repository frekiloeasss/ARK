#!/usr/bin/env python3
import asyncio
import argparse
import base64
import json
from pathlib import Path

import websockets

from afk_protocol import encode_length_delimited_field, encode_varint_field


ROOT = Path(__file__).resolve().parent
LOGIN_FIXTURE = ROOT / "data" / "fixtures" / "ws-login-timeline-1.json"


def decode_event(event: dict) -> str | bytes:
    if event["message_type"] == "text":
        return event["payload"]
    return base64.b64decode(event["payload"])


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
    raise ValueError("invalid varint")


def parse_fields(buffer: bytes) -> list[tuple[int, int, int | bytes]]:
    fields = []
    offset = 0
    while offset < len(buffer):
        key, offset = decode_varint(buffer, offset)
        number = key >> 3
        wire_type = key & 0x07
        if wire_type == 0:
            value, offset = decode_varint(buffer, offset)
        elif wire_type == 2:
            size, offset = decode_varint(buffer, offset)
            value = buffer[offset:offset + size]
            offset += size
        else:
            raise ValueError(f"unsupported wire type: {wire_type}")
        fields.append((number, wire_type, value))
    return fields


def get_varint(fields: list[tuple[int, int, int | bytes]], number: int) -> int | None:
    for field_number, wire_type, value in fields:
        if field_number == number and wire_type == 0:
            return int(value)
    return None


def get_blob(fields: list[tuple[int, int, int | bytes]], number: int) -> bytes | None:
    for field_number, wire_type, value in fields:
        if field_number == number and wire_type == 2:
            return bytes(value)
    return None


def reply_kind(message: str | bytes) -> tuple[str, int | None]:
    if not isinstance(message, bytes):
        return "text", None

    fields = parse_fields(message)
    seq = get_varint(fields, 2)
    if get_blob(fields, 31) is not None:
        return "sdk_login_reply", seq
    if get_blob(fields, 4) is not None:
        return "login_reply", seq
    if get_blob(fields, 32) is not None:
        return "charge_reply", seq
    if get_blob(fields, 9) is not None and seq == 0:
        return "server_push", seq
    if get_blob(fields, 6) is not None:
        return "stage_reply", seq
    if get_blob(fields, 5) is not None:
        return "hero_upgrade_reply", seq
    if get_blob(fields, 13) is not None:
        return "tavern_reply", seq
    if b"\xaa\x01" in message:
        return "heartbeat_reply", seq
    return "unknown", seq


async def main(url: str) -> None:
    fixture = json.loads(LOGIN_FIXTURE.read_text(encoding="utf-8"))
    by_index = {event["index"]: event for event in fixture["events"]}
    steps = [
        (1, None),
        (2, "sdk_login_reply"),
        (3, None),
        (4, "login_reply"),
        (5, None),
        (6, "charge_reply"),
        (7, "server_push"),
        (8, None),
        (9, "heartbeat_reply"),
        (10, None),
        (11, "stage_reply"),
    ]

    async with websockets.connect(url, max_size=None) as websocket:
        for index, expected_kind in steps:
            event = by_index[index]
            if event["kind"] == "expect_client":
                await websocket.send(decode_event(event))
                print(f"sent event_{index}")
                continue

            message = await asyncio.wait_for(websocket.recv(), timeout=6)
            kind, seq = reply_kind(message)
            print(f"recv event_{index}: kind={kind} seq={seq} bytes={len(message)}")
            if kind != expected_kind:
                raise AssertionError(f"event_{index}: expected {expected_kind}, got {kind}")

        await websocket.send(decode_event(by_index[10]))
        message = await asyncio.wait_for(websocket.recv(), timeout=6)
        kind, seq = reply_kind(message)
        print(f"interaction replay: kind={kind} seq={seq} bytes={len(message)}")
        if kind != "stage_reply" or seq != 104:
            raise AssertionError(f"interaction replay failed: kind={kind} seq={seq}")

        tavern_seq = 105
        tavern_request = b"".join(
            (
                encode_varint_field(1, tavern_seq),
                encode_varint_field(2, 0),
                encode_length_delimited_field(
                    11,
                    encode_length_delimited_field(2, encode_varint_field(1, 1)),
                ),
            )
        )
        await websocket.send(tavern_request)
        message = await asyncio.wait_for(websocket.recv(), timeout=6)
        kind, seq = reply_kind(message)
        print(f"tavern draw: kind={kind} seq={seq} bytes={len(message)}")
        if kind != "tavern_reply" or seq != tavern_seq:
            raise AssertionError(f"tavern draw failed: kind={kind} seq={seq}")

        ten_seq = 106
        ten_request = b"".join(
            (
                encode_varint_field(1, ten_seq),
                encode_varint_field(2, 0),
                encode_length_delimited_field(
                    11,
                    encode_length_delimited_field(2, encode_varint_field(1, 2)),
                ),
            )
        )
        await websocket.send(ten_request)
        message = await asyncio.wait_for(websocket.recv(), timeout=6)
        kind, seq = reply_kind(message)
        outer = parse_fields(message)
        tavern = parse_fields(get_blob(outer, 13) or b"")
        draw = parse_fields(get_blob(tavern, 2) or b"")
        reward = parse_fields(get_blob(draw, 1) or b"")
        hero_count = sum(1 for number, wire, _ in reward if number == 3 and wire == 2)
        print(f"tavern ten draw: kind={kind} seq={seq} heroes={hero_count} bytes={len(message)}")
        if kind != "tavern_reply" or seq != ten_seq or hero_count != 10:
            raise AssertionError(
                f"tavern ten draw failed: kind={kind} seq={seq} heroes={hero_count}"
            )

        hero_seq = 107
        up_level = b"".join((encode_varint_field(1, 1), encode_varint_field(2, 1)))
        hero_request = b"".join(
            (
                encode_varint_field(1, hero_seq),
                encode_varint_field(2, 0),
                encode_length_delimited_field(4, encode_length_delimited_field(1, up_level)),
            )
        )
        await websocket.send(hero_request)
        message = await asyncio.wait_for(websocket.recv(), timeout=6)
        kind, seq = reply_kind(message)
        print(f"hero upgrade: kind={kind} seq={seq} bytes={len(message)}")
        if kind != "hero_upgrade_reply" or seq != hero_seq:
            raise AssertionError(f"hero upgrade failed: kind={kind} seq={seq}")

        charge_seq = 108
        charge_request = b"".join(
            (
                encode_varint_field(1, charge_seq),
                encode_varint_field(2, 0),
                encode_length_delimited_field(30, b"\x0a\x00"),
                encode_length_delimited_field(57, b"0" * 32),
            )
        )
        await websocket.send(charge_request)
        message = await asyncio.wait_for(websocket.recv(), timeout=6)
        kind, seq = reply_kind(message)
        print(f"post-login charge refresh: kind={kind} seq={seq} bytes={len(message)}")
        if kind != "charge_reply" or seq != charge_seq:
            raise AssertionError(f"post-login charge refresh failed: kind={kind} seq={seq}")

    print("structured + interaction validation ok")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate structured login and interaction replay."
    )
    parser.add_argument("--url", default="ws://127.0.0.1:15007")
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    asyncio.run(main(args.url))
