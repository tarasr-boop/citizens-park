import gzip
import http.client
import io
import json
import unittest
import urllib.error
import zlib
from unittest import mock

from parkbot import fetch, telegram
from parkbot.fetch import FetchError
from parkbot.telegram import TelegramError

TOKEN = "123456:SECRET-test-token"


class FakeReply:
    """Stands in for the object ``urlopen`` returns."""

    def __init__(self, body: bytes, headers: dict[str, str] | None = None):
        self._body = body
        self.headers = headers or {}

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def http_error(code: int, body: dict | str = "") -> urllib.error.HTTPError:
    raw = json.dumps(body).encode() if isinstance(body, dict) else body.encode()
    return urllib.error.HTTPError(f"https://api.telegram.org/bot{TOKEN}/sendMessage", code, "error", {}, io.BytesIO(raw))


def telegram_ok(message_id: int = 42) -> FakeReply:
    return FakeReply(json.dumps({"ok": True, "result": {"message_id": message_id}}).encode())


class NetworkTest(unittest.TestCase):
    """Replaces the network and the clock, so nothing here leaves the machine or waits."""

    def setUp(self):
        opener = mock.patch("urllib.request.urlopen")
        sleeper = mock.patch("time.sleep")
        self.urlopen = opener.start()
        self.sleep = sleeper.start()
        self.addCleanup(opener.stop)
        self.addCleanup(sleeper.stop)

    def request(self, call: int = 0):
        return self.urlopen.call_args_list[call].args[0]

    def waits(self) -> list[float]:
        return [call.args[0] for call in self.sleep.call_args_list]


class TelegramSendTest(NetworkTest):
    def test_sends_one_html_message_to_the_channel(self):
        self.urlopen.return_value = telegram_ok(42)
        self.assertEqual(telegram.send(TOKEN, "ExampleParkDogs", "<b>Hello</b>"), 42)
        self.assertEqual(self.urlopen.call_count, 1)
        request = self.request()
        self.assertEqual(request.full_url, f"https://api.telegram.org/bot{TOKEN}/sendMessage")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(
            json.loads(request.data),
            {
                "chat_id": "@ExampleParkDogs",
                "text": "<b>Hello</b>",
                "parse_mode": "HTML",
                "link_preview_options": {"is_disabled": True},
                "disable_notification": False,
            },
        )

    def test_a_silent_message_does_not_buzz(self):
        self.urlopen.return_value = telegram_ok()
        telegram.send(TOKEN, "ExampleParkDogs", "Week ahead", silent=True)
        self.assertTrue(json.loads(self.request().data)["disable_notification"])

    def test_refuses_to_try_without_a_token_or_a_channel(self):
        with self.assertRaisesRegex(TelegramError, "TELEGRAM_BOT_TOKEN"):
            telegram.send("", "ExampleParkDogs", "Hello")
        with self.assertRaisesRegex(TelegramError, "telegram.channel"):
            telegram.send(TOKEN, "", "Hello")
        self.urlopen.assert_not_called()

    def test_explains_what_to_fix(self):
        cases = [
            (403, "Forbidden: bot is not a member of the channel chat", "Add the bot to the channel as an administrator"),
            (400, "Bad Request: need administrator rights in the channel chat", "Add the bot to the channel as an administrator"),
            (400, "Bad Request: chat not found", "Check the channel name in config.toml"),
            (401, "Unauthorized", "update the TELEGRAM_BOT_TOKEN secret"),
        ]
        for code, description, advice in cases:
            with self.subTest(description=description):
                self.urlopen.reset_mock()
                self.urlopen.side_effect = http_error(code, {"ok": False, "error_code": code, "description": description})
                with self.assertRaises(TelegramError) as caught:
                    telegram.send(TOKEN, "ExampleParkDogs", "Hello")
                self.assertIn(description, str(caught.exception))
                self.assertIn(advice, str(caught.exception))
                # Asking again would get the same answer.
                self.assertEqual(self.urlopen.call_count, 1)

    def test_a_refusal_inside_a_normal_reply(self):
        self.urlopen.return_value = FakeReply(json.dumps({"ok": False, "description": "Bad Request: message is too long"}).encode())
        with self.assertRaisesRegex(TelegramError, "message is too long"):
            telegram.send(TOKEN, "ExampleParkDogs", "Hello")
        self.assertEqual(self.urlopen.call_count, 1)

    def test_waits_as_long_as_telegram_asks_when_told_to_slow_down(self):
        slow_down = {"ok": False, "error_code": 429, "description": "Too Many Requests: retry after 2", "parameters": {"retry_after": 2}}
        self.urlopen.side_effect = [http_error(429, slow_down), telegram_ok(7)]
        self.assertEqual(telegram.send(TOKEN, "ExampleParkDogs", "Hello"), 7)
        self.assertEqual(self.waits(), [2.0])

    def test_never_waits_longer_than_half_a_minute(self):
        slow_down = {"ok": False, "error_code": 429, "description": "Too Many Requests", "parameters": {"retry_after": 900}}
        self.urlopen.side_effect = [http_error(429, slow_down), telegram_ok()]
        telegram.send(TOKEN, "ExampleParkDogs", "Hello")
        self.assertEqual(self.waits(), [30.0])

    def test_tries_again_when_telegram_has_a_bad_moment(self):
        self.urlopen.side_effect = [http_error(502, "<html>Bad Gateway</html>"), telegram_ok(9)]
        self.assertEqual(telegram.send(TOKEN, "ExampleParkDogs", "Hello"), 9)
        self.assertEqual(self.urlopen.call_count, 2)

    def test_gives_up_after_three_tries(self):
        self.urlopen.side_effect = [http_error(502, ""), http_error(502, ""), http_error(502, "")]
        with self.assertRaisesRegex(TelegramError, "HTTP 502"):
            telegram.send(TOKEN, "ExampleParkDogs", "Hello")
        self.assertEqual(self.urlopen.call_count, 3)
        self.assertEqual(len(self.waits()), 2)

    def test_tries_again_when_telegram_cannot_be_reached(self):
        self.urlopen.side_effect = [urllib.error.URLError(ConnectionRefusedError("refused")), telegram_ok(5)]
        self.assertEqual(telegram.send(TOKEN, "ExampleParkDogs", "Hello"), 5)

    def test_does_not_send_twice_when_the_answer_is_lost(self):
        # The message may have gone out before the line went quiet, so sending
        # again could post it twice. The next scheduled run decides instead.
        self.urlopen.side_effect = TimeoutError("timed out")
        with self.assertRaisesRegex(TelegramError, "did not answer in time"):
            telegram.send(TOKEN, "ExampleParkDogs", "Hello")
        self.assertEqual(self.urlopen.call_count, 1)

    def test_a_dropped_line_is_not_sent_twice_either(self):
        for failure in (ConnectionResetError("reset by peer"), http.client.RemoteDisconnected("closed"), http.client.IncompleteRead(b"")):
            with self.subTest(failure=type(failure).__name__):
                self.urlopen.reset_mock()
                self.urlopen.side_effect = failure
                with self.assertRaisesRegex(TelegramError, "broke part-way"):
                    telegram.send(TOKEN, "ExampleParkDogs", "Hello")
                self.assertEqual(self.urlopen.call_count, 1)

    def test_a_mangled_token_is_caught_before_anything_is_sent(self):
        for bad in ("abc", "123456:SECRET with spaces", "123456:SECRET\nnewline", "bot123456:SECRET", '"123456:SECRET"'):
            with self.subTest(bad=bad):
                with self.assertRaises(TelegramError) as caught:
                    telegram.send(bad, "ExampleParkDogs", "Hello")
                self.assertIn("does not look like a bot token", str(caught.exception))
                self.assertNotIn("SECRET", str(caught.exception))
        self.urlopen.assert_not_called()

    def test_a_reply_that_makes_no_sense(self):
        for body in (b"<html>hello</html>", b'{"ok": true}', b'{"ok": true, "result": {"message_id": "many"}}', b"[]"):
            with self.subTest(body=body):
                self.urlopen.reset_mock()
                self.urlopen.return_value = FakeReply(body)
                with self.assertRaisesRegex(TelegramError, "could not be understood"):
                    telegram.send(TOKEN, "ExampleParkDogs", "Hello")
                self.assertEqual(self.urlopen.call_count, 1)

    def test_the_token_never_appears_in_an_error(self):
        failures = [
            http_error(401, {"ok": False, "description": "Unauthorized"}),
            http_error(404, "Not Found"),
            [http_error(500, "")] * 3,
            [urllib.error.URLError(OSError(f"cannot reach https://api.telegram.org/bot{TOKEN}/sendMessage"))] * 3,
            TimeoutError(f"https://api.telegram.org/bot{TOKEN}/sendMessage timed out"),
            ConnectionResetError(f"https://api.telegram.org/bot{TOKEN}/sendMessage reset"),
            http.client.InvalidURL(f"URL can't contain control characters. '/bot{TOKEN}/sendMessage'"),
        ]
        for failure in failures:
            with self.subTest(failure=repr(failure)[:40]):
                self.urlopen.reset_mock()
                self.urlopen.side_effect = failure
                with self.assertRaises(TelegramError) as caught:
                    telegram.send(TOKEN, "ExampleParkDogs", "Hello")
                self.assertNotIn(TOKEN, str(caught.exception))
                self.assertNotIn("SECRET", str(caught.exception))
                self.assertNotIn("SECRET", repr(caught.exception))
                # Nothing chained to the error may carry the address either.
                self.assertIsNone(caught.exception.__cause__)


class FetchTest(NetworkTest):
    def test_returns_the_page_and_says_who_is_asking(self):
        self.urlopen.return_value = FakeReply("<p>Citizens Park</p>".encode(), {"Content-Type": "text/html; charset=utf-8"})
        self.assertEqual(fetch.get("https://council.example/park", "ParkbotTests/1.0", accept="text/html"), "<p>Citizens Park</p>")
        request = self.request()
        self.assertEqual(request.full_url, "https://council.example/park")
        self.assertEqual(request.get_header("User-agent"), "ParkbotTests/1.0")
        self.assertEqual(request.get_header("Accept"), "text/html")

    def test_unpacks_a_compressed_page(self):
        text = "Booked 4:15pm-7:30pm " * 50
        self.urlopen.return_value = FakeReply(gzip.compress(text.encode()), {"Content-Encoding": "gzip"})
        self.assertEqual(fetch.get("https://council.example/park", "x"), text)
        self.urlopen.return_value = FakeReply(zlib.compress(text.encode()), {"Content-Encoding": "deflate"})
        self.assertEqual(fetch.get("https://council.example/park", "x"), text)

    def test_reads_the_character_set_the_server_names(self):
        self.urlopen.return_value = FakeReply("Café 4–5pm".encode("cp1252"), {"Content-Type": 'text/html; charset="windows-1252"'})
        self.assertEqual(fetch.get("https://council.example/park", "x"), "Café 4–5pm")

    def test_an_unknown_character_set_falls_back_to_utf8(self):
        self.urlopen.return_value = FakeReply("Café".encode(), {"Content-Type": "text/html; charset=klingon"})
        self.assertEqual(fetch.get("https://council.example/park", "x"), "Café")

    def test_bad_bytes_do_not_stop_the_read(self):
        self.urlopen.return_value = FakeReply(b"Booked \xff 4pm", {"Content-Type": "text/html"})
        self.assertIn("Booked", fetch.get("https://council.example/park", "x"))

    def test_a_refusal_is_not_asked_again(self):
        for code in (403, 404, 410):
            with self.subTest(code=code):
                self.urlopen.reset_mock()
                self.urlopen.side_effect = http_error(code)
                with self.assertRaisesRegex(FetchError, f"the server answered {code}"):
                    fetch.get("https://council.example/park", "x")
                self.assertEqual(self.urlopen.call_count, 1)
        self.sleep.assert_not_called()

    def test_a_server_having_a_bad_moment_is_asked_again(self):
        self.urlopen.side_effect = [http_error(503), FakeReply(b"fine")]
        self.assertEqual(fetch.get("https://council.example/park", "x"), "fine")
        self.assertEqual(self.waits(), [4])

    def test_gives_up_after_three_tries_and_waits_longer_each_time(self):
        self.urlopen.side_effect = [http_error(503), http_error(503), http_error(503)]
        with self.assertRaisesRegex(FetchError, "the server answered 503"):
            fetch.get("https://council.example/park", "x")
        self.assertEqual(self.urlopen.call_count, 3)
        self.assertEqual(self.waits(), [4, 8])

    def test_no_connection(self):
        self.urlopen.side_effect = urllib.error.URLError("Name or service not known")
        with self.assertRaisesRegex(FetchError, r"could not connect \(Name or service not known\)"):
            fetch.get("https://council.example/park", "x", tries=2)
        self.assertEqual(self.urlopen.call_count, 2)

    def test_a_slow_server(self):
        self.urlopen.side_effect = TimeoutError("The read operation timed out")
        with self.assertRaisesRegex(FetchError, "TimeoutError: The read operation timed out"):
            fetch.get("https://council.example/park", "x", tries=1)

    def test_a_broken_compressed_page(self):
        self.urlopen.return_value = FakeReply(b"this is not gzip", {"Content-Encoding": "gzip"})
        with self.assertRaises(FetchError):
            fetch.get("https://council.example/park", "x", tries=1)


if __name__ == "__main__":
    unittest.main()
