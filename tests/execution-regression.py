# Use an isolated test copy; starts real localhost browser runs and creates test projects/downloads.
import os,json,time
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
out=Path(os.environ.get('UI_TEST_ARTIFACTS','verification/execution-artifacts'));out.mkdir(parents=True,exist_ok=True)
Path('public/__qa').mkdir(exist_ok=True)
Path('public/__qa/index.html').write_text('<html><body><a id="download" download="test-report.txt" href="/studio-test-report.txt">Download fixture</a></body></html>')
Path('public/studio-test-report.txt').write_text('Automation Studio local regression report\n')
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path=os.environ.get('TEST_CHROMIUM'),args=['--no-sandbox','--disable-dev-shm-usage'])
 page=browser.new_page(viewport={'width':1440,'height':1050})
 project=page.request.post('http://127.0.0.1:4175/api/studio/projects',data={'id':'execution-verification','name':'Local execution verification','targetUrl':'http://127.0.0.1:4175/__qa/','allowedDomains':['127.0.0.1'],'adapter':'generic','parameters':[],'steps':[{'id':'nav','name':'Open fixture','kind':'navigate','enabled':True,'url':'http://127.0.0.1:4175/__qa/'},{'id':'dl','name':'Download fixture','kind':'download','enabled':True,'selectors':[{'strategy':'css','value':'#download'}],'downloadMode':'auto','timeoutMs':10000}],'browser':{'channel':'bundled','headless':True,'reuseProfile':False,'connectionMode':'managed'},'settings':{'minStepDelayMs':500,'humanizedPlayback':False,'safePlayback':False}}).json()['project']
 page.goto('http://127.0.0.1:4175');page.wait_for_load_state('networkidle');page.evaluate("id=>window.studioBridge.loadProject(id)",project['id']);page.evaluate("window.studioBridge.navigate('designer')")
 page.locator('#designerRunButton').click();page.wait_for_function("['completed','failed'].includes(window.studioBridge.snapshot().state.currentRun?.status)",timeout=45000)
 run=page.evaluate('window.studioBridge.snapshot().state.currentRun');print('REAL RUN',run['status'],run.get('errorMessage'),flush=True)
 assert run['status']=='completed',run
 assert len(run['downloads'])==1,run
 assert Path(run['downloads'][0]).read_text()=='Automation Studio local regression report\n'
 print('PASS actual browser navigation, click/download and file content',flush=True)
 page.evaluate("window.studioBridge.navigate('batch')");page.get_by_role('button',name='新增一列',exact=True).click();page.get_by_role('button',name='新增一列',exact=True).click()
 with page.expect_response(lambda r:'/batch' in r.url and r.request.method=='POST') as response:page.get_by_role('button',name='執行批次',exact=True).click()
 runs=response.value.json()['runs'];print('BATCH CREATED',len(runs),flush=True)
 assert len(runs)>=2
 for task in runs:
  deadline=time.time()+45
  while time.time()<deadline:
   r=page.request.get('http://127.0.0.1:4175/api/studio/runs/'+task['id']).json()['run']
   if r['status'] in ['completed','failed','cancelled']:break
   time.sleep(.3)
  assert r['status']=='completed',r
  assert len(r['downloads'])==1
 print('PASS actual two-row batch execution and downloads',flush=True)
 page.evaluate("window.studioBridge.navigate('runs')");expect(page.locator('#modern-runs .run-pill.completed').first).to_be_visible()
 page.locator('#modern-runs').get_by_role('button',name='執行詳情',exact=True).first.click();expect(page.get_by_role('dialog')).to_be_visible();expect(page.locator('.history-modern-detail')).to_contain_text('test-report')
 print('PASS execution history and existing download detail actions',flush=True)
 (out/'execution-results.json').write_text(json.dumps({'single':run,'batch_run_ids':[r['id'] for r in runs],'checks':['Actual browser navigation','Actual click and file download','Downloaded file content','Two-row batch execution','Batch downloads','Execution history and download detail']},indent=2))
 browser.close()
