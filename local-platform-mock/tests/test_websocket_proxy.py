import unittest
import json
import base64
from pathlib import Path

from afk_protocol import (
    ProtoField,
    encode_proto_fields,
    encode_length_delimited_field,
    encode_varint_field,
    get_proto_bytes,
    get_repeated_proto_bytes,
    get_proto_varint,
    parse_proto_fields,
)
from websocket_proxy import (
    build_login_payload_from_business_state,
    build_structured_login_reply,
    build_structured_login_templates,
    build_structured_charge_reply,
    build_structured_hero_upgrade_reply,
    build_hero_growth_reply,
    build_character_hero_payload,
    build_extended_hero_reply,
    build_structured_idle_claim_reply,
    build_structured_hd_idle_query_reply,
    build_structured_hd_assist_stage_reply,
    build_structured_idle_query_reply,
    build_structured_quick_idle_reply,
    build_structured_reconnect_reply,
    build_structured_stage_retry_reply,
    build_stage_summary_payload,
    build_structured_tavern_draw_reply,
    build_tavern_open_panel_payload,
    build_arena_system_reply,
    build_altar_system_reply,
    build_guild_system_reply,
    build_mail_system_reply,
    build_maze_system_reply,
    build_shop_system_reply,
    build_task_system_reply,
    build_instant_charge_reply,
    build_tower_system_reply,
    build_generic_protocol_reply,
    equip_game_action_args,
    tavern_game_action_args,
    BusinessStateProvider,
    decode_new_proto_frame,
    encode_new_proto_frame,
    CompatibleClientConnection,
    legacy_core_response_to_new,
    new_core_request_to_legacy,
    NEW_NATIVE_HD_ROUTES,
    LEGACY_PROTO_DEFS,
    NEW_PROTO_DEFS,
    PROTOBUF_ENUMS,
    project_proto_message,
    try_build_heartbeat_reply,
    parse_client_message_kind,
    parse_generic_protocol_request,
    patch_login_activity_entries,
)


class EquipmentProtocolTests(unittest.TestCase):
    def test_enhance_request_maps_to_single_equipment_action(self):
        material = encode_proto_fields([
            ProtoField(1, 0, 2), ProtoField(2, 0, 15), ProtoField(3, 0, 6),
        ])
        enhance = encode_proto_fields([
            ProtoField(1, 0, 1001), ProtoField(2, 0, 1), ProtoField(3, 2, material),
        ])
        request = encode_proto_fields([
            ProtoField(1, 0, 88),
            ProtoField(26, 2, encode_length_delimited_field(2, enhance)),
        ])
        info = parse_generic_protocol_request(request)
        self.assertEqual(info["generic_module"], "equip")
        self.assertEqual(info["generic_operation"], "enhance")
        self.assertEqual(equip_game_action_args(info), {
            "op": "equip_enhance", "hero_id": 1001, "index": 1,
            "assets": [{"type": "item", "id": 15, "amount": 6}],
        })

    def test_classic_enhance_maps_asset_type_8_to_equipment(self):
        material = encode_proto_fields([
            ProtoField(1, 0, 8), ProtoField(2, 0, 9), ProtoField(3, 0, 6),
        ])
        enhance = encode_proto_fields([
            ProtoField(1, 0, 100034), ProtoField(2, 0, 1), ProtoField(3, 2, material),
        ])
        request = encode_proto_fields([
            ProtoField(1, 0, 156),
            ProtoField(26, 2, encode_length_delimited_field(2, enhance)),
        ])
        info = parse_generic_protocol_request(request)
        self.assertEqual(equip_game_action_args(info)["assets"], [
            {"type": "equip", "id": 9, "amount": 6},
        ])

    def test_enhance_reply_contains_updated_hero_cost_and_reward(self):
        request_info = {
            "seq": 89, "generic_module": "equip", "generic_operation": "enhance",
            "generic_reply_outer_field": 29, "generic_reply_operation_field": 2,
            "generic_reply_type": "reply_equip_enhance",
        }
        reply = parse_proto_fields(build_generic_protocol_reply(request_info, {
            "ok": True,
            "character": {"character_id": "1001", "level": 20, "star": 3, "extra": {
                "hero_id": 1001, "tid": 1, "quality": 3,
                "equips": {"1": {"id": 27001, "tid": 27, "enhance_lv": 1}},
            }},
            "cost": [{"type": "item", "id": 15, "amount": 6}, {"type": "currency", "id": "gold", "amount": 6000}],
            "rewards": [],
        }))
        equip_reply = parse_proto_fields(get_proto_bytes(reply, 29))
        enhance_reply = parse_proto_fields(get_proto_bytes(equip_reply, 2))
        hero = parse_proto_fields(get_proto_bytes(enhance_reply, 1))
        self.assertEqual(get_proto_varint(hero, 1), 1001)
        self.assertIsNotNone(get_proto_bytes(enhance_reply, 2))
        self.assertIsNotNone(get_proto_bytes(enhance_reply, 3))


class TavernStateProtocolTests(unittest.TestCase):
    def test_dragon_wish_target_request_maps_to_persisted_pool_target(self):
        info = {
            "generic_operation": "req_set_tavern_wish_tid",
            "generic_payload": {"field_1": 25, "field_2": 18},
        }
        self.assertEqual(tavern_game_action_args(info), {
            "op": "tavern_set_wish_tid", "pool_id": 25, "hero_tid": 18,
        })

    def test_stargazer_and_pick_pool_queries_return_concrete_state(self):
        for operation, field_number in (("req_open_stargazer_wanted", 4), ("req_init_pick_pool", 9)):
            info = {
                "seq": 90, "generic_module": "tavern", "generic_operation": operation,
                "generic_reply_outer_field": 13, "generic_reply_operation_field": field_number,
                "generic_reply_type": "bytes",
            }
            reply = parse_proto_fields(build_generic_protocol_reply(info, {
                "stargazer_id": 18, "wishlist": {"1": 17}, "pick_pool": 19,
                "draw_times": {"12": 3},
            }))
            module = parse_proto_fields(get_proto_bytes(reply, 13))
            payload = parse_proto_fields(get_proto_bytes(module, field_number))
            self.assertGreater(len(payload), 0)


class _MemoryWebSocket:
    def __init__(self, incoming):
        self.incoming = list(incoming)
        self.sent = []

    async def recv(self):
        return self.incoming.pop(0)

    async def send(self, message):
        self.sent.append(message)


class ClassicFramedTransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_classic_framed_sdk_login_keeps_classic_root_numbers(self):
        sdk_payload = b"".join(
            (
                encode_varint_field(1, 1),
                encode_length_delimited_field(2, b"180945015752192"),
                encode_length_delimited_field(3, b"local-ticket-test"),
            )
        )
        framed = encode_new_proto_frame(
            encode_length_delimited_field(3, sdk_payload), seq=100
        )
        socket = _MemoryWebSocket([framed])
        client = CompatibleClientConnection(socket)

        request = await client.recv()
        info = parse_client_message_kind(request)
        self.assertEqual(info["kind"], "sdk_login")
        self.assertEqual(info["seq"], 100)
        self.assertTrue(client.uses_classic_framed_proto)

        legacy_reply = b"".join(
            (
                encode_varint_field(1, 1_787_000_000),
                encode_varint_field(2, 100),
                encode_length_delimited_field(31, b""),
            )
        )
        await client.send(legacy_reply)
        reply = decode_new_proto_frame(socket.sent[0])
        self.assertEqual(reply.seq, 100)
        self.assertIsNotNone(get_proto_bytes(parse_proto_fields(reply.proto_data), 31))
        self.assertIsNone(get_proto_varint(parse_proto_fields(reply.proto_data), 2))

    async def test_classic_framed_reconnect_is_detected_without_sdk_login(self):
        md5_row = b"".join(
            (
                encode_length_delimited_field(1, b"hero"),
                encode_length_delimited_field(2, b"0123456789abcdef"),
            )
        )
        reconnect_payload = b"".join(
            (
                encode_varint_field(1, 1),
                encode_length_delimited_field(2, b"180945015752192"),
                encode_varint_field(3, 19),
                encode_varint_field(4, 211123),
                encode_length_delimited_field(5, b"local-ticket-test"),
                encode_length_delimited_field(6, b"1.201.01"),
                encode_length_delimited_field(7, md5_row),
            )
        )
        framed = encode_new_proto_frame(
            encode_length_delimited_field(29, reconnect_payload), seq=155
        )
        socket = _MemoryWebSocket([framed])
        client = CompatibleClientConnection(socket)

        request = await client.recv()
        self.assertEqual(parse_client_message_kind(request)["kind"], "reconnect")
        self.assertTrue(client.uses_classic_framed_proto)

        await client.send(build_structured_reconnect_reply({"seq": 155}))
        reply = decode_new_proto_frame(socket.sent[0])
        self.assertEqual(reply.seq, 155)
        self.assertIsNotNone(get_proto_bytes(parse_proto_fields(reply.proto_data), 35))
        self.assertIsNone(get_proto_bytes(parse_proto_fields(reply.proto_data), 31))

    async def test_classic_framed_sdk_login_accepts_local_auth_token(self):
        sdk_login = encode_proto_fields([
            ProtoField(2, 2, b"179768958023614"),
            ProtoField(11, 2, b"local-auth:test-session-token"),
            ProtoField(4, 2, encode_proto_fields([ProtoField(1, 0, 1)])),
        ])
        framed = encode_new_proto_frame(encode_length_delimited_field(3, sdk_login), seq=100)
        socket = _MemoryWebSocket([framed])
        client = CompatibleClientConnection(socket)
        request = await client.recv()
        self.assertEqual(parse_client_message_kind(request)["kind"], "sdk_login")
        self.assertTrue(client.uses_classic_framed_proto)


class NewProtoTransportTests(unittest.TestCase):
    CAPTURED_SDK_LOGIN = base64.b64decode(
        "p6TvkAAAAABkAAAAAAAAAAAAIGZjOWIxZTEyNjEzYzIwNzMwODU4Y2NhNmU0NjNkZmI5"
        "AAAAUBJOCAESDzE4MDk0NTAxNTc1MjE5MhotbG9jYWwtdGlja2V0LWE0OTE4YjYzNDYw"
        "MGFhMDBmMTY2Nzg1ZWEyZTQ1Mjc1KAAyAggBQgJDTlAC"
    )

    def test_decodes_captured_1201_sdk_login_frame(self):
        frame = decode_new_proto_frame(self.CAPTURED_SDK_LOGIN)
        self.assertEqual(frame.seq, 100)
        self.assertEqual(frame.repeat, 0)
        self.assertEqual(frame.module_id, 0)
        self.assertEqual(frame.sign, b"fc9b1e12613c20730858cca6e463dfb9")
        request = new_core_request_to_legacy(frame)
        info = parse_client_message_kind(request)
        self.assertEqual(info["kind"], "sdk_login")
        self.assertEqual(info["seq"], 100)
        self.assertTrue(info["htoken"].startswith("local-ticket-"))

    def test_crc_corruption_is_rejected(self):
        corrupted = bytearray(self.CAPTURED_SDK_LOGIN)
        corrupted[-1] ^= 1
        with self.assertRaisesRegex(ValueError, "CRC mismatch"):
            decode_new_proto_frame(bytes(corrupted))

    def test_response_projection_and_frame_round_trip(self):
        old_response = b"".join(
            (
                encode_varint_field(1, 1_787_000_000),
                encode_varint_field(2, 100),
                encode_length_delimited_field(31, encode_length_delimited_field(1, b"token")),
            )
        )
        seq, projected = legacy_core_response_to_new(old_response)
        projected_fields = parse_proto_fields(projected)
        self.assertEqual(seq, 100)
        self.assertEqual(get_proto_varint(projected_fields, 1), 1_787_000_000)
        self.assertIsNotNone(get_proto_bytes(projected_fields, 28))

        encoded = encode_new_proto_frame(projected, seq=seq)
        decoded = decode_new_proto_frame(encoded)
        self.assertEqual(decoded.seq, 100)
        self.assertEqual(decoded.proto_data, projected)
        self.assertEqual(decoded.extra_data, b"")

    def test_large_response_uses_compressed_transport(self):
        proto = encode_length_delimited_field(3, b"x" * 1200)
        decoded = decode_new_proto_frame(encode_new_proto_frame(proto, seq=9))
        self.assertEqual(decoded.control, 1)
        self.assertEqual(decoded.proto_data, proto)

    def test_hd_only_activity_uses_native_generic_round_trip(self):
        outer_field, route = next(
            (field, entry)
            for field, entry in NEW_NATIVE_HD_ROUTES.items()
            if entry["module"] == "hero_return"
        )
        operation_field = min(route["operations"])
        new_request = encode_length_delimited_field(
            outer_field, encode_length_delimited_field(operation_field, b"")
        )
        frame = decode_new_proto_frame(encode_new_proto_frame(new_request, seq=119))
        legacy_request = new_core_request_to_legacy(frame)
        info = parse_client_message_kind(legacy_request)
        self.assertEqual(info["kind"], "generic_hero_return")
        self.assertTrue(info["native_hd"])
        self.assertEqual(info["generic_request_operation_field"], operation_field)

        legacy_reply = build_generic_protocol_reply(
            info,
            {
                "ok": True,
                "wire_projection": {
                    "result": 1,
                    "progress": 2,
                    "timestamp": 1_787_000_000,
                },
            },
        )
        seq, projected = legacy_core_response_to_new(legacy_reply)
        self.assertEqual(seq, 119)
        root_fields = parse_proto_fields(projected)
        reply_payload = get_proto_bytes(root_fields, route["reply_outer_field"])
        self.assertIsNotNone(reply_payload)
        self.assertIsNotNone(
            get_proto_bytes(
                parse_proto_fields(reply_payload),
                route["operations"][operation_field]["reply_field"],
            )
        )

    def test_hd_stage_idle_query_survives_legacy_business_adapter(self):
        new_request = encode_proto_fields(
            [ProtoField(4, 2, encode_length_delimited_field(10, b""))]
        )
        frame = decode_new_proto_frame(
            encode_new_proto_frame(new_request, seq=113)
        )
        legacy_request = new_core_request_to_legacy(frame)
        info = parse_client_message_kind(legacy_request)
        self.assertEqual(info, {"kind": "stage_hd_query_idle_reward", "seq": 113})

        idle = {
            "start_ts": 100,
            "end_ts": 200,
            "left_secs": [300],
            "assets": [
                {"type": "currency", "id": "gold", "amount": 25},
                {"type": "chest", "id": 18, "amount": 12},
            ],
        }
        legacy_reply = build_structured_hd_idle_query_reply(info, idle)
        seq, projected = legacy_core_response_to_new(legacy_reply)
        self.assertEqual(seq, 113)
        down = parse_proto_fields(projected)
        stage = parse_proto_fields(get_proto_bytes(down, 6))
        query_reply = parse_proto_fields(get_proto_bytes(stage, 10))
        normal_idle = parse_proto_fields(get_proto_bytes(query_reply, 1))
        deep_idle = parse_proto_fields(get_proto_bytes(query_reply, 2))
        self.assertEqual(get_proto_varint(normal_idle, 1), 1)
        self.assertEqual(get_proto_varint(deep_idle, 1), 2)
        self.assertEqual(len(get_repeated_proto_bytes(normal_idle, 5)), 1)
        hamper_info = parse_proto_fields(get_proto_bytes(query_reply, 3))
        self.assertEqual(get_proto_varint(hamper_info, 1), 1)

    def test_hd_assist_stage_route_survives_legacy_business_adapter(self):
        new_request = encode_proto_fields(
            [ProtoField(108, 2, encode_varint_field(1, 1))]
        )
        frame = decode_new_proto_frame(
            encode_new_proto_frame(new_request, seq=119)
        )
        legacy_request = new_core_request_to_legacy(frame)
        info = parse_client_message_kind(legacy_request)
        self.assertEqual(info["kind"], "hd_assist_stage")
        self.assertEqual(info["assist_operation"], "open_panel")

        legacy_reply = build_structured_hd_assist_stage_reply(info)
        seq, projected = legacy_core_response_to_new(legacy_reply)
        self.assertEqual(seq, 119)
        down = parse_proto_fields(projected)
        assist = parse_proto_fields(get_proto_bytes(down, 113))
        open_panel = parse_proto_fields(get_proto_bytes(assist, 1))
        self.assertEqual(get_proto_varint(open_panel, 3), 0)

    def test_next_chapter_result_is_retyped_as_hd_reward_message(self):
        old_reply = encode_proto_fields(
            [
                ProtoField(1, 0, 1_787_000_000),
                ProtoField(2, 0, 111),
                ProtoField(6, 2, encode_varint_field(7, 1)),
            ]
        )
        seq, projected = legacy_core_response_to_new(old_reply)
        self.assertEqual(seq, 111)
        down = parse_proto_fields(projected)
        stage = parse_proto_fields(get_proto_bytes(down, 6))
        next_chapter = [field for field in stage if field.number == 5]
        self.assertEqual(len(next_chapter), 1)
        self.assertEqual(next_chapter[0].wire_type, 2)
        self.assertEqual(next_chapter[0].value, b"")

    def test_hd_next_chapter_default_enum_projects_to_legacy_empty_message(self):
        new_request = encode_proto_fields(
            [ProtoField(4, 2, encode_varint_field(5, 0))]
        )
        frame = decode_new_proto_frame(encode_new_proto_frame(new_request, seq=333))
        info = parse_client_message_kind(new_core_request_to_legacy(frame))
        self.assertEqual(info["kind"], "generic_stage")
        self.assertEqual(info["generic_operation"], "next_chapter")
        self.assertEqual(info["seq"], 333)

    def test_battle_projection_drops_legacy_scalar_reusing_stats_field(self):
        fixture = json.loads(
            (
                Path(__file__).parents[1]
                / "data"
                / "fixtures"
                / "ws-interactions-stage-battle-1.json"
            ).read_text(encoding="utf-8")
        )
        rule = next(
            row
            for row in fixture["rules"]
            if row["match"].get("kind") == "stage_battle_start"
        )
        old_reply = base64.b64decode(rule["responses"][0]["payload"])
        _, projected = legacy_core_response_to_new(old_reply)
        down = parse_proto_fields(projected)
        stage = parse_proto_fields(get_proto_bytes(down, 6))
        start = parse_proto_fields(get_proto_bytes(stage, 1))
        battle = parse_proto_fields(get_proto_bytes(start, 1))
        battle_input = parse_proto_fields(get_proto_bytes(battle, 3))
        self.assertFalse(
            any(field.number == 6 and field.wire_type == 0 for field in battle_input)
        )

    def test_login_projection_synthesizes_new_required_idle_type(self):
        fixture = Path(__file__).parents[1] / "data" / "fixtures" / "ws-login-timeline-1.json"
        templates = build_structured_login_templates(str(fixture))
        old_reply = build_structured_login_reply({"seq": 101}, templates)
        seq, projected = legacy_core_response_to_new(old_reply)
        self.assertEqual(seq, 101)
        down = parse_proto_fields(projected)
        login = parse_proto_fields(get_proto_bytes(down, 4))
        user = parse_proto_fields(get_proto_bytes(login, 1))
        stage = parse_proto_fields(get_proto_bytes(user, 11))
        idle = parse_proto_fields(get_proto_bytes(stage, 2))
        self.assertEqual(get_proto_varint(idle, 1), 1)
        quick_idle = parse_proto_fields(get_proto_bytes(stage, 4))
        card_quick_idle = parse_proto_fields(get_proto_bytes(stage, 9))
        self.assertEqual(
            get_proto_varint(card_quick_idle, 1),
            get_proto_varint(quick_idle, 1),
        )

        pentagram = parse_proto_fields(get_proto_bytes(user, 77))
        self.assertEqual(get_proto_varint(pentagram, 1), get_proto_varint(user, 42))
        self.assertEqual(get_proto_varint(pentagram, 3), get_proto_varint(user, 42))
        self.assertGreaterEqual(
            get_proto_varint(pentagram, 4),
            get_proto_varint(pentagram, 3),
        )
        deep_stage = parse_proto_fields(get_proto_bytes(user, 84))
        self.assertEqual(get_proto_varint(deep_stage, 1), 1)
        self.assertIsNotNone(get_proto_bytes(deep_stage, 2))
        self.assertIsNotNone(get_proto_bytes(deep_stage, 3))

        task_info = parse_proto_fields(get_proto_bytes(user, 14))
        self.assertIsNone(get_proto_bytes(task_info, 5))
        self.assertIsNone(get_proto_bytes(task_info, 6))
        self.assertIsNone(get_proto_bytes(task_info, 7))


class QuickIdleProtocolTests(unittest.TestCase):
    def test_every_recovered_operation_has_runtime_domain_fallback(self):
        route_map = json.loads((Path(__file__).parents[1] / "runtime" / "protocol-route-map.json").read_text(encoding="utf-8"))
        checked = 0
        for outer_text, route in route_map["modules"].items():
            outer = int(outer_text)
            for operation_field in route["operations"]:
                request = encode_proto_fields([ProtoField(1, 0, checked + 1), ProtoField(outer, 2, encode_length_delimited_field(int(operation_field), b""))])
                info = parse_generic_protocol_request(request)
                self.assertIsNotNone(info, f"{route['module']}:{operation_field}")
                checked += 1
        self.assertEqual(checked, 1599)

    def test_generic_official_module_gets_non_blocking_reply_envelope(self):
        request = encode_proto_fields([ProtoField(1, 0, 900), ProtoField(49, 2, encode_length_delimited_field(1, b""))])
        info = parse_client_message_kind(request)
        self.assertEqual(info["generic_module"], "activity")
        reply = parse_proto_fields(build_generic_protocol_reply(info))
        self.assertEqual(get_proto_varint(reply, 2), 900)
        self.assertIsNotNone(get_proto_bytes(reply, info["generic_reply_outer_field"]))

    def test_pentagram_open_panel_contains_required_crystal_state(self):
        info = parse_generic_protocol_request(base64.b64decode("CHa6AgIKAA=="))
        self.assertEqual(info["generic_module"], "pentagram")
        outer = parse_proto_fields(build_generic_protocol_reply(info))
        module = parse_proto_fields(get_proto_bytes(outer, 42))
        panel = parse_proto_fields(get_proto_bytes(module, 1))
        pentagram = parse_proto_fields(get_proto_bytes(panel, 1))
        grid = parse_proto_fields(get_proto_bytes(pentagram, 1))
        self.assertEqual(get_proto_varint(grid, 2), 25)
        self.assertEqual(get_proto_varint(pentagram, 5), 999)

    def test_generic_domain_reply_contains_schema_required_state(self):
        request = encode_proto_fields([
            ProtoField(1, 0, 901),
            ProtoField(22, 2, encode_length_delimited_field(1, encode_varint_field(1, 77))),
        ])
        info = parse_client_message_kind(request)
        self.assertEqual(info["generic_module"], "bounty")
        self.assertEqual(info["generic_payload"], {"field_1": 77})
        transaction = {"wire_projection": {"level": 8, "timestamp": 1}, "state": {"level": 8}}
        outer = parse_proto_fields(build_generic_protocol_reply(info, transaction))
        bounty = parse_proto_fields(get_proto_bytes(outer, 25))
        panel = parse_proto_fields(get_proto_bytes(bounty, 1))
        self.assertEqual(get_proto_varint(panel, 1), 8)

    def test_daily_login_panel_encodes_received_reward_ids(self):
        request = encode_proto_fields([
            ProtoField(1, 0, 904),
            ProtoField(42, 2, encode_length_delimited_field(1, b"")),
        ])
        info = parse_client_message_kind(request)
        self.assertEqual(info["generic_module"], "daily_login")
        reply = parse_proto_fields(build_generic_protocol_reply(info, {
            "wire_projection": {"season": 1, "recved_rewards": [1, 3]},
            "state": {},
        }))
        daily_reply = parse_proto_fields(get_proto_bytes(reply, 45))
        panel = parse_proto_fields(get_proto_bytes(daily_reply, 1))
        self.assertEqual(get_proto_varint(panel, 1), 1)
        self.assertEqual([field.value for field in panel if field.number == 2], [1, 3])

    def test_medal_panel_reply_contains_all_profile_honor_counters(self):
        request = encode_proto_fields([
            ProtoField(1, 0, 903),
            ProtoField(82, 2, encode_length_delimited_field(1, b"")),
        ])
        info = parse_client_message_kind(request)
        self.assertEqual(info["generic_module"], "medal")
        outer = parse_proto_fields(build_generic_protocol_reply(info, {"ok": True}))
        medal_reply = parse_proto_fields(get_proto_bytes(outer, 85))
        panel = parse_proto_fields(get_proto_bytes(medal_reply, 1))
        honors = [parse_proto_fields(value) for value in get_repeated_proto_bytes(panel, 3)]
        self.assertEqual([get_proto_varint(value, 1) for value in honors], [1, 3, 4, 5])
        self.assertEqual([get_proto_varint(value, 2) for value in honors], [0, 0, 0, 0])

    def test_artifact_operation_has_semantic_reply(self):
        request = encode_proto_fields([
            ProtoField(1, 0, 902),
            ProtoField(4, 2, encode_length_delimited_field(9, encode_varint_field(1, 123))),
        ])
        info = parse_client_message_kind(request)
        self.assertEqual(info["kind"], "hero_wear_artifact")
        self.assertEqual(info["hero_id"], 123)
        reply = parse_proto_fields(build_extended_hero_reply(info, {"character": {"level": 240, "extra": {"hero_id": 123, "tid": 22}}}))
        unit = parse_proto_fields(get_proto_bytes(reply, 5))
        wear = parse_proto_fields(get_proto_bytes(unit, 9))
        self.assertEqual(len(get_repeated_proto_bytes(wear, 1)), 1)
        self.assertEqual(len(get_repeated_proto_bytes(wear, 2)), 1)

    def test_account_query_always_contains_classic_and_hd_parents(self):
        info = parse_generic_protocol_request(base64.b64decode("CHGyAkcyRQgBEg44ODMwNTQ0Nzc5ODE5MxovbG9jYWwtYXV0aDoxMTc4MzE5OS0zZGNhLTRkMjctOWIyMS00MzE0M2UyNWIzODIgAA=="))
        self.assertEqual(info["generic_module"], "acc")
        self.assertEqual(info["generic_operation"], "query_account")
        reply = parse_proto_fields(build_generic_protocol_reply(info, {"wire_projection": {"uid": 88, "name": "测试", "level": 240}}))
        acc = parse_proto_fields(get_proto_bytes(reply, info["generic_reply_outer_field"]))
        query = parse_proto_fields(get_proto_bytes(acc, info["generic_reply_operation_field"]))
        classics = parse_proto_fields(get_proto_bytes(query, 1))
        self.assertIsNotNone(get_proto_bytes(classics, 1))
        self.assertIsNotNone(get_proto_bytes(query, 2))

    def test_builds_captured_field5_quick_idle_route_and_reward_reply(self):
        request = encode_proto_fields(
            [ProtoField(1, 0, 223), ProtoField(2, 0, 0), ProtoField(5, 2, b"\x2a\x00")]
        )
        self.assertEqual(parse_client_message_kind(request)["kind"], "stage_quick_idle_claim")
        reply = build_structured_quick_idle_reply(
            {"seq": 223},
            {"assets": [{"type": "currency", "id": "gold", "amount": 100}]},
        )
        outer = parse_proto_fields(reply)
        self.assertEqual(get_proto_varint(outer, 2), 223)
        stage = parse_proto_fields(get_proto_bytes(outer, 6))
        quick = parse_proto_fields(get_proto_bytes(stage, 5))
        rewards = get_repeated_proto_bytes(quick, 1)
        self.assertEqual(len(rewards), 1)
        self.assertEqual(get_proto_bytes(quick, 2), b"")
        cd = parse_proto_fields(get_proto_bytes(quick, 3))
        self.assertEqual(get_proto_varint(cd, 1), 13)
        self.assertEqual(get_proto_varint(cd, 2), 1)


class AltarProtocolTests(unittest.TestCase):
    def test_classifies_disband_and_builds_success_reply(self):
        request = encode_proto_fields([
            ProtoField(1, 0, 110), ProtoField(2, 0, 0),
            ProtoField(21, 2, encode_proto_fields([ProtoField(1, 0, 1006), ProtoField(1, 0, 1007)])),
        ])
        parsed = parse_client_message_kind(request)
        self.assertEqual(parsed["kind"], "altar_disband")
        self.assertEqual(parsed["hero_ids"], [1006, 1007])
        reply = parse_proto_fields(build_altar_system_reply(parsed, {"ok": True, "rewards": []}))
        self.assertEqual(get_proto_varint(reply, 2), 110)
        altar = parse_proto_fields(get_proto_bytes(reply, 24))
        info = parse_proto_fields(get_proto_bytes(altar, 1))
        self.assertEqual(get_proto_varint(info, 1), 1)


class IdleProtocolTests(unittest.TestCase):
    def test_empty_classic_stage_message_defaults_to_query_reward(self):
        request = encode_proto_fields(
            [ProtoField(1, 0, 77), ProtoField(5, 2, b"")]
        )
        parsed = parse_client_message_kind(request)
        self.assertEqual(parsed["kind"], "generic_stage")
        self.assertEqual(parsed["generic_operation"], "query_reward")

    def test_classifies_query_and_claim_routes(self):
        for inner_field, kind in ((1, "stage_idle_query"), (2, "stage_idle_claim")):
            request = encode_proto_fields(
                [
                    ProtoField(1, 0, 40 + inner_field),
                    ProtoField(2, 0, 0),
                    ProtoField(5, 2, encode_length_delimited_field(inner_field, b"")),
                ]
            )
            self.assertEqual(parse_client_message_kind(request)["kind"], kind)

    def test_builds_idle_query_and_draw_rewards_from_official_schema(self):
        idle = {
            "start_ts": 100,
            "end_ts": 200,
            "left_secs": [300],
            "assets": [{"type": "currency", "id": "gold", "amount": 25}],
        }
        query = parse_proto_fields(build_structured_idle_query_reply({"seq": 41}, idle))
        stage = parse_proto_fields(get_proto_bytes(query, 6))
        idle_fields = parse_proto_fields(get_proto_bytes(stage, 1))
        self.assertEqual(get_proto_varint(idle_fields, 3), 200)
        self.assertEqual(len(get_repeated_proto_bytes(idle_fields, 4)), 1)

        claim = parse_proto_fields(
            build_structured_idle_claim_reply(
                {"seq": 42},
                {"assets": [{"type": "currency", "id": "gold", "amount": 25}]},
            )
        )
        stage = parse_proto_fields(get_proto_bytes(claim, 6))
        draw = parse_proto_fields(get_proto_bytes(stage, 2))
        self.assertEqual(len(get_repeated_proto_bytes(draw, 1)), 1)
        self.assertIsNotNone(get_proto_bytes(draw, 2))

    def test_hd_idle_currency_aliases_encode_known_enum_ids(self):
        reply = build_structured_hd_idle_query_reply(
            {"seq": 43},
            {
                "assets": [
                    {"type": "currency", "id": "homelandcoin", "amount": 2},
                    {"type": "currency", "id": "pentagram_coin", "amount": 3},
                    {"type": "currency", "id": "petcoin", "amount": 4},
                ]
            },
        )
        _, hd_payload = legacy_core_response_to_new(reply)
        root = parse_proto_fields(hd_payload)
        stage_number = NEW_PROTO_DEFS["down_msg"]["by_name"]["reply_stage"]["number"]
        stage = parse_proto_fields(get_proto_bytes(root, stage_number))
        query = parse_proto_fields(get_proto_bytes(stage, 10))
        idle = parse_proto_fields(get_proto_bytes(query, 1))
        asset_ids = [
            get_proto_varint(parse_proto_fields(asset), 2)
            for asset in get_repeated_proto_bytes(idle, 5)
        ]
        self.assertEqual(asset_ids, [10000019, 10000012, 10000029])


class LoginBusinessStateTests(unittest.TestCase):
    def test_login_clears_captured_chapter_boundary_after_stage_projection(self):
        stage = encode_proto_fields(
            [
                ProtoField(1, 0, 13),
                ProtoField(5, 0, 1),
            ]
        )
        login = encode_proto_fields(
            [
                ProtoField(
                    1,
                    2,
                    encode_proto_fields(
                        [ProtoField(3, 0, 1), ProtoField(12, 2, stage)]
                    ),
                )
            ]
        )
        patched = build_login_payload_from_business_state(
            login,
            {
                "player": {},
                "inventory": [
                    {"item_id": "meta_campaign_cur_stage", "quantity": 4892}
                ],
                "characters": [],
                "liveops": [],
            },
        )
        user = parse_proto_fields(get_proto_bytes(parse_proto_fields(patched), 1))
        projected_stage = parse_proto_fields(get_proto_bytes(user, 12))
        self.assertEqual(get_proto_varint(projected_stage, 1), 3232)
        self.assertEqual(get_proto_varint(projected_stage, 5), 0)

    def test_classic_login_keeps_stage_inside_exact_client_table(self):
        stage = encode_proto_fields([ProtoField(1, 0, 13)])
        login = encode_proto_fields(
            [ProtoField(1, 2, encode_proto_fields([ProtoField(12, 2, stage)]))]
        )
        patched = build_login_payload_from_business_state(
            login,
            {
                "player": {},
                "inventory": [
                    {"item_id": "meta_campaign_cur_stage", "quantity": 3231}
                ],
                "characters": [],
                "liveops": [],
            },
            classic_layout=True,
        )
        user = parse_proto_fields(get_proto_bytes(parse_proto_fields(patched), 1))
        projected_stage = parse_proto_fields(get_proto_bytes(user, 12))
        self.assertEqual(get_proto_varint(projected_stage, 1), 3231)

    def test_classic_charge_reply_uses_empty_native_open_panel(self):
        templates = build_structured_login_templates(
            "data/fixtures/ws-login-timeline-1.json"
        )
        reply = build_structured_charge_reply(
            {"seq": 102}, templates, classic_layout=True
        )
        root = parse_proto_fields(reply)
        charge = parse_proto_fields(get_proto_bytes(root, 32))
        self.assertEqual(get_proto_bytes(charge, 1), b"")

    def test_classic_login_seeds_repeated_activity_when_template_has_none(self):
        login = encode_proto_fields(
            [ProtoField(1, 2, encode_proto_fields([ProtoField(3, 0, 1)]))]
        )
        patched = build_login_payload_from_business_state(
            login,
            {"player": {}, "inventory": [], "characters": [], "liveops": []},
            classic_layout=True,
        )
        user = parse_proto_fields(get_proto_bytes(parse_proto_fields(patched), 1))
        activities = get_repeated_proto_bytes(user, 38)
        self.assertEqual(len(activities), 1)
        activity = parse_proto_fields(activities[0])
        self.assertEqual(get_proto_varint(activity, 1), 1461)
        self.assertEqual(
            get_proto_varint(activity, 2),
            PROTOBUF_ENUMS["t_activity"]["hundred_draw"],
        )

    def test_activity_projection_encodes_params_in_field_three(self):
        projected = patch_login_activity_entries([], [{
            "activity_key": "act_endless_draw",
            "title": "Unlimited Summons",
            "starts_at": "2026-09-01T00:00:00Z",
            "ends_at": "2026-09-30T00:00:00Z",
        }])
        # HundredDraw compatibility activities are projected alongside the
        # requested liveops row; select the Unlimited Summons entry itself.
        info = next(
            parse_proto_fields(field.value)
            for field in projected
            if get_proto_varint(parse_proto_fields(field.value), 1) == 2032
        )
        self.assertGreaterEqual(len(get_repeated_proto_bytes(info, 3)), 1)
        self.assertEqual(len(get_repeated_proto_bytes(info, 4)), 1)
        act_data = parse_proto_fields(get_proto_bytes(info, 4))
        self.assertEqual(len(get_repeated_proto_bytes(act_data, 111)), 1)

    def test_hd_release_activity_projection_filters_missing_config_and_banner_rows(self):
        projected = patch_login_activity_entries(
            [],
            [
                {"activity_key": "act_endless_draw", "title": "missing in shipped HD table"},
                {"activity_key": "daily_login", "title": "known HD activity"},
            ],
            compatible_activity_ids=frozenset({2450}),
        )
        ids = [
            get_proto_varint(parse_proto_fields(field.value), 1)
            for field in projected
            if field.number == 38
        ]
        self.assertEqual(ids, [2450])
        self.assertNotIn(975, ids)
        self.assertNotIn(1461, ids)
        self.assertNotIn(2032, ids)

    def test_preserves_repeated_wallet_entries_and_patches_assets_and_hero(self):
        currencies = [
            encode_proto_fields([ProtoField(1, 0, 10000001), ProtoField(2, 0, 700)]),
            encode_proto_fields([ProtoField(1, 0, 10000002), ProtoField(2, 0, 600)]),
            encode_proto_fields([ProtoField(1, 0, 10000004), ProtoField(2, 0, 500)]),
            encode_proto_fields([ProtoField(1, 0, 123400004), ProtoField(2, 0, 2)]),
        ]
        item = encode_proto_fields([ProtoField(1, 0, 13), ProtoField(2, 0, 1)])
        hero = encode_proto_fields(
            [
                ProtoField(1, 0, 1),
                ProtoField(2, 0, 22),
                ProtoField(3, 0, 1),
                ProtoField(4, 0, 2),
                ProtoField(5, 0, 10),
                ProtoField(6, 0, 997),
            ]
        )
        user_info = encode_proto_fields(
            [
                ProtoField(6, 0, 700),
                ProtoField(7, 0, 600),
                *[ProtoField(8, 2, entry) for entry in currencies],
                ProtoField(9, 2, item),
                ProtoField(11, 2, hero),
            ]
        )
        login = encode_proto_fields([ProtoField(1, 2, user_info)])
        business_state = {
            "player": {"created_at": "2026-09-01T10:39:34Z"},
            "inventory": [
                {"item_id": "gold", "quantity": 10000},
                {"item_id": "diamond", "quantity": 20000},
                {"item_id": "hero_exp", "quantity": 30000},
                {"item_id": "item_13", "quantity": 20},
            ],
            "characters": [
                {
                    "character_id": "1",
                    "level": 11,
                    "extra_json": {
                        "hero_id": 1,
                        "tid": 22,
                        "quality": 1,
                        "rank": 2,
                        "gs": 1110,
                    },
                }
            ],
        }

        patched = build_login_payload_from_business_state(login, business_state)
        patched_user = parse_proto_fields(get_proto_bytes(parse_proto_fields(patched), 1))
        self.assertEqual(get_proto_varint(patched_user, 6), 10000)
        self.assertEqual(get_proto_varint(patched_user, 7), 20000)
        self.assertEqual(get_proto_varint(patched_user, 32), 1788259174)
        self.assertEqual(get_proto_varint(patched_user, 49), 999)

        currency_entries = get_repeated_proto_bytes(patched_user, 8)
        self.assertEqual(len(currency_entries), 4)
        amounts = {
            get_proto_varint(fields, 1): get_proto_varint(fields, 2)
            for fields in map(parse_proto_fields, currency_entries)
        }
        self.assertEqual(amounts[10000001], 10000)
        self.assertEqual(amounts[10000002], 20000)
        self.assertEqual(amounts[10000004], 30000)
        self.assertEqual(amounts[123400004], 2)

        patched_item = parse_proto_fields(get_proto_bytes(patched_user, 9))
        self.assertEqual(get_proto_varint(patched_item, 2), 20)
        item_amounts = {
            get_proto_varint(fields, 1): get_proto_varint(fields, 2)
            for fields in map(
                parse_proto_fields, get_repeated_proto_bytes(patched_user, 9)
            )
        }
        self.assertEqual(item_amounts[47], 999999)
        self.assertEqual(item_amounts[2044], 999999)
        self.assertEqual(item_amounts[6000], 999999)
        self.assertEqual(item_amounts[6001], 999999)
        patched_hero = parse_proto_fields(get_proto_bytes(patched_user, 11))
        self.assertEqual(get_proto_varint(patched_hero, 5), 11)
        self.assertEqual(get_proto_varint(patched_hero, 6), 1110)

    def test_appends_database_heroes_missing_from_captured_login(self):
        captured_hero = encode_proto_fields(
            [
                ProtoField(1, 0, 1),
                ProtoField(2, 0, 22),
                ProtoField(3, 0, 1),
                ProtoField(4, 0, 2),
                ProtoField(5, 0, 10),
                ProtoField(6, 0, 997),
                ProtoField(8, 0, 0),
            ]
        )
        user_info = encode_proto_fields([ProtoField(11, 2, captured_hero)])
        login = encode_proto_fields([ProtoField(1, 2, user_info)])
        business_state = {
            "player": {},
            "inventory": [],
            "characters": [
                {
                    "character_id": "graduate_hero_4",
                    "level": 1004,
                    "star": 5,
                    "extra_json": {
                        "hero_id": 100004,
                        "tid": 4,
                        "quality": 20,
                        "rank": 5,
                        "gs": 100000000,
                        "artifact_lv": 5,
                    },
                }
            ],
        }

        patched = build_login_payload_from_business_state(login, business_state)
        patched_user = parse_proto_fields(get_proto_bytes(parse_proto_fields(patched), 1))
        heroes = [parse_proto_fields(raw) for raw in get_repeated_proto_bytes(patched_user, 11)]
        self.assertEqual(len(heroes), 2)
        graduated = next(row for row in heroes if get_proto_varint(row, 1) == 100004)
        self.assertEqual(get_proto_varint(graduated, 2), 4)
        self.assertEqual(get_proto_varint(graduated, 5), 1004)
        self.assertEqual(get_proto_varint(graduated, 6), 100000000)
        self.assertEqual(get_proto_varint(graduated, 8), 5)


class ReconnectProtocolTests(unittest.TestCase):
    def test_classifies_captured_reconnect_route(self):
        request = b"".join(
            (
                encode_varint_field(1, 122),
                encode_varint_field(2, 0),
                encode_length_delimited_field(29, b"\x08\x01"),
            )
        )
        self.assertEqual(
            parse_client_message_kind(request),
            {"kind": "reconnect", "seq": 122, "uid": None, "htoken": None},
        )

    def test_builds_reply_reconnect_with_new_backdoor_disabled(self):
        reply = build_structured_reconnect_reply({"seq": 122})
        fields = parse_proto_fields(reply)
        self.assertEqual(get_proto_varint(fields, 2), 122)
        reconnect = parse_proto_fields(get_proto_bytes(fields, 35))
        self.assertIsNone(get_proto_varint(reconnect, 1))
        self.assertEqual(get_proto_varint(reconnect, 4), 0)

    def test_reconnect_projects_current_md5_user_collections(self):
        hero = encode_proto_fields([
            ProtoField(1, 0, 100004), ProtoField(2, 0, 4),
            ProtoField(3, 0, 20), ProtoField(4, 0, 5),
            ProtoField(5, 0, 1004), ProtoField(6, 0, 2000000000),
            ProtoField(8, 0, 5),
        ])
        user = encode_proto_fields([
            ProtoField(8, 2, encode_proto_fields([ProtoField(1, 0, 10000002), ProtoField(2, 0, 999)])),
            ProtoField(11, 2, hero),
        ])
        reply = parse_proto_fields(build_structured_reconnect_reply({"seq": 122}, user))
        reconnect = parse_proto_fields(get_proto_bytes(reply, 35))
        tiny_user = parse_proto_fields(get_proto_bytes(reconnect, 2))
        self.assertIsNotNone(get_proto_bytes(tiny_user, 3))
        md5_user = parse_proto_fields(get_proto_bytes(reconnect, 3))
        self.assertEqual(
            [bytes(field.value).decode() for field in md5_user if field.number == 1],
            ["currency", "item", "equip", "hero"],
        )
        self.assertEqual(len(get_repeated_proto_bytes(md5_user, 2)), 1)
        heroes = get_repeated_proto_bytes(md5_user, 5)
        self.assertEqual(len(heroes), 1)
        self.assertEqual(get_proto_varint(parse_proto_fields(heroes[0]), 1), 100004)

    def test_classifies_shifted_classic_reconnect_body_before_friend_route(self):
        request = base64.b64decode(
            "CJsBkgKvAhIPMTgwOTQ1MDE1NzUyMTkyKi1sb2NhbC10aWNrZXQtYTQ5MThiNjM0NjAwYWEwMGYxNjY3ODVlYTJlNDUyNzUyJjEuMjAxOmFma2FyZW5hX3YxLjIwMS4wMS4zNjA0MDk6MzAxLjA2OigKBGl0ZW0SIDljMmM1NTExOTdmOTEyZDQ4YzdkNjczOTc0Zjg2ZGVmOikKBWVxdWlwEiA3OGNhZTg3NjI1YmQ4NjBiMzEyMTg5YTUwMjlhM2QzODooCgRoZXJvEiA5YWJkMmVlZDhmZmVmZWI2ZGYwNzBlNDQzZmU1OWJjMTosCghjdXJyZW5jeRIgN2Y0OWQ4YmMzYzY5ZmIxNDk0OGUwZmNkZTFkMzRiNWJKGGs3b3JwNzIwaWplNXZwNmsxcWNyZ3FwbtoEIGU0YzY1YzEyN2VhZGU3YTJjZTQ2OWNkZmJmOGViMjcw"
        )
        self.assertEqual(
            parse_client_message_kind(request),
            {"kind": "reconnect", "seq": 155, "reconnect_outer_field": 34},
        )


class StageBattlePayloadTests(unittest.TestCase):
    def test_classic_multi_team_retry_selects_current_team_and_returns_battle_common(self):
        request = base64.b64decode(
            "CJABKlNKUQigGRoqCAESBggBEMKNBhIGCAIQtI0GEgYIAxCpjQYSBggEEKWNBhIGCAUQpI0G"
            "GhoIAhIGCAEQnI8GEgYIAhCbjwYSBggDEJePBiAAKAIwAA=="
        )
        parsed = parse_client_message_kind(request)
        self.assertEqual(parsed["generic_module"], "stage")
        self.assertEqual(parsed["generic_operation"], "retry_battle")
        self.assertEqual(parsed["stage_id"], 3232)
        self.assertEqual(parsed["team_index"], 2)
        self.assertEqual(parsed["lineup_ids"], [100252, 100251, 100247])
        self.assertEqual(len(parsed["lineup_teams"]), 2)
        self.assertEqual(parsed["lineup_teams"][0], [100034, 100020, 100009, 100005, 100004])

        battle = encode_proto_fields([
            ProtoField(1, 0, 1),
            ProtoField(2, 2, encode_varint_field(2, 3232)),
            ProtoField(3, 2, encode_proto_fields([])),
        ])
        generated_start = encode_proto_fields([
            ProtoField(1, 0, 1),
            ProtoField(2, 0, 2),
            ProtoField(6, 2, encode_length_delimited_field(
                3, encode_length_delimited_field(1, battle)
            )),
            ProtoField(9, 2, b"stale-task-delta"),
        ])
        reply = build_structured_stage_retry_reply(parsed, generated_start)
        self.assertIsNotNone(reply)
        response_fields = parse_proto_fields(reply)
        self.assertFalse(any(field.number == 9 for field in response_fields))
        stage = parse_proto_fields(get_proto_bytes(response_fields, 6))
        retry = parse_proto_fields(get_proto_bytes(stage, 9))
        retry_battle = get_proto_bytes(retry, 1)
        self.assertEqual(retry_battle, battle)

        characters = [
            {
                "character_id": f"hero_{hero_id}",
                "level": 8000,
                "star": 5,
                "extra_json": {
                    "hero_id": hero_id,
                    "tid": hero_id - 100000,
                    "quality": 20,
                    "rank": 14,
                    "gs": 2_000_000_000,
                },
            }
            for hero_id in parsed["lineup_teams"][0] + parsed["lineup_teams"][1]
        ]
        patched_battle = build_stage_summary_payload(
            battle,
            {},
            characters,
            [],
            stage_id=3232,
            lineup_ids=parsed["lineup_ids"],
            lineup_teams=parsed["lineup_teams"],
        )
        battle_input = parse_proto_fields(get_proto_bytes(parse_proto_fields(patched_battle), 3))
        self_teams = get_repeated_proto_bytes(battle_input, 1)
        self.assertEqual(len(self_teams), 2)
        second_slots = get_repeated_proto_bytes(parse_proto_fields(self_teams[1]), 1)
        self.assertEqual(
            [get_proto_varint(parse_proto_fields(get_proto_bytes(parse_proto_fields(slot), 2)), 1) for slot in second_slots],
            [100252, 100251, 100247],
        )

    def test_business_battle_replies_strip_stale_fixture_reply_extra(self):
        provider = BusinessStateProvider(enabled=True)
        battle_summary = encode_proto_fields([
            ProtoField(1, 0, 1),
            ProtoField(2, 2, encode_varint_field(2, 13)),
            ProtoField(3, 2, encode_proto_fields([])),
        ])
        start_template = encode_proto_fields([
            ProtoField(1, 0, 1),
            ProtoField(2, 0, 2),
            ProtoField(6, 2, encode_length_delimited_field(
                3, encode_length_delimited_field(1, battle_summary)
            )),
            ProtoField(9, 2, b"stale-task-delta"),
        ])
        start_reply = provider._build_stage_battle_start_reply(
            {"seq": 88, "stage_id": 13, "lineup_ids": []},
            start_template,
            {"player": {}, "characters": [], "stages": []},
        )
        self.assertFalse(any(field.number == 9 for field in parse_proto_fields(start_reply)))

        result_template = encode_proto_fields([
            ProtoField(1, 0, 1),
            ProtoField(2, 0, 2),
            ProtoField(6, 2, encode_length_delimited_field(
                4,
                encode_proto_fields([
                    ProtoField(1, 0, 1),
                    ProtoField(3, 2, encode_varint_field(1, 13)),
                ]),
            )),
            ProtoField(9, 2, b"stale-task-delta"),
        ])
        result_reply = provider._build_stage_battle_result_reply(
            {"seq": 89, "battle_result": "defeat"},
            result_template,
            {"player": {}, "inventory": [], "stages": []},
        )
        self.assertFalse(any(field.number == 9 for field in parse_proto_fields(result_reply)))

    def test_character_payload_projects_advanced_growth_into_native_fields(self):
        hero = parse_proto_fields(build_character_hero_payload({
            "level": 1004,
            "star": 5,
            "extra": {
                "hero_id": 100004,
                "tid": 4,
                "quality": 20,
                "rank": 5,
                "gs": 2_000_000_000,
                "equips": {"1": {"id": 1000041, "tid": 159, "enhance_lv": 5, "source_tid": 159}},
                "artifact_id": 103,
                "artifact_tid": 103,
                "artifact_awaken_lv": 5,
                "artifact_lv": 5,
                "pentagram_lv": 1004,
                "signature_level": 50,
                "furnitures": [{"id": 10000401, "tid": 100724, "lv": 0, "hero_tag": 1}],
                "trans_quality": 20,
            },
        }))
        equip_entry = parse_proto_fields(get_proto_bytes(hero, 7))
        self.assertEqual(get_proto_varint(equip_entry, 1), 1)
        equip = parse_proto_fields(get_proto_bytes(equip_entry, 2))
        self.assertEqual(get_proto_varint(equip, 2), 159)
        self.assertEqual(get_proto_varint(equip, 5), 5)
        artifact = parse_proto_fields(get_proto_bytes(hero, 11))
        self.assertEqual(get_proto_varint(artifact, 2), 103)
        self.assertEqual(get_proto_varint(artifact, 3), 5)
        self.assertEqual(get_proto_varint(hero, 12), 1004)
        signature = parse_proto_fields(get_proto_bytes(hero, 13))
        self.assertEqual(get_proto_varint(signature, 1), 50)
        furniture = parse_proto_fields(get_proto_bytes(hero, 17))
        self.assertEqual(get_proto_varint(furniture, 2), 100724)
        hd_hero = parse_proto_fields(project_proto_message(
            encode_proto_fields(hero), "hero", "hero", LEGACY_PROTO_DEFS, NEW_PROTO_DEFS
        ))
        self.assertEqual(get_proto_varint(hd_hero, 21), 20)
        self.assertIsNotNone(get_proto_bytes(hd_hero, 10))
        self.assertIsNotNone(get_proto_bytes(hd_hero, 15))

    def test_stage_start_does_not_write_scalars_into_battle_stats(self):
        battle_input = encode_proto_fields(
            [
                ProtoField(1, 2, b""),
                ProtoField(4, 0, 1_700_000_000),
                ProtoField(5, 0, 66),
                ProtoField(6, 0, 240),
            ]
        )
        battle = encode_proto_fields(
            [
                ProtoField(1, 0, 1),
                ProtoField(2, 2, encode_varint_field(2, 13)),
                ProtoField(3, 2, battle_input),
            ]
        )
        patched = build_stage_summary_payload(
            battle,
            {"level": 240},
            [{
                "character_id": "graduate_hero_4",
                "level": 1004,
                "star": 5,
                "extra_json": {
                    "hero_id": 100004,
                    "tid": 4,
                    "quality": 20,
                    "rank": 5,
                    "gs": 2000000000,
                    "artifact_lv": 5,
                },
            }],
            [],
            stage_id=3232,
            battle_seed=987654,
            lineup_ids=[100004],
        )
        patched_battle = parse_proto_fields(patched)
        patched_common = parse_proto_fields(get_proto_bytes(patched_battle, 2))
        self.assertEqual(get_proto_varint(patched_common, 1), 987654)
        self.assertEqual(get_proto_varint(patched_common, 2), 3232)
        patched_input = parse_proto_fields(
            get_proto_bytes(patched_battle, 3)
        )
        self.assertFalse(
            any(
                field.number in (5, 6) and field.wire_type == 0
                for field in patched_input
            )
        )
        self_teams = get_repeated_proto_bytes(patched_input, 1)
        self.assertEqual(len(self_teams), 1)
        team = parse_proto_fields(self_teams[0])
        slots = get_repeated_proto_bytes(team, 1)
        self.assertEqual(len(slots), 1)
        slot = parse_proto_fields(slots[0])
        self.assertEqual(get_proto_varint(slot, 1), 1)
        hero = parse_proto_fields(get_proto_bytes(slot, 2))
        self.assertEqual(get_proto_varint(hero, 1), 100004)
        self.assertEqual(get_proto_varint(hero, 2), 4)
        self.assertEqual(get_proto_varint(hero, 3), 15)
        self.assertEqual(get_proto_varint(hero, 5), 1004)
        self.assertEqual(get_proto_varint(hero, 6), 2000000000)


class HeroUpgradeProtocolTests(unittest.TestCase):
    def test_classifies_captured_req_unit_up_level_shape(self):
        up_level = encode_proto_fields([ProtoField(1, 0, 1), ProtoField(2, 0, 1)])
        request = encode_proto_fields(
            [
                ProtoField(1, 0, 111),
                ProtoField(2, 0, 0),
                ProtoField(4, 2, encode_length_delimited_field(1, up_level)),
            ]
        )
        self.assertEqual(
            parse_client_message_kind(request),
            {"kind": "hero_up_level", "seq": 111, "hero_id": 1, "up_level": 1},
        )

    def test_builds_captured_reply_unit_upgrade_shape(self):
        reply = build_structured_hero_upgrade_reply({"seq": 111})
        fields = parse_proto_fields(reply)
        self.assertEqual(get_proto_varint(fields, 2), 111)
        unit = parse_proto_fields(get_proto_bytes(fields, 5))
        up_level = parse_proto_fields(get_proto_bytes(unit, 1))
        hero = parse_proto_fields(get_proto_bytes(up_level, 1))
        self.assertEqual(get_proto_varint(hero, 1), 1)
        self.assertEqual(get_proto_varint(hero, 5), 11)
        self.assertEqual(get_proto_varint(hero, 6), 1110)
        cost = parse_proto_fields(get_proto_bytes(up_level, 3))
        self.assertEqual(len(get_repeated_proto_bytes(cost, 1)), 3)

    def test_classifies_and_builds_quality_and_equipment_growth(self):
        quality = encode_proto_fields([ProtoField(1, 0, 1), ProtoField(2, 0, 2)])
        request = encode_proto_fields([ProtoField(1, 0, 112), ProtoField(4, 2, encode_length_delimited_field(2, quality))])
        info = parse_client_message_kind(request)
        self.assertEqual(info["kind"], "hero_up_quality")
        self.assertEqual(info["cost_hero_ids"], [2])
        reply = build_hero_growth_reply(info, {"character": {"level": 10, "star": 2, "extra": {"hero_id": 1, "tid": 22, "quality": 2, "rank": 2}}})
        outer = parse_proto_fields(reply)
        unit = parse_proto_fields(get_proto_bytes(outer, 5))
        self.assertIsNotNone(get_proto_bytes(unit, 2))

        wear = encode_proto_fields([ProtoField(1, 0, 1), ProtoField(2, 0, 3), ProtoField(3, 0, 77)])
        wear_request = encode_proto_fields([ProtoField(1, 0, 113), ProtoField(4, 2, encode_length_delimited_field(3, wear))])
        self.assertEqual(parse_client_message_kind(wear_request)["kind"], "hero_wear_equip")

        wear_best = encode_proto_fields([ProtoField(1, 0, 1), ProtoField(2, 0, 1)])
        wear_best_request = encode_proto_fields([ProtoField(1, 0, 114), ProtoField(4, 2, encode_length_delimited_field(6, wear_best))])
        wear_best_info = parse_client_message_kind(wear_best_request)
        self.assertEqual(wear_best_info["kind"], "hero_wear_best_equip")
        self.assertEqual(wear_best_info["hero_id"], 1)
        reply = build_hero_growth_reply(
            wear_best_info,
            {"character": {"level": 10, "star": 2, "extra": {"hero_id": 1, "tid": 22, "equips": {"1": 77}}}},
        )
        unit = parse_proto_fields(get_proto_bytes(parse_proto_fields(reply), 5))
        wear_best_reply = parse_proto_fields(get_proto_bytes(unit, 6))
        new_hero = parse_proto_fields(get_proto_bytes(wear_best_reply, 1))
        self.assertEqual(get_proto_varint(new_hero, 1), 1)
        self.assertIsNotNone(get_proto_bytes(new_hero, 7))

        remove_all_request = encode_proto_fields([ProtoField(1, 0, 115), ProtoField(4, 2, encode_varint_field(5, 1))])
        remove_all_info = parse_client_message_kind(remove_all_request)
        self.assertEqual(remove_all_info["kind"], "hero_remove_all_equips")
        self.assertEqual(remove_all_info["hero_id"], 1)


class TavernTenPullProtocolTests(unittest.TestCase):
    def test_open_panel_projects_graduated_draw_counts_for_stargazer_unlock(self):
        pool_ids = [1, 6, 7, 5, 12, 14, 15, 23, 24, 25, 26, 27, 28, 29, 30]
        tavern_state = {"draw_times": {str(pool_id): 999 for pool_id in pool_ids}, "amazing_point": 999}
        panel = parse_proto_fields(build_tavern_open_panel_payload(tavern_state))
        self.assertEqual(get_proto_varint(panel, 8), 22)
        self.assertEqual(get_proto_varint(panel, 16), 124)
        self.assertEqual(
            [field.value for field in panel if field.number == 1],
            pool_ids,
        )
        draw_counts = {}
        for raw_entry in get_repeated_proto_bytes(panel, 2):
            entry = parse_proto_fields(raw_entry)
            draw_counts[get_proto_varint(entry, 1)] = get_proto_varint(entry, 2)
        self.assertEqual(draw_counts, {pool_id: 999 for pool_id in pool_ids})

        hd_panel = parse_proto_fields(
            project_proto_message(
                build_tavern_open_panel_payload(tavern_state),
                "reply_tavern_open_panel",
                "reply_tavern_open_panel",
                LEGACY_PROTO_DEFS,
                NEW_PROTO_DEFS,
            )
        )
        self.assertEqual(get_proto_varint(hd_panel, 17), 999)
        self.assertEqual(get_proto_varint(hd_panel, 15), 124)

    def test_furniture_tavern_open_panel_has_pools_maps_and_unlock(self):
        info = {
            "seq": 120,
            "generic_module": "homeland_tavern",
            "generic_operation": "open_panel",
            "generic_reply_operation_field": 1,
            "generic_reply_outer_field": 98,
            "generic_reply_type": "reply_homeland_tavern_open_panel",
        }
        reply = build_generic_protocol_reply(info, {})
        outer = parse_proto_fields(reply)
        module = parse_proto_fields(get_proto_bytes(outer, 98))
        panel = parse_proto_fields(get_proto_bytes(module, 1))
        self.assertEqual([field.value for field in panel if field.number == 1], [8])
        draw_times = [parse_proto_fields(raw) for raw in get_repeated_proto_bytes(panel, 2)]
        self.assertEqual([get_proto_varint(row, 1) for row in draw_times], [15, 16])
        self.assertEqual(len(get_repeated_proto_bytes(panel, 3)), 9)
        self.assertEqual(get_proto_varint(panel, 4), 999)
        self.assertEqual(get_proto_varint(panel, 6), 1)

    def test_furniture_tavern_ten_draw_returns_ten_furniture_rows(self):
        info = {
            "seq": 120,
            "generic_module": "homeland_tavern",
            "generic_operation": "draw",
            # draw_tavern_cnt counts ten-pull batches for an even TavernID.
            "generic_payload": {"field_1": 16, "field_2": 1},
            "generic_reply_operation_field": 2,
            "generic_reply_outer_field": 98,
            "generic_reply_type": "reply_homeland_tavern_draw",
        }
        reply = parse_proto_fields(build_generic_protocol_reply(info, {}))
        module = parse_proto_fields(get_proto_bytes(reply, 98))
        draw = parse_proto_fields(get_proto_bytes(module, 2))
        reward = parse_proto_fields(get_proto_bytes(draw, 1))
        furnitures = [
            parse_proto_fields(raw)
            for raw in get_repeated_proto_bytes(reward, 5)
        ]
        self.assertEqual(len(furnitures), 10)
        self.assertTrue(all(get_proto_varint(row, 2) >= 10001 for row in furnitures))
        self.assertIsNotNone(get_proto_bytes(draw, 2))

    def test_homeland_look_around_has_friend_and_nonempty_buildings(self):
        info = {
            "seq": 121,
            "generic_module": "homeland_friend",
            "generic_operation": "look_around",
            "generic_reply_operation_field": 7,
            "generic_reply_outer_field": 97,
            "generic_reply_type": "reply_homeland_friend_look_around",
        }
        reply = parse_proto_fields(build_generic_protocol_reply(info, {}))
        module = parse_proto_fields(get_proto_bytes(reply, 97))
        look_around = parse_proto_fields(get_proto_bytes(module, 7))
        self.assertIsNotNone(get_proto_bytes(look_around, 1))
        buildings = get_repeated_proto_bytes(look_around, 2)
        self.assertEqual(len(buildings), 1)
        building = parse_proto_fields(buildings[0])
        self.assertEqual(get_proto_varint(building, 1), 1)
        self.assertEqual(len(get_repeated_proto_bytes(building, 2)), 1)

    def test_dragon_tavern_open_has_both_pool_progress_and_targets(self):
        info = {
            "seq": 121,
            "generic_module": "tavern",
            "generic_operation": "req_open_tavern",
            "generic_reply_operation_field": 16,
            "generic_reply_outer_field": 13,
            "generic_reply_type": "reply_tavern_open",
        }
        reply = build_generic_protocol_reply(info, {
            "draw_times": {str(pool_id): pool_id * 10 for pool_id in [14, 15, 25, 26, 27, 28, 29, 30]},
            "wish_tids": {"14": 22, "15": 23, "25": 24},
        })
        module = parse_proto_fields(get_proto_bytes(parse_proto_fields(reply), 13))
        panel = parse_proto_fields(get_proto_bytes(module, 16))
        self.assertEqual(len(get_repeated_proto_bytes(panel, 1)), 20)
        points = [parse_proto_fields(raw) for raw in get_repeated_proto_bytes(panel, 2)]
        self.assertEqual([get_proto_varint(row, 1) for row in points], [14, 15, 25, 26, 27, 28, 29, 30])
        self.assertEqual([get_proto_varint(row, 2) for row in points], [140, 150, 250, 260, 270, 280, 290, 300])
        self.assertEqual(len(get_repeated_proto_bytes(panel, 3)), 8)

    def test_endless_draw_returns_ten_concrete_assets(self):
        info = {
            "seq": 122,
            "generic_module": "act_endless_draw",
            "generic_operation": "draw",
            "generic_reply_operation_field": 2,
            "generic_reply_outer_field": 186,
            "generic_reply_type": "endless_draw_result",
        }
        reply = build_generic_protocol_reply(info, {})
        module = parse_proto_fields(get_proto_bytes(parse_proto_fields(reply), 186))
        result = parse_proto_fields(get_proto_bytes(module, 2))
        self.assertEqual(get_proto_varint(result, 1), 1)
        assets = [parse_proto_fields(raw) for raw in get_repeated_proto_bytes(result, 2)]
        self.assertEqual(len(assets), 10)
        self.assertTrue(all(get_proto_varint(asset, 1) == 4 for asset in assets))

        reply = build_generic_protocol_reply(info, {"rewards": [{"type": "hero", "id": 17, "amount": 1}]})
        module = parse_proto_fields(get_proto_bytes(parse_proto_fields(reply), 186))
        result = parse_proto_fields(get_proto_bytes(module, 2))
        self.assertEqual(len(get_repeated_proto_bytes(result, 2)), 10)

        reward_info = {**info, "generic_operation": "reward", "generic_reply_operation_field": 4,
                       "generic_reply_type": "reward"}
        reply = build_generic_protocol_reply(reward_info, {})
        module = parse_proto_fields(get_proto_bytes(parse_proto_fields(reply), 186))
        reward = parse_proto_fields(get_proto_bytes(module, 4))
        self.assertEqual(len(get_repeated_proto_bytes(reward, 3)), 10)

    def test_activity_calendar_contains_endless_draw_with_live_window(self):
        info = {
            "seq": 123,
            "generic_module": "activity",
            "generic_operation": "calendar_acts",
            "generic_reply_operation_field": 15,
            "generic_reply_outer_field": 12,
            "generic_reply_type": "reply_calendar_acts",
        }
        reply = build_generic_protocol_reply(info, {})
        module = parse_proto_fields(get_proto_bytes(parse_proto_fields(reply), 12))
        calendar = parse_proto_fields(get_proto_bytes(module, 15))
        acts = [parse_proto_fields(raw) for raw in get_repeated_proto_bytes(calendar, 1)]
        endless = next(row for row in acts if get_proto_varint(row, 1) == 2032)
        self.assertGreater(get_proto_varint(endless, 3), 0)
        self.assertGreater(get_proto_varint(endless, 4), get_proto_varint(endless, 3))
        self.assertEqual(len(get_repeated_proto_bytes(endless, 5)), 1)

    def test_maps_captured_tavern_id_two_to_ten_draws(self):
        request = encode_proto_fields(
            [
                ProtoField(1, 0, 110),
                ProtoField(2, 0, 0),
                ProtoField(
                    11,
                    2,
                    encode_length_delimited_field(2, encode_varint_field(1, 2)),
                ),
            ]
        )
        self.assertEqual(
            parse_client_message_kind(request),
            {
                "kind": "tavern_draw",
                "seq": 110,
                "protocol_tavern_id": 2,
                "draw_count": 10,
            },
        )

    def test_builds_ten_hero_rewards_and_total_ticket_cost(self):
        hero = {
            "id": 1005,
            "tid": 17,
            "quality": 1,
            "rank": 1,
            "level": 1,
            "gs": 797,
        }
        draw_result = {
            "reply_tavern": {
                "draw": {
                    "reward": {"heroes": [hero for _ in range(10)]},
                    "cost": {"assets": [{"type": "item", "id": 13, "amount": 10}]},
                }
            }
        }
        reply = build_structured_tavern_draw_reply(
            {"seq": 110, "draw_count": 10}, draw_result
        )
        outer = parse_proto_fields(reply)
        tavern = parse_proto_fields(get_proto_bytes(outer, 13))
        draw = parse_proto_fields(get_proto_bytes(tavern, 2))
        reward = parse_proto_fields(get_proto_bytes(draw, 1))
        self.assertEqual(len(get_repeated_proto_bytes(reward, 3)), 10)
        self.assertEqual(get_proto_varint(draw, 5), 20)
        self.assertIsNone(get_proto_bytes(draw, 4))
        cost = parse_proto_fields(get_proto_bytes(draw, 2))
        asset = parse_proto_fields(get_proto_bytes(cost, 1))
        self.assertEqual(get_proto_varint(asset, 2), 13)
        self.assertEqual(get_proto_varint(asset, 3), 10)


class CoreSystemsProtocolTests(unittest.TestCase):
    def request(self, outer_field, inner):
        return encode_proto_fields([ProtoField(1, 0, 300), ProtoField(2, 0, 0), ProtoField(outer_field, 2, inner)])

    def test_classifies_shop_mail_task_and_four_game_modes(self):
        cases = [
            (8, encode_varint_field(1, 2), "shop_open"),
            (10, encode_length_delimited_field(1, b""), "mail_list"),
            (13, encode_length_delimited_field(1, b""), "task_info"),
            (14, encode_length_delimited_field(1, b""), "guild_open"),
            (15, encode_length_delimited_field(1, b""), "arena_open"),
            (16, encode_length_delimited_field(1, b""), "tower_open"),
            (24, encode_length_delimited_field(1, b""), "maze_open"),
        ]
        for outer, inner, expected in cases:
            self.assertEqual(parse_client_message_kind(self.request(outer, inner))["kind"], expected)

    def test_builders_use_recovered_down_message_fields(self):
        task = parse_proto_fields(build_task_system_reply({"seq": 301, "kind": "task_info"}, {"task_info": {}}))
        self.assertIsNotNone(get_proto_bytes(task, 15))

    def test_charge_exchange_is_classified_for_instant_grant(self):
        exchange = encode_proto_fields([ProtoField(1, 0, 74257200), ProtoField(2, 0, 987600046)])
        request = encode_proto_fields([ProtoField(1, 0, 701), ProtoField(30, 2, encode_length_delimited_field(3, exchange))])
        info = parse_client_message_kind(request)
        self.assertEqual(info["kind"], "charge_purchase")
        self.assertEqual(info["goods_id"], 987600046)
        reply = parse_proto_fields(build_instant_charge_reply(info, {"rewards": [{"type": "item", "id": 999, "amount": 10}]}))
        charge = parse_proto_fields(get_proto_bytes(reply, 32))
        self.assertIsNotNone(get_proto_bytes(charge, 3))

    def test_line_task_claim_builds_field_four_reply(self):
        line = encode_proto_fields([ProtoField(1, 0, 2), ProtoField(2, 0, 801)])
        request = encode_proto_fields([ProtoField(1, 0, 702), ProtoField(13, 2, encode_length_delimited_field(4, line))])
        info = parse_client_message_kind(request)
        self.assertEqual(info["kind"], "task_line_claim")
        self.assertEqual(info["task_line"], 2)
        reply = parse_proto_fields(build_task_system_reply(info, {"ok": True, "ids": [801], "rewards": []}))
        task = parse_proto_fields(get_proto_bytes(reply, 15))
        self.assertIsNotNone(get_proto_bytes(task, 4))
        shop = parse_proto_fields(build_shop_system_reply({"seq": 302, "kind": "shop_open", "shop_id": 2}, {"shop_id": 2, "goods": []}))
        self.assertIsNotNone(get_proto_bytes(shop, 10))
        mail = parse_proto_fields(build_mail_system_reply({"seq": 303, "kind": "mail_list"}, {"mails": []}))
        self.assertIsNotNone(get_proto_bytes(mail, 12))
        arena = parse_proto_fields(build_arena_system_reply({"seq": 304, "kind": "arena_open"}, {}))
        self.assertIsNotNone(get_proto_bytes(arena, 17))
        tower = parse_proto_fields(build_tower_system_reply({"seq": 305, "kind": "tower_open"}, {}))
        self.assertIsNotNone(get_proto_bytes(tower, 18))
        maze = parse_proto_fields(build_maze_system_reply({"seq": 306, "kind": "maze_open"}, {}))
        self.assertIsNotNone(get_proto_bytes(maze, 27))
        guild = parse_proto_fields(build_guild_system_reply({"seq": 307, "kind": "guild_join", "id": 1}, {"guild_id": 1}))
        self.assertIsNotNone(get_proto_bytes(guild, 16))

    def test_tower_start_field_order_and_guild_lifecycle_routes(self):
        slot = encode_proto_fields([ProtoField(1, 0, 1), ProtoField(2, 0, 42)])
        team = encode_proto_fields([ProtoField(1, 0, 1), ProtoField(2, 2, slot)])
        tower_start = encode_proto_fields([ProtoField(1, 0, 2), ProtoField(2, 0, 17), ProtoField(4, 2, team), ProtoField(5, 0, 1)])
        tower = parse_client_message_kind(self.request(16, encode_length_delimited_field(2, tower_start)))
        self.assertEqual(tower["tower_type"], 2)
        self.assertEqual(tower["floor_id"], 17)
        self.assertEqual(tower["lineup_ids"], [42])

        create = encode_proto_fields([ProtoField(1, 2, "测试公会".encode()), ProtoField(2, 0, 1)])
        parsed_create = parse_client_message_kind(self.request(14, encode_length_delimited_field(2, create)))
        self.assertEqual(parsed_create["kind"], "guild_create")
        self.assertEqual(parsed_create["name"], "测试公会")
        search = encode_proto_fields([ProtoField(1, 0, 7)])
        self.assertEqual(parse_client_message_kind(self.request(14, encode_length_delimited_field(4, search)))["id"], 7)

        reply = parse_proto_fields(build_guild_system_reply({"seq": 308, "kind": "guild_open"}, {"joined": False}))
        guild = parse_proto_fields(get_proto_bytes(reply, 16))
        opened = parse_proto_fields(get_proto_bytes(guild, 2))
        self.assertIsNotNone(get_proto_bytes(opened, 2))

    def test_extended_mode_reply_routes(self):
        arena = parse_proto_fields(build_arena_system_reply({"seq": 310, "kind": "arena_buy_ticket"}, {"cost": [], "rewards": []}))
        self.assertIsNotNone(get_proto_bytes(parse_proto_fields(get_proto_bytes(arena, 17)), 10))
        tower = parse_proto_fields(build_tower_system_reply({"seq": 311, "kind": "tower_records"}, {}))
        self.assertIsNotNone(get_proto_bytes(parse_proto_fields(get_proto_bytes(tower, 18)), 4))
        maze = parse_proto_fields(build_maze_system_reply({"seq": 312, "kind": "maze_give_up", "cell_id": 1}, {"cell_id": 1}))
        self.assertIsNotNone(get_proto_bytes(parse_proto_fields(get_proto_bytes(maze, 27)), 11))
        guild = parse_proto_fields(build_guild_system_reply({"seq": 313, "kind": "guild_boss_open"}, {"boss_id": 1, "attempts": 3}))
        self.assertIsNotNone(get_proto_bytes(parse_proto_fields(get_proto_bytes(guild, 16)), 19))

        settled = parse_proto_fields(build_guild_system_reply(
            {"seq": 314, "kind": "guild_boss_end"},
            {"boss_id": 1, "attempts": 1, "battle_id": "guild-1", "rewards": [{"type": "currency", "id": "guild_coin", "amount": 1}]},
        ))
        guild_reply = parse_proto_fields(get_proto_bytes(settled, 16))
        end_reply = parse_proto_fields(get_proto_bytes(guild_reply, 21))
        misc_reward = parse_proto_fields(get_proto_bytes(end_reply, 1))
        self.assertEqual(get_proto_varint(misc_reward, 1), 1)
        self.assertIsNotNone(get_proto_bytes(misc_reward, 2))
        self.assertIsNotNone(get_proto_bytes(end_reply, 2))

    def test_maze_battle_query_contains_native_enemy_slots(self):
        action = {
            "cell_id": 2,
            "cell": {"id": 2, "type": "normal", "type_id": 0, "status": 0},
            "authoritative_battle": {"enemy_team": [
                {"id": "enemy_2_1", "slot": 1, "tid": 1008, "quality": 1, "rank": 1, "level": 2, "hp": 100, "atk": 10},
            ]},
        }
        outer = parse_proto_fields(build_maze_system_reply({"seq": 314, "kind": "maze_query", "cell_id": 2}, action))
        maze = parse_proto_fields(get_proto_bytes(outer, 27))
        query = parse_proto_fields(get_proto_bytes(maze, 2))
        cell = parse_proto_fields(get_proto_bytes(query, 1))
        enemies = get_repeated_proto_bytes(cell, 13)
        self.assertEqual(len(enemies), 1)
        enemy = parse_proto_fields(enemies[0])
        self.assertEqual(len(get_repeated_proto_bytes(enemy, 2)), 1)
        rewards = get_repeated_proto_bytes(query, 2)
        self.assertEqual(len(rewards), 1)
        preview_reward = parse_proto_fields(rewards[0])
        self.assertEqual(get_proto_varint(preview_reward, 1), 1)
        self.assertIsNotNone(get_proto_bytes(preview_reward, 2))

    def test_maze_victory_marks_enemy_defeated_and_keeps_relic_pool(self):
        action = {
            "cell_id": 2,
            "cell": {"id": 2, "type": "normal", "type_id": 0, "status": 1, "heirloom_pool": [1017, 1042, 1063]},
            "battle_result": 1,
            "rewards": [],
        }
        outer = parse_proto_fields(build_maze_system_reply({"seq": 315, "kind": "maze_end", "cell_id": 2}, action))
        maze = parse_proto_fields(get_proto_bytes(outer, 27))
        ended = parse_proto_fields(get_proto_bytes(maze, 5))
        cell = parse_proto_fields(get_proto_bytes(ended, 3))
        self.assertEqual([int(field.value) for field in cell if field.number == 8], [1017, 1042, 1063])
        enemy = parse_proto_fields(get_repeated_proto_bytes(cell, 13)[0])
        self.assertEqual(get_proto_varint(enemy, 4), 1)

    def test_maze_carriage_projects_four_heroes_and_selected_assistant(self):
        heroes = [
            {"id": 6000221 + index, "tid": tid, "quality": 8, "rank": 10, "level": 240, "gs": 120000}
            for index, tid in enumerate((22, 31, 17, 39))
        ]
        action = {
            "cell_id": 22,
            "cell": {"id": 22, "type": "carriage", "type_id": 9, "status": 0, "assist_heroes": heroes},
            "assist_hero": heroes[0],
        }
        outer = parse_proto_fields(build_maze_system_reply({"seq": 316, "kind": "maze_use_relic", "cell_id": 22}, action))
        maze = parse_proto_fields(get_proto_bytes(outer, 27))
        used = parse_proto_fields(get_proto_bytes(maze, 6))
        cell = parse_proto_fields(get_proto_bytes(used, 1))
        self.assertEqual(len(get_repeated_proto_bytes(cell, 10)), 4)
        selected = parse_proto_fields(get_proto_bytes(used, 3))
        self.assertEqual(get_proto_varint(selected, 1), heroes[0]["id"])
        self.assertEqual(get_proto_varint(selected, 2), 22)
        self.assertEqual(get_proto_varint(selected, 8), 0)

    def test_accepts_extended_live_heartbeat_payload(self):
        nested = encode_proto_fields([ProtoField(1, 0, 120), ProtoField(2, 0, 30000000), ProtoField(3, 0, 2)])
        request = self.request(19, nested)
        reply = try_build_heartbeat_reply(request)
        self.assertIsNotNone(reply)
        self.assertEqual(get_proto_varint(parse_proto_fields(reply), 2), 300)

    def test_friend_recommendations_are_encoded_from_social_ecosystem(self):
        request_info = {
            "seq": 314,
            "generic_module": "friend",
            "generic_operation": "query_rec_friends",
            "generic_reply_outer_field": 37,
            "generic_reply_operation_field": 12,
            "generic_reply_type": "reply_user_summaries",
        }
        reply = parse_proto_fields(build_generic_protocol_reply(request_info, {
            "social_friends": {
                "suggestions": [{
                    "bot_id": 90000001,
                    "nickname": "Test Ranger",
                    "level": 35,
                    "avatar": "avatar:1134006",
                    "guild_id": 2,
                    "guild_name": "Test Guild",
                    "power": 58216,
                }]
            }
        }))
        friend = parse_proto_fields(get_proto_bytes(reply, 37))
        recommendations = parse_proto_fields(get_proto_bytes(friend, 12))
        summary = parse_proto_fields(get_proto_bytes(recommendations, 1))
        self.assertEqual(get_proto_varint(summary, 1), 90000001)
        self.assertEqual(get_proto_bytes(summary, 3), b"Test Ranger")
        self.assertEqual(get_proto_varint(summary, 13), 58216)

    def test_edit_user_route_and_reply_include_persisted_nickname(self):
        edit = encode_proto_fields([ProtoField(1, 2, "伊索米亚勇者".encode("utf-8"))])
        request = encode_proto_fields([ProtoField(1, 0, 315), ProtoField(17, 2, encode_length_delimited_field(1, edit))])
        info = parse_client_message_kind(request)
        self.assertEqual(info["kind"], "generic_users")
        self.assertEqual(info["generic_operation"], "req_edit_user")
        self.assertEqual(info["generic_payload"]["field_1"], "伊索米亚勇者")
        reply = parse_proto_fields(build_generic_protocol_reply(info, {
            "ok": True,
            "wire_projection": {"result": "success", "name": "伊索米亚勇者", "desc": ""},
        }))
        users = parse_proto_fields(get_proto_bytes(reply, 19))
        edited = parse_proto_fields(get_proto_bytes(users, 1))
        self.assertEqual(get_proto_varint(edited, 1), 1)
        self.assertEqual(get_proto_bytes(edited, 2), "伊索米亚勇者".encode("utf-8"))


if __name__ == "__main__":
    unittest.main()
