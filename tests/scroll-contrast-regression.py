# Use in an isolated test copy with the layout-review fixture from layout-review.py. Set FIX_STAGE=after.
import os,json
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
out=Path(os.environ.get('SCROLL_TEST_ARTIFACTS','verification/scroll-contrast-review'))/os.environ.get('FIX_STAGE','before');out.mkdir(parents=True,exist_ok=True)
checks=[]
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path=os.environ.get('TEST_CHROMIUM'),args=['--no-sandbox','--disable-dev-shm-usage'])
 page=browser.new_page(viewport={'width':1440,'height':900});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto('http://127.0.0.1:4175');page.wait_for_load_state('networkidle');page.evaluate("window.studioBridge.setTheme('light');window.studioBridge.loadProject('layout-review')")
 page.evaluate("window.studioBridge.navigate('designer')");page.locator('[data-modern-step="fill"]').dblclick();expect(page.get_by_role('dialog')).to_be_visible();page.wait_for_timeout(400)
 mount=page.locator('.property-mount');info=mount.evaluate('e=>({client:e.clientHeight,scroll:e.scrollHeight,top:e.scrollTop})');page.locator('#stepName').hover();page.mouse.wheel(0,650);page.wait_for_timeout(350);info['afterWheel']=mount.evaluate('e=>e.scrollTop');checks.append({'wheel_from_field':info})
 if os.environ.get('FIX_STAGE')=='after':assert info['afterWheel']>100,info
 mount.evaluate('e=>e.scrollTop=0');page.locator('.monaco-editor').first.hover();page.mouse.wheel(0,600);page.wait_for_timeout(350);checks.append({'wheel_from_editor':mount.evaluate('e=>e.scrollTop')})
 if os.environ.get('FIX_STAGE')=='after':assert mount.evaluate('e=>e.scrollTop')>50,'Monaco traps wheel'
 page.screenshot(path=str(out/'step-settings-scroll.png'),full_page=False)
 if os.environ.get('FIX_STAGE')=='after':
  mount.evaluate('e=>e.scrollTop=e.scrollHeight');expect(page.locator('#saveStepButton')).to_be_visible();page.locator('#saveStepButton').click();checks.append({'save_after_scroll':True})
 page.get_by_role('dialog').get_by_role('button',name='關閉',exact=True).click()
 page.locator('.developer-menu').evaluate('e=>e.open=true')
 for theme in ['light','dark']:
  page.evaluate('t=>window.studioBridge.setTheme(t)',theme)
  for view in ['aiWorkflow','developer']:
   button=page.locator('.developer-menu button[data-view="'+view+'"]');button.click();page.mouse.move(800,40);page.wait_for_timeout(200)
   colors=button.evaluate('e=>({color:getComputedStyle(e).color,background:getComputedStyle(e).backgroundColor,active:e.classList.contains("active")})');checks.append({'theme':theme,'view':view,**colors})
   if os.environ.get('FIX_STAGE')=='after':
    contrast=button.evaluate('''e=>{const parse=c=>c.match(/[\\d.]+/g).slice(0,3).map(Number);const lum=c=>parse(c).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4}).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);const a=lum(getComputedStyle(e).color),b=lum(getComputedStyle(e).backgroundColor);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)}''');assert contrast>=4.5,(theme,view,colors,contrast);checks[-1]['contrast']=contrast
   page.screenshot(path=str(out/(theme+'-'+view+'.png')),full_page=False)
 if os.environ.get('FIX_STAGE')=='after':
  page.set_viewport_size({'width':390,'height':844});page.evaluate("window.studioBridge.navigate('designer')");page.locator('[data-modern-step="fill"]').dblclick();page.wait_for_timeout(250);page.locator('#stepName').hover();page.mouse.wheel(0,600);page.wait_for_timeout(300);assert mount.evaluate('e=>e.scrollTop')>50;checks.append({'mobile_wheel':True});page.screenshot(path=str(out/'mobile-step-settings.png'),full_page=False)
 assert not errors,errors
 (out/'results.json').write_text(json.dumps({'checks':checks,'errors':errors},ensure_ascii=False,indent=2));print(json.dumps(checks,ensure_ascii=False),flush=True);browser.close()
