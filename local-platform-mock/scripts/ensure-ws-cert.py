#!/usr/bin/env python3
"""Issue a local WSS leaf certificate from the mitmproxy CA trusted by the emulator."""

import argparse
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ca-pem", type=Path, required=True)
    parser.add_argument("--cert-path", type=Path, required=True)
    parser.add_argument("--key-path", type=Path, required=True)
    parser.add_argument("--dns-name", action="append", required=True)
    args = parser.parse_args()

    ca_pem = args.ca_pem.read_bytes()
    ca_cert = x509.load_pem_x509_certificate(ca_pem)
    ca_key = serialization.load_pem_private_key(ca_pem, password=None)
    dns_names = sorted(set(args.dns_name))

    if args.cert_path.exists() and args.key_path.exists():
        existing = x509.load_pem_x509_certificate(args.cert_path.read_bytes())
        try:
            existing_names = sorted(
                item.value
                for item in existing.extensions.get_extension_for_class(
                    x509.SubjectAlternativeName
                ).value
                if isinstance(item, x509.DNSName)
            )
        except x509.ExtensionNotFound:
            existing_names = []
        if existing.issuer == ca_cert.subject and existing_names == dns_names:
            print(f"Reusing WSS certificate: {args.cert_path}")
            return 0

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    now = datetime.now(timezone.utc)
    subject = x509.Name(
        [
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "AFK Local Gateway"),
            x509.NameAttribute(NameOID.COMMON_NAME, dns_names[0]),
        ]
    )
    certificate = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(ca_cert.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=365))
        .add_extension(
            x509.SubjectAlternativeName([x509.DNSName(name) for name in dns_names]),
            critical=False,
        )
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]),
            critical=False,
        )
        .sign(ca_key, hashes.SHA256())
    )

    args.cert_path.parent.mkdir(parents=True, exist_ok=True)
    args.cert_path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    args.key_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        )
    )
    print(f"Generated WSS certificate: {args.cert_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
