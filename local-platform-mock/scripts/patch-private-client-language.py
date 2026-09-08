#!/usr/bin/env python3
"""Set the default language in an encrypted AFK Arena game.jsone file."""

import argparse
import importlib.util
import json
from pathlib import Path


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets-root", type=Path, required=True)
    parser.add_argument("--libsec", type=Path, required=True)
    parser.add_argument("--language", default="cn")
    args = parser.parse_args()

    scripts_dir = Path(__file__).resolve().parent
    decrypt_module = load_module("afk_decrypt", scripts_dir / "decrypt-afk-config.py")
    patch_module = load_module(
        "afk_private_patch", scripts_dir / "patch-private-client-game-util.py"
    )
    decryptor = decrypt_module.AfkDecryptor(args.libsec)
    encryptor = patch_module.AfkEncryptor(decrypt_module, args.libsec)

    probe = bytes.fromhex("0011223344556677")
    if decryptor.decrypt_block(encryptor.encrypt_block(probe)) != probe:
        raise RuntimeError("Native encryption round-trip validation failed")

    targets = [
        args.assets_root / "hd" / "game.jsone",
        args.assets_root / "classic" / "game.jsone",
    ]
    patched_count = 0
    for target in targets:
        if not target.exists():
            continue
        config = json.loads(decryptor.decrypt(target.read_bytes()).decode("utf-8"))
        previous = config.get("sysLang")
        config["sysLang"] = args.language
        plain = json.dumps(config, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        encrypted = encryptor.encrypt(plain)
        target.write_bytes(encrypted)
        verified = json.loads(decryptor.decrypt(encrypted).decode("utf-8"))
        if verified.get("sysLang") != args.language:
            raise RuntimeError(f"Language verification failed for {target}")
        patched_count += 1
        print(f"patched {target}: sysLang {previous!r} -> {args.language!r}")

    if not patched_count:
        raise RuntimeError("No game.jsone files found under assets root")


if __name__ == "__main__":
    main()
