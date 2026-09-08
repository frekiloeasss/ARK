#!/usr/bin/env python3
"""Bulk-decrypt an AFK .jsone tree with one reusable native decryptor.

The original single-file helper is intentionally kept unchanged.  This wrapper
loads it once, supports deterministic sharding, validates every decrypted JSON
document, and emits a per-shard evidence manifest.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import time


def load_decryptor(script_path: Path):
    spec = importlib.util.spec_from_file_location("afk_config_decrypt", script_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load decryptor: {script_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.AfkDecryptor


def atomic_write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    temporary.write_bytes(payload)
    temporary.replace(path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--libsec", type=Path, required=True)
    parser.add_argument("--shard-count", type=int, default=1)
    parser.add_argument("--shard-index", type=int, default=0)
    parser.add_argument("--pattern", default="*.jsone")
    parser.add_argument("--output-suffix", default=".json")
    parser.add_argument("--validate-json", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    if args.shard_count < 1 or not 0 <= args.shard_index < args.shard_count:
        parser.error("invalid shard selection")
    root = args.input.resolve()
    output = args.output.resolve()
    files = sorted(root.rglob(args.pattern))
    selected = [path for index, path in enumerate(files) if index % args.shard_count == args.shard_index]
    decryptor_type = load_decryptor(Path(__file__).with_name("decrypt-afk-config.py"))
    decryptor = decryptor_type(args.libsec.resolve())
    started = time.time()
    records: list[dict[str, object]] = []
    failures: list[dict[str, str]] = []

    for position, source in enumerate(selected, 1):
        relative = source.relative_to(root).with_suffix(args.output_suffix)
        target = output / relative
        try:
            if target.exists() and not args.force:
                plain = target.read_bytes()
                if args.validate_json or args.output_suffix.lower() == ".json":
                    json.loads(plain)
                status = "existing"
            else:
                plain = decryptor.decrypt(source.read_bytes())
                if args.validate_json or args.output_suffix.lower() == ".json":
                    json.loads(plain)
                else:
                    plain.decode("utf-8")
                atomic_write(target, plain)
                status = "decrypted"
            records.append({
                "source": source.relative_to(root).as_posix(),
                "output": relative.as_posix(),
                "bytes": len(plain),
                "sha256": hashlib.sha256(plain).hexdigest(),
                "status": status,
            })
            if position % 25 == 0 or position == len(selected):
                print(f"shard {args.shard_index}: {position}/{len(selected)}", flush=True)
        except Exception as error:  # retain a complete audit instead of stopping the shard
            failures.append({"source": source.relative_to(root).as_posix(), "error": str(error)})
            print(f"FAILED {source}: {error}", file=sys.stderr, flush=True)

    manifest = {
        "format": "afk-decrypted-config-shard-v1",
        "source_root": str(root),
        "output_root": str(output),
        "libsec": str(args.libsec.resolve()),
        "shard_count": args.shard_count,
        "shard_index": args.shard_index,
        "selected": len(selected),
        "completed": len(records),
        "failed": len(failures),
        "duration_seconds": round(time.time() - started, 3),
        "records": records,
        "failures": failures,
    }
    atomic_write(
        output / f"manifest-shard-{args.shard_index}-of-{args.shard_count}.json",
        (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
    )
    print(json.dumps({key: manifest[key] for key in ("shard_index", "selected", "completed", "failed", "duration_seconds")}))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
