import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await fs.readFile(new URL('../public/startup.js', import.meta.url), 'utf8');
function boot({ stored = 'dark', blocked = false, cached = false } = {}) {
  const root = { dataset: { studioBoot: 'loading', theme: '' } };
  const nodes: Record<string, any> = Object.fromEntries(['studio-startup-title', 'studio-startup-description', 'studio-startup-reload', 'studio-startup'].map(id => [id, { textContent: '', hidden: true, attributes: {}, setAttribute(key: string, value: string) { this.attributes[key] = value; } }]));
  nodes['studio-modern-styles'] = { sheet: cached ? {} : null };
  const shell = { inert: true, attributes: {} as Record<string,string>, setAttribute(key: string,value: string) { this.attributes[key] = value; } };
  const events = new Map<string, Array<(event: any) => void>>();
  const frames: Array<() => void> = [];
  const timers = new Map<number, () => void>();
  let reloads = 0;
  const listen = (type: string, listener: (event: any) => void) => events.set(type, [...events.get(type) ?? [], listener]);
  const window: any = {
    matchMedia: () => ({ matches: false }), addEventListener: listen,
    setTimeout: (callback: () => void) => { timers.set(1, callback); return 1; }, clearTimeout: (id: number) => timers.delete(id),
    requestAnimationFrame: (callback: () => void) => frames.push(callback), location: { reload: () => reloads++ }
  };
  const document = { documentElement: root, getElementById: (id: string) => nodes[id], querySelector: () => shell, addEventListener: listen };
  vm.runInNewContext(source, { window, document, localStorage: { getItem: () => { if (blocked) throw new Error('blocked'); return stored; } } });
  return { window, root, nodes, shell, timers,
    emit: (type: string, event: any = {}) => events.get(type)?.forEach(listener => listener(event)),
    paint: () => { while (frames.length) frames.shift()!(); }, reloads: () => reloads };
}

test('啟動先套用主題，資料、樣式及 React 全部就緒前不顯示介面', () => {
  for (const order of [['ui','data','styles'], ['data','styles','ui'], ['styles','ui','data']]) {
    const h = boot();
    assert.equal(h.root.dataset.theme, 'dark');
    for (const part of order.slice(0,2)) h.window.studioStartup.complete(part);
    h.paint();
    assert.equal(h.root.dataset.studioBoot, 'loading');
    assert.equal(h.shell.inert, true);
    h.window.studioStartup.complete(order[2]);
    assert.equal(h.root.dataset.studioBoot, 'loading');
    h.paint();
    assert.equal(h.root.dataset.studioBoot, 'ready');
    assert.equal(h.shell.inert, false);
    assert.equal(h.shell.attributes['aria-busy'], 'false');
    assert.equal(h.timers.size, 0);
  }
});

test('快取樣式已載入時仍須等待資料和 React；儲存設定受限時採系統主題', () => {
  const h = boot({ blocked:true, cached:true });
  assert.equal(h.root.dataset.theme, 'light');
  h.window.studioStartup.complete('ui'); h.paint();
  assert.equal(h.root.dataset.studioBoot, 'loading');
  h.window.studioStartup.complete('data'); h.paint();
  assert.equal(h.root.dataset.studioBoot, 'ready');
});

test('必要樣式或腳本失敗時保留遮罩，提供重新整理，不回退原有介面', () => {
  for (const target of [{ id:'studio-modern-styles' }, { id:'studio-base-styles' }, { id:'studio-modern-script' }, { tagName:'SCRIPT',src:'http://localhost/bridge.js' }, { tagName:'SCRIPT',src:'http://localhost/app.js' }]) {
    const h = boot();h.emit('error',{target});
    assert.equal(h.root.dataset.studioBoot,'failed');
    assert.equal(h.shell.inert,true);
    assert.equal(h.nodes['studio-startup-reload'].hidden,false);
    assert.equal(h.nodes['studio-startup'].attributes.role,'alert');
    for (const part of ['data','styles','ui']) h.window.studioStartup.complete(part);
    h.paint();assert.equal(h.root.dataset.studioBoot,'failed');
    h.emit('click',{target:{id:'studio-startup-reload'}});assert.equal(h.reloads(),1);
  }
});

test('載入過久提供提示與重試，但遲到的成功初始化仍可顯示新版介面', () => {
  const h = boot();h.timers.get(1)!();
  assert.equal(h.root.dataset.studioBoot,'loading');
  assert.match(h.nodes['studio-startup-description'].textContent,/繼續等候/);
  assert.equal(h.nodes['studio-startup-reload'].hidden,false);
  for (const part of ['data','styles','ui']) h.window.studioStartup.complete(part);
  h.paint();assert.equal(h.root.dataset.studioBoot,'ready');
});

test('排定顯示後發生初始化錯誤不會揭開遮罩；正常執行期間的錯誤不被啟動監聽攔截', () => {
  const h = boot();for (const part of ['data','styles','ui']) h.window.studioStartup.complete(part);
  h.emit('unhandledrejection');h.paint();assert.equal(h.root.dataset.studioBoot,'failed');
  const ready = boot();for (const part of ['data','styles','ui']) ready.window.studioStartup.complete(part);
  ready.paint();ready.emit('unhandledrejection');ready.emit('error',{message:'normal run error'});
  assert.equal(ready.root.dataset.studioBoot,'ready');
  ready.window.studioStartup.fail('React render failed');assert.equal(ready.root.dataset.studioBoot,'failed');
});

test('啟動程式在應用程式之前，首次 HTML 即遮蔽舊畫面，建置保留載入資源識別', async () => {
  const html = await fs.readFile(new URL('../public/index.html',import.meta.url),'utf8');
  assert.match(html,/<html[^>]*data-studio-boot="loading"/);
  assert.match(html,/<div class="app-shell" inert aria-busy="true">/);
  assert.ok(html.indexOf('studio-startup-style') < html.indexOf('styles.css'));
  assert.ok(html.indexOf('studio-startup-script') < html.indexOf('<body>'));
  assert.ok(html.indexOf('studio-startup-script') < html.indexOf('./app.js'));
  assert.match(html, /html:not\(\[data-studio-boot="ready"\]\) \.app-shell/);
  const app = await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const react = await fs.readFile(new URL('../frontend/src/main.tsx',import.meta.url),'utf8');
  assert.match(app, /renderAIWorkflowAssistant\(\);\s*window\.studioStartup\?\.complete\("data"\)/);
  assert.match(react,/useLayoutEffect\(\(\) => \{[\s\S]*?studioStartup\?\.complete\('ui'\)/);
  const builder = await fs.readFile(new URL('../scripts/install-frontend.mjs',import.meta.url),'utf8');
  assert.match(builder,/studio-modern-styles/);assert.match(builder,/studio-modern-script/);
  assert.match(html, /<script id="studio-startup-script">/);
  assert.doesNotMatch(html, /src="\/startup\.js/);
});
