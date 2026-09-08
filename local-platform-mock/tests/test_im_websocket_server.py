import unittest

from im_websocket_server import wire_timestamp


class IMTimestampTests(unittest.TestCase):
    def test_im_wire_uses_unix_milliseconds(self):
        self.assertEqual(wire_timestamp(1_788_684_000), 1_788_684_000_000)
        self.assertEqual(wire_timestamp(1_788_684_000_123), 1_788_684_000_123)

    def test_iso_timestamp_is_encoded_as_milliseconds(self):
        value = wire_timestamp("2026-09-06T08:54:01+00:00")
        self.assertGreaterEqual(value, 1_000_000_000_000)
        self.assertEqual(value % 1000, 0)


if __name__ == "__main__":
    unittest.main()
