# Use only in an isolated test copy; creates layout-review sample data.
import json,os
from pathlib import Path
from playwright.sync_api import sync_playwright
from PIL import Image,ImageDraw
out=Path(os.environ.get('LAYOUT_REVIEW_ARTIFACTS','verification/layout-review'))/os.environ.get('REVIEW_STAGE','before');out.mkdir(parents=True,exist_ok=True)
views=['dashboard','workstation','designer','parameters','test','batch','runs','publish','settings','help','report','aiWorkflow','developer']
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path=os.environ.get('TEST_CHROMIUM'),args=['--no-sandbox','--disable-dev-shm-usage'])
 page=browser.new_page(viewport={'width':1440,'height':1000}); errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto('http://127.0.0.1:4175');page.wait_for_load_state('networkidle');page.wait_for_function("document.documentElement.classList.contains('modern-active')")
 # Work on a dedicated sample project; do not save UI-only fixtures to real projects.
 project=page.request.post('http://127.0.0.1:4175/api/studio/projects',data={'id':'layout-review','name':'版面檢視範例','targetUrl':'https://example.com','allowedDomains':['example.com'],'adapter':'generic','parameters':[{'id':'year','name':'year','label':'年度','type':'select','required':True,'defaultValue':'115','options':['114','115']},{'id':'keyword','name':'keyword','label':'查詢關鍵字','type':'text','defaultValue':'測試資料'}],'steps':[{'id':'nav','name':'開啟查詢頁面','kind':'navigate','enabled':True,'url':'https://example.com'},{'id':'fill','name':'填入查詢條件','kind':'fill','enabled':True,'value':'{{keyword}}','selectors':[{'kind':'css','value':'input[name=keyword]'}]},{'id':'wait','name':'等待查詢完成','kind':'wait','enabled':True,'value':'1000'}]}).json()['project']
 page.reload();page.wait_for_load_state('networkidle');page.evaluate('id=>window.studioBridge.loadProject(id)',project['id']);page.evaluate("window.studioBridge.setTheme('light')")
 results=[]
 for width in [1440,1280,390]:
  page.set_viewport_size({'width':width,'height':1000 if width>500 else 844})
  for v in views:
   page.evaluate('v=>window.studioBridge.navigate(v)',v);page.wait_for_timeout(550);page.evaluate('window.scrollTo(0,0)')
   page.screenshot(path=str(out/f'{width}-{v}.png'),full_page=True)
   results.append(page.evaluate('''v=>{const r=e=>{const b=e.getBoundingClientRect();return {selector:e.id||e.className,x:Math.round(b.x),y:Math.round(b.y),width:Math.round(b.width),height:Math.round(b.height)}};const root=document.getElementById(v+'View');return {view:v,width:innerWidth,bodyWidth:document.documentElement.scrollWidth,cards:[...root.querySelectorAll('.card,.designer-grid,.canvas-pane,.debug-workbench')].map(r),overflow:[...root.querySelectorAll('*')].filter(e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().right>innerWidth+2&&getComputedStyle(e).position!=='fixed'&&!e.closest('.grid-scroll,.data-table-wrap,.batch-table-wrap,.help-tab-strip')).slice(0,12).map(r)}}''',v))
  if width==1440:
   page.evaluate("window.studioBridge.navigate('designer')");page.get_by_role('button',name='視覺畫布',exact=True).click();page.wait_for_timeout(500);page.screenshot(path=str(out/'1440-canvas.png'),full_page=True)
   page.get_by_role('button',name='階層清單',exact=True).click();page.locator('[data-modern-step="fill"]').dblclick();page.wait_for_timeout(800);page.screenshot(path=str(out/'1440-property.png'),full_page=True);page.get_by_role('dialog').get_by_role('button',name='關閉',exact=True).click()
 page.set_viewport_size({'width':1440,'height':1000})
 page.evaluate("window.studioBridge.navigate('settings')")
 page.locator('.ai-settings-card>summary').click();page.locator('[data-ai-provider]').first.locator('summary').first.click();page.wait_for_timeout(300)
 page.screenshot(path=str(out/'1440-settings-expanded.png'),full_page=True)
 page.evaluate("""()=>{const s=window.studioBridge.snapshot().state;s.batchRows=Array.from({length:8},(_,i)=>({id:'review-row-'+i,enabled:true,parameters:{year:'115',keyword:'查詢條件 '+(i+1)}}));window.studioBridge.setBatchRows(s.batchRows);window.studioBridge.navigate('batch');}""")
 page.wait_for_timeout(350);page.screenshot(path=str(out/'1440-batch-populated.png'),full_page=True)
 page.evaluate("""()=>{const s=window.studioBridge.snapshot().state;s.currentRun={id:'layout-preview-run',status:'failed',startedAt:new Date().toISOString(),completedSteps:1,totalSteps:3,steps:[{stepId:'nav',name:'開啟查詢頁面',status:'completed',attempt:1,durationMs:1250},{stepId:'fill',name:'填入查詢條件',status:'failed',attempt:2,durationMs:30300,message:'範例：等待輸入欄位逾時，請檢查定位規則。'}],variables:{year:'115',result:{count:0}},downloads:[]};s.currentRunDebug={events:[{type:'console',level:'info',text:'範例：網站已載入',at:new Date().toISOString()},{type:'step_failed',message:'範例：定位輸入欄位失敗',at:new Date().toISOString()},{type:'http_error',url:'https://example.com/reports',status:500,method:'GET',at:new Date().toISOString()}],variables:s.currentRun.variables};renderRun(s.currentRun);window.studioBridge.navigate('test');}""")
 page.wait_for_timeout(400);page.get_by_role('tab',name='Console',exact=True).click();page.screenshot(path=str(out/'1440-debug-populated.png'),full_page=True)
 page.evaluate("""()=>{const s=window.studioBridge.snapshot().state;const d={name:'報表查詢草稿',description:'版面檢查用範例資料',targetUrl:'https://example.com',allowedDomains:['example.com'],adapter:'generic',parameters:s.project.parameters,steps:s.project.steps};s.aiWorkflowDraft=d;s.aiWorkflowValidation={valid:true,errors:[],warnings:[]};s.aiWorkflowConversation=[{role:'user',content:'請延長等待時間，並加入下載步驟。'},{role:'assistant',content:'已準備候選修改：等待時間調整為 2 秒，新增下載步驟。請先檢查右側差異。'}];s.aiWorkflowPendingRevision={draft:{...d,steps:[...d.steps.slice(0,2),{...d.steps[2],value:'2000'},{id:'new-download',name:'下載報表',kind:'download',enabled:true}]},validation:{valid:true,errors:[],warnings:[]},diff:{changed:true,summary:['等待時間由 1 秒調整為 2 秒','新增下載報表步驟'],steps:[{id:'wait',type:'modified'},{id:'new-download',type:'added'}],parameters:{added:[],modified:[],removed:[]}}};window.studioBridge.navigate('aiWorkflow');renderAIWorkflowAssistant();}""")
 page.wait_for_timeout(500);page.locator('.ai-workflow-prompt-card').evaluate('e=>e.scrollTop=e.scrollHeight');page.screenshot(path=str(out/'1440-ai-populated.png'),full_page=True)
 assert page.locator('.ai-workflow-prompt-card').evaluate('e=>e.scrollHeight>e.clientHeight'), 'AI panel should scroll independently'
 for width in [768,390]:
  page.set_viewport_size({'width':width,'height':900})
  for v in ['designer','test','batch','aiWorkflow','settings']:
   page.evaluate('v=>window.studioBridge.navigate(v)',v);page.wait_for_timeout(250);page.evaluate('window.scrollTo(0,0)');page.screenshot(path=str(out/f'{width}-{v}-active.png'),full_page=True)
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),f'{width}/{v} body overflow'
   if v=='aiWorkflow':
    assert page.locator('.ai-floating-bar').evaluate('e=>{const b=e.getBoundingClientRect();return b.left>=-1&&b.right<=innerWidth+1&&b.top>=0&&b.bottom<=innerHeight+1}'), 'AI actions outside viewport'
   if v=='designer':
    assert page.locator('.canvas-pane').evaluate('e=>e.getBoundingClientRect().right<=innerWidth+1'), 'designer canvas clipped'
 page.set_viewport_size({'width':1440,'height':1000});page.evaluate("window.studioBridge.setTheme('dark');window.studioBridge.navigate('designer')");page.wait_for_timeout(300);page.screenshot(path=str(out/'1440-designer-dark.png'),full_page=True)
 page.evaluate("window.studioBridge.navigate('aiWorkflow')");page.locator('.ai-workflow-prompt-card').evaluate('e=>e.scrollTop=e.scrollHeight');page.wait_for_timeout(300);page.screenshot(path=str(out/'1440-ai-dark.png'),full_page=True)
 assert not errors, errors
 (out/'geometry.json').write_text(json.dumps({'pages':results,'errors':errors},ensure_ascii=False,indent=2))
 browser.close()
for start in range(0,len(views),4):
 subset=views[start:start+4];sheet=Image.new('RGB',(1440,1040),'#dde3eb');d=ImageDraw.Draw(sheet)
 for i,v in enumerate(subset):
  im=Image.open(out/f'1440-{v}.png').convert('RGB');im.thumbnail((720,480));x=(i%2)*720;y=(i//2)*520;d.text((x+10,y+5),v,fill='black');sheet.paste(im,(x,y+30))
 sheet.save(out/f'sheet-{start//4}.png')
print(json.dumps({'dir':str(out),'errors':errors,'overflow':[{'view':r['view'],'width':r['width'],'body':r['bodyWidth']} for r in results if r['bodyWidth']>r['width']+1]},ensure_ascii=False),flush=True)
