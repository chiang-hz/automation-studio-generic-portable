"""Regression for the v2.3.2 Python selector-uniqueness mismatch.
Run: python -m unittest discover -s tests -p 'test_python_selector_parity.py'
"""
import contextlib
import sys
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src' / 'studio' / 'python-runtime'))
from engine import BrowserEngine


class LocatorParityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.engine = BrowserEngine({'id': 'parity', 'browser': {}}, self.tmp.name, 'playwright')
        from playwright.sync_api import sync_playwright
        self.p = sync_playwright().start()
        try:
            self.browser = self.p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        except Exception as exc:
            self.p.stop()
            self.tmp.cleanup()
            self.skipTest('Chromium unavailable: ' + str(exc)[:150])
        self.engine.page = self.browser.new_page()
        self.engine.page.set_content('''
            <button class="submit" id="hidden" style="display:none">Hidden submit</button>
            <div class="mobile"><button class="submit" id="mobile">Mobile submit</button></div>
            <button class="submit" id="desktop">Desktop submit</button>
            <button class="two" id="first">First</button>
            <button class="two" id="second">Second</button>
        ''')

    def tearDown(self):
        if hasattr(self, 'browser'): self.browser.close()
        if hasattr(self, 'p'): self.p.stop()
        if hasattr(self, 'tmp'): self.tmp.cleanup()

    def test_unique_excludes_hidden_and_mobile(self):
        el = self.engine.locate([{'strategy': 'css', 'value': 'button.submit'}], 'unique')
        self.assertEqual(el.get_attribute('id'), 'desktop')

    def test_unique_stops_on_two_real_visible_candidates(self):
        with self.assertRaisesRegex(RuntimeError, '2 visible desktop elements'):
            self.engine.locate([{'strategy': 'css', 'value': 'button.two'}], 'unique')

    def test_later_fallback_selector_is_tried(self):
        el = self.engine.locate([
            {'strategy': 'css', 'value': 'button.two'},
            {'strategy': 'css', 'value': '#desktop'}
        ], 'unique')
        self.assertEqual(el.get_attribute('id'), 'desktop')

    def test_position_counts_only_visible_desktop(self):
        el = self.engine.locate([{'strategy': 'css', 'value': 'button.submit'}], 'nth', 1)
        self.assertEqual(el.get_attribute('id'), 'desktop')
        last = self.engine.locate([{'strategy': 'css', 'value': 'button.two'}], 'last')
        self.assertEqual(last.get_attribute('id'), 'second')


class FakeElement:
    def __init__(self, name, visible=True, mobile=False):
        self.name = name
        self._visible = visible
        self.mobile = mobile
    def is_displayed(self): return self._visible


class FakeBrowser:
    def execute_script(self, script, element):
        return element.mobile


@contextlib.contextmanager
def fake_selenium():
    from unittest.mock import patch
    names = [
        'selenium', 'selenium.webdriver', 'selenium.webdriver.common',
        'selenium.webdriver.common.by', 'selenium.webdriver.support',
        'selenium.webdriver.support.ui', 'selenium.common',
        'selenium.common.exceptions'
    ]
    modules = {name: types.ModuleType(name) for name in names}
    modules['selenium.webdriver.common.by'].By = types.SimpleNamespace(
        CSS_SELECTOR='css', XPATH='xpath', NAME='name')
    class Wait:
        def __init__(self, browser, timeout): self.browser = browser
        def until(self, fn):
            result = fn(self.browser)
            if result: return result
            raise TimeoutError('not visible')
    modules['selenium.webdriver.support.ui'].WebDriverWait = Wait
    modules['selenium.common.exceptions'].InvalidSelectorException = ValueError
    with patch.dict(sys.modules, modules):
        yield


class SeleniumSelectorParityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.engine = BrowserEngine({'id':'parity','browser':{}}, self.tmp.name,'selenium')
        self.engine.browser = FakeBrowser()
        self.hidden = FakeElement('hidden', visible=False)
        self.mobile = FakeElement('mobile', mobile=True)
        self.desktop = FakeElement('desktop')
        self.engine._selenium_find = lambda *args: [self.hidden, self.mobile, self.desktop]

    def tearDown(self):
        self.tmp.cleanup()

    def test_unique_excludes_hidden_and_mobile(self):
        with fake_selenium():
            self.assertIs(self.engine._find({'strategy':'css','value':'button.submit'},'unique',1,1000),self.desktop)

    def test_multiple_visible_still_rejected(self):
        self.engine._selenium_find = lambda *args: [FakeElement('one'),FakeElement('two')]
        with fake_selenium():
            with self.assertRaisesRegex(RuntimeError,'2 visible desktop elements'):
                self.engine._find({'strategy':'css','value':'button.submit'},'unique',1,1000)


class WorkflowMatchDefaultTests(unittest.TestCase):
    def test_unspecified_match_mode_is_unique_like_typescript(self):
        from unittest.mock import Mock
        import runner
        with tempfile.TemporaryDirectory() as temp:
            previous = runner.ROOT
            runner.ROOT = Path(temp)
            try:
                engine = Mock()
                flow = runner.Runner({'browser': {}}, engine, {})
                flow.locate({'kind':'click','selectors':[{'strategy':'css','value':'button'}]})
                self.assertEqual(engine.locate.call_args.args[1], 'unique')
            finally:
                runner.ROOT = previous

if __name__ == '__main__':
    unittest.main()
