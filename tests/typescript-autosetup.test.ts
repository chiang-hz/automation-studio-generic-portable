import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ExportService } from '../src/studio/exporter.ts';
import { createDefaultProject } from '../src/studio/store.ts';
test('TypeScript export contains auto dependency setup, local Chrome and scoped TLS retry', async () => {
  const service = new ExportService() as any;
  const previous = service.exportDir;
  const temp = await fs.mkdtemp(path.resolve('./exports/ts-auto-'));
  service.exportDir = temp;
  try {
    const project = createDefaultProject({ name: 'ts-bootstrap', targetUrl: 'https://example.com' });
    project.steps = [{ id:'nav', name:'open', kind:'navigate', enabled:true, url:'https://example.com' }];
    const result = await service.create(project, {portableWorkflow:false,typescript:true,skill:false,pythonPlaywright:false,pythonSelenium:false,includeExamples:true});
    const zip = await fs.readFile(result.filePath);
    for (const fragment of ['typescript-project/start.bat', 'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1', 'call "%STUDIO_NPM%" install', '--strict-ssl=false', 'node_modules\\playwright', 'npm-install.log', 'typescript-project/src/run.ts']) assert.ok(zip.includes(Buffer.from(fragment)),fragment);
  } finally { service.exportDir=previous; await fs.rm(temp,{recursive:true,force:true}); }
});

test('TypeScript starter verifies node and paired npm, recovers checksum-pinned portable runtime and preserves TLS scope', async () => {
  const starter = await fs.readFile(new URL('../src/studio/templates/typescript-start.bat.txt', import.meta.url), 'utf8');
  for (const text of ['"%~1" --version', 'call "%~1" --version', ':try_system_node', ':try_system_npm', '%%~dpPnpm.cmd', 'NODE_ZIP_SHA256', 'Get-FileHash', 'runtime\\node\\npm.cmd', '--ssl-no-revoke', '--strict-ssl=false', 'set "NODE_TLS_REJECT_UNAUTHORIZED="']) {
    assert.ok(starter.includes(text), text);
  }
  assert.ok(starter.indexOf('if exist "%STUDIO_NODE%"') < starter.indexOf('for /f "delims=" %%P in (\'where node.exe'), 'portable runtime must be reused before system probing');
});
