import unittest

from afk_protocol import (
    classify_field13_request,
    ProtoField,
    classify_field11_request,
    classify_field5_request,
    decode_varint,
    encode_proto_fields,
    encode_varint,
    parse_proto_fields,
    replace_top_level_varint_field,
)


class VarintTests(unittest.TestCase):
    def test_round_trip_boundary_values(self):
        for value in (0, 1, 127, 128, 255, 16384, 2**32, 2**63 - 1):
            encoded = encode_varint(value)
            decoded, offset = decode_varint(encoded)
            self.assertEqual(decoded, value)
            self.assertEqual(offset, len(encoded))

    def test_negative_varint_is_rejected(self):
        with self.assertRaises(ValueError):
            encode_varint(-1)


class ProtoFieldTests(unittest.TestCase):
    def test_fields_round_trip(self):
        fields = [ProtoField(1, 0, 104), ProtoField(5, 2, b"\x32\x00")]
        self.assertEqual(parse_proto_fields(encode_proto_fields(fields)), fields)

    def test_replaces_sequence_without_changing_other_fields(self):
        original = encode_proto_fields(
            [ProtoField(1, 0, 100), ProtoField(2, 0, 7), ProtoField(5, 2, b"x")]
        )
        replaced = parse_proto_fields(replace_top_level_varint_field(original, 2, 99))
        self.assertEqual(replaced[1], ProtoField(2, 0, 99))
        self.assertEqual(replaced[2], ProtoField(5, 2, b"x"))

    def test_unsupported_wire_type_is_rejected(self):
        with self.assertRaises(ValueError):
            parse_proto_fields(b"\x0d")


class RouteClassificationTests(unittest.TestCase):
    def test_stage_routes(self):
        self.assertEqual(classify_field5_request(b"\x32\x00"), "stage_query_assist_summaries")
        self.assertEqual(classify_field5_request(b"\x1a\x00"), "stage_battle_start")
        self.assertEqual(classify_field5_request(b"\x22\x00"), "stage_battle_result")
        self.assertEqual(classify_field5_request(b"\x2a\x00"), "stage_quick_idle_claim")

    def test_tavern_routes(self):
        self.assertEqual(classify_field11_request(b"\x0a\x00"), "tavern_open_panel")
        self.assertEqual(classify_field11_request(b"\x12\x02\x08\x01"), "tavern_draw")

    def test_captured_task_batch_route(self):
        self.assertEqual(
            classify_field13_request(b"\x40\x01\x40\x04\x40\x05\x40\x06"),
            "task_batch_claim",
        )


if __name__ == "__main__":
    unittest.main()
