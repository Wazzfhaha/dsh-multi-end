import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch, MagicMock
import tempfile
import io
import json

spec = importlib.util.spec_from_file_location('probe', Path(__file__).parents[1] / 'src/remote_probe.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)

class ProbeTests(unittest.TestCase):
    def test_only_current_loopback_port_is_a_candidate(self):
        data = b'http://evil.test:3080/?token=bad http://127.0.0.1:9999/?token=bad http://127.0.0.1:3080/?token=good'
        self.assertEqual(probe.candidates(data, 3080), ['http://127.0.0.1:3080/?token=good'])

    def test_latest_candidate_first_and_deduplicated(self):
        data = b'http://127.0.0.1:3080/?token=old http://127.0.0.1:3080/?token=new http://127.0.0.1:3080/?token=new'
        self.assertEqual(probe.candidates(data, 3080)[0], 'http://127.0.0.1:3080/?token=new')

    def test_session_projection_does_not_copy_context_or_credentials(self):
        item = {'sessionId': 's', 'cwd': '/project', 'running': True, 'context': 'private', 'apiKey': 'secret'}
        self.assertEqual(probe.project_session(item), {'sessionId': 's', 'cwd': '/project', 'running': True})

    def test_login_handoff_is_only_in_the_explicit_private_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            process = Path(directory)
            (process / 'fd').mkdir()
            url = 'http://127.0.0.1:42123/?token=fake-test-only'
            (process / 'fd/1').write_text(url)
            for handoff in [False, True]:
                opener = MagicMock()
                opener.open.side_effect = [io.BytesIO(b'__DSH_BOOT__ DeepSeek Harness'), io.BytesIO(json.dumps({'result': {'ok': True, 'value': {'items': [{'sessionId': 's', 'apiKey': 'do-not-copy'}]}}}).encode())]
                with patch.object(probe, 'owner', return_value=process), patch.object(probe.urllib.request, 'build_opener', return_value=opener):
                    result = probe.probe(42123, handoff)
                self.assertEqual(result['sessions'], [{'sessionId': 's'}])
                self.assertEqual(result.get('loginUrl'), url if handoff else None)

if __name__ == '__main__':
    unittest.main()
