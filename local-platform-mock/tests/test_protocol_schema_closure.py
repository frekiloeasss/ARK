import json
import unittest
from pathlib import Path

from afk_protocol import get_proto_bytes, get_proto_varint, parse_proto_fields
from websocket_proxy import build_generic_protocol_reply


ROOT = Path(__file__).resolve().parents[1]


class ProtocolSchemaClosureTests(unittest.TestCase):
    def test_every_recovered_operation_builds_a_parseable_typed_reply(self):
        route_map = json.loads((ROOT / "runtime" / "protocol-route-map.json").read_text(encoding="utf-8"))["modules"]
        operation_count = 0
        for request_field, module in route_map.items():
            for operation_field, operation in module["operations"].items():
                info = {
                    "seq": operation_count + 1,
                    "generic_reply_outer_field": module["reply_outer_field"],
                    "generic_reply_operation_field": operation["reply_field"],
                    "generic_reply_type": operation["reply_type"],
                }
                transaction = {
                    "state": {"level": 2, "progress": 3, "score": 4, "rank": 5, "position": 6, "attempts": 1},
                    "wire_projection": {"result": 1, "level": 2, "progress": 3, "score": 4, "rank": 5, "position": 6, "attempts": 1, "timestamp": 100},
                    "rewards": [{"type": "currency", "id": "gold", "amount": 10}],
                    "costs": [],
                }
                outer = parse_proto_fields(build_generic_protocol_reply(info, transaction))
                self.assertEqual(get_proto_varint(outer, 2), operation_count + 1, f"{module['module']}.{operation['request_name']}")
                self.assertIsNotNone(get_proto_bytes(outer, module["reply_outer_field"]), f"{module['module']}.{operation['request_name']}")
                operation_count += 1
        self.assertGreater(operation_count, 1500)


if __name__ == "__main__":
    unittest.main()
