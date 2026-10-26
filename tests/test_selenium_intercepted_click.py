"""Regression: fixed header must not intercept Selenium click or download.

A fake WebDriver wires a real Chromium DOM into the exact Selenium engine
click method. It intentionally reproduces ChromeDriver click interception.
"""
import sys
import io
import zipfile
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'src'/'studio'/'python-runtime'))
from engine import BrowserEngine

class ElementClickInterceptedException(Exception):
    pass

class WebDriverElement:
    def __init__(self, page, selector, on_success=None):
        self.page,self.selector,self.on_success=page,selector,on_success
        self.clicks=0
        self.interceptions=0
    def click(self):
        hit=self.page.evaluate('''selector => {
          const el=document.querySelector(selector), r=el.getBoundingClientRect();
          const x=r.x+r.width/2,y=r.y+r.height/2;
          const top=document.elementFromPoint(x,y);
          return Boolean(top && (top===el || el.contains(top)));
        }''',self.selector)
        if not hit:
            self.interceptions+=1
            raise ElementClickInterceptedException('element click intercepted by fixed header')
        self.clicks+=1
        self.page.locator(self.selector).click()
        if self.on_success:self.on_success()

class Driver:
    def __init__(self,page):self.page=page
    def execute_script(self, script, element, retry):
        return self.page.evaluate('''([code, selector, retry]) => {
          return (new Function(code))(document.querySelector(selector), retry);
        }''',[script,element.selector,retry])

class SafeClickTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            from playwright.sync_api import sync_playwright
            cls.pw=sync_playwright().start()
            cls.browser=cls.pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
        except Exception as err:
            if hasattr(cls,'pw'):cls.pw.stop()
            raise unittest.SkipTest(str(err))
    @classmethod
    def tearDownClass(cls):
        cls.browser.close();cls.pw.stop()
    def setUp(self):
        self.page=self.browser.new_page(viewport={'width':1300,'height':500})
        self.page.set_content('''
          <style>body{margin:0} #header{position:fixed;z-index:3000;top:0;left:0;right:0;height:75px;background:navy}
          #export{position:absolute;top:1150px;right:30px;height:44px;width:170px}
          #spacer{height:2000px}</style>
          <a id="header" href="/dashboard">Dashboard</a>
          <div id="spacer"></div><button id="export" onclick="window.exportCount=(window.exportCount||0)+1">匯出為 Excel</button>
        ''')
        # Position button's center under the fixed header (reported Selenium bug).
        self.page.evaluate('window.scrollTo(0, document.querySelector("#export").offsetTop - 1)')
        self.tmp=tempfile.TemporaryDirectory()
        self.engine=BrowserEngine({'id':'test','browser':{}}, self.tmp.name, 'selenium')
        self.engine.browser=Driver(self.page)
        self.el=WebDriverElement(self.page,'#export')
        self.exc=types.ModuleType('selenium.common.exceptions')
        self.exc.ElementClickInterceptedException=ElementClickInterceptedException
        self.mod=types.ModuleType('selenium')
        self.common=types.ModuleType('selenium.common')
        self.mod.common=self.common
        self.common.exceptions=self.exc
        self.override=patch.dict(sys.modules,{
            'selenium':self.mod,'selenium.common':self.common,'selenium.common.exceptions':self.exc
        })
        self.override.start()
    def tearDown(self):
        self.override.stop();self.page.close();self.tmp.cleanup()
    def test_initial_hit_is_intercepted(self):
        with self.assertRaises(ElementClickInterceptedException):self.el.click()
        self.assertEqual(self.el.clicks,0)
    def test_safe_click_centers_button_and_clicks_once(self):
        self.engine._selenium_safe_click(self.el)
        self.assertEqual(self.el.clicks,1)
        self.assertEqual(self.page.evaluate('window.exportCount'),1)
        self.assertEqual(self.el.interceptions,0)
    def test_download_uses_same_safe_click(self):
        capture={'path':None}
        def route(path=None): capture['path']=Path(path) if path else None
        self.engine._selenium_download_behavior=route
        def saved():
            data=io.BytesIO()
            with zipfile.ZipFile(data,'w') as archive:
                archive.writestr('xl/workbook.xml','content')
            (capture['path']/'report.xlsx').write_bytes(data.getvalue())
        self.el.on_success=saved
        result=self.engine.download(self.el,timeout=1200,expected_format='excel')
        self.assertTrue(result.endswith('report.xlsx'))
        self.assertEqual(self.el.clicks,1)
        self.assertIsNone(capture['path'])
    def test_persistent_modal_blocks_without_js_bypass(self):
        self.page.evaluate('''() => {const div=document.createElement('div');div.id='modal';
          div.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999';
          document.body.append(div); }''')
        with self.assertRaisesRegex(RuntimeError,'Click remains obstructed'):
            self.engine._selenium_safe_click(self.el)
        self.assertEqual(self.el.clicks,0)
        self.assertEqual(self.page.evaluate('window.exportCount || 0'),0)
        self.assertEqual(self.el.interceptions,3)

if __name__=='__main__':unittest.main()
