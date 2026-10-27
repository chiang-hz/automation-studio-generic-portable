"""Offline tests for independent Python JSON / CSV / XLSX batch launcher."""
import csv
import importlib.util
import json
import os
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'src' / 'studio' / 'python-runtime' / 'batch_runner.py'
sys.path.insert(0, str(SOURCE.parent))
import runner
runner.BACKEND = 'selenium'
spec = importlib.util.spec_from_file_location('batch_runner', SOURCE)
batch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(batch)
PROJECT = {'allowedDomains': ['example.com'], 'browser': {'connectionMode': 'managed'},
           'parameters': [
               {'name': 'year', 'type': 'select', 'defaultValue': '114', 'required': True},
               {'name': 'stage', 'type': 'select', 'defaultValue': '審定決算', 'required': True},
               {'name': 'secret', 'type': 'secret', 'defaultValue': '', 'required': False, 'sensitive': True},
               {'name': 'flag', 'type': 'boolean', 'defaultValue': False, 'required': False},
           ], 'steps': [{'id': 'a', 'name': 'open', 'kind': 'navigate', 'enabled': True, 'url': 'https://example.com'}]}


class BatchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)

    def write(self, filename, text):
        dest = self.path / filename
        dest.write_text(text, encoding='utf-8')
        return dest

    def test_automation_studio_batch_json(self):
        file = self.write('batch.json', json.dumps({'format': 'automation-studio-batch', 'version': 1,
            'rows': [{'enabled': True, 'parameters': {'year': '113', 'stage': '自編決算'}},
                     {'enabled': False, 'parameters': {'year': '114'}}]}, ensure_ascii=False))
        rows = batch.load_rows(file, PROJECT)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['parameters']['year'], '113')
        self.assertEqual(rows[0]['parameters']['stage'], '自編決算')
        self.assertFalse(rows[1]['enabled'])

    def test_csv_bom_and_boolean(self):
        file = self.write('batch.csv', '\ufeff__studio_enabled,year,stage,flag\ntrue,113,院編決算,true\nfalse,114,自編決算,false\n')
        result = batch.load_rows(file, PROJECT)
        self.assertEqual(result[0]['parameters']['flag'], True)
        self.assertFalse(result[1]['enabled'])

    def test_unknown_key_fails(self):
        file = self.write('wrong.json', '[{"enabled":true,"parameters":{"passwordLeak":"no"}}]')
        with self.assertRaisesRegex(ValueError, 'unknown parameter'):
            batch.load_rows(file, PROJECT)

    def test_missing_required_parameter_fails(self):
        file = self.write('wrong.json', '[{"enabled":true,"parameters":{"year":""}}]')
        with self.assertRaisesRegex(ValueError, 'required parameter year'):
            batch.load_rows(file, PROJECT)

    def test_plain_json_list_supported(self):
        file = self.write('batch.json', '[{"enabled":true,"year":"112","stage":"自編決算"}]')
        self.assertEqual(batch.load_rows(file, PROJECT)[0]['parameters']['year'], '112')

    def test_xlsx_with_text_preserves_leading_zero(self):
        try:
            from openpyxl import Workbook
        except ImportError:
            self.skipTest('openpyxl optional')
        book = Workbook()
        book.active.append(['__studio_enabled', 'year', 'stage'])
        book.active.append([True, '0114', '自編決算'])
        file = self.path / 'batch.xlsx'
        book.save(file)
        self.assertEqual(batch.load_rows(file, PROJECT)[0]['parameters']['year'], '0114')

    def test_no_browser_on_check_only(self):
        self.write('workflow.json', json.dumps(PROJECT))
        self.write('batch.json', '[{"enabled":true,"parameters":{"year":"114"}}]')
        with patch.object(batch, 'ROOT', self.path), patch.object(batch, '_prepare_cdp', side_effect=AssertionError('browser opened')):
            self.assertEqual(batch.run_batch(['--input', 'batch.json', '--cdp', '--check-only']), 0)
        self.assertFalse((self.path / '.local').exists())

    def test_runs_enabled_rows_and_summary_no_parameter_values(self):
        self.write('workflow.json', json.dumps(PROJECT))
        self.write('batch.json', json.dumps({'rows': [
            {'enabled': True, 'parameters': {'year': '111-PRIVATE', 'stage': '自編決算'}},
            {'enabled': False, 'parameters': {'year': '114', 'stage': '審定決算'}},
            {'enabled': True, 'parameters': {'year': '112-PRIVATE', 'stage': '院編決算'}}]}))
        calls = []
        def fake_row(row, endpoint, folder):
            calls.append((row['row'], endpoint))
            log = folder / f"row-{row['row']:04d}.log"
            log.write_text('Fake test log')
            return (0 if row['row'] == 1 else 1), log
        with patch.object(batch, 'ROOT', self.path), patch.object(batch, 'run_row', side_effect=fake_row):
            self.assertEqual(batch.run_batch(['--input', 'batch.json', '--on-error', 'continue']), 1)
        self.assertEqual([item[0] for item in calls], [1, 3])
        directory = next((self.path / '.local/batch-runs').iterdir())
        summary = (directory / 'summary.json').read_text()
        self.assertNotIn('PRIVATE', summary)
        self.assertEqual([r['status'] for r in json.loads(summary)['rows']], ['success', 'failed'])
        with (directory / 'summary.csv').open(encoding='utf-8-sig') as file:
            self.assertEqual(len(list(csv.DictReader(file))), 2)

    def test_stop_on_error(self):
        self.write('workflow.json', json.dumps(PROJECT))
        self.write('batch.json', json.dumps([{'enabled': True, 'year': '114'}, {'enabled': True, 'year': '113'}]))
        calls = []
        def fail_first(row, endpoint, folder):
            calls.append(row['row'])
            return 1, folder / 'failure.log'
        with patch.object(batch, 'ROOT', self.path), patch.object(batch, 'run_row', side_effect=fail_first):
            self.assertEqual(batch.run_batch(['--input', 'batch.json']), 1)
        self.assertEqual(calls, [1])


if __name__ == '__main__':
    unittest.main()
