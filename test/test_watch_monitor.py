import asyncio
import base64
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('watch_monitor', Path(__file__).parents[1] / 'scripts' / 'watch_monitor.py')
watch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watch)


class FakeSocket:
    def __init__(self, capture_fails=False):
        self.calls = []
        self.reply = None
        self.capture_fails = capture_fails
        self.closed = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        self.closed = True

    async def send(self, raw):
        message = json.loads(raw)
        method = message['method']
        self.calls.append(method)
        values = {
            'Target.getTargets': {'targetInfos': [{'type': 'page', 'targetId': 'synthetic', 'url': 'https://icp.administracionelectronica.gob.es/icpplustieb/acCitar?session=PRIVATE'}]},
            'Target.attachToTarget': {'sessionId': 'synthetic-session'},
            'Runtime.evaluate': {'result': {'value': {'candidate': True, 'code': None}}},
            'Page.captureScreenshot': {'data': base64.b64encode(b'synthetic-png-data').decode()},
            'Target.detachFromTarget': {},
        }
        self.reply = {'id': message['id'], 'result': values[method]}
        if method == 'Page.captureScreenshot' and self.capture_fails:
            self.reply = {'id': message['id'], 'error': {'message': 'synthetic failure'}}

    async def recv(self):
        return json.dumps(self.reply)


class ObserverTests(unittest.TestCase):
    def test_target_hosts_are_restricted(self):
        self.assertTrue(watch.allowed_host('icp.administracionelectronica.gob.es'))
        self.assertTrue(watch.allowed_host('pasarela.clave.gob.es'))
        self.assertFalse(watch.allowed_host('evilclave.gob.es'))
        self.assertFalse(watch.allowed_host('example.com'))

    def test_expiry_or_entry_is_not_availability(self):
        host = 'icp.administracionelectronica.gob.es'
        self.assertEqual(watch.category({'candidate': True}, host), 'potential_availability')
        self.assertEqual(watch.category({'candidate': True, 'expired': True}, host), 'session_expired')
        self.assertEqual(watch.category({'candidate': True, 'entry': True}, host), 'checking')
        self.assertEqual(watch.category({'candidate': True, 'applicantForm': True}, host), 'checking')
        self.assertEqual(watch.category({'unavailable': True}, host), 'no_appointments')

    def test_report_uses_madrid_time_and_restores_history(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = watch.Journal(directory, 123)
            journal.record('no_appointments', code='0501')
            journal.record('potential_availability')
            journal.record('potential_availability', evidence='synthetic.png')
            restored = watch.Journal(directory, 123)
            self.assertEqual(restored.counts['potential_availability'], 2)
            self.assertEqual(len(restored.candidates), 1)
            self.assertEqual(restored.candidates[0]['evidence'], 'synthetic.png')
            self.assertEqual(restored.started, journal.started)
            report = (Path(directory) / 'report.md').read_text(encoding='utf-8')
            self.assertIn('Europe/Madrid', report)
            self.assertIn('synthetic.png', report)
            self.assertNotIn('session=PRIVATE', report)

    def test_locked_derived_report_does_not_lose_the_journal(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = watch.Journal(directory, 123)
            with patch.object(watch, 'atomic_json', side_effect=PermissionError), patch.object(journal, 'write_report', side_effect=PermissionError):
                journal.record('no_appointments')
            self.assertEqual(len((Path(directory) / 'observations.jsonl').read_text().splitlines()), 1)

    def run_probe(self, directory, capture_fails=False):
        socket = FakeSocket(capture_fails)
        endpoint = json.dumps({'webSocketDebuggerUrl': 'ws://127.0.0.1:12345/devtools/browser/synthetic'}).encode()
        with patch.object(watch.urllib.request, 'urlopen', return_value=io.BytesIO(endpoint)), patch.object(watch.websockets, 'connect', return_value=socket):
            result = asyncio.run(watch.observe(12345, capture=True, screenshot_path=Path(directory) / 'evidence.png'))
        self.assertTrue(socket.closed)
        self.assertEqual(set(socket.calls), {'Target.getTargets', 'Target.attachToTarget', 'Runtime.evaluate', 'Page.captureScreenshot', 'Target.detachFromTarget'})
        return result

    def test_candidate_evidence_uses_read_only_protocol_methods(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(self.run_probe(directory), ('potential_availability', None, 'evidence.png'))
            self.assertTrue((Path(directory) / 'evidence.png').exists())

    def test_failed_screenshot_still_records_candidate(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(self.run_probe(directory, capture_fails=True), ('potential_availability', None, None))


if __name__ == '__main__':
    unittest.main()
