#!/usr/bin/env python3
"""Exercise three authenticated IM sessions and cross-account realtime pushes."""

import asyncio
import json
import sys
from pathlib import Path
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from websockets.asyncio.client import connect

from afk_protocol import (
    encode_length_delimited_field,
    encode_varint_field,
    get_proto_bytes,
    get_proto_varint,
    parse_proto_fields,
)

BASE_URL = "http://127.0.0.1:18080"
IM_URL = "ws://127.0.0.1:15007/im"
WORLD_CHANNEL_ID = 3_000_000_001
GUILD_CHANNEL_ID = 2_000_000_001


def http_json(path: str, payload: dict) -> dict:
    request = Request(
        BASE_URL + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


def pack(seq: int, pack_type: int, payload: bytes = b"") -> bytes:
    return b"".join((
        encode_varint_field(1, seq),
        encode_varint_field(2, pack_type),
        encode_length_delimited_field(pack_type, payload),
    ))


def pack_type(raw: bytes) -> int:
    return int(get_proto_varint(parse_proto_fields(raw), 2) or 0)


async def receive_type(socket, expected: int, timeout: float = 5.0) -> bytes:
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            raise TimeoutError(f"missing IM pack type {expected}")
        raw = await asyncio.wait_for(socket.recv(), remaining)
        if pack_type(raw) == expected:
            return raw


async def open_session(uid: int, token: str):
    socket = await connect(IM_URL, max_size=4 * 1024 * 1024)
    login = b"".join((
        encode_varint_field(1, 1),
        encode_varint_field(2, uid),
        encode_length_delimited_field(4, b"afk-private-cn"),
        encode_length_delimited_field(5, token.encode("utf-8")),
    ))
    await socket.send(pack(1, 100, login))
    await receive_type(socket, 101)
    return socket


async def send_chat(socket, seq: int, channel_type: int, channel_id: int, message: str):
    payload = b"".join((
        encode_varint_field(1, channel_type),
        encode_varint_field(2, channel_id),
        encode_length_delimited_field(4, message.encode("utf-8")),
    ))
    await socket.send(pack(seq, 202, payload))
    response_raw = await receive_type(socket, 203)
    response_body = parse_proto_fields(get_proto_bytes(parse_proto_fields(response_raw), 203) or b"")
    message_id = int(get_proto_varint(response_body, 2) or 0)
    if message_id <= 0:
        raise AssertionError("chat send returned no message id")
    await receive_type(socket, 1000)
    return message_id


async def main() -> None:
    accounts = [
        ("afk_test01", "AfkTest012026", 68, 211121),
        ("afk_test02", "AfkTest022026", 69, 211122),
        ("afk_test03", "AfkTest032026", 70, 211123),
    ]
    tokens = []
    for username, password, player_id, _ in accounts:
        login = await asyncio.to_thread(http_json, "/__afk/accounts/login", {"username": username, "password": password})
        if not login.get("ok") or int(login.get("player_id") or 0) != player_id:
            raise AssertionError(f"account login mismatch for {username}")
        tokens.append(login["token"])

    sockets = []
    try:
        for (_, _, _, uid), token in zip(accounts, tokens):
            sockets.append(await open_session(uid, token))

        # Re-create 01 <-> 02 friendship through the native IM request protocol.
        await asyncio.to_thread(http_json, "/__afk/social/friends", {
            "player_uid": "local-account:55", "friend_player_id": 69, "action": "remove",
        })
        await sockets[0].send(pack(10, 126, encode_varint_field(1, 69)))
        await receive_type(sockets[0], 127)
        await sockets[1].send(pack(11, 124))
        incoming_raw = await receive_type(sockets[1], 125)
        incoming = parse_proto_fields(get_proto_bytes(parse_proto_fields(incoming_raw), 125) or b"")
        if not any(field.number == 2 for field in incoming):
            raise AssertionError("test02 did not receive test01 friend request")
        await sockets[1].send(pack(12, 128, encode_varint_field(1, 68)))
        await receive_type(sockets[1], 129)
        await sockets[0].send(pack(13, 120))
        friend_raw = await receive_type(sockets[0], 121)
        friend_body = parse_proto_fields(get_proto_bytes(parse_proto_fields(friend_raw), 121) or b"")
        if 69 not in [int(field.value) for field in friend_body if field.number == 1 and field.wire_type == 0]:
            raise AssertionError("accepted friendship not visible to test01")

        # The prior blacklist regression intentionally left test03 blocking
        # test01.  Clear that fixture and establish the friendship required by
        # native private chat before testing target-only delivery.
        await asyncio.to_thread(http_json, "/__afk/social/friends", {
            "player_uid": "local-account:57", "friend_player_id": 68, "action": "unblock",
        })
        await asyncio.to_thread(http_json, "/__afk/social/friends", {
            "player_uid": "local-account:57", "friend_player_id": 68, "action": "request",
        })
        await asyncio.to_thread(http_json, "/__afk/social/friends", {
            "player_uid": "local-account:55", "friend_player_id": 70, "action": "accept",
        })

        marker = str(int(asyncio.get_running_loop().time() * 1000))
        world_id = await send_chat(sockets[0], 20, 4, WORLD_CHANNEL_ID, f"world-{marker}")
        await receive_type(sockets[1], 1000)
        await receive_type(sockets[2], 1000)

        guild_id = await send_chat(sockets[1], 21, 1, GUILD_CHANNEL_ID, f"guild-{marker}")
        await receive_type(sockets[0], 1000)
        await receive_type(sockets[2], 1000)

        private_id = await send_chat(sockets[2], 22, 2, 68, f"private-{marker}")
        await receive_type(sockets[0], 1000)
        leaked_private = False
        try:
            await receive_type(sockets[1], 1000, 0.6)
            leaked_private = True
        except (TimeoutError, asyncio.TimeoutError):
            pass
        if leaked_private:
            raise AssertionError("private message leaked to test02")

        print(json.dumps({
            "ok": True,
            "accounts": [row[0] for row in accounts],
            "role_ids": [row[3] for row in accounts],
            "friend_request_and_accept": True,
            "world_push_all": True,
            "guild_push_all": True,
            "private_push_target_only": True,
            "message_ids": {"world": world_id, "guild": guild_id, "private": private_id},
        }, ensure_ascii=False))
    finally:
        await asyncio.gather(*(socket.close() for socket in sockets), return_exceptions=True)


if __name__ == "__main__":
    asyncio.run(main())
