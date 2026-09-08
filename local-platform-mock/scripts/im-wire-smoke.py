#!/usr/bin/env python3
import asyncio
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from websockets.asyncio.client import connect

from afk_protocol import (
    encode_length_delimited_field,
    encode_varint_field,
    get_proto_bytes,
    get_proto_text,
    get_proto_varint,
    get_repeated_proto_bytes,
    parse_proto_fields,
)


def request(seq: int, request_type: int, payload: bytes = b"") -> bytes:
    return b"".join(
        (
            encode_varint_field(1, seq),
            encode_varint_field(2, request_type),
            encode_length_delimited_field(request_type, payload),
        )
    )


async def main(url: str) -> None:
    evidence = {}
    async with connect(url, max_size=4 * 1024 * 1024) as socket:
        login = encode_varint_field(2, 211123) + encode_length_delimited_field(4, b"afk-private-cn")
        await socket.send(request(1, 100, login))
        fields = parse_proto_fields(await socket.recv())
        assert get_proto_varint(fields, 2) == 101
        login_resp = parse_proto_fields(get_proto_bytes(fields, 101) or b"")
        evidence["login_version"] = get_proto_text(login_resp, 1)

        await socket.send(request(2, 120))
        fields = parse_proto_fields(await socket.recv())
        assert get_proto_varint(fields, 2) == 121
        evidence["friend_response"] = True

        await socket.send(request(3, 140))
        fields = parse_proto_fields(await socket.recv())
        assert get_proto_varint(fields, 2) == 141
        evidence["blacklist_response"] = True

        await socket.send(request(4, 220))
        fields = parse_proto_fields(await socket.recv())
        channels = get_repeated_proto_bytes(parse_proto_fields(get_proto_bytes(fields, 221) or b""), 1)
        assert channels
        evidence["channel_count"] = len(channels)

        message_list = encode_length_delimited_field(
            1,
            encode_varint_field(1, 4)
            + encode_varint_field(2, 3_000_000_001)
            + encode_varint_field(3, 1)
            + encode_varint_field(4, 2**31 - 1),
        )
        await socket.send(request(5, 200, message_list))
        fields = parse_proto_fields(await socket.recv())
        assert get_proto_varint(fields, 2) == 201
        results = get_repeated_proto_bytes(parse_proto_fields(get_proto_bytes(fields, 201) or b""), 1)
        evidence["history_result_count"] = len(results)

    print(json.dumps({"ok": True, **evidence}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="ws://127.0.0.1:15008")
    asyncio.run(main(parser.parse_args().url))
