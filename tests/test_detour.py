"""The detour, over a real encrypted connection to a server on this machine.

The other tests replace the network. These do not, because what matters about
the detour is in the connection itself: it goes to an address of our choosing,
so it must still refuse any server that cannot prove it is the site.

Nothing here leaves the machine. The test server gets a certificate made on
the spot with the ``openssl`` command, which GitHub's runners have. Where that
command is missing, these tests are skipped.
"""

import errno
import gzip
import http.client
import http.server
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

from parkbot import fetch
from parkbot.fetch import FetchError, NoAnswer

# The test server's certificate says it is this site, and no other.
SITE = "weather.example"
HERE = "127.0.0.1"

_CERTIFICATE_REQUEST = f"""\
[req]
distinguished_name = name
x509_extensions = extensions
prompt = no
[name]
CN = {SITE}
[extensions]
subjectAltName = DNS:{SITE}
basicConstraints = critical, CA:TRUE
keyUsage = critical, digitalSignature, keyCertSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
"""


class _Site(http.server.BaseHTTPRequestHandler):
    """A stand-in for the weather service."""

    protocol_version = "HTTP/1.1"
    requests: list[tuple[str, dict[str, str]]] = []

    def do_GET(self):  # noqa: N802 - the name http.server looks for
        self.requests.append((self.path, dict(self.headers)))
        status, headers, body = 404, {}, b"no such page"
        if self.path.startswith("/v1/forecast"):
            status, body = 200, gzip.compress(b'{"rain": "likely"}')
            headers = {"Content-Type": "application/json; charset=utf-8", "Content-Encoding": "gzip"}
        elif self.path == "/plain":
            status, body, headers = 200, "Café at 4pm".encode(), {"Content-Type": "text/plain; charset=utf-8"}
        elif self.path == "/moved":
            status, body, headers = 302, b"", {"Location": "/plain"}
        elif self.path == "/busy":
            status, body = 503, b"try later"
        self.send_response(status)
        for name, value in headers.items():
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *arguments):
        pass  # keep the test output quiet


@unittest.skipUnless(shutil.which("openssl"), "the openssl command is needed to make the test server's certificate")
class DetourOverARealConnectionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._folder = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls._folder.cleanup)
        folder = Path(cls._folder.name)
        (folder / "request.cnf").write_text(_CERTIFICATE_REQUEST, encoding="utf-8")
        cls.certificate = str(folder / "certificate.pem")
        subprocess.run(
            [
                "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
                "-config", str(folder / "request.cnf"), "-keyout", str(folder / "key.pem"), "-out", cls.certificate,
            ],  # fmt: skip
            check=True,
            capture_output=True,
            timeout=120,
        )
        server_side = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        server_side.load_cert_chain(cls.certificate, str(folder / "key.pem"))
        cls.server = http.server.ThreadingHTTPServer((HERE, 0), _Site)
        cls.server.socket = server_side.wrap_socket(cls.server.socket, server_side=True)
        cls.port = cls.server.server_address[1]
        thread = threading.Thread(target=cls.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        thread.start()
        cls.addClassCleanup(thread.join, 5)
        cls.addClassCleanup(cls.server.server_close)
        cls.addClassCleanup(cls.server.shutdown)

    def setUp(self):
        _Site.requests.clear()

    def trusting_the_test_certificate(self):
        """Adds the test server's certificate to the ones the code trusts. Every other check stays as it is."""
        usual = fetch._tls

        def context() -> ssl.SSLContext:
            made = usual()
            made.load_verify_locations(cafile=self.certificate)
            return made

        return mock.patch.object(fetch, "_tls", context)

    def url(self, path: str = "/v1/forecast?latitude=-37.8&hourly=rain", site: str = SITE, port: int | None = None) -> str:
        return f"https://{site}:{port or self.port}{path}"

    def silent_server(self) -> int:
        """A server that takes the connection and then says nothing, as the weather service's did. Returns its port."""
        listener = socket.create_server((HERE, 0))
        self.addCleanup(listener.close)
        return listener.getsockname()[1]

    def test_the_server_at_the_address_is_asked_for_the_site_by_name(self):
        with self.trusting_the_test_certificate():
            text = fetch.get_at(self.url(), "ParkbotTests/1.0", HERE, timeout=5, accept="application/json")
        self.assertEqual(text, '{"rain": "likely"}')
        ((path, headers),) = _Site.requests
        self.assertEqual(path, "/v1/forecast?latitude=-37.8&hourly=rain")
        # The request is the one the usual route sends: same site, same introduction.
        self.assertEqual(headers["Host"], f"{SITE}:{self.port}")
        self.assertEqual(headers["User-Agent"], "ParkbotTests/1.0")
        self.assertEqual(headers["Accept"], "application/json")
        self.assertEqual(headers["Accept-Encoding"], "gzip")
        self.assertEqual(headers["Connection"], "close")

    def test_a_plain_page_and_its_letters(self):
        with self.trusting_the_test_certificate():
            self.assertEqual(fetch.get_at(self.url("/plain"), "x", HERE, timeout=5), "Café at 4pm")

    def test_a_server_that_is_not_the_site_is_refused(self):
        # The same server, asked for a site its certificate does not name.
        with self.trusting_the_test_certificate():
            with self.assertRaisesRegex(FetchError, "certificate was not accepted") as caught:
                fetch.get_at(self.url(site="council.example"), "x", HERE, timeout=5)
        self.assertNotIsInstance(caught.exception, NoAnswer)
        self.assertEqual(_Site.requests, [], "nothing may be sent to a server that is not the site")

    def test_a_certificate_nobody_vouches_for_is_refused(self):
        # No patch here: these are the checks a real run makes, and the test certificate is home-made.
        with self.assertRaisesRegex(FetchError, "certificate was not accepted") as caught:
            fetch.get_at(self.url(), "x", HERE, timeout=5)
        self.assertNotIsInstance(caught.exception, NoAnswer)
        self.assertEqual(_Site.requests, [])

    def test_the_checks_cannot_be_left_out(self):
        context = fetch._tls()
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        careless = ssl.create_default_context()
        careless.check_hostname = False
        careless.verify_mode = ssl.CERT_NONE
        with mock.patch.object(fetch, "_tls", return_value=careless):
            with self.assertRaisesRegex(FetchError, "would not be checked"):
                fetch.get_at(self.url(), "x", HERE, timeout=5)
        self.assertEqual(_Site.requests, [])

    def test_anything_but_the_page_is_a_failure(self):
        with self.trusting_the_test_certificate():
            for path, status in (("/busy", 503), ("/missing", 404), ("/moved", 302)):
                with self.subTest(path=path):
                    with self.assertRaisesRegex(FetchError, f"^the server answered {status}$"):
                        fetch.get_at(self.url(path), "x", HERE, timeout=5)

    def test_a_server_that_says_nothing_is_no_answer(self):
        with self.assertRaisesRegex(NoAnswer, "timed out"):
            fetch.get_at(self.url(port=self.silent_server()), "x", HERE, timeout=0.3)

    def test_nobody_at_the_address_is_no_answer(self):
        listener = socket.create_server((HERE, 0))
        port = listener.getsockname()[1]
        listener.close()
        with self.assertRaisesRegex(NoAnswer, "ConnectionRefusedError"):
            fetch.get_at(self.url(port=port), "x", HERE, timeout=5)

    def test_an_address_that_cannot_be_reached_from_here_is_no_answer(self):
        # For example an IPv6 address, asked from a machine that has no IPv6.
        for code in (errno.ENETUNREACH, errno.EHOSTUNREACH):
            with mock.patch("socket.create_connection", side_effect=OSError(code, "unreachable")):
                with self.assertRaises(NoAnswer):
                    fetch.get_at(self.url(), "x", "2607:5300:60:1234::1", timeout=5)

    def test_other_trouble_is_a_failure_with_a_reason(self):
        for trouble in (OSError("something else"), http.client.IncompleteRead(b"half"), EOFError(), ValueError("bad")):
            with self.subTest(trouble=type(trouble).__name__):
                with mock.patch("socket.create_connection", side_effect=trouble):
                    with self.assertRaisesRegex(FetchError, type(trouble).__name__) as caught:
                        fetch.get_at(self.url(), "x", HERE, timeout=5)
                self.assertNotIsInstance(caught.exception, NoAnswer)

    def test_only_an_encrypted_address(self):
        for url in (f"http://{SITE}:{self.port}/plain", "ftp://weather.example/x", "weather.example/v1/forecast", "https:///x"):
            with self.subTest(url=url):
                with self.assertRaisesRegex(FetchError, "only an https address"):
                    fetch.get_at(url, "x", HERE, timeout=5)
        self.assertEqual(_Site.requests, [])

    def test_a_stalled_usual_route_ends_with_the_forecast_from_the_other_server(self):
        # The whole of fetch.get, with only the usual route played by a stand-in.
        stalled = urllib.error.URLError(TimeoutError("_ssl.c:1011: The handshake operation timed out"))
        detours = []
        with (
            self.trusting_the_test_certificate(),
            mock.patch("urllib.request.urlopen", side_effect=stalled),
            mock.patch("time.sleep") as sleep,
            mock.patch.object(fetch, "addresses_of", return_value=["51.81.167.44"]),
            mock.patch.object(fetch, "is_public", return_value=True),  # the test server is on this machine
        ):
            text = fetch.get(
                self.url(),
                "ParkbotTests/1.0",
                timeout=5,
                tries=5,
                pause=10,
                accept="application/json",
                addresses=[HERE],
                detour=lambda address, reason: detours.append((address, reason)),
            )
        self.assertEqual(text, '{"rain": "likely"}')
        self.assertEqual(detours, [(HERE, "could not connect (_ssl.c:1011: The handshake operation timed out)")])
        sleep.assert_not_called()
        self.assertEqual(len(_Site.requests), 1)

    def test_both_servers_silent_is_an_ordinary_failed_fetch(self):
        url = self.url(port=self.silent_server())
        with (
            mock.patch("urllib.request.urlopen", side_effect=TimeoutError("The read operation timed out")),
            mock.patch("time.sleep"),
            mock.patch.object(fetch, "addresses_of", return_value=[]),
            mock.patch.object(fetch, "is_public", return_value=True),
        ):
            with self.assertRaisesRegex(FetchError, "The read operation timed out; the site's other server did not work either$"):
                fetch.get(url, "x", timeout=0.2, tries=2, pause=1, addresses=[HERE])


if __name__ == "__main__":
    unittest.main()
