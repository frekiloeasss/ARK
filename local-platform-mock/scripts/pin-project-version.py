#!/usr/bin/env python3
"""Pin an encrypted AFK project.jsone while preserving its LZ4 wrapper."""

import argparse
import hashlib
import importlib.util
import json
import struct
from pathlib import Path

import lz4.block


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--libsec", type=Path, required=True)
    parser.add_argument("--version", required=True)
    args = parser.parse_args()

    scripts_dir = Path(__file__).resolve().parent
    decrypt_module = load_module("afk_decrypt", scripts_dir / "decrypt-afk-config.py")
    patch_module = load_module(
        "afk_private_patch", scripts_dir / "patch-private-client-game-util.py"
    )
    decryptor = decrypt_module.AfkDecryptor(args.libsec)
    encryptor = patch_module.AfkEncryptor(decrypt_module, args.libsec)

    original = args.input.read_bytes()
    header, source = patch_module.extract_wrapper(decrypt_module, decryptor, original)
    project = json.loads(source.decode("utf-8"))
    project["latestVersion"] = args.version
    project["secLatestVersion"] = args.version

    # Keep the official formatting so the output differs only in the two version
    # values. The wrapper header carries the plaintext MD5 used by native verify.
    patched_source = json.dumps(project, ensure_ascii=False, indent=4).encode("utf-8")
    if source.endswith(b"\n"):
        patched_source += b"\n"
    digest = hashlib.md5(patched_source).hexdigest().encode("ascii")
    header = header[:-32] + digest
    compressed = lz4.block.compress(patched_source, store_size=False)
    wrapped = header + struct.pack("<I", len(patched_source)) + compressed
    result = encryptor.encrypt(wrapped)

    if decryptor.decrypt(result) != patched_source:
        raise RuntimeError("Pinned project verification failed")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(result)
    print(
        f"pinned {args.input} -> {args.output}: {args.version} "
        f"({len(result)} bytes, md5 {digest.decode()})"
    )


if __name__ == "__main__":
    main()
