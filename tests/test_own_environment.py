"""The tests keep to themselves, wherever they are started: see ``tests/__init__.py``."""

import os
import unittest

import tests


class OwnEnvironmentTest(unittest.TestCase):
    def test_what_makes_a_job_on_github_is_taken_out_and_the_rest_stays(self):
        environ = {
            "GITHUB_ACTIONS": "true",
            "GITHUB_STEP_SUMMARY": "/somewhere/summary.md",
            "GITHUB_OUTPUT": "/somewhere/output.txt",
            "GITHUB_REPOSITORY": "someone/a-park",
            "GH_TOKEN": "a-token",
            "TELEGRAM_BOT_TOKEN": "123:a-token",
            "PATH": "/usr/bin",
            "HOME": "/home/someone",
        }
        tests.forget_the_job(environ)
        self.assertEqual(environ, {"PATH": "/usr/bin", "HOME": "/home/someone"})

    def test_no_test_runs_as_the_job(self):
        # On GitHub the runner sets the first three for every step, so this
        # fails there as soon as the tests stop clearing their environment.
        for name in ("GITHUB_ACTIONS", "GITHUB_STEP_SUMMARY", "GITHUB_OUTPUT", "GH_TOKEN", "TELEGRAM_BOT_TOKEN"):
            self.assertNotIn(name, os.environ)


if __name__ == "__main__":
    unittest.main()
