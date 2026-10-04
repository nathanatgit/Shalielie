"""Check certificate chain, renewal and a real HTTPS request to the dev server."""
from functools import partial
from http.server import ThreadingHTTPServer
import ipaddress
from pathlib import Path
import ssl
import sys
import tempfile
import threading
import urllib.request

from cryptography import x509
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.x509.oid import ExtendedKeyUsageOID

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from create_https_cert import generate
from serve_web import IsolatedHandler

# Documentation-only addresses; these fixtures never connect to a LAN host.
TEST_IP = "192.0.2.10"
RENEWED_TEST_IP = "192.0.2.11"

with tempfile.TemporaryDirectory() as directory:
    output = generate(TEST_IP, directory)
    ca_bytes = (output / "rootCA.pem").read_bytes()
    ca_key_bytes = (output / "rootCA-key.pem").read_bytes()
    ca = x509.load_der_x509_certificate((output / "rootCA.cer").read_bytes())
    cert = x509.load_pem_x509_certificate((output / "lan-cert.pem").read_bytes())
    ca.public_key().verify(cert.signature, cert.tbs_certificate_bytes, padding.PKCS1v15(), cert.signature_hash_algorithm)
    assert x509.load_pem_x509_certificate(ca_bytes) == ca
    assert cert.extensions.get_extension_for_class(x509.BasicConstraints).value.ca is False
    assert ExtendedKeyUsageOID.SERVER_AUTH in cert.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value
    assert ipaddress.ip_address(TEST_IP) in cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value.get_values_for_type(x509.IPAddress)
    assert (cert.not_valid_after_utc - cert.not_valid_before_utc).days == 90

    generate(RENEWED_TEST_IP, output)
    assert (output / "rootCA.pem").read_bytes() == ca_bytes
    assert (output / "rootCA-key.pem").read_bytes() == ca_key_bytes
    renewed = x509.load_pem_x509_certificate((output / "lan-cert.pem").read_bytes())
    assert renewed.serial_number != cert.serial_number
    assert ipaddress.ip_address(RENEWED_TEST_IP) in renewed.extensions.get_extension_for_class(x509.SubjectAlternativeName).value.get_values_for_type(x509.IPAddress)

    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(IsolatedHandler, directory=str(ROOT / "web")))
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(output / "lan-cert.pem", output / "lan-key.pem")
    server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        client = ssl.create_default_context(cafile=str(output / "rootCA.pem"))
        with urllib.request.urlopen(f"https://localhost:{server.server_port}/", context=client) as response:
            assert response.status == 200
            assert response.headers["Cross-Origin-Opener-Policy"] == "same-origin"
            assert response.headers["Cross-Origin-Embedder-Policy"] == "require-corp"
            assert b'app.js?v=' in response.read()
    finally:
        server.shutdown()
        server.server_close()
        thread.join()

try:
    generate(TEST_IP, ROOT / "web" / "certs")
except ValueError:
    pass
else:
    raise AssertionError("Private keys must not be generated in the served directory")
print("Certificate chain, SAN, CA reuse, DER export and trusted HTTPS isolation headers passed")
