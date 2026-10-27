import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ExportService, validatePythonCompatibility } from '../src/studio/exporter.ts';
import { createDefaultProject } from '../src/studio/store.ts';

test('Python Playwright and Selenium export source-only zip without credentials', async () => {
  const project = createDefaultProject({name:'python-export', targetUrl:'https://example.com'});
  project.parameters.push({id:'secret-param', name:'password',label:'密碼',type:'secret',required:false,sensitive:true,defaultValue:'SUPER-SECRET-DO-NOT-EXPORT'});
  project.steps = [{id:'open',name:'開啟頁面',kind:'navigate',url:'https://example.com',enabled:true}];
  const service = new ExportService() as any;
  const previous = service.exportDir;
  await fs.mkdir(path.resolve('./exports'), { recursive: true });
  const temp = await fs.mkdtemp(path.resolve('./exports/python-test-'));
  service.exportDir = temp;
  try {
    const result = await service.create(project, {portableWorkflow:false,typescript:false,skill:false,pythonPlaywright:true,pythonSelenium:true,includeExamples:true});
    const zip = await fs.readFile(result.filePath);
    for (const name of ['python-playwright-project/runner.py','python-selenium-project/runner.py','python-playwright-project/engine.py','python-selenium-project/requirements.txt','python-playwright-project/run-cdp.bat','python-selenium-project/run-cdp.bat','python-playwright-project/cdp_bootstrap.py','python-selenium-project/cdp_bootstrap.py','python-playwright-project/dependency_bootstrap.py','python-selenium-project/dependency_bootstrap.py','python-playwright-project/launch-python.bat','python-selenium-project/launch-python.bat','python-selenium-project/selector_compat.js','python-selenium-project/locator_compat.js','python-selenium-project/option_compat.js']) {
      assert.ok(zip.includes(Buffer.from(name)), `Missing ${name}`);
    }
    assert.ok(zip.length < 450_000, `Standalone Python source only unexpectedly large ${zip.length}`);
    assert.equal(zip.includes(Buffer.from('SUPER-SECRET-DO-NOT-EXPORT')),false);
    assert.equal(zip.includes(Buffer.from('node.exe')),false);
    assert.ok(zip.includes(Buffer.from('dependency_bootstrap.py')), 'Both batch launchers must use auto dependency installer');
    assert.ok(zip.includes(Buffer.from('AUTOMATION_STUDIO_OFFLINE_ONLY')), 'Offline guard missing from auto dependency installer');
    assert.ok(zip.includes(Buffer.from('visible = q.filter(visible=True)')), 'Exported Playwright engine is missing visible-only selector fix');
    assert.ok(zip.includes(Buffer.from('Click remains obstructed after centered scrolling')), 'Exported Selenium engine must include v2.3.9 safe click recovery');
    assert.ok(zip.includes(Buffer.from('_download_name(filename, dl.suggested_filename, file_path=probe)')), 'Download extension preservation must be included in new Python exports');
    assert.ok(zip.includes(Buffer.from('_selenium_capture_download')), 'Download steps must capture into isolated staging');
    assert.ok(zip.includes(Buffer.from('Chrome CRX extension/component package')), 'Chrome model component download must be quarantined');
    assert.ok(zip.includes(Buffer.from("{'behavior': 'default'}")), 'Chrome download behavior must be restored after each explicit action');
    assert.ok(zip.includes(Buffer.from('_content_disposition_filename(disposition)')), 'Direct downloads must recognize HTTP filenames');
    assert.ok(zip.includes(Buffer.from("step.get('matchMode', 'unique')")), 'Exported runner must default to unique locator mode');
  } finally { service.exportDir = previous; await fs.rm(temp,{force:true,recursive:true}); }
});

test('Python exports browser JavaScript, safely translates Selenium locators and rejects Node-only code', () => {
  const project = createDefaultProject({name:'python-negative',targetUrl:'https://example.com'});
  project.steps=[{id:'js',name:'危險腳本',kind:'script',enabled:true,script:'document.body.click()'}];
  assert.doesNotThrow(()=>validatePythonCompatibility(project,'playwright'));
  project.steps[0].script = 'const fs = require("node:fs");';
  assert.throws(()=>validatePythonCompatibility(project,'playwright'), /Node.js/);
  project.steps=[{id:'pw-selector',name:'點擊',kind:'click',enabled:true,selectors:[{strategy:'css',value:'button:has-text("Continue")'}]}];
  assert.doesNotThrow(()=>validatePythonCompatibility(project,'selenium'));
  project.steps=[{id:'data',name:'擷取',kind:'extractWebData',enabled:true,dataMode:'list',dataRowSelector:'tr:has-text(\"品質檢測\")',dataFields:[{name:'結果',selector:'.status:visible'}]}];
  assert.doesNotThrow(()=>validatePythonCompatibility(project,'selenium'));
  assert.doesNotThrow(()=>validatePythonCompatibility(project,'playwright'));
});

test('Managed Auth validation blocks missing website health-check settings', () => {
  const project = createDefaultProject({name:'auth-guard',targetUrl:'https://example.com'});
  project.browser.authStateEnabled=true;
  assert.throws(()=>validatePythonCompatibility(project,'playwright'),/登入檢查網址/);
  project.browser.authVerifyUrl='https://example.com/secure';
  project.browser.authSuccessSelector='#account-menu';
  assert.doesNotThrow(()=>validatePythonCompatibility(project,'playwright'));
});

test('All 29 Automation Studio step kinds are accepted for Playwright Python with supported config', () => {
  const project=createDefaultProject({name:'action-matrix',targetUrl:'https://example.com'});
  const kinds=['navigate','manual','click','dblclick','fill','select','upload','press','hover','check','uncheck','wait','assert','download','savePagePdf','screenshot','script','condition','loop','extractWebData','saveDocument','extractText','extractPattern','clipboard','newTab','switchTab','waitNewFirst','captureListSnapshot','waitNewListItem'] as const;
  project.browser.stealth=true;
  project.steps=kinds.map((kind,i)=>({id:'s-'+i,name:'Action '+kind,kind,enabled:true,...(kind==='script'?{script:'document.title'}:{}),...(kind==='waitNewListItem'?{periodicRefresh:true,refreshIntervalSeconds:15}:{}),...(kind==='download'?{downloadMode:'direct'}:{})}));
  assert.equal(kinds.length,29);
  assert.doesNotThrow(()=>validatePythonCompatibility(project,'playwright'));
  assert.doesNotThrow(()=>validatePythonCompatibility(project,'selenium'));
  project.steps.push({id:'bad',name:'Bad Interval',kind:'waitNewFirst',enabled:true,periodicRefresh:true,refreshIntervalSeconds:1});
  assert.throws(()=>validatePythonCompatibility(project,'playwright'), /5～600/);
});

test('Python batch export includes launchers and redacts sensitive batch values', async () => {
  const project = createDefaultProject({name:'python-batch-export',targetUrl:'https://example.com'});
  project.parameters.push({id:'test-year',name:'year',label:'年度',type:'select',required:true,defaultValue:'114',options:['114','113']});
  project.parameters.push({id:'test-secret',name:'accessKey',label:'憑證',type:'secret',required:false,sensitive:true,defaultValue:'CONFIDENTIAL-DEFAULT'});
  project.steps=[{id:'open',name:'open',kind:'navigate',enabled:true,url:'https://example.com'}];
  const service = new ExportService() as any;
  const previous = service.exportDir;
  const temp = await fs.mkdtemp(path.resolve('./exports/batch-test-'));
  service.exportDir = temp;
  try {
    const result = await service.create(project, {portableWorkflow:false,typescript:false,skill:false,
      pythonSelenium:true,pythonPlaywright:true,includeTests:true,includeExamples:true,
      pythonBatch:true,pythonBatchIncludeCurrentRows:true,
      pythonBatchRows:[{enabled:true,parameters:{year:'113',accessKey:'CONFIDENTIAL-ROW'}}]});
    const buffer = await fs.readFile(result.filePath);
    for(const backend of ['selenium','playwright']) for(const name of [
      'batch_runner.py','run-batch.bat','run-batch-cdp.bat','batch-settings.json','batch.json','batch.example.csv']) {
      assert.ok(buffer.includes(Buffer.from(`python-${backend}-project/${name}`)), `Missing ${backend}/${name}`);
    }
    assert.ok(buffer.includes(Buffer.from('"year": "113"')));
    assert.ok(buffer.includes(Buffer.from('openpyxl>=3.1,<4')));
    assert.ok(buffer.includes(Buffer.from('\"onError\": \"continue\"')));
    const stopResult = await service.create(project, {portableWorkflow:false,typescript:false,skill:false,pythonSelenium:true,pythonBatch:true,pythonBatchOnError:'stop'});
    const stopZip = await fs.readFile(stopResult.filePath);
    assert.ok(stopZip.includes(Buffer.from('\"onError\": \"stop\"')));
    assert.ok(!buffer.includes(Buffer.from('CONFIDENTIAL-DEFAULT')));
    assert.ok(!buffer.includes(Buffer.from('CONFIDENTIAL-ROW')));
    assert.ok(!buffer.includes(Buffer.from('"pythonBatchRows":')),
      'Raw batch rows must never be copied into export manifest');
    const withoutBatch = await service.create(project,{portableWorkflow:false,typescript:false,skill:false,
      pythonSelenium:true,pythonBatch:false,includeTests:false,includeExamples:false});
    const other = await fs.readFile(withoutBatch.filePath);
    assert.ok(!other.includes(Buffer.from('python-selenium-project/batch_runner.py')));
  } finally {
    service.exportDir=previous;
    await fs.rm(temp,{recursive:true,force:true});
  }
});
