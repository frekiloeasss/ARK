#!/usr/bin/env python3
import argparse
import ipaddress
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate a local self-signed certificate for the AFK mock HTTPS listener."
    )
    parser.add_argument("--cert-path", required=True)
    parser.add_argument("--key-path", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    return parser.parse_args()


def maybe_ip_address(value: str):
    try:
        return ipaddress.ip_address(value)
    except ValueError:
        return None


def build_subject() -> x509.Name:
    return x509.Name(
        [
            x509.NameAttribute(NameOID.COUNTRY_NAME, "CN"),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "AFK Local Mock"),
            x509.NameAttribute(NameOID.COMMON_NAME, "afk-local-mock"),
        ]
    )


def build_san_entries(host: str) -> list[x509.GeneralName]:
    entries: list[x509.GeneralName] = [
        x509.DNSName("localhost"),
        x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
        x509.IPAddress(ipaddress.ip_address("::1")),
    ]

    normalized_host = str(host or "").strip()
    if normalized_host and normalized_host not in {"0.0.0.0", "::"}:
        host_ip = maybe_ip_address(normalized_host)
        if host_ip is not None:
            entries.append(x509.IPAddress(host_ip))
        elif normalized_host.lower() != "localhost":
            entries.append(x509.DNSName(normalized_host))

    return entries


def write_pem_files(cert_path: Path, key_path: Path, host: str) -> None:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = build_subject()
    san_entries = build_san_entries(host)
    now = datetime.now(timezone.utc)

    certificate = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=365))
        .add_extension(x509.SubjectAlternativeName(san_entries), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]),
            critical=False,
        )
        .sign(private_key=key, algorithm=hashes.SHA256())
    )

    cert_path.parent.mkdir(parents=True, exist_ok=True)
    key_path.parent.mkdir(parents=True, exist_ok=True)

    cert_path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )


def main() -> int:
    args = parse_args()
    cert_path = Path(args.cert_path)
    key_path = Path(args.key_path)

    if cert_path.exists() and key_path.exists():
        print(f"Reusing existing dev certificate: {cert_path}")
        return 0

    write_pem_files(cert_path=cert_path, key_path=key_path, host=args.host)
    print(f"Generated dev certificate: {cert_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
