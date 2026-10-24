import {canonicalOrigin, VaultError} from './session-vault.mjs';
import {validateLocalCDPEndpoint} from './cdp-capture.mjs';

const MAX_PAGES = 30;
export function candidateUrl(raw) {
  try {
    const url = new URL(raw);
    canonicalOrigin(url.href);
    if (url.username || url.password) return null;
    // Never persist OAuth codes, query tokens, fragment identifiers or signed URLs.
    url.search = '';
    url.hash = '';
    if (/\/(?:login|logout|sign[-_]?in|sign[-_]?out|auth|oauth|callback)(?:\/|$)/i.test(url.pathname)) return null;
    return url.toString();
  } catch {return null;}
}
export function permittedSite(raw, allowedDomains) {
  const url = candidateUrl(raw);
  if (!url) return null;
  const host = new URL(url).hostname;
  if (!Array.isArray(allowedDomains) || !allowedDomains.includes(host)) return null;
  return url;
}
export function loginEvidenceSelectors() {
  // These are candidates only; real matching AND a logged-out negative control are mandatory.
  return [
    'a[href*="logout" i]', 'a[href*="signout" i]', 'button[aria-label*="登出"]',
    'a[aria-label*="登出"]', 'button[title*="登出"]',
    '[data-testid*="account-menu" i]', '[data-testid*="user-menu" i]',
    '[data-testid*="profile-menu" i]', '[aria-label*="目前使用者"]',
    '[aria-label*="我的帳戶"]', '[aria-label*="個人中心"]',
    '[data-authenticated="true"]', '[data-logged-in="true"]'
  ];
}
async function findTabs(browser, allowedDomains) {
  const available = [];
  for (const ctx of browser.contexts()) {
    for (const page of ctx.pages()) {
      if (available.length >= MAX_PAGES) break;
      const url = permittedSite(page.url(), allowedDomains);
      if (!url) continue;
      let focused = false;
      try {focused = await page.evaluate(() => document.hasFocus() || document.visibilityState === 'visible');} catch {}
      let title = '已開啟的網站';
      try {title = String(await page.title()).slice(0, 80) || title;} catch {}
      available.push({page, title, url, focused});
    }
  }
  return available;
}
function chooseTab(tabs, index) {
  if (index !== undefined && index !== null) {
    if (!Number.isInteger(index) || index < 0 || index >= tabs.length) throw new VaultError('所選分頁已不存在，請重新掃描已開啟網頁。', 'TAB_NOT_FOUND');
    return tabs[index];
  }
  return tabs.find(t => t.focused) || tabs[0];
}
export async function inspectCDPTabs({chromium, endpoint, allowedDomains}) {
  if (!chromium?.connectOverCDP) throw new VaultError('無法使用 Playwright CDP。', 'PLAYWRIGHT_REQUIRED');
  validateLocalCDPEndpoint(endpoint);
  const browser = await chromium.connectOverCDP(endpoint);
  try {
    const tabs = await findTabs(browser, allowedDomains);
    return {tabs:tabs.map((t, index)=>({index,url:t.url,title:t.title,focused:t.focused})), recommendedIndex:Math.max(0,tabs.findIndex(t=>t.focused))};
  } finally {await browser.close().catch(()=>{});}
}

async function findAutoSelector(page) {
  const candidates = loginEvidenceSelectors();
  for (const selector of candidates) {
    try {
      if (await page.locator(selector).first().isVisible()) return selector;
    } catch {}
  }
  return null;
}

// Compare an authenticated CDP tab against an isolated, cookie-free context.
// A public-only or ambiguous element cannot establish a successful login.
export async function proveLoginOnly(browser, url, selector, timeoutMs=12000) {
  let ctx;
  try {
    ctx = await browser.newContext({acceptDownloads:false});
    const page = await ctx.newPage();
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:timeoutMs});
    if (canonicalOrigin(page.url()) !== canonicalOrigin(url)) return true; // redirected to SSO
    await page.waitForTimeout(600);
    return !(await page.locator(selector).first().isVisible());
  } catch (error) {
    throw new VaultError('無法完成未登入對照檢查，請確認網站可以開啟後重試，不會在缺少驗證的情況下保存登入狀態。', 'AUTH_PROOF_UNAVAILABLE');
  } finally {await ctx?.close().catch(()=>{});}
}

export async function pickVisibleElement(page, timeoutMs=90000) {
  // A capture-phase listener prevents accidental submission/navigation on the picked element.
  await page.evaluate(() => {
    const key = '__ast_auth_picker_v1';
    if (window[key]?.cleanup) window[key].cleanup();
    let result = null;
    const esc = (s) => {try{return CSS.escape(s)}catch{return String(s).replace(/[^a-zA-Z0-9_-]/g,'\\$&')}};
    function cssFor(el) {
      if (el.id) return `#${esc(el.id)}`;
      for (const attr of ['data-testid','data-test','data-qa','aria-label','title']) {
        const v = el.getAttribute(attr);
        if (v && v.length < 110 && !/token|secret|password|key/i.test(v)) return `${el.localName}[${attr}="${v.replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"]`;
      }
      if (el.localName === 'a' && el.getAttribute('href')?.match(/logout|signout/i)) return `a[href*="${el.getAttribute('href').match(/logout|signout/i)[0]}"]`;
      const parts=[];
      let n=el;
      while (n && n.nodeType===1 && parts.length<7) {
        let part=n.localName;
        if (n.id) {part+='#'+esc(n.id);parts.unshift(part);break;}
        const siblings = Array.from(n.parentElement?.children || []).filter(c=>c.localName===n.localName);
        if (siblings.length>1) part+=`:nth-of-type(${siblings.indexOf(n)+1})`;
        parts.unshift(part); n=n.parentElement;
      }
      return parts.join(' > ');
    }
    const notice=document.createElement('div');notice.textContent='登入狀態辨識：請點選「登入後才會出現」的帳戶或功能項目；Esc 取消。';
    Object.assign(notice.style,{position:'fixed',zIndex:'2147483647',bottom:'12px',left:'12px',right:'12px',padding:'14px',borderRadius:'8px',background:'#14263b',color:'white',font:'bold 14px sans-serif',boxShadow:'0 4px 14px #0005',pointerEvents:'none'});
    document.documentElement.append(notice);
    const hover = (event)=>{const el=event.target;if(el instanceof Element && el!==notice){el.style.outline='2px solid #2c7be5';}};
    const leave = (event)=>{const el=event.target;if(el instanceof Element && el!==notice){el.style.removeProperty('outline');}};
    const click=(event)=>{
      if (!(event.target instanceof Element)) return;
      event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();
      const el=event.target.closest('a,button,[role="button"],[data-testid]') || event.target;
      result={selector:cssFor(el),tag:el.localName};
      cleanup();
    };
    const keydown=(e)=>{if(e.key==='Escape'){result={cancelled:true};cleanup();}};
    const cleanup=()=>{document.removeEventListener('click',click,true);document.removeEventListener('keydown',keydown,true);document.removeEventListener('mouseover',hover,true);document.removeEventListener('mouseout',leave,true);notice.remove();};
    window[key]={get result(){return result},cleanup};
    document.addEventListener('click',click,true);document.addEventListener('keydown',keydown,true);
    document.addEventListener('mouseover',hover,true);document.addEventListener('mouseout',leave,true);
  });
  try {
    await page.waitForFunction(() => window.__ast_auth_picker_v1?.result !== null,null,{timeout:timeoutMs});
    const result=await page.evaluate(() => window.__ast_auth_picker_v1?.result);
    if (!result || result.cancelled) throw new VaultError('已取消選取登入辨識元素。', 'PICK_CANCELLED');
    return result.selector;
  } finally {
    await page.evaluate(() => window.__ast_auth_picker_v1?.cleanup?.()).catch(()=>{});
  }
}

export async function detectCDPAuthentication({chromium, endpoint, allowedDomains, mode='auto', tabIndex}) {
  if (!['auto','pick'].includes(mode)) throw new VaultError('不支援的登入辨識模式。', 'INVALID_MODE');
  validateLocalCDPEndpoint(endpoint);
  const browser=await chromium.connectOverCDP(endpoint);
  try {
    const tabs=await findTabs(browser,allowedDomains);
    const selected=chooseTab(tabs,tabIndex);
    if (!selected) throw new VaultError('在允許網域內找不到可用網頁。請先使用 CDP Chrome 登入並開啟網站的管理頁面。','NO_PERMITTED_TAB');
    const {page,url}=selected;
    let selector=mode==='pick' ? await pickVisibleElement(page):await findAutoSelector(page);
    if (!selector) throw new VaultError('未找到可靠的登入後專屬元素。請改用「在網頁上點選」功能。','AUTO_NOT_FOUND');
    // Never trust a stale/invisible selector or public DOM element.
    if (!(await page.locator(selector).first().isVisible())) throw new VaultError('選取的元素未顯示，請重新選取。','PICK_NOT_VISIBLE');
    if (!(await proveLoginOnly(browser,url,selector))) throw new VaultError('未登入時也能看到相同元素，因此不能用它判斷登入成功。請改選帳戶或登出功能。','NOT_LOGIN_SPECIFIC');
    return {verifyUrl:url,selector,mode,verified:true,tabTitle:selected.title};
  } finally {await browser.close().catch(()=>{});}
}
