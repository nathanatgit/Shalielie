# /// script
# requires-python = ">=3.12"
# dependencies = ["cryptography>=45,<47"]
# ///
"""Create local HTTPS certificates; preserves the CA already trusted by an iPhone."""
import argparse
from datetime import datetime, timedelta, timezone
import ipaddress
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID


def save_key(path, key):
    path.write_bytes(key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ))
    path.chmod(0o600)


def generate(ip, output):
    address = ipaddress.ip_address(ip)
    output = Path(output).resolve()
    web = Path(__file__).resolve().parents[1] / "web"
    if output.is_relative_to(web.resolve()):
        raise ValueError("Certificate/private-key files must be outside web/")
    output.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)
    ca_path, ca_key_path = output / "rootCA.pem", output / "rootCA-key.pem"
    if ca_path.exists() != ca_key_path.exists():
        raise ValueError("Incomplete existing CA: both rootCA.pem and rootCA-key.pem are required")
    if ca_path.exists():
        ca = x509.load_pem_x509_certificate(ca_path.read_bytes())
        ca_key = serialization.load_pem_private_key(ca_key_path.read_bytes(), password=None)
        if (ca.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
                != ca_key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)):
            raise ValueError("Existing CA certificate and key do not match")
        if not ca.extensions.get_extension_for_class(x509.BasicConstraints).value.ca:
            raise ValueError("Existing root certificate is not a CA")
        if not ca.not_valid_before_utc <= now < ca.not_valid_after_utc - timedelta(days=90):
            raise ValueError("Existing CA is not valid for the next 90 days; use a new output directory and trust its root on the iPhone")
    else:
        ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Shalielie Local HTTPS CA")])
        ca = (x509.CertificateBuilder()
              .subject_name(name).issuer_name(name).public_key(ca_key.public_key())
              .serial_number(x509.random_serial_number())
              .not_valid_before(now - timedelta(minutes=5))
              .not_valid_after(now + timedelta(days=3650))
              .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
              .add_extension(x509.KeyUsage(
                  digital_signature=True, content_commitment=False, key_encipherment=False,
                  data_encipherment=False, key_agreement=False, key_cert_sign=True,
                  crl_sign=True, encipher_only=False, decipher_only=False), critical=True)
              .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
              .sign(ca_key, hashes.SHA256()))
        save_key(ca_key_path, ca_key)
        ca_path.write_bytes(ca.public_bytes(serialization.Encoding.PEM))

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    names = [x509.IPAddress(address), x509.DNSName("localhost")]
    for loopback in ("127.0.0.1", "::1"):
        if address != ipaddress.ip_address(loopback):
            names.append(x509.IPAddress(ipaddress.ip_address(loopback)))
    cert = (x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, str(address))]))
            .issuer_name(ca.subject).public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(minutes=5)).not_valid_after(now + timedelta(days=90))
            .add_extension(x509.SubjectAlternativeName(names), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.KeyUsage(
                digital_signature=True, content_commitment=False, key_encipherment=True,
                data_encipherment=False, key_agreement=False, key_cert_sign=False,
                crl_sign=False, encipher_only=False, decipher_only=False), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
            .sign(ca_key, hashes.SHA256()))
    save_key(output / "lan-key.pem", key)
    (output / "lan-cert.pem").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    # DER .cer is convenient for installing a certificate profile on iOS.
    (output / "rootCA.cer").write_bytes(ca.public_bytes(serialization.Encoding.DER))
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ip", required=True, help="LAN IP used in the iPhone's URL")
    parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[1] / ".local-https")
    args = parser.parse_args()
    try:
        output = generate(args.ip, args.out)
    except (ValueError, OSError, x509.ExtensionNotFound) as error:
        parser.error(str(error))
    print(f"HTTPS certificate and key: {output / 'lan-cert.pem'} / {output / 'lan-key.pem'}")
    print(f"Install ONLY {output / 'rootCA.cer'} on the iPhone, then enable full trust.")
    print("No OS trust settings have been changed. Keep both *-key.pem files on this computer.")
    print("Server certificate is valid for 90 days. Re-run to renew or change IP; the CA is reused.")


if __name__ == "__main__":
    main()
