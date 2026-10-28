/* CDP login-state UI for the prebuilt studio frontend. Offline, no external assets. */
(() => {
  'use strict';
  const id = 'studio-auth-panel-native';
  const css = document.createElement('style');
  css.textContent = `#${id}{margin:18px 0;padding:20px;border:1px solid var(--border,#a0aab5);border-radius:12px;max-width:100%;box-sizing:border-box} #${id} h3{font-size:17px;font-weight:700;margin:0 0 6px} #${id} p{margin:4px 0 12px;line-height:1.55} #${id} .auth-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:12px} #${id} label{display:flex;flex-direction:column;gap:5px;font-size:13px} #${id} label.auth-switch{flex-direction:row;align-items:center;gap:8px} #${id} input:not([type=checkbox]),#${id} select{width:100%;box-sizing:border-box;border:1px solid #9ba5af;border-radius:6px;padding:9px;font:inherit;min-width:0;background:var(--surface,#fff);color:inherit} #${id} .auth-buttons{display:flex;flex-wrap:wrap;gap:9px;margin-top:12px} #${id} button{border:1px solid #89939d;border-radius:7px;padding:9px 12px;cursor:pointer;background:var(--surface,#fff);color:inherit} #${id} button:disabled{opacity:.45;cursor:not-allowed} #${id} .auth-status{font-size:13px;margin-top:12px;overflow-wrap:anywhere;white-space:pre-line} #${id} small{display:block;font-size:12px;opacity:.8} #${id} .auth-discover{border:1px solid var(--border,#ccd3dc);border-radius:10px;padding:14px;margin-top:12px} #${id} .auth-good{border-left:3px solid #15835b;padding:8px 12px;overflow-wrap:anywhere} #${id} details{margin:12px 0;border:1px solid var(--border,#ccd3dc);border-radius:8px;padding:10px} #${id} summary{cursor:pointer;font-weight:600} #${id} .auth-main-summary{cursor:pointer;font-size:17px;font-weight:700;line-height:1.5;list-style:revert} #${id} .auth-caption{overflow-wrap:anywhere;font-size:12px;color:inherit;opacity:.85}`;
  document.head.append(css);
  const panel = document.createElement('section');
  panel.id = id;
  panel.setAttribute('aria-label','CDP 登入狀態共用');
  panel.innerHTML = `<details data-k="main" class="auth-main"><summary class="auth-main-summary">登入狀態共用（最多 3 個管理瀏覽器）</summary>
  <p>先用 Chrome 完成登入，再讓系統從目前開啟的網站自動找到登入檢查網址及登入後專屬元素。一般使用者不必輸入網址或 CSS。</p>
  <label class="auth-switch"><input data-k="enabled" type="checkbox"/> 在管理瀏覽器中使用保存的登入狀態（預設關閉）</label>
  <section class="auth-discover" aria-label="自動辨識登入狀態">
    <b>步驟 1：選擇已登入的網頁</b>
    <div class="auth-buttons"><button type="button" data-action="tabs">讀取 Chrome 已開啟的網頁</button></div>
    <div class="auth-form"><label>網頁清單<select data-k="tab"><option value="">請先點擊讀取</option></select><small>只顯示此專案允許的網站；請先在 Chrome 登入並開啟網站管理頁面。</small></label></div>
    <b>步驟 2：辨識登入成功條件</b>
    <div class="auth-buttons"><button type="button" data-action="auto">自動辨識（建議）</button><button type="button" data-action="pick">在 Chrome 點選登入後專屬項目</button></div>
    <div data-k="discovery" class="auth-caption" role="status" aria-live="polite">尚未辨識。若自動辨識失敗，請使用滑鼠點選帳戶選單、登出按鈕或登入後才有的管理功能。</div>
  </section>
  <details data-k="advanced"><summary>進階設定（僅供熟悉網站結構者）</summary><div class="auth-form">
   <label>登入檢查網址（HTTPS）<input data-k="verifyUrl" type="url" placeholder="請先使用上方自動辨識"/><small>建議由 Chrome 已登入分頁自動填入；不可使用登入頁或驗證碼轉址。</small></label>
   <label>登入成功判斷 CSS<input data-k="selector" placeholder="請先使用上方自動辨識"/><small>僅手動備援；未登入時也可看見的元素不適用。</small></label>
   <label>CDP 本機位址<input data-k="cdpEndpoint" placeholder="http://127.0.0.1:9222"/></label>
  </div></details>
  <div class="auth-form"><label>加密／解鎖密語（至少 16 字）<input data-k="passphrase" type="password" autocomplete="new-password"/><small>只用於本機擷取、解鎖；不寫入設定檔或匯出工作流程。</small></label></div>
  <div class="auth-buttons">
   <button type="button" data-action="save">儲存登入共用設定</button>
   <button type="button" data-action="capture">確認並加密保存登入狀態</button>
   <button type="button" data-action="unlock">解鎖保存狀態</button>
   <button type="button" data-action="lock">鎖定</button>
   <button type="button" data-action="saved">刪除保存狀態</button>
  </div><div data-k="status" class="auth-status" role="status" aria-live="polite">未載入</div></details>`;
  const field = key => panel.querySelector(`[data-k="${key}"]`);
  let currentId = '', currentMode = '', currentEnabled = null, dirtyEnabled = false, busy = false, savedState = null, tabs = [], detected = false;
  const show = text => { field('status').textContent = text; };
  const activeProject = () => window.studioBridge?.snapshot()?.state?.project;
  const api = (project, action) => `/api/studio/projects/${encodeURIComponent(project.id)}/auth/${action}`;
  function responseError(payload, status) {
    const error = payload && typeof payload === 'object' ? payload.error : undefined;
    const message = typeof error === 'string' ? error
      : typeof error?.message === 'string' ? error.message
      : typeof payload?.message === 'string' ? payload.message
      : `伺服器回應 HTTP ${status}`;
    const code = typeof error?.code === 'string' ? error.code : '';
    return new Error(code && code !== 'REQUEST_FAILED' ? `${message} (${code})` : message);
  }
  async function jsonRequest(url, options) {
    let response;
    try { response = await fetch(url, options); }
    catch { throw new Error('無法連線至 Automation Studio 本機服務，請檢查程式是否仍在執行。'); }
    const raw = await response.text();
    let payload;
    try { payload = raw ? JSON.parse(raw) : {}; }
    catch { throw new Error(`伺服器回應非 JSON 格式（HTTP ${response.status}），請檢查本機服務紀錄。`); }
    if (!response.ok) throw responseError(payload, response.status);
    return payload;
  }
  function validateSettings(project, action) {
    if (action !== 'capture' && action !== 'unlock') return;
    const input = field('verifyUrl').value.trim();
    let url;
    try { url = new URL(input); } catch { throw new Error('請先使用「讀取網頁 → 自動辨識」，由系統填入登入檢查網址。'); }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname))) throw new Error('登入檢查網址必須使用 HTTPS。');
    if (!field('selector').value.trim()) throw new Error('請先使用自動辨識或在 Chrome 點選登入後專屬項目；亦可於進階設定填入 CSS。');
    if (!(project.allowedDomains || []).includes(url.hostname)) throw new Error(`請先在本專案「允許網域」加入 ${url.hostname}，再保存設定。`);
    if (action === 'capture') {
      let cdp;
      try { cdp = new URL(field('cdpEndpoint').value.trim()); }
      catch { throw new Error('CDP 位址格式不正確，範例：http://127.0.0.1:9222。'); }
      if (!['127.0.0.1','localhost','[::1]'].includes(cdp.hostname) || !['http:','ws:'].includes(cdp.protocol)) throw new Error('CDP 必須使用本機 Chrome 位址（例如 http://127.0.0.1:9222）。');
    }
  }
  function fill(project) {
    field('enabled').checked = project.browser?.authStateEnabled === true;
    field('cdpEndpoint').value = project.browser?.cdpEndpoint || 'http://127.0.0.1:9222';
    field('verifyUrl').value = project.browser?.authVerifyUrl || '';
    field('selector').value = project.browser?.authSuccessSelector || '';
    field('passphrase').value = '';
    // The preference remains editable in CDP mode; only managed browsers apply saved auth state.
    field('enabled').disabled = false;
    detected = Boolean(field('verifyUrl').value && field('selector').value);
    field('discovery').textContent = detected ? '已載入之前保存的辨識設定；如網站變動，可重新自動辨識。' : '尚未辨識。請先讀取網頁並自動辨識。';
    field('tab').replaceChildren(new Option('請先點擊讀取',''));
  }
  async function refresh(project) {
    const {auth} = await jsonRequest(api(project,'status'));
    savedState = auth;
    show(auth.unlocked ? `登入狀態已解鎖，有效至 ${new Date(auth.expiresAt).toLocaleString('zh-TW')}` : auth.saved ? '登入狀態已保存，尚未解鎖' : '登入狀態尚未保存');
  }
  async function save(project) {
    const updated = {...project, browser: {...project.browser,
      authStateEnabled: field('enabled').checked,
      authVerifyUrl: field('verifyUrl').value.trim(),
      authSuccessSelector: field('selector').value.trim(),
      cdpEndpoint: field('cdpEndpoint').value.trim()
    }};
    const body = await jsonRequest(`/api/studio/projects/${encodeURIComponent(project.id)}`, {method:'PUT',headers:{'Content-Type':'application/json'},body: JSON.stringify(updated)});
    window.studioBridge?.adoptProject?.(body.project);
    dirtyEnabled = false;
    currentEnabled = body.project.browser?.authStateEnabled === true;
    return body.project;
  }
  function displayTabs(payload) {
    tabs = Array.isArray(payload.tabs) ? payload.tabs : [];
    const selected = field('tab');
    selected.replaceChildren();
    for(const tab of tabs) selected.add(new Option(`${tab.focused?'★ ':''}${tab.title} — ${tab.url}`,String(tab.index)));
    if(tabs.length) selected.value=String(payload.recommendedIndex ?? tabs[0].index);
    else selected.add(new Option('未找到允許的已登入分頁',''));
    field('discovery').textContent = tabs.length ? `找到 ${tabs.length} 個符合允許網域的網頁。請選擇已登入後的管理頁面，再按「自動辨識」。` : '目前未找到允許網域中的 Chrome 網頁。請先登入網站並開啟其管理頁面。';
  }
  async function discover(project, mode) {
    if(!tabs.length) {
      const payload = await jsonRequest(api(project,'tabs'));
      displayTabs(payload);
    }
    if(!tabs.length) throw new Error('沒有可供辨識的網頁；請先在 CDP Chrome 開啟已登入的網站管理頁面。');
    const tabIndex = Number(field('tab').value);
    if(mode === 'pick') field('discovery').textContent='請切換到 Chrome，在選取的網頁上點選「登入後才有」的帳戶或功能項目；按 Esc 取消。';
    else field('discovery').textContent='正在比對登入與未登入狀態，檢查辨識條件是否可靠…';
    const response=await jsonRequest(api(project,'detect'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode,tabIndex})});
    const result=response.detected;
    field('verifyUrl').value=result.verifyUrl;
    field('selector').value=result.selector;
    detected=true;
    field('discovery').textContent=`✓ 已完成登入辨識：${result.tabTitle}。\n檢查頁面：${result.verifyUrl}\n系統已確認未登入時不會出現相同辨識元素。可直接輸入密語並擷取保存。`;
  }
  panel.addEventListener('change', event => {
    if (event.target === field('enabled')) dirtyEnabled = true;
  });
  panel.addEventListener('input', event => {
    if(event.target === field('selector') || event.target === field('verifyUrl')) {
      detected=false;
      field('discovery').textContent='已修改進階設定。儲存前請確認所選元素只在登入後出現。';
    }
  });
  panel.addEventListener('click', async e => {
    const action = e.target.closest('button[data-action]')?.dataset?.action;
    if (!action || busy) return;
    let project = activeProject();
    if (!project) return;
    busy = true;
    for (const button of panel.querySelectorAll('button')) button.disabled = true;
    try {
      if (action === 'tabs' || action === 'auto' || action === 'pick') {
        project=await save(project); // Persist CDP endpoint before backend discovery.
        if(action==='tabs') displayTabs(await jsonRequest(api(project,'tabs')));
        else await discover(project,action);
        return;
      }
      validateSettings(project, action);
      if (action === 'save' || action === 'capture' || action === 'unlock') project = await save(project);
      if (action === 'save') {show('登入共用設定已儲存。');return;}
      const secret = field('passphrase').value;
      if ((action === 'capture' || action === 'unlock') && secret.length < 16) throw Error('密語至少需要 16 個字元。');
      const opts = {method:action === 'saved'?'DELETE':'POST',headers:{'Content-Type':'application/json'}};
      if (action === 'capture' || action === 'unlock') opts.body = JSON.stringify({passphrase:secret});
      const result = await jsonRequest(api(project,action),opts);
      savedState = result.auth;
      show(action === 'capture' ? '已擷取並加密保存，管理瀏覽器可重用登入狀態。' : action === 'unlock' ? '已解鎖，可供管理瀏覽器使用。' : action === 'lock' ? '已鎖定。' : '已刪除加密保存檔。');
    } catch (error) { show(`操作失敗：${error instanceof Error ? error.message : String(error)}`); field('discovery').textContent = action==='auto' || action==='pick' ? `辨識未完成：${error.message}` : field('discovery').textContent; }
    finally {if(!['auto','pick','tabs'].includes(action)) field('passphrase').value = '';busy = false;for(const button of panel.querySelectorAll('button')) button.disabled = false;}
  });
  function tick() {
    const target = document.querySelector('.workstation-page .workstation-profile');
    if (document.getElementById('studio-auth-react-panel')) {panel.remove();return;}
    const project = activeProject();
    if (!target || !project) {panel.remove();currentId='';return;}
    if (!panel.isConnected || panel.previousElementSibling !== target) target.insertAdjacentElement('afterend',panel);
    const mode = project.browser?.connectionMode || 'managed';
    const enabled = project.browser?.authStateEnabled === true;
    if (currentId !== project.id) {
      currentId = project.id;
      currentMode = mode;
      currentEnabled = enabled;
      dirtyEnabled = false;
      fill(project);
      show('讀取登入狀態中…');
      refresh(project).catch(error=>show(`無法讀取登入狀態：${error.message}`));
    } else {
      // Browser mode changes do not change the project id. Never leave the checkbox disabled.
      if (currentMode !== mode) {currentMode = mode;field('enabled').disabled = false;}
      // Refresh external persisted changes without erasing an unsaved user selection.
      if (currentEnabled !== enabled && !dirtyEnabled) {currentEnabled = enabled;field('enabled').checked = enabled;}
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',()=>{setInterval(tick,800);tick();});
  else {setInterval(tick,800);tick();}
})();
