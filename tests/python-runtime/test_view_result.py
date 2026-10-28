"""Deterministic tests for Selenium's post-view result routing (no network)."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'src/studio/python-runtime'))
from runner import Runner

TARGET = 'https://cms.data.gov.tw/dataset/provider/quality-check-list?id=10801'
REPORT = 'https://cms.data.gov.tw/dataset/provider/quality-check-result?nid=10801'
SELECTOR = 'table:has-text("資料集編號"):has-text("10801")'

class FakeBrowser:
    def __init__(self, engine):
        self.engine = engine
    @property
    def window_handles(self):
        return list(self.engine.tabs)

class FakeEngine:
    backend = 'selenium'
    def __init__(self, valid=None):
        self.tabs = {'list': TARGET}
        self.active = 'list'
        self.valid = set(valid or [])
        self.browser = FakeBrowser(self)
        self.select_calls = []
    def url(self): return self.tabs[self.active]
    def _tab_id(self): return self.active
    def auth_tab_urls(self): return dict(self.tabs)
    def select_auth_tab(self, handle):
        assert handle in self.tabs
        self.active = handle
        self.select_calls.append(handle)
    def selector_state(self, selectors, auto_frame=False):
        assert selectors == [{'strategy':'css','value':SELECTOR}]
        is_visible = self.active in self.valid
        return is_visible,is_visible

class ViewTests(unittest.TestCase):
    def runner(self, engine):
        r = Runner({'allowedDomains':['cms.data.gov.tw'], 'browser':{'authStateEnabled':True}}, engine, {})
        r._pending_result_click = {'origin':'list','tabs': {'list': TARGET}, 'step':'9. 檢視'}
        return r
    def step(self, timeout=100):
        return {'kind':'extractWebData','waitBefore':{'kind':'visible','value':SELECTOR,'timeoutMs':timeout},
                'timeoutMs':timeout}

    def test_same_tab_report_is_used_without_opening_tabs(self):
        e = FakeEngine({'list'})
        r = self.runner(e)
        r._await_report_after_view_click(self.step())
        self.assertEqual(e.active, 'list')
        self.assertIsNone(r._pending_result_click)

    def test_new_report_tab_is_adopted(self):
        e = FakeEngine({'detail'})
        r = self.runner(e)
        e.tabs['detail'] = REPORT
        r._await_report_after_view_click(self.step())
        self.assertEqual(e.active,'detail')
        self.assertIsNone(r._pending_result_click)

    def test_login_tab_is_not_report(self):
        e = FakeEngine({'login'})
        r = self.runner(e)
        e.tabs['login'] = 'https://cms.data.gov.tw/login'
        with self.assertRaisesRegex(TimeoutError,'TAB_RESULT_TIMEOUT'):
            r._await_report_after_view_click(self.step(timeout=10))

    def test_unrelated_host_is_not_adopted(self):
        e = FakeEngine({'stranger'})
        r = self.runner(e)
        e.tabs['stranger'] = 'https://example.com/dataset/provider/quality-check-result'
        with self.assertRaisesRegex(TimeoutError,'TAB_RESULT_TIMEOUT'):
            r._await_report_after_view_click(self.step(timeout=10))
        self.assertEqual(e.active,'list')

    def test_stale_previous_tab_is_ignored(self):
        e = FakeEngine({'stale'})
        e.tabs['stale'] = REPORT
        r = self.runner(e)
        r._pending_result_click['tabs']['stale'] = REPORT
        with self.assertRaisesRegex(TimeoutError,'TAB_RESULT_TIMEOUT'):
            r._await_report_after_view_click(self.step(timeout=10))

    def test_ambiguous_matching_tabs_fail_closed(self):
        e = FakeEngine({'detail1','detail2'})
        r = self.runner(e)
        e.tabs['detail1'] = REPORT
        e.tabs['detail2'] = REPORT
        with self.assertRaisesRegex(RuntimeError,'TAB_AMBIGUOUS'):
            r._await_report_after_view_click(self.step(timeout=20))

    def test_click_then_extract_adopts_popup_without_reclick(self):
        e = FakeEngine({'detail'})
        r = self.runner(e)
        r._pending_result_click = None  # begin before first click
        class Link:
            def get_attribute(self, name):
                return {'target':'_blank','href':REPORT}.get(name)
        click_calls = []
        def click(action, item, value):
            click_calls.append(action)
            e.tabs['detail'] = REPORT
        e.locate = lambda *args, **kwargs: Link()
        e.act = click
        r.extract_data = lambda step: click_calls.append('extracted')
        click_step = {'kind':'click', 'name':'9. 檢視指定品質資料集結果',
                      'selectors':[{'strategy':'xpath','value':'//a[normalize-space(.)="檢視"]'}],
                      'waitAfter':None, 'retryCount':0}
        extract_step = {**self.step(), 'name':'10. 擷取指定品質資料集檢測結果',
                        'dataRowSelector':SELECTOR, 'dataMode':'list', 'dataFields':[{'name':'檢測面向'}]}
        r.execute(click_step)
        r.execute(extract_step)
        self.assertEqual(click_calls,['click','extracted'])
        self.assertEqual(e.active,'detail')

    def test_tab_can_appear_after_delay(self):
        e = FakeEngine({'detail'})
        r = self.runner(e)
        def create_tab(_seconds):
            e.tabs['detail'] = REPORT
        with patch('runner.time.sleep',side_effect=create_tab):
            r._await_report_after_view_click(self.step(timeout=2000))
        self.assertEqual(e.active,'detail')

if __name__=='__main__':unittest.main()
