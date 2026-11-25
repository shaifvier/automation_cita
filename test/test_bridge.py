import importlib.util
import pathlib
import subprocess
import unittest
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('bridge', pathlib.Path(__file__).parents[1] / 'scripts' / 'seleniumbase_bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class ChallengeWorkerTests(unittest.TestCase):
    def test_worker_is_bounded_and_receives_only_endpoint_and_target(self):
        with patch.object(bridge.subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as run:
            self.assertTrue(bridge.run_challenge('http://127.0.0.1:12345', 'synthetic-target'))
            args, kwargs = run.call_args
            self.assertEqual(args[0][-3:], ['--worker', 'http://127.0.0.1:12345', 'synthetic-target'])
            self.assertEqual(kwargs['timeout'], 55)
            self.assertEqual(kwargs['stdout'], subprocess.DEVNULL)
            self.assertEqual(kwargs['stderr'], subprocess.DEVNULL)

    def test_timeout_or_failure_requires_human_review(self):
        with patch.object(bridge.subprocess, 'run', side_effect=subprocess.TimeoutExpired('synthetic', 55)):
            self.assertFalse(bridge.run_challenge('http://127.0.0.1:12345', 'synthetic-target'))
        with patch.object(bridge.subprocess, 'run', return_value=SimpleNamespace(returncode=1)):
            self.assertFalse(bridge.run_challenge('http://127.0.0.1:12345', 'synthetic-target'))


if __name__ == '__main__':
    unittest.main()
