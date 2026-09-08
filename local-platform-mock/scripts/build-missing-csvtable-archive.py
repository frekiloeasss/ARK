#!/usr/bin/env python3
"""Rebuild one missing AFK csvtable archive and match its URL hash prefix."""

import argparse
import hashlib
import struct
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


def build_zip(source_dir: Path, letter: str) -> bytes:
    import io

    files = sorted(source_dir.glob(f"{letter.upper()}*.jsone"))
    if not files:
        raise RuntimeError(f"No {letter.upper()}*.jsone files found under {source_dir}")
    buffer = io.BytesIO()
    with ZipFile(buffer, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for source in files:
            info = ZipInfo(f"csvjson/cn/{source.name}", (2026, 9, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, source.read_bytes(), compress_type=ZIP_DEFLATED, compresslevel=9)
    return buffer.getvalue()


def match_md5_prefix(payload: bytes, prefix: str) -> tuple[bytes, str, int]:
    prefix = prefix.lower()
    if not prefix or any(ch not in "0123456789abcdef" for ch in prefix):
        raise ValueError("MD5 prefix must be hexadecimal")
    if payload[-2:] != b"\x00\x00":
        raise RuntimeError("ZIP already has a comment")

    hashed_prefix = payload[:-2] + struct.pack("<H", 4)
    base = hashlib.md5(hashed_prefix)
    for nonce in range(0x1_0000_0000):
        comment = struct.pack("<I", nonce)
        digest = base.copy()
        digest.update(comment)
        hexdigest = digest.hexdigest()
        if hexdigest.startswith(prefix):
            return hashed_prefix + comment, hexdigest, nonce
    raise RuntimeError("Unable to match MD5 prefix")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--letter", default="P")
    parser.add_argument("--md5-prefix", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    base_zip = build_zip(args.source_dir, args.letter)
    patched_zip, digest, nonce = match_md5_prefix(base_zip, args.md5_prefix)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(patched_zip)

    with ZipFile(args.output) as archive:
        names = archive.namelist()
        if not names or any(not name.startswith("csvjson/cn/") for name in names):
            raise RuntimeError("Generated archive failed validation")
        for name in names:
            archive.read(name)
    print(
        f"built {args.output} entries={len(names)} bytes={len(patched_zip)} "
        f"md5={digest} nonce={nonce}"
    )


if __name__ == "__main__":
    main()
