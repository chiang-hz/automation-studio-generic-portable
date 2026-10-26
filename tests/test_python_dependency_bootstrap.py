"""Offline-only regression tests for generated Python dependency bootstrap."""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

MODULE = Path(__file__).resolve().parents[1] / 'src/studio/python-runtime/dependency_bootstrap.py'
spec = importlib.util.spec_from_file_location('dependency_bootstrap', MODULE)
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


class DependencyBootstrapTests(unittest.TestCase):
    def test_dependency_probe_detects_missing_version_without_network(self):
        with tempfile.TemporaryDirectory() as folder:
            reqs = Path(folder) / 'requirements.txt'
            reqs.write_text('pip>=0,<999\n', encoding='utf-8')
            with mock.patch.object(bootstrap, 'REQUIREMENTS', reqs):
                self.assertEqual(bootstrap.missing_dependencies(sys.executable), '')
                reqs.write_text('not-a-real-dist-for-automation-studio>=1\n', encoding='utf-8')
                self.assertIn('not-a-real-dist-for-automation-studio',
                              bootstrap.missing_dependencies(sys.executable))

    def test_check_only_does_not_touch_installer(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'runner.py').write_text('import sys\nsys.exit(0 if "--check-only" in sys.argv else 55)\n')
            with mock.patch.object(bootstrap, 'ROOT', root), \
                 mock.patch.object(bootstrap, 'prepare_python', side_effect=AssertionError('must not install')):
                self.assertEqual(bootstrap.main(['runner.py', '--check-only']), 0)

    def test_installer_respects_offline_only_when_no_wheelhouse(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            reqs = root / 'requirements.txt'
            reqs.write_text('selenium>=4.30,<5\n')
            with mock.patch.object(bootstrap, 'ROOT', root), \
                 mock.patch.object(bootstrap, 'REQUIREMENTS', reqs), \
                 mock.patch.dict(os.environ, {'AUTOMATION_STUDIO_OFFLINE_ONLY': '1'}, clear=False):
                with self.assertRaisesRegex(RuntimeError, 'wheelhouse is missing'):
                    bootstrap.install(Path(sys.executable))

    def test_installer_tries_wheelhouse_without_network(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            reqs = root / 'requirements.txt'
            reqs.write_text('selenium>=4.30,<5\n')
            (root / 'wheelhouse').mkdir()
            with mock.patch.object(bootstrap, 'ROOT', root), \
                 mock.patch.object(bootstrap, 'REQUIREMENTS', reqs), \
                 mock.patch('subprocess.run', return_value=mock.Mock(returncode=0)) as subprocess_run:
                bootstrap.install(Path(sys.executable))
                self.assertIn('--no-index', subprocess_run.call_args.args[0])
                subprocess_run.assert_called_once()

    def test_auto_install_can_be_disabled(self):
        with mock.patch.dict(os.environ, {'AUTOMATION_STUDIO_AUTO_INSTALL': '0'}, clear=False):
            with self.assertRaisesRegex(RuntimeError, 'disabled'):
                bootstrap.install(Path(sys.executable))

    def test_rejects_unexpected_entrypoint(self):
        with self.assertRaisesRegex(RuntimeError, 'Specify runner.py'):
            bootstrap.main(['../../unexpected.py'])


if __name__ == '__main__':
    unittest.main()
