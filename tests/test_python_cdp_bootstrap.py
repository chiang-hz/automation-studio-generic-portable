"""Standard-library regression tests for Windows exported run-cdp bootstrap."""
import contextlib
import importlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src' / 'studio' / 'python-runtime'))
import runner
import cdp_bootstrap as boot


def demo(auth=False):
    return {'id': 'demo', 'name': 'Demo', 'targetUrl': 'https://example.com/login',
            'allowedDomains': ['example.com'], 'browser': {
                'connectionMode': 'managed', 'cdpEndpoint': 'http://127.0.0.1:9222',
                'authStateEnabled': auth,
                'authVerifyUrl': 'https://example.com/account' if auth else '',
                'authSuccessSelector': '#user' if auth else ''},
            'steps': [{'id':'1','name':'Open','kind':'navigate','enabled':True,'url':'https://example.com/login'}]}


class CdpBootstrapTests(unittest.TestCase):
    def test_default_and_explicit_ports_are_local(self):
        self.assertEqual(boot.endpoint_for(demo()), 'http://127.0.0.1:9222')
        self.assertEqual(boot.endpoint_for(demo(), '9333'), 'http://127.0.0.1:9333')
        for candidate in ('0', '70000', 'notaport'):
            with self.assertRaises(boot.CdpStartupError):
                boot.endpoint_for(demo(), candidate)
        altered=demo()
        altered['browser']['cdpEndpoint']='http://192.168.1.3:9222'
        with self.assertRaises(boot.CdpStartupError): boot.endpoint_for(altered)

    def test_open_only_allowed_target(self):
        self.assertEqual(boot.login_start_url(demo()), 'https://example.com/login')
        altered=demo()
        altered['targetUrl']='https://not-allowed.example/login'
        self.assertEqual(boot.login_start_url(altered), 'about:blank')

    def test_check_only_never_launches_chrome(self):
        with tempfile.TemporaryDirectory() as td, patch.object(boot, 'ROOT', Path(td)), patch.object(runner, 'ROOT', Path(td)):
            (Path(td)/'workflow.json').write_text(json.dumps(demo()), encoding='utf-8')
            with patch.object(runner, 'BACKEND', 'selenium'), patch.object(boot, 'probe', side_effect=AssertionError('CDP should not be contacted')):
                self.assertEqual(boot.main(['--check-only']),0)

    def test_existing_cdp_uses_runner_override_without_mutating_json(self):
        with tempfile.TemporaryDirectory() as td, patch.object(boot, 'ROOT', Path(td)), patch.object(runner, 'ROOT', Path(td)):
            workflow=Path(td)/'workflow.json'
            workflow.write_text(json.dumps(demo(auth=True)), encoding='utf-8')
            calls=[]
            def fake_runner(args):
                calls.append(args)
                return 0
            with patch.object(boot, 'run_workflow', side_effect=fake_runner), \
                 patch.object(boot.sys, 'platform', 'win32'), \
                 patch.object(boot, 'check_dependencies'), \
                 patch.object(boot, 'probe', return_value=True), \
                 patch.object(boot, 'start_chrome', side_effect=AssertionError('should reuse existing CDP')):
                self.assertEqual(boot.main([]),0)
            self.assertEqual(calls[0], ['--check-only'])
            self.assertEqual(calls[1], ['--cdp-endpoint','http://127.0.0.1:9222'])
            self.assertEqual(json.loads(workflow.read_text())['browser']['connectionMode'], 'managed')

    def test_new_chrome_wait_and_manual_auth_gate(self):
        with tempfile.TemporaryDirectory() as td, patch.object(boot, 'ROOT', Path(td)), patch.object(runner, 'ROOT', Path(td)):
            (Path(td)/'workflow.json').write_text(json.dumps(demo()), encoding='utf-8')
            calls=[]
            with patch.object(boot, 'run_workflow', side_effect=lambda args:calls.append(args) or 0), \
                 patch.object(boot.sys, 'platform', 'win32'), \
                 patch.object(boot, 'check_dependencies'), \
                 patch.object(boot, 'probe', return_value=False), \
                 patch.object(boot, 'tcp_port_open', return_value=False), \
                 patch.object(boot, 'chrome_binary', return_value='C:/Chrome/chrome.exe'), \
                 patch.object(boot, 'start_chrome', return_value=object()), \
                 patch.object(boot, 'wait_for_cdp') as wait, patch('builtins.input', return_value='') as prompt:
                self.assertEqual(boot.main([]),0)
            wait.assert_called_once()
            prompt.assert_called_once()
            self.assertEqual(calls[1], ['--cdp-endpoint','http://127.0.0.1:9222'])

    def test_runner_cli_override_validates_without_chrome(self):
        with tempfile.TemporaryDirectory() as td, patch.object(runner, 'ROOT', Path(td)):
            (Path(td)/'workflow.json').write_text(json.dumps(demo()), encoding='utf-8')
            with patch.object(runner, 'BACKEND', 'selenium'):
                self.assertEqual(runner.main(['--check-only','--cdp-endpoint','http://127.0.0.1:9222']),0)
            self.assertEqual(json.loads((Path(td)/'workflow.json').read_text())['browser']['connectionMode'], 'managed')


if __name__ == '__main__':
    unittest.main()
