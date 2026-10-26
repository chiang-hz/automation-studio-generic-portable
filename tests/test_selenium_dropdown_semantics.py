"""v2.3.7 Selenium dropdown selection regression.

Broad recorded [role=option] CSS and exact text must be intersected, never
resolved separately or downgraded to an arbitrary first() click.
"""
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src' / 'studio' / 'python-runtime'))
from engine import BrowserEngine


def recorded_option(name='決算報表'):
    return [
        {'strategy': 'css', 'value': 'div[role="option"]:visible'},
        {'strategy': 'css', 'value': 'div.relative.flex:visible'},
        {'strategy': 'text', 'value': name, 'exact': True},
    ]


class SelectionPlanningTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.engine = BrowserEngine({'browser': {}, 'id': 'dropdown'}, self.tmp.name, 'selenium')

    def tearDown(self):
        self.tmp.cleanup()

    def test_recorded_options_use_exact_aria_role(self):
        for name in ('決算報表', '中央銀行', '損益表'):
            with self.subTest(name=name):
                self.assertEqual(self.engine._prioritize_semantic_rules(recorded_option(name), 'unique'), [
                    {'strategy': 'role', 'role': 'option', 'value': name, 'exact': True}
                ])

    def test_original_workflow_selectors_resolve_without_manual_edits(self):
        import json
        workflow = json.loads((ROOT / 'tests' / 'fixtures' / 'dropdown-duplicate-options.json').read_text(encoding='utf-8'))
        for step in workflow['steps']:
            rules = self.engine._prioritize_semantic_rules(step['selectors'], 'unique')
            self.assertEqual(len(rules), 1)
            self.assertEqual(rules[0]['role'], 'option')
            self.assertTrue(rules[0]['exact'])

    def test_single_broad_option_without_exact_name_is_not_modified(self):
        original = recorded_option()[:2]
        self.assertEqual(self.engine._prioritize_semantic_rules(original, 'unique'), original)

    def test_non_unique_match_modes_are_not_changed(self):
        for mode in ('first', 'last', 'nth'):
            original = recorded_option()
            self.assertEqual(self.engine._prioritize_semantic_rules(original, mode), original)

    def test_named_option_does_not_fallback_to_broad_css(self):
        original = [{'strategy': 'css', 'value': 'div[role="option"]:visible'},
                    {'strategy': 'role', 'role': 'option', 'value': '審定決算', 'exact': True}]
        self.assertEqual(self.engine._prioritize_semantic_rules(original, 'unique'), original[1:])

    def test_unrelated_roles_preserve_fallback(self):
        original = [{'strategy': 'css', 'value': 'button.primary'},
                    {'strategy': 'role', 'role': 'button', 'value': '執行查詢', 'exact': True}]
        self.assertEqual(self.engine._prioritize_semantic_rules(original, 'unique'), [original[1], original[0]])

    def test_ambiguous_or_missing_exact_name_never_uses_broad_fallback(self):
        original = recorded_option()
        queries = []
        def missing(rule, *_args):
            queries.append(rule)
            raise RuntimeError('no visible desktop elements')
        self.engine._find = missing
        with self.assertRaisesRegex(RuntimeError, 'no visible desktop elements'):
            self.engine.locate(original, 'unique')
        self.assertEqual(len(queries), 1)
        self.assertEqual(queries[0]['role'], 'option')
        self.assertEqual(queries[0]['value'], '決算報表')

    def test_duplicate_exact_options_remain_a_hard_failure(self):
        queries=[]
        def duplicate(rule,*_args):
            queries.append(rule)
            raise RuntimeError('Selector is not unique (2 visible desktop elements)')
        self.engine._find=duplicate
        with self.assertRaisesRegex(RuntimeError, '2 visible desktop elements'):
            self.engine.locate(recorded_option(), 'unique')
        self.assertEqual(len(queries), 1)


class BrowserDropdownTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            from playwright.sync_api import sync_playwright
            cls.playwright = sync_playwright().start()
            cls.browser = cls.playwright.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        except Exception as exc:
            if hasattr(cls, 'playwright'):
                cls.playwright.stop()
            raise unittest.SkipTest('Chromium browser unavailable: '+str(exc)[:160])
        helper_dir=ROOT/'src'/'studio'/'python-runtime'
        cls.locator_js=(helper_dir/'locator_compat.js').read_text(encoding='utf-8')
        cls.css_js=(helper_dir/'selector_compat.js').read_text(encoding='utf-8')
        cls.option_js=(helper_dir/'option_compat.js').read_text(encoding='utf-8')

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.page = self.browser.new_page()
        self.page.set_content('''
          <div role="combobox" aria-label="資料來源">決算報表</div>
          <div role="listbox">
            <div role="option" id="finance" class="relative flex"><span>決算報表</span></div>
            <div role="option" id="quality" class="relative flex"><span>品質報表</span></div>
          </div>
        ''')

    def tearDown(self):
        self.page.close()

    def query_ids(self, rule):
        return self.page.evaluate('''([rule, cssText, locatorText]) => {
          const css = (0,eval)(cssText), find = (0,eval)(locatorText);
          return find(document, rule, css).filter(e => e.getClientRects().length).map(e => e.id);
        }''', [rule, self.css_js, self.locator_js])

    def test_broad_css_and_text_each_reproduce_ambiguity(self):
        self.assertEqual(len(self.query_ids(recorded_option()[0])), 2)
        # Both selected label and actual menu item share the same text.
        self.assertGreaterEqual(len(self.query_ids(recorded_option()[2])), 2)

    def test_precise_semantic_rule_targets_correct_menu_option(self):
        prepared=BrowserEngine._prioritize_semantic_rules(recorded_option(), 'unique')
        self.assertEqual(self.query_ids(prepared[0]), ['finance'])

    def option_query(self):
        return self.page.evaluate('''([locatorText, cssText, optionText]) => {
          const find=(0,eval)(locatorText), css=(0,eval)(cssText), resolve=(0,eval)(optionText);
          const candidates=find(document,{strategy:'role',role:'option',value:'決算報表',exact:true},css);
          const report=resolve(candidates,document.querySelector('#opened'));
          return {...report, ids:report.elements.map(e=>e.id), count:report.elements.length, elements:[]};
        }''', [self.locator_js, self.css_js, self.option_js])

    def test_last_opened_combobox_owns_only_one_of_duplicate_visible_options(self):
        self.page.set_content('''
          <button id="opened" role="combobox" aria-controls="menuA" aria-expanded="true">選擇資料來源</button>
          <div role="listbox" id="menuA"><div id="correct" role="option">決算報表</div></div>
          <div role="listbox" id="menuB"><div id="duplicate" role="option">決算報表</div></div>
        ''')
        result=self.option_query()
        self.assertEqual(result['ids'], ['correct'])
        self.assertEqual(result['reason'],'last-opened combobox controls')

    def test_accessibility_hidden_duplicate_is_ignored(self):
        self.page.set_content('''
          <div role="listbox"><div id="a" role="option">決算報表</div></div>
          <div role="listbox" aria-hidden="true"><div id="b" role="option">決算報表</div></div>
        ''')
        self.assertEqual(self.query_ids({'strategy':'role','role':'option','value':'決算報表','exact':True}), ['a'])

    def test_two_real_options_in_active_menu_remain_ambiguous(self):
        self.page.set_content('''
          <button id="opened" role="combobox" aria-controls="menuA" aria-expanded="true">選擇資料來源</button>
          <div role="listbox" id="menuA"><div id="a" role="option">決算報表</div><div id="b" role="option">決算報表</div></div>
        ''')
        result=self.option_query()
        self.assertEqual(result['ids'], ['a','b'])
        self.assertIn('ambiguous',result['reason'])

    def test_closed_target_menu_does_not_escape_to_other_popup(self):
        self.page.set_content('''
          <button id="opened" role="combobox" aria-controls="menuA" aria-expanded="true">選擇資料來源</button>
          <div role="listbox" id="menuA"><div role="option">其他項目</div></div>
          <div role="listbox" id="menuB"><div role="option">決算報表</div><div role="option">決算報表</div></div>
        ''')
        result=self.option_query()
        self.assertEqual(result['count'],2)
        self.assertIn('no matching option within',result['reason'])

    def test_single_unobscured_duplicate_can_be_chosen(self):
        self.page.set_content('''
          <style>#a,#b{position:fixed;top:100px;left:100px;width:120px;height:40px;}#a{z-index:1;}#b{z-index:2;}</style>
          <div role="listbox"><div id="a" role="option">決算報表</div><div id="b" role="option">決算報表</div></div>
        ''')
        result=self.option_query()
        self.assertEqual(result['ids'],['b'])
        self.assertIn('hit-test',result['reason'])

    def test_multiple_identically_named_options_are_not_silently_selected(self):
        self.page.evaluate('''() => {
            const duplicate=document.createElement('div'); duplicate.id='other';
            duplicate.setAttribute('role','option');duplicate.textContent='決算報表';
            document.querySelector('[role=listbox]').appendChild(duplicate);
        }''')
        prepared=BrowserEngine._prioritize_semantic_rules(recorded_option(), 'unique')
        self.assertEqual(self.query_ids(prepared[0]), ['finance', 'other'])


if __name__ == '__main__': unittest.main()
