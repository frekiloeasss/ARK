#!/usr/bin/env python3
import argparse
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from urllib.parse import unquote, urlparse

import websocket_proxy as ws


def load_events(path: Path) -> list[dict]:
    events = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            events.append(json.loads(line))
    return events


CLIENT_DIRECTIONS = {
    "client_to_upstream",
    "client_to_local_replay",
    "client_to_local_structured",
    "client_to_local_interaction",
}
SERVER_DIRECTIONS = {
    "upstream_to_client",
    "local_replay_to_client",
    "local_structured_to_client",
    "local_interaction_to_client",
}


def business_generator_for_request_kind(request_kind: str | None) -> str | None:
    for generator, config in ws.BUSINESS_RESPONSE_GENERATORS.items():
        if request_kind in config["fallback_kinds"]:
            return generator
    return None


def classify_direction(direction: str) -> str:
    if direction in CLIENT_DIRECTIONS:
        return "expect_client"
    if direction in SERVER_DIRECTIONS:
        return "send_client"
    raise ValueError(f"Unsupported websocket frame direction in fixture extraction: {direction}")


def build_fixture(events: list[dict], session_id: int, source_log: Path) -> dict:
    session_frames = [
        event for event in events
        if event.get("session_id") == session_id and event.get("event") == "frame"
    ]

    if not session_frames:
        raise ValueError(f"No websocket frames found for session {session_id}.")

    timeline = []
    previous_ts = None
    client_frame_count = 0
    server_frame_count = 0

    for index, frame in enumerate(session_frames, start=1):
        frame_ts = datetime.fromisoformat(frame["ts"])
        capture_gap_ms = 0
        if previous_ts is not None:
            capture_gap_ms = max(0, round((frame_ts - previous_ts).total_seconds() * 1000))
        previous_ts = frame_ts

        kind = classify_direction(frame["direction"])
        if kind == "expect_client":
            client_frame_count += 1
        else:
            server_frame_count += 1

        timeline.append(
            {
                "index": index,
                "label": f"event_{index}",
                "kind": kind,
                "message_type": frame["message_type"],
                "payload": frame.get("text") or frame.get("base64"),
                "size": frame["size"],
                "captured_direction": frame["direction"],
                "capture_gap_ms": capture_gap_ms,
                # Only server sends need their captured delay replayed.
                "delay_ms": capture_gap_ms if kind == "send_client" else 0,
            }
        )

    return {
        "format_version": 2,
        "source_log": str(source_log.resolve()),
        "session_id": session_id,
        "events": timeline,
        "post_replay": {"mode": "auto_heartbeat"},
        "stats": {
            "frame_count": len(session_frames),
            "client_frame_count": client_frame_count,
            "server_frame_count": server_frame_count,
        },
    }


def decode_frame_payload(frame: dict) -> str | bytes:
    if frame["message_type"] == "text":
        return frame.get("text", "")
    if frame["message_type"] == "binary":
        import base64

        return base64.b64decode(frame["base64"])
    raise ValueError(f"Unsupported websocket frame message_type: {frame['message_type']}")


def frame_payload(frame: dict) -> str:
    return frame.get("text") or frame.get("base64")


def build_interaction_fixture(
    events: list[dict],
    session_id: int,
    source_log: Path,
    include_login: bool,
) -> dict:
    session_frames = [
        event for event in events
        if event.get("session_id") == session_id and event.get("event") == "frame"
    ]

    if not session_frames:
        raise ValueError(f"No websocket frames found for session {session_id}.")

    rules = []
    previous_ts = None
    pending_request = None
    rule_index = 1
    skipped_request_count = 0

    for frame in session_frames:
        frame_ts = datetime.fromisoformat(frame["ts"])
        capture_gap_ms = 0
        if previous_ts is not None:
            capture_gap_ms = max(0, round((frame_ts - previous_ts).total_seconds() * 1000))
        previous_ts = frame_ts

        direction = frame["direction"]
        if classify_direction(direction) == "expect_client":
            request_message = decode_frame_payload(frame)
            request_signature = ws.request_signature(request_message)
            request_kind = request_signature.get("kind")
            if not include_login and request_kind in {"sdk_login", "login", "charge", "heartbeat"}:
                pending_request = None
                skipped_request_count += 1
                continue

            pending_request = {
                "label": f"rule_{rule_index}_{request_kind or 'request'}",
                "frame": frame,
                "request_signature": request_signature,
                "responses": [],
            }
            continue

        if pending_request is None:
            continue

        response_message = decode_frame_payload(frame)
        response = {
            "label": f"{pending_request['label']}_response_{len(pending_request['responses']) + 1}",
            "message_type": frame["message_type"],
            "payload": frame_payload(frame),
            "size": frame["size"],
            "captured_direction": direction,
            "capture_gap_ms": capture_gap_ms,
            "delay_ms": capture_gap_ms,
            "response_signature": ws.response_signature(response_message),
        }
        business_generator = business_generator_for_request_kind(
            pending_request["request_signature"].get("kind")
        )
        if business_generator:
            generator_config = ws.BUSINESS_RESPONSE_GENERATORS[business_generator]
            response["business_generator"] = business_generator
            response["business_label"] = generator_config["label"]
            response["business_tables"] = generator_config["tables"]
        pending_request["responses"].append(response)

        request_signature = dict(pending_request["request_signature"])
        match = {
            "message_type": request_signature.get("message_type"),
            "kind": request_signature.get("kind"),
            "size": request_signature.get("size"),
            "top_fields": request_signature.get("top_fields"),
        }
        if request_signature.get("route_field") is not None:
            match["route_field"] = request_signature.get("route_field")
            match["route_payload_sizes"] = request_signature.get("route_payload_sizes")
            if request_signature.get("route_payload_shapes") is not None:
                match["route_payload_shapes"] = request_signature.get("route_payload_shapes")
            if request_signature.get("route_field") != 5:
                match["route_payload_sha1"] = request_signature.get("route_payload_sha1")

        if match.get("kind") == "heartbeat":
            match["repeatable"] = True

        rules.append(
            {
                "index": rule_index,
                "label": pending_request["label"],
                "match": match,
                "request": pending_request["request_signature"],
                "responses": pending_request["responses"],
            }
        )
        rule_index += 1
        pending_request = None

    return {
        "format_version": 3,
        "fixture_type": "interaction_rules",
        "source_log": str(source_log.resolve()),
        "session_id": session_id,
        "unmatched_policy": "log",
        "rules": rules,
        "post_replay": {"mode": "auto_heartbeat"},
        "stats": {
            "frame_count": len(session_frames),
            "rule_count": len(rules),
            "skipped_request_count": skipped_request_count,
        },
    }


def load_mysql_config() -> dict:
    database_url = os.environ.get("AFK_DB_URL")
    if database_url:
        parsed = urlparse(database_url)
        return {
            "host": parsed.hostname or "127.0.0.1",
            "port": parsed.port or 3306,
            "user": unquote(parsed.username or "root"),
            "password": unquote(parsed.password or ""),
            "database": unquote(parsed.path.lstrip("/") or "AFK"),
            "charset": "utf8mb4",
            "autocommit": True,
        }

    return {
        "host": os.environ.get("AFK_DB_HOST", "127.0.0.1"),
        "port": int(os.environ.get("AFK_DB_PORT", "3306")),
        "user": os.environ.get("AFK_DB_USER", "root"),
        "password": os.environ.get("AFK_DB_PASSWORD", os.environ.get("MYSQL_PWD", "")),
        "database": os.environ.get("AFK_DB_NAME", os.environ.get("MYSQL_DATABASE", "AFK")),
        "charset": "utf8mb4",
        "autocommit": True,
    }


def import_interaction_rules_to_mysql(fixture: dict, source_fixture: Path | None) -> int:
    rules = fixture.get("rules") or []
    if not rules:
        return 0

    root = Path(__file__).resolve().parent
    node_script = root / "scripts" / "import-interaction-rules.js"
    fixture_path = source_fixture
    temporary_path = None

    if fixture_path is None:
        handle = tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            suffix=".json",
            delete=False,
        )
        temporary_path = Path(handle.name)
        with handle:
            json.dump(fixture, handle, ensure_ascii=False, separators=(",", ":"))
        fixture_path = temporary_path

    try:
        result = subprocess.run(
            ["node", str(node_script), "--fixture", str(fixture_path)],
            cwd=root,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        if result.stdout.strip():
            print(result.stdout.strip())
    except subprocess.CalledProcessError as exc:
        if exc.stdout:
            sys.stdout.write(exc.stdout)
        if exc.stderr:
            sys.stderr.write(exc.stderr)
        raise
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)

    return len(rules)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract a websocket replay timeline fixture from ws-frames.jsonl.")
    parser.add_argument("--log-file", required=True)
    parser.add_argument("--session-id", type=int, required=True)
    parser.add_argument("--output")
    parser.add_argument(
        "--mode",
        choices=("timeline", "interaction"),
        default="timeline",
        help="timeline preserves captured order; interaction builds request-matched local response rules.",
    )
    parser.add_argument(
        "--include-login",
        action="store_true",
        help="Include sdk_login/login/charge/heartbeat requests in interaction fixtures.",
    )
    parser.add_argument(
        "--write-mysql",
        action="store_true",
        help="Write generated interaction rules directly into MySQL ws_interaction_rules.",
    )
    parser.add_argument(
        "--mysql-only",
        action="store_true",
        help="Write rules to MySQL without writing an output fixture file.",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    log_file = Path(args.log_file)
    events = load_events(log_file)
    if args.mode == "interaction":
        fixture = build_interaction_fixture(events, args.session_id, log_file, args.include_login)
    else:
        fixture = build_fixture(events, args.session_id, log_file)

    output_path = Path(args.output) if args.output else None
    if args.mysql_only and args.mode != "interaction":
        raise ValueError("--mysql-only is only supported with --mode interaction.")
    if args.mysql_only and not args.write_mysql:
        raise ValueError("--mysql-only requires --write-mysql.")
    if output_path is None and not args.mysql_only:
        raise ValueError("--output is required unless --mysql-only is used.")

    if output_path is not None and not args.mysql_only:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(fixture, ensure_ascii=False, indent=2), encoding="utf-8")
        print(output_path)

    if args.write_mysql:
        if args.mode != "interaction":
            raise ValueError("--write-mysql is only supported with --mode interaction.")
        inserted = import_interaction_rules_to_mysql(fixture, output_path)
        print(f"Inserted {inserted} interaction rules into MySQL.")
