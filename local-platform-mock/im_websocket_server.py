#!/usr/bin/env python3
"""Minimal AFK 1.201 IM 3.0 server backed by the local social REST service."""

import argparse
import asyncio
import json
import logging
from datetime import datetime
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from websockets.asyncio.server import ServerConnection, serve

from afk_protocol import (
    ProtoField,
    encode_length_delimited_field,
    encode_proto_fields,
    encode_varint_field,
    decode_varint,
    get_proto_bytes,
    get_proto_text,
    get_proto_varint,
    get_repeated_proto_bytes,
    get_repeated_proto_varints,
    parse_proto_fields,
)


LOG = logging.getLogger("afk-im")
WORLD_CHANNEL_ID = 3_000_000_001
GUILD_CHANNEL_BASE = 2_000_000_000


def pb_bytes(number: int, value: bytes | str) -> bytes:
    if isinstance(value, str):
        value = value.encode("utf-8")
    return encode_length_delimited_field(number, value)


def repeated_varints(fields: list[ProtoField], number: int) -> list[int]:
    values = get_repeated_proto_varints(fields, number)
    for packed in get_repeated_proto_bytes(fields, number):
        offset = 0
        while offset < len(packed):
            value, offset = decode_varint(packed, offset)
            values.append(int(value))
    return values


def timestamp(value) -> int:
    if isinstance(value, (int, float)):
        return int(value)
    try:
        return int(datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp())
    except (TypeError, ValueError):
        return 0


def wire_timestamp(value) -> int:
    """The 1.201 IM client interprets protobuf timestamps as Unix milliseconds."""
    value = timestamp(value)
    return value if value >= 1_000_000_000_000 else value * 1000


def json_request(base_url: str, path: str, payload: dict | None = None) -> dict:
    url = base_url.rstrip("/") + path
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = Request(url, data=data, headers=headers, method="POST" if data is not None else "GET")
    try:
        with urlopen(request, timeout=8) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        try:
            body = json.loads(error.read().decode("utf-8"))
        except Exception:
            body = {"error": f"http_{error.code}"}
        body.setdefault("ok", False)
        return body


async def api(base_url: str, path: str, payload: dict | None = None) -> dict:
    return await asyncio.to_thread(json_request, base_url, path, payload)


def user_detail(user: dict) -> bytes:
    uid = int(user.get("uid") or user.get("friend_player_id") or 0)
    extra = json.dumps(
        {
            "power": int(user.get("power") or 0),
            "last_offline": int(user.get("last_offline") or 0),
            "is_robot": bool(user.get("is_robot")),
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return b"".join(
        (
            encode_varint_field(1, uid),
            pb_bytes(2, user.get("nickname") or f"玩家{uid}"),
            pb_bytes(3, user.get("avatar") or "avatar:1"),
            pb_bytes(4, str(user.get("avatar_frame") or "1")),
            encode_varint_field(5, int(user.get("level") or 1)),
            encode_varint_field(6, int(user.get("guild_id") or 0)),
            pb_bytes(7, extra),
        )
    )


def user_snap(user: dict) -> bytes:
    uid = int(user.get("uid") or user.get("friend_player_id") or 0)
    return b"".join(
        (
            encode_varint_field(1, uid),
            pb_bytes(2, user.get("avatar") or "avatar:1"),
            pb_bytes(3, user.get("nickname") or f"玩家{uid}"),
        )
    )


def request_info(user: dict, *, outgoing: bool, self_uid: int) -> bytes:
    other_uid = int(user.get("uid") or user.get("friend_player_id") or 0)
    requester = self_uid if outgoing else other_uid
    target = other_uid if outgoing else self_uid
    return b"".join(
        (
            pb_bytes(1, user_snap(user)),
            encode_varint_field(2, requester),
            encode_varint_field(3, target),
            encode_varint_field(4, wire_timestamp(user.get("updated_at"))),
            encode_varint_field(5, 0),
        )
    )


def chat_message(row: dict, channel_type: int, channel_id: int, sender_override: int | None = None) -> bytes:
    payload = row.get("payload_json") or {}
    sender = int(sender_override or row.get("player_id") or payload.get("bot_id") or 0)
    return b"".join(
        (
            encode_varint_field(1, channel_type),
            encode_varint_field(2, channel_id),
            encode_varint_field(3, sender),
            encode_varint_field(4, 1),
            pb_bytes(5, row.get("message") or ""),
            pb_bytes(6, json.dumps(payload, ensure_ascii=False, separators=(",", ":"))),
            encode_varint_field(7, wire_timestamp(row.get("created_at"))),
            encode_varint_field(8, int(row.get("id") or 0)),
        )
    )


def channel_info(
    channel_type: int,
    channel_id: int,
    name: str,
    messages: list[dict],
    *,
    self_player_id: int = 0,
    protocol_uid: int = 0,
) -> bytes:
    last = messages[-1] if messages else None
    sender_override = protocol_uid if last and int(last.get("player_id") or 0) == self_player_id else None
    last_payload = chat_message(last, channel_type, channel_id, sender_override) if last else b""
    return b"".join(
        (
            encode_varint_field(1, channel_type),
            encode_varint_field(2, channel_id),
            pb_bytes(3, name),
            pb_bytes(4, "avatar:1"),
            encode_varint_field(5, 0),
            encode_varint_field(6, 0),
            encode_varint_field(7, 0),
            encode_varint_field(8, 0),
            encode_varint_field(9, 0),
            pb_bytes(10, last_payload),
            pb_bytes(11, "{}"),
        )
    )


def response(seq: int, request_type: int, payload: bytes = b"", *, error: str = "") -> bytes:
    response_type = request_type + 1
    result = b"" if not error else b"".join((encode_varint_field(1, 1), pb_bytes(2, error)))
    parts = [encode_varint_field(1, seq), encode_varint_field(2, response_type), pb_bytes(3, result)]
    # Every request field number equals PackType and every response field uses request+1.
    parts.append(pb_bytes(response_type, payload))
    return b"".join(parts)


def push(pack_type: int, payload: bytes) -> bytes:
    return b"".join((encode_varint_field(1, 0), encode_varint_field(2, pack_type), pb_bytes(pack_type, payload)))


class IMSession:
    def __init__(self, socket: ServerConnection, base_url: str, sessions: set):
        self.socket = socket
        self.base_url = base_url
        self.sessions = sessions
        self.protocol_uid = 0
        self.player_id = 0
        self.player_uid = ""
        self.guild_id = 0
        self.pending_pushes: list[bytes] = []

    async def snapshot(self) -> dict:
        suffix = "?" + urlencode({"player_uid": self.player_uid}) if self.player_uid else ""
        result = await api(self.base_url, "/__afk/social/friends" + suffix)
        self.player_id = int((result.get("self") or {}).get("uid") or self.player_id or 0)
        self.player_uid = str((result.get("self") or {}).get("player_uid") or self.player_uid or "")
        self.guild_id = int((result.get("self") or {}).get("guild_id") or 0)
        return result

    async def chat_rows(self, channel_type: int, channel_id: int) -> dict:
        query = {"player_uid": self.player_uid}
        if channel_type == 2:
            query.update({"channel": "private", "recipient_player_id": channel_id})
        elif channel_type == 1:
            query["channel"] = "guild"
        else:
            query["channel"] = "world"
        return await api(self.base_url, "/__afk/social/chat?" + urlencode(query))

    async def handle(self, raw: bytes) -> list[bytes]:
        fields = parse_proto_fields(raw)
        seq = int(get_proto_varint(fields, 1) or 0)
        request_type = int(get_proto_varint(fields, 2) or 0)
        body = get_proto_bytes(fields, request_type) or b""
        request = parse_proto_fields(body)
        try:
            payload = await self.dispatch(request_type, request)
            replies = [response(seq, request_type, payload), *self.pending_pushes]
            self.pending_pushes.clear()
            return replies
        except Exception as error:
            LOG.exception("IM request failed type=%s", request_type)
            self.pending_pushes.clear()
            return [response(seq, request_type, error=str(error)[:160])]

    async def dispatch(self, request_type: int, request: list[ProtoField]) -> bytes:
        if request_type == 10:  # heartbeat
            return b""
        if request_type == 100:  # user login
            self.protocol_uid = int(get_proto_varint(request, 2) or 0)
            token = get_proto_text(request, 5) or ""
            resolved = await api(self.base_url, "/__afk/social/session", {"token": token})
            if resolved.get("ok"):
                self.player_id = int(resolved.get("player_id") or 0)
                self.player_uid = str(resolved.get("player_uid") or "")
            await self.snapshot()
            return pb_bytes(1, "afk-private-im/1.201")
        if request_type == 102:  # user list
            ids = repeated_varints(request, 1)
            result = await api(self.base_url, "/__afk/social/users?" + urlencode({"ids": ",".join(map(str, ids))}))
            users = result.get("users", [])
            if self.protocol_uid in ids and not any(int(user.get("uid") or 0) == self.protocol_uid for user in users):
                snapshot = await self.snapshot()
                self_user = dict(snapshot.get("self") or {})
                if self_user:
                    self_user["uid"] = self.protocol_uid
                    self_user["friend_player_id"] = self.protocol_uid
                    users.append(self_user)
            return b"".join(pb_bytes(1, user_detail(user)) for user in users)

        snapshot = await self.snapshot()
        if not snapshot.get("ok"):
            raise RuntimeError(snapshot.get("error") or "social_snapshot_failed")
        self_uid = int((snapshot.get("self") or {}).get("uid") or self.player_id)

        if request_type == 120:
            return b"".join(encode_varint_field(1, int(user["uid"])) for user in snapshot.get("friends", []))
        if request_type == 122:
            target = int(get_proto_varint(request, 1) or 0)
            result = await api(self.base_url, "/__afk/social/friends", {"player_uid": self.player_uid, "action": "remove", "friend_player_id": target})
            if not result.get("ok"): raise RuntimeError(result.get("error") or "friend_remove_failed")
            return b""
        if request_type == 124:
            sent = b"".join(pb_bytes(1, request_info(user, outgoing=True, self_uid=self_uid)) for user in snapshot.get("outgoing_requests", []))
            received = b"".join(pb_bytes(2, request_info(user, outgoing=False, self_uid=self_uid)) for user in snapshot.get("incoming_requests", []))
            return sent + received
        if request_type in (126, 128, 130, 132):
            target = int(get_proto_varint(request, 1) or 0)
            action = {126: "request", 128: "accept", 130: "reject", 132: "remove"}[request_type]
            result = await api(self.base_url, "/__afk/social/friends", {"player_uid": self.player_uid, "action": action, "friend_player_id": target})
            if not result.get("ok"): raise RuntimeError(result.get("error") or f"friend_{action}_failed")
            return b""
        if request_type == 140:
            return b"".join(encode_varint_field(1, int(user["uid"])) for user in snapshot.get("blacklist", []))
        if request_type in (142, 144):
            target = int(get_proto_varint(request, 1) or 0)
            action = "block" if request_type == 142 else "unblock"
            result = await api(self.base_url, "/__afk/social/friends", {"player_uid": self.player_uid, "action": action, "friend_player_id": target})
            if not result.get("ok"): raise RuntimeError(result.get("error") or f"friend_{action}_failed")
            return b""
        if request_type == 146:
            target = int(get_proto_varint(request, 1) or 0)
            blocked = any(int(user.get("uid") or 0) == target for user in snapshot.get("blacklist", []))
            return encode_varint_field(1, int(blocked))
        if request_type == 220:
            world = await self.chat_rows(4, WORLD_CHANNEL_ID)
            channel_args = {"self_player_id": self.player_id, "protocol_uid": self.protocol_uid}
            channels = [channel_info(4, WORLD_CHANNEL_ID, "世界", world.get("messages", []), **channel_args)]
            guild_id = int((snapshot.get("self") or {}).get("guild_id") or 0)
            if guild_id:
                guild = await self.chat_rows(1, GUILD_CHANNEL_BASE + guild_id)
                channels.append(channel_info(1, GUILD_CHANNEL_BASE + guild_id, "公会", guild.get("messages", []), **channel_args))
            for friend in snapshot.get("friends", []):
                target = int(friend.get("uid") or 0)
                private = await self.chat_rows(2, target)
                if private.get("messages"):
                    channels.append(channel_info(2, target, friend.get("nickname") or f"玩家{target}", private["messages"], **channel_args))
            return b"".join(pb_bytes(1, value) for value in channels)
        if request_type == 200:
            results = []
            for encoded_range in get_repeated_proto_bytes(request, 1):
                range_fields = parse_proto_fields(encoded_range)
                channel_type = int(get_proto_varint(range_fields, 1) or 4)
                channel_id = int(get_proto_varint(range_fields, 2) or WORLD_CHANNEL_ID)
                data = await self.chat_rows(channel_type, channel_id)
                rows = data.get("messages", [])
                start = int(get_proto_varint(range_fields, 3) or 1)
                end = int(get_proto_varint(range_fields, 4) or (rows[-1].get("id") if rows else 0))
                rows = [row for row in rows if start <= int(row.get("id") or 0) <= end]
                result = b"".join(
                    pb_bytes(
                        1,
                        chat_message(
                            row,
                            channel_type,
                            channel_id,
                            self.protocol_uid if int(row.get("player_id") or 0) == self.player_id else None,
                        ),
                    )
                    for row in rows
                )
                result += encode_varint_field(2, channel_type) + encode_varint_field(3, channel_id)
                result += encode_varint_field(4, int(data.get("messages", [])[-1].get("id") if data.get("messages") else 0))
                results.append(result)
            return b"".join(pb_bytes(1, result) for result in results)
        if request_type == 202:
            channel_type = int(get_proto_varint(request, 1) or 4)
            channel_id = int(get_proto_varint(request, 2) or WORLD_CHANNEL_ID)
            message = get_proto_text(request, 4) or ""
            payload = {"player_uid": self.player_uid, "message": message, "payload": {"source": "im_3"}}
            if channel_type == 2:
                payload.update({"channel": "private", "recipient_player_id": channel_id})
            elif channel_type == 1:
                payload["channel"] = "guild"
            else:
                payload["channel"] = "world"
            result = await api(self.base_url, "/__afk/social/chat", payload)
            if not result.get("ok"): raise RuntimeError(result.get("error") or "chat_send_failed")
            message_id = int(result.get("id") or 0)
            now = wire_timestamp(datetime.now().isoformat())
            row = {
                "id": message_id,
                "player_id": self.player_id,
                "message": message,
                "payload_json": payload.get("payload") or {},
                "created_at": now,
            }
            peer_push = push(1000, pb_bytes(2, chat_message(row, channel_type, channel_id)))
            peers = []
            for peer in tuple(self.sessions):
                if peer is self or not peer.player_id:
                    continue
                if channel_type == 4 or (channel_type == 1 and peer.guild_id == self.guild_id) or (channel_type == 2 and peer.player_id == channel_id):
                    peers.append(peer.socket.send(peer_push))
            if peers:
                await asyncio.gather(*peers, return_exceptions=True)
            self.pending_pushes.append(
                push(1000, pb_bytes(2, chat_message(row, channel_type, channel_id, self.protocol_uid)))
            )
            return encode_varint_field(1, now) + encode_varint_field(2, message_id) + encode_varint_field(3, message_id)
        if request_type in (240, 246, 248):
            return b""
        if request_type in (242, 244):
            return encode_varint_field(1, 0) + encode_varint_field(2, 0)
        if request_type == 280:
            return b""
        if request_type == 282:
            return encode_varint_field(1, 0)
        if request_type == 300:
            # PBTextTranslateResp.translated_text = 1
            return pb_bytes(1, get_proto_text(request, 1) or "")
        LOG.warning("Returning compatible empty response for unsupported type=%s", request_type)
        return b""


async def run(args: argparse.Namespace) -> None:
    sessions: set[IMSession] = set()

    async def handler(socket: ServerConnection) -> None:
        session = IMSession(socket, args.api_base_url, sessions)
        sessions.add(session)
        LOG.info("IM client connected remote=%s", socket.remote_address)
        try:
            async for message in socket:
                if isinstance(message, str):
                    continue
                for reply in await session.handle(bytes(message)):
                    await socket.send(reply)
        finally:
            sessions.discard(session)
            LOG.info("IM client disconnected uid=%s player_id=%s", session.protocol_uid, session.player_id)

    async with serve(handler, args.listen_host, args.listen_port, max_size=4 * 1024 * 1024):
        LOG.info("AFK IM listening on ws://%s:%s", args.listen_host, args.listen_port)
        await asyncio.Future()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="AFK 1.201 local IM 3.0 websocket service")
    parser.add_argument("--listen-host", default="0.0.0.0")
    parser.add_argument("--listen-port", type=int, default=15008)
    parser.add_argument("--api-base-url", default="http://127.0.0.1:18080")
    return parser.parse_args()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    asyncio.run(run(parse_args()))
