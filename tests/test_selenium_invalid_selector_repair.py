"""Regression tests: Playwright locator shorthand exported to Selenium.
Run with: python -m unittest discover -s tests -p 'test_selenium_invalid_selector_repair.py'
"""
import contextlib
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src' / 'studio' / 'python-runtime'))
from engine import BrowserEngine


class Element:
    def __init__(self, visible=True):
        self.visible = visible
    def is_displayed(self):
        return self.visible


class FakeDriver:
    def __init__(self):
        self.queries = []
        self.element = Element()
    def switch_to(self):
        raise AssertionError('unreachable')
    def find_elements(self, by, value):
        self.queries.append((by, value))
        if by == 'css selector' and (value.startswith(('//', 'xpath=', 'css=')) or value.startswith('text=')):
            raise ValueError('invalid selector: An invalid or illegal selector was specified')
        return [self.element]
    def execute_script(self, code, argument):
        if code.lstrip().startswith('return Boolean(arguments[0].closest('):
            return False
        if 'selector' in code.lower() or 'locator' in code.lower():
            return [self.element]
        return False


@contextlib.contextmanager
def selenium_stubs():
    modules = {name: types.ModuleType(name) for name in [
        'selenium', 'selenium.webdriver', 'selenium.webdriver.common',
        'selenium.webdriver.common.by', 'selenium.webdriver.support',
        'selenium.webdriver.support.ui', 'selenium.common', 'selenium.common.exceptions'
    ]}
    modules['selenium.webdriver.common.by'].By = types.SimpleNamespace(CSS_SELECTOR='css selector', XPATH='xpath')
    class Wait:
        def __init__(self, browser, timeout): self.browser = browser
        def until(self, callback): return callback(self.browser) or (_ for _ in ()).throw(TimeoutError('missing'))
    modules['selenium.webdriver.support.ui'].WebDriverWait = Wait
    modules['selenium.common.exceptions'].InvalidSelectorException = ValueError
    with patch.dict(sys.modules, modules):
        yield


class SeleniumInvalidSelectorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.engine = BrowserEngine({'browser': {}, 'id': 'test'}, self.tmp.name, 'selenium')
        self.driver = FakeDriver()
        self.engine.browser = self.driver
        # The real _selenium_find changes only frame context before invoking the same query.
        self.engine._selenium_find = lambda by, val, *args: self.engine._selenium_query(by, val)
    def tearDown(self):
        self.tmp.cleanup()

    def test_css_labeled_xpath_is_sent_to_xpath_driver(self):
        for selector in ['//input[@name="nid"]', 'xpath=//input[@name="nid"]']:
            with self.subTest(selector=selector), selenium_stubs():
                self.assertIs(self.engine.locate([{'strategy':'css','value':selector}], 'unique'), self.driver.element)
                self.assertEqual(self.driver.queries[-1][0], 'xpath')

    def test_css_prefix_is_removed_before_webdriver(self):
        with selenium_stubs():
            self.engine.locate([{'strategy':'css','value':'css=input[name="nid"]'}], 'unique')
        self.assertEqual(self.driver.queries[-1], ('css selector','input[name="nid"]'))

    def test_xpath_strategy_prefix_is_removed(self):
        with selenium_stubs():
            self.engine.locate([{'strategy':'xpath','value':'xpath=//div[@id="list"]'}])
        self.assertEqual(self.driver.queries[-1], ('xpath','//div[@id="list"]'))

    def test_playwright_text_shorthand_uses_text_resolver(self):
        with selenium_stubs():
            self.engine.locate([{'strategy':'css','value':'text="資料標準檢測"'}])
        self.assertFalse(self.driver.queries)

    def test_selector_state_uses_same_xpath_detection(self):
        with selenium_stubs():
            attached, visible = self.engine.selector_state([{'strategy':'css','value':'//input[@id="nid"]'}])
        self.assertTrue(attached)
        self.assertTrue(visible)
        self.assertEqual(self.driver.queries[-1][0], 'xpath')

    def test_untranslatable_invalid_css_fails_with_actual_selector(self):
        self.driver.find_elements = lambda by, value: (_ for _ in ()).throw(ValueError('invalid selector: An invalid or illegal selector was specified'))
        with selenium_stubs():
            with self.assertRaisesRegex(RuntimeError, r'Invalid css selector .*broken'):
                self.engine.locate([{'strategy':'css','value':'broken:unknown-pseudo'}], 'unique')

    def test_multiple_visible_matches_still_fail_unique(self):
        self.driver.find_elements = lambda by, value: [Element(), Element()]
        with selenium_stubs():
            with self.assertRaisesRegex(RuntimeError, 'Selector is not unique'):
                self.engine.locate([{'strategy':'css','value':'input'}], 'unique')


if __name__ == '__main__': unittest.main()
