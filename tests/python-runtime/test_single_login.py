"""Offline regression tests: no auth-only tab and no duplicate navigation."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock
from tempfile import TemporaryDirectory
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'src/studio/python-runtime'))
from runner import Runner
from engine import BrowserEngine

TARGET='https://cms.data.gov.tw/dataset/provider/quality-check-list'

class Browser:
    def execute_script(self, _script):
        return False

class FakeEngine:
    backend='selenium'
    external=True
    def __init__(self, url=TARGET):
        self.handles={'tab1': url}
        self.active='tab1'
        self.browser=Browser()
        self.goto_calls=[]
        self.tabs=[]
        self.tab_selections=[]
    @property
    def current(self): return self.handles[self.active]
    @current.setter
    def current(self, value): self.handles[self.active]=value
    def url(self): return self.current
    def _tab_id(self): return self.active
    def auth_tab_urls(self): return dict(self.handles)
    def select_auth_tab(self, handle):
        assert handle in self.handles
        self.tab_selections.append(handle)
        self.active=handle
    def goto(self, target):
        self.goto_calls.append(target)
        self.current=target
    def new_tab(self, name, url):
        self.tabs.append((name,url))

class SingleLoginTests(unittest.TestCase):
    def make_runner(self, engine):
        project={
            'allowedDomains':['cms.data.gov.tw'],
            'targetUrl':'https://cms.data.gov.tw/',
            'browser':{'authStateEnabled':True,'authVerifyUrl':'https://cms.data.gov.tw/',
                       'authSuccessSelector':'div:nth-of-type(1)>table','headless':False},
            'settings':{},
            'steps':[]
        }
        return Runner(project,engine,{})

    def test_auth_check_does_not_create_tab_or_navigate(self):
        engine=FakeEngine(TARGET)
        runner=self.make_runner(engine)
        runner.ensure_auth()
        self.assertEqual(engine.tabs, [])
        self.assertEqual(engine.goto_calls, [])

    def test_first_step_same_url_skips_navigation(self):
        engine=FakeEngine(TARGET)
        runner=self.make_runner(engine)
        runner.execute({'kind':'navigate','url':TARGET,'enabled':True,'waitBefore':None,'waitAfter':None})
        self.assertEqual(engine.goto_calls, [])
        self.assertEqual(engine.tabs, [])

    def test_blank_tab_navigates_target_once(self):
        engine=FakeEngine('about:blank')
        runner=self.make_runner(engine)
        runner.ensure_auth()
        runner.execute({'kind':'navigate','url':TARGET,'enabled':True,'waitBefore':None,'waitAfter':None})
        self.assertEqual(engine.goto_calls, [TARGET])
        self.assertEqual(engine.tabs, [])

    def test_existing_login_page_auto_resumes_without_enter(self):
        engine=FakeEngine('https://cms.data.gov.tw/login')
        runner=self.make_runner(engine)
        def complete_login(_duration):
            engine.current=TARGET
        with patch('runner.time.sleep', side_effect=complete_login):
            runner.ensure_auth()
        self.assertEqual(engine.tabs, [])
        self.assertEqual(engine.goto_calls, [])
        self.assertTrue(runner._manual_auth_requested)

    def test_delayed_login_redirect_during_target_wait_resumes_once(self):
        engine=FakeEngine('about:blank')
        orig_goto=engine.goto
        def goto(url):
            orig_goto(url)
            # Server-side auth redirect to login only on first navigation.
            if len(engine.goto_calls) == 1:
                engine.current='https://cms.data.gov.tw/login'
        engine.goto=goto
        engine.selector_state=lambda _rules, auto_frame=False: (engine.current == TARGET, engine.current == TARGET)
        runner=self.make_runner(engine)
        def finish_login(_duration):
            # Website completes sign-in on homepage; runner must resume target.
            if engine.current.endswith('/login'):
                engine.current='https://cms.data.gov.tw/'
        with patch('runner.time.sleep', side_effect=finish_login):
            runner.execute({'kind':'navigate','url':TARGET,'enabled':True,
                            'waitAfter':{'kind':'visible','value':'input[placeholder="查詢資料集編號"]:visible', 'timeoutMs':1000}})
        self.assertEqual(engine.goto_calls, [TARGET, TARGET])
        self.assertEqual(engine.tabs, [])
        self.assertEqual(engine.current, TARGET)

    def test_second_login_after_resume_stops_without_loop(self):
        engine=FakeEngine('https://cms.data.gov.tw/login')
        def goto(url):
            engine.goto_calls.append(url)
            engine.current='https://cms.data.gov.tw/login'
        engine.goto=goto
        runner=self.make_runner(engine)
        def finish_login(_duration):
            if not engine.goto_calls:
                engine.current='https://cms.data.gov.tw/'
        with patch('runner.time.sleep', side_effect=finish_login):
            with self.assertRaisesRegex(RuntimeError, 'AUTH_INVALID'):
                runner._manual_auth_on_current_tab(TARGET)
        self.assertEqual(engine.goto_calls, [TARGET])
        self.assertEqual(engine.tabs, [])

    def test_login_completed_in_another_chrome_tab(self):
        engine=FakeEngine('https://cms.data.gov.tw/login')
        engine.handles['tab2']='https://cms.data.gov.tw/login'
        runner=self.make_runner(engine)
        def finish_login(_duration):
            # User signs in via browser tab 2; tab 1 stays at /login.
            engine.handles['tab2']='https://cms.data.gov.tw/dataset/dashboard'
        with patch('runner.time.sleep', side_effect=finish_login):
            runner._manual_auth_on_current_tab(TARGET)
        self.assertEqual(engine.active, 'tab2')
        self.assertEqual(engine.current, TARGET)
        self.assertEqual(engine.goto_calls, [TARGET])
        self.assertEqual(engine.tabs, [])

    def test_old_dashboard_does_not_short_circuit_new_login(self):
        engine=FakeEngine('https://cms.data.gov.tw/login')
        engine.handles['stale']='https://cms.data.gov.tw/dataset/dashboard'
        engine.handles['new']='https://cms.data.gov.tw/login'
        runner=self.make_runner(engine)
        def finish_login(_duration):
            engine.handles['new']='https://cms.data.gov.tw/dataset/dashboard'
        with patch('runner.time.sleep', side_effect=finish_login):
            runner._manual_auth_on_current_tab(TARGET)
        self.assertEqual(engine.active, 'new')
        self.assertEqual(engine.goto_calls, [TARGET])

    def test_404_then_site_opens_login_tab_and_auto_recovers(self):
        engine=FakeEngine('about:blank')
        def goto(url):
            engine.goto_calls.append(url)
            engine.current='https://cms.data.gov.tw/404' if len(engine.goto_calls)==1 else url
        engine.goto=goto
        engine.selector_state=lambda _rules, auto_frame=False: (engine.current == TARGET, engine.current == TARGET)
        runner=self.make_runner(engine)
        def website_signin(_duration):
            if 'tab2' not in engine.handles:
                engine.handles['tab2']='https://cms.data.gov.tw/login'
            else:
                engine.handles['tab2']='https://cms.data.gov.tw/dataset/dashboard'
        with patch('runner.time.sleep', side_effect=website_signin):
            runner.execute({'kind':'navigate','url':TARGET,'enabled':True,
                            'waitAfter':{'kind':'visible','value':'input[placeholder="查詢資料集編號"]:visible','timeoutMs':1500}})
        self.assertEqual(engine.goto_calls, [TARGET, TARGET])
        self.assertEqual(engine.active, 'tab2')
        self.assertEqual(engine.current, TARGET)

    def test_404_is_never_accepted_as_completed_login(self):
        engine=FakeEngine('https://cms.data.gov.tw/login')
        engine.handles['tab2']='https://cms.data.gov.tw/404'
        runner=self.make_runner(engine)
        self.assertFalse(runner._is_authenticated_page_candidate('https://cms.data.gov.tw/404'))
        self.assertFalse(runner._is_authenticated_page_candidate('https://cms.data.gov.tw/403'))
        self.assertFalse(runner._is_authenticated_page_candidate('https://cms.data.gov.tw/login'))
        self.assertTrue(runner._is_authenticated_page_candidate('https://cms.data.gov.tw/dataset/dashboard'))

    def test_peer_login_detected_after_404(self):
        engine=FakeEngine('https://cms.data.gov.tw/404')
        engine.handles['login']='https://cms.data.gov.tw/login'
        runner=self.make_runner(engine)
        self.assertTrue(runner._peer_login_tab_visible())
        engine.handles.pop('login')
        self.assertFalse(runner._peer_login_tab_visible())

class CdpSnapshotTests(unittest.TestCase):
    def test_cdp_target_snapshot_does_not_switch_tabs_during_login(self):
        with TemporaryDirectory() as temp:
            project={'id':'test','browser':{'authVerifyUrl':'https://cms.data.gov.tw/'},
                     'targetUrl':'https://cms.data.gov.tw/'}
            engine=BrowserEngine(project,temp,'selenium')
            driver=MagicMock()
            driver.window_handles=['CDwindow-ABC', 'CDwindow-DEF']
            driver.current_window_handle='CDwindow-ABC'
            driver.execute_cdp_cmd.return_value={'targetInfos':[
                {'targetId':'ABC','url':'https://cms.data.gov.tw/login','type':'page'},
                {'targetId':'DEF','url':'https://cms.data.gov.tw/dataset/dashboard','type':'page'}]}
            engine.browser=driver
            tabs=engine.auth_tab_urls()
            self.assertEqual(tabs['CDwindow-DEF'],'https://cms.data.gov.tw/dataset/dashboard')
            driver.switch_to.window.assert_not_called()
            engine.select_auth_tab('CDwindow-DEF')
            driver.switch_to.window.assert_called_once_with('CDwindow-DEF')

    def test_browser_tab_selection_does_not_prefer_404_over_login(self):
        with TemporaryDirectory() as temp:
            project={'id':'test','browser':{'authVerifyUrl':'https://cms.data.gov.tw/'},
                     'targetUrl':'https://cms.data.gov.tw/'}
            engine=BrowserEngine(project,temp,'selenium')
            driver=MagicMock()
            driver.window_handles=['h404','hlogin']
            driver.current_window_handle='h404'
            driver.current_url='https://cms.data.gov.tw/404'
            def switch(handle):
                driver.current_url=('https://cms.data.gov.tw/404'
                                    if handle=='h404' else 'https://cms.data.gov.tw/login')
            driver.switch_to.window.side_effect=switch
            engine.browser=driver
            engine._select_existing_site_tab()
            self.assertEqual(driver.switch_to.window.call_args.args,('hlogin',))

if __name__=='__main__': unittest.main()
