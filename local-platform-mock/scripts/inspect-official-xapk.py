"""Inspect an AFK Arena XAPK without installing it or changing the emulator."""
from __future__ import annotations

import argparse
import hashlib
import json
import tempfile
import zipfile
from pathlib import Path

from androguard.core.apk import APK
from loguru import logger

logger.remove()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("xapk")
    parser.add_argument("--expected-package", default="com.lilithgame.hgame.gp")
    parser.add_argument("--expected-version", default="")
    parser.add_argument("--expected-cert-sha1", default="acf60a05aa19fa5de96b1988a87a29e90e4c6f15")
    parser.add_argument("--output", default="")
    args = parser.parse_args()
    source = Path(args.xapk).resolve()
    with zipfile.ZipFile(source) as archive:
        apk_names = [name for name in archive.namelist() if name.lower().endswith(".apk")]
        if not apk_names:
            raise RuntimeError("XAPK contains no APK")
        manifest = json.loads(archive.read("manifest.json")) if "manifest.json" in archive.namelist() else {}
        declared_base = next((entry.get("file") for entry in manifest.get("split_apks", []) if entry.get("id") == "base"), None)
        base_name = declared_base if declared_base in apk_names else min(apk_names, key=lambda name: ("config." in name or "asset" in name.lower(), -archive.getinfo(name).file_size))
        with tempfile.TemporaryDirectory(prefix="afk-xapk-") as temporary:
            base_path = Path(temporary) / "base.apk"
            with archive.open(base_name) as src, base_path.open("wb") as dst:
                for block in iter(lambda: src.read(1024 * 1024), b""):
                    dst.write(block)
            apk = APK(str(base_path))
            certificates = []
            for cert in apk.get_certificates_der_v3() or apk.get_certificates_der_v2() or apk.get_certificates_der_v1() or []:
                certificates.append(hashlib.sha1(cert).hexdigest())
            result = {
                "format": "afk-official-xapk-inspection-v1",
                "xapk": str(source), "xapk_bytes": source.stat().st_size, "xapk_sha256": sha256(source),
                "base_apk_entry": base_name, "apk_count": len(apk_names), "package": apk.get_package(),
                "version_name": apk.get_androidversion_name() or manifest.get("version_name"), "version_code": apk.get_androidversion_code() or manifest.get("version_code"),
                "certificate_sha1": certificates, "valid_apk": bool(apk.is_valid_APK()),
            }
    expected_cert = args.expected_cert_sha1.lower().replace(":", "")
    result["checks"] = {
        "package": result["package"] == args.expected_package,
        "version": not args.expected_version or result["version_name"] == args.expected_version,
        "certificate": expected_cert in certificates,
    }
    result["ok"] = result["valid_apk"] and all(result["checks"].values())
    encoded = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        Path(args.output).write_text(encoded + "\n", encoding="utf-8")
    print(encoded)
    return 0 if result["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
