"""Headless Chromium acceptance tests for Selenium's bundled browser-side helpers.
The JS is evaluated in a real DOM, independently of a ChromeDriver installation.
"""
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JS_DIR = ROOT / 'src/studio/python-runtime'
sys.path.insert(0, str(JS_DIR))
import runner as py_runner
from engine import BrowserEngine


class BrowserCompatTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from playwright.sync_api import sync_playwright
        cls.pw = sync_playwright().start()
        try:
            cls.browser = cls.pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        except Exception as error:
            cls.pw.stop()
            raise unittest.SkipTest('Browser unavailable: ' + str(error))
        cls.css_source = (JS_DIR / 'selector_compat.js').read_text()
        cls.locator_source = (JS_DIR / 'locator_compat.js').read_text()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.page = self.browser.new_page()
        self.page.set_content('''
          <section class="panel">
            <label for="account">登入帳號</label><input id="account" placeholder="Email address" />
            <button id="a" aria-label="送出品質檢測">送出</button>
            <button id="b" class="mobile" style="display:none">送出</button>
            <table id="scores"><tr><th>項目</th><th>結果</th></tr>
              <tr class="result"><td class="name">品質檢測</td><td class="status">完檢</td></tr>
              <tr class="result"><td class="name">標準檢測</td><td class="status">等待</td></tr></table>
          </section>
        ''')

    def tearDown(self):
        self.page.close()

    def locate(self, rule):
        return self.page.evaluate('''([rule, cssText, locatorText]) => {
          const css = (0,eval)(cssText), find = (0,eval)(locatorText);
          return find(document, rule, css).map(el => el.id || el.className || el.tagName);
        }''', [rule, self.css_source, self.locator_source])

    def test_playwright_css_text_and_native_has(self):
        self.assertEqual(self.locate({'strategy': 'css', 'value': 'button:has-text("送出")'}), ['a','b'])
        self.assertEqual(self.locate({'strategy': 'css', 'value': 'section:has(button:has-text("送出")) button:visible'}), ['a'])
        self.assertEqual(self.locate({'strategy': 'css', 'value':'tr:has-text("標準檢測") .status'}), ['status'])

    def test_role_name_label_and_placeholder(self):
        self.assertEqual(self.locate({'strategy':'role', 'role':'button', 'value':'品質檢測','exact':False}), ['a'])
        self.assertEqual(self.locate({'strategy':'label','value':'登入帳號','exact':True}), ['account'])
        self.assertEqual(self.locate({'strategy':'placeholder','value':'Email','exact':False}), ['account'])
        self.assertEqual(self.locate({'strategy':'testId','value':'not-found'}), [])

    def test_data_table_and_fields(self):
        class Browser:
            def __init__(self, page): self.page = page
            def execute_script(self, script, opts):
                return self.page.evaluate('([script,opts]) => (new Function(script))(opts)', [script,opts])
        engine=BrowserEngine({'browser':{},'id':'browser-test'},ROOT,'selenium')
        engine.browser=Browser(self.page)
        engine.url=lambda:'https://example.com/quality'
        original=py_runner.ROOT
        import tempfile
        with tempfile.TemporaryDirectory() as temp:
            py_runner.ROOT=Path(temp)
            try:
                runner=py_runner.Runner({'browser':{},'allowedDomains':['example.com']},engine,{})
                runner.extract_data({'kind':'extractWebData','dataMode':'table','dataRowSelector':'table:has-text("品質檢測")','dataCollection':'quality'})
                self.assertEqual(runner.collections['quality'][0]['結果'],'完檢')
                self.assertEqual(len(runner.collections['quality']),2)
                runner.extract_data({'kind':'extractWebData','dataMode':'list','dataRowSelector':'tr.result',
                   'dataFields':[{'name':'名稱','selector':'.name:visible','required':True},{'name':'狀態','selector':'.status','required':True}],
                   'dataCollection':'checks'})
                self.assertEqual([r['名稱'] for r in runner.collections['checks']], ['品質檢測','標準檢測'])
            finally:
                py_runner.ROOT=original


if __name__=='__main__': unittest.main()
