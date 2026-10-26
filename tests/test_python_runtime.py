"""Browser-independent regression checks for exported Python runtime actions.
Run: python -m unittest discover -s tests -p 'test_python_runtime.py'
"""
import contextlib
import io
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src' / 'studio' / 'python-runtime'))
import runner as py_runner

class Element:
    def __init__(self,text='Old'):
        self.value=text
    def is_visible(self): return True
    def inner_text(self): return self.value

class MockEngine:
    backend='playwright'
    external=False
    def __init__(self):
        self.calls=[]
        self.item=Element('Old')
        self.rows=[]
    def url(self): return 'https://example.com/reports'
    def locate(self,*args,**kwargs): return self.item
    def text(self,item):return item.value
    def visible(self,item):return True
    def attr(self,item,attr):return 'demo'
    def html(self,item):return '<i>demo</i>'
    def goto(self,u):self.calls.append(('goto',u))
    def new_tab(self,n,u):self.calls.append(('newTab',n,u))
    def switch_tab(self,*args):self.calls.append(('switchTab',args))
    def act(self,*args):self.calls.append(('act',args))
    def download(self,*args,**kwargs):return '/mock/file.pdf'
    def direct_download(self,*args,**kwargs):return '/mock/file.pdf'
    def screenshot(self,*args):self.calls.append(('screenshot',args))
    def pdf(self,*args):self.calls.append(('pdf',args))
    def evaluate(self,s):self.calls.append(('script',s))
    def clipboard(self,s):self.calls.append(('clipboard',s))
    def list_items(self,*args):return self.rows
    def component_action(self,*args):self.calls.append(('component',args))
    def reload(self,*args):self.calls.append(('reload',args))
    def selector_state(self,*args,**kwargs):return (True,True)

class RuntimeActionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.previous=py_runner.ROOT
        py_runner.ROOT=Path(self.temp.name)
        self.project={'id':'mock','targetUrl':'https://example.com','allowedDomains':['example.com'],
                      'browser':{'headless':False}, 'settings':{'screenshotMode':'never'}}
        self.engine=MockEngine()
        self.runner=py_runner.Runner(self.project,self.engine,{})
    def tearDown(self):
        py_runner.ROOT=self.previous
        self.temp.cleanup()
    def test_action_matrix_matches_studio_schema(self):
        import re
        types=(ROOT/'src/studio/types.ts').read_text()
        kind_block=types.split('export type StepKind =',1)[1].split(';',1)[0]
        kinds=set(re.findall(r'"([A-Za-z]+)"',kind_block))
        self.assertEqual(len(kinds),29)
        self.assertEqual(kinds,py_runner.SUPPORTED)
        self.assertFalse(py_runner.validate({'allowedDomains':['example.com'],'steps':[{'kind':k,'enabled':True,'name':k} for k in kinds],'browser':{}},'playwright'))
    def test_snapshot_new_item_detection_and_click(self):
        self.engine.rows=[{'text':'Old','fingerprint':'fp-old','element':self.engine.item}]
        self.runner.execute({'kind':'captureListSnapshot','outputVariable':'base','selectors':[{'strategy':'css','value':'li'}]})
        self.assertEqual(json.loads(self.runner.variables['base'])[0]['text'],'Old')
        self.engine.rows=[{'text':'New report','fingerprint':'fp-new','element':self.engine.item}]
        self.runner.execute({'kind':'waitNewListItem','sourceVariable':'base','outputVariable':'new','clickOnMatch':True,'timeoutMs':2000,'selectors':[{'strategy':'css','value':'li'}]})
        self.assertEqual(self.runner.variables['new'],'New report')
        self.assertTrue(any(x[0]=='act' and x[1][0]=='click' for x in self.engine.calls))
    def test_wait_first_diff(self):
        self.runner.variables['old']='Old'
        self.engine.item.value='New report'
        self.runner.execute({'kind':'waitNewFirst','sourceVariable':'old','outputVariable':'new','timeoutMs':1000,'selectors':[{'strategy':'css','value':'li'}]})
        self.assertEqual(self.runner.variables['new'],'New report')
    def test_script_and_clipboard_execute(self):
        self.runner.execute({'kind':'script','script':'document.body.dataset.test="ok"'})
        self.runner.execute({'kind':'clipboard','value':'abc'})
        self.assertIn(('script','document.body.dataset.test="ok"'),self.engine.calls)
        self.assertIn(('clipboard','abc'),self.engine.calls)
    def test_save_all_document_formats(self):
        self.runner.collections['data']=[{'id':'1','value':'測試'},{'id':'2','value':'第二筆'}]
        for fmt in ('json','xlsx','docx'):
            self.runner.execute({'kind':'saveDocument','dataCollection':'data','documentFormat':fmt,'documentLayout':'table','documentFileName':'trial','documentUseLocalTime':False})
            dest=self.runner.out/('trial.'+fmt)
            self.assertTrue(dest.exists(),str(dest))
            self.assertGreater(dest.stat().st_size,30)
            if fmt=='json':self.assertEqual(json.loads(dest.read_text())[0]['value'],'測試')
        from docx import Document
        doc=Document(self.runner.out/'trial.docx')
        self.assertEqual(doc.tables[0].rows[1].cells[1].text,'測試')
    def test_dangerous_script_is_stopped(self):
        bad={'allowedDomains':['example.com'],'steps':[{'kind':'script','name':'host-script','script':'const fs=require("fs");'}],'browser':{}}
        self.assertTrue(any('host-script' in v for v in py_runner.validate(bad,'playwright')))
    def test_reload_validation_and_no_network(self):
        project={'allowedDomains':['example.com'],'steps':[{'kind':'waitNewFirst','name':'watch','periodicRefresh':True,'refreshIntervalSeconds':10}], 'browser':{}}
        self.assertEqual(py_runner.validate(project,'selenium'),[])
        project['steps'][0]['refreshIntervalSeconds']=2
        self.assertTrue(py_runner.validate(project,'selenium'))
    def test_component_path_and_actions(self):
        self.runner.execute({'kind':'fill','componentPath':'Ext.x','value':'1'})
        self.assertTrue(any(x[0]=='component' for x in self.engine.calls))
    def test_direct_download(self):
        self.runner.execute({'kind':'download','downloadMode':'direct','selectors':[{'strategy':'css','value':'a'}]})
    def test_hidden_verification_never_succeeds_with_visible_matches(self):
        with self.assertRaisesRegex(RuntimeError, 'verification failed'):
            self.runner.verify({'kind':'hidden','selector':[{'strategy':'css','value':'button'}]})

    def test_download_verification_requires_saved_artifact(self):
        with self.assertRaisesRegex(RuntimeError, 'no artifact saved'):
            self.runner.verify({'kind':'download'})
        self.runner.execute({'kind':'download','downloadMode':'direct','selectors':[{'strategy':'css','value':'a'}]})
        self.runner.verify({'kind':'download'})

    def test_condition_and_loop_run_after_action_verification(self):
        self.runner.variables['flag']='yes'
        self.runner.execute({'kind':'condition','condition':{'source':'variable','name':'flag','operator':'equals','value':'yes'},
                             'thenSteps':[{'kind':'clipboard','name':'inside','value':'ok'}],
                             'verification':{'kind':'visible','selector':[{'strategy':'css','value':'button'}]}})
        self.runner.execute({'kind':'loop','loopValues':['a','b'],'loopVariable':'iteration',
                             'steps':[{'kind':'clipboard','name':'repeat','value':'{{iteration}}'}],
                             'verification':{'kind':'visible','selector':[{'strategy':'css','value':'button'}]}})
        copies=[args for op,args in self.engine.calls if op=='clipboard']
        self.assertEqual(copies,['ok','a','b'])


if __name__=='__main__':unittest.main()
