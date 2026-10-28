import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ExportService } from '../src/studio/exporter.ts';
import { createDefaultProject } from '../src/studio/store.ts';
import { isPotentialLoginUrl, isRequestedUrlAlreadyOpen, scoreExistingSiteTab } from '../src/studio/authNavigation.ts';
import { selectCdpPage } from '../src/studio/cdp.ts';

test('same-origin CDP tabs outrank login/error/blank without changing explicit index mode', () => {
  const urls = ['about:blank', 'https://example.com/login', 'https://example.com/404', 'https://example.com/data', 'https://unrelated.org'];
  const pages = urls.map(url => ({ url: () => url, isClosed: () => false }));
  const settings = { cdpInitialPageMode: 'first', authVerifyUrl: 'https://example.com/' } as any;
  assert.equal(selectCdpPage(pages, settings), pages[3]);
  assert.equal(selectCdpPage(pages, { ...settings, cdpInitialPageMode: 'index', cdpInitialPageIndex: 2 }), pages[1]);
  assert.ok(isPotentialLoginUrl('https://example.com/login'));
  assert.equal(scoreExistingSiteTab('https://example.com/404', 'https://example.com'), 0);
  assert.ok(isRequestedUrlAlreadyOpen('https://example.com/data/', 'https://example.com/data'));
});

test('Studio source export contains v2.5.2 authentication recovery in both languages', async () => {
  const project = createDefaultProject({ name: 'auth-export-verify', targetUrl: 'https://example.com/secure' });
  project.browser.authStateEnabled = true;
  project.browser.authVerifyUrl = 'https://example.com/';
  project.browser.authSuccessSelector = '#my-account';
  project.browser.connectionMode = 'cdp';
  project.steps = [
    { id: 'nav', kind: 'navigate', name: 'Open', enabled: true, url: 'https://example.com/secure' },
    { id: 'click', kind: 'click', name: 'Details', enabled: true, selectors: [{strategy: 'css', value: 'a.detail'}] },
    { id: 'read', kind: 'extractWebData', name: 'Read', enabled: true, waitBefore: {kind: 'visible', value: 'table.detail'} }
  ] as any;
  const exporter = new ExportService() as any;
  const previous = exporter.exportDir;
  const temporary = await fs.mkdtemp(path.resolve('./exports/auth-export-test-'));
  exporter.exportDir = temporary;
  try {
    const result = await exporter.create(project, {portableWorkflow: false, typescript: true, pythonSelenium: true, pythonPlaywright: true, skill: false, includeTests: false});
    const zip = await fs.readFile(result.filePath);
    for (const expected of ['typescript-project/src/authNavigation.ts', 'typescript-project/src/run.ts',
      'python-selenium-project/runner.py', 'python-playwright-project/runner.py',
      'scoreExistingSiteTab', 'authentication_resumed', '_manual_auth_on_current_tab',
      '_await_report_after_view_click', 'TAB_RESULT_TIMEOUT', 'about:blank', '"productVersion": "2.5.2"']) {
      assert.ok(zip.includes(Buffer.from(expected)), `Export is missing ${expected}`);
    }
    assert.ok(!zip.includes(Buffer.from('NODE_TLS_REJECT_UNAUTHORIZED=0')));
  } finally {
    exporter.exportDir = previous;
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
