import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { captureWebData, extractWebData, parseDataCollection, buildCollectedDocument, saveCollectedDocument, validateWebDataConfig } from "../src/studio/webData.ts";
import { createDefaultProject, createImportedProject } from "../src/studio/store.ts";
import { ExportService } from "../src/studio/exporter.ts";
import { WorkflowRunner } from "../src/studio/executor.ts";

const expand = (value: unknown) => String(value ?? "");
class Locator {
  readonly nodes: any[];
  constructor(nodes: any[]) { this.nodes = nodes; }
  locator(selector: string) { return new Locator(this.nodes.flatMap(node => node.map?.[selector] ?? [])); }
  count() { return Promise.resolve(this.nodes.length); }
  first() { return this.nth(0); }
  nth(index: number) { return new Locator(this.nodes.slice(index, index + 1)); }
  async waitFor() { if (!this.nodes.length) throw new Error("No matching element"); }
  async innerText() { return this.nodes[0].text ?? ""; }
  async innerHTML() { return this.nodes[0].html ?? ""; }
  async getAttribute(name: string) { return this.nodes[0].attrs?.[name] ?? null; }
  async evaluateAll(fn: any, arg: any) { return fn(this.nodes, arg); }
}
const scope = (map: Record<string, any[]>) => new Locator([{ map }]);
function entries(bytes: Buffer) {
  const result: Record<string, Buffer> = {};
  for (let at = 0; bytes.readUInt32LE(at) === 0x04034b50;) {
    assert.equal(bytes.readUInt16LE(at + 8), 0);
    const size = bytes.readUInt32LE(at + 18), nameLength = bytes.readUInt16LE(at + 26), extra = bytes.readUInt16LE(at + 28);
    const name = bytes.subarray(at + 30, at + 30 + nameLength).toString();
    const start = at + 30 + nameLength + extra;
    result[name] = bytes.subarray(start, start + size); at = start + size;
  }
  return result;
}

test("single page extraction preserves text, HTML, attributes, optional blanks and source metadata", async () => {
  const rows = await extractWebData(scope({ h1: [{text:"  繁體中文標題  "}], a:[{attrs:{href:"/data?id=001"}}], article:[{html:"<p>甲 &amp; 乙</p>"}] }), {
    dataFields:[{name:"標題",selector:"h1",required:true},{name:"連結",selector:"a",mode:"attribute",attribute:"href"},{name:"內容",selector:"article",mode:"html"},{name:"選填",selector:".missing"}]
  },expand,"https://example.com/page");
  assert.equal(rows[0].標題,"繁體中文標題"); assert.equal(rows[0].連結,"/data?id=001"); assert.equal(rows[0].內容,"<p>甲 &amp; 乙</p>"); assert.equal(rows[0].選填,"");
  assert.equal(rows[0]._sourceUrl,"https://example.com/page"); assert.ok(Number.isFinite(Date.parse(rows[0]._capturedAt)));
});
test("collections append across pages, replace explicitly, and remain unchanged on failed extraction",async()=>{
  const vars:Record<string,string|boolean>={}; const config={dataCollection:"results",dataFields:[{name:"標題",selector:"h1",required:true}]};
  await captureWebData(scope({h1:[{text:"第一頁"}]}),config,vars,expand,"https://example.com/1");
  await captureWebData(scope({h1:[{text:"第二頁"}]}),config,vars,expand,"https://example.com/2");
  assert.equal(parseDataCollection(vars.results).length,2); const before=vars.results;
  await assert.rejects(captureWebData(scope({}),config,vars,expand,"https://example.com/3"),/必填/); assert.equal(vars.results,before);
  await captureWebData(scope({h1:[{text:"取代"}]}),{...config,dataAppend:false},vars,expand,"https://example.com/4");
  assert.equal(parseDataCollection(vars.results).length,1);
});
test("list extraction uses item-relative selectors, supports item text and enforces limits",async()=>{
  const row=(name:string)=>({text:name,map:{a:[{text:name,attrs:{href:"/"+name}}]}});
  const rows=await extractWebData(scope({".item":[row("甲"),row("乙"),row("丙")]}),{dataMode:"list",dataRowSelector:".item",dataLimit:2,dataIncludeSource:false,dataFields:[{name:"整筆",selector:""},{name:"名稱",selector:"a"}]},expand,"https://example.com");
  assert.deepEqual(rows,[{整筆:"甲",名稱:"甲"},{整筆:"乙",名稱:"乙"}]);
});
test("HTML tables derive unique headers and preserve data rows",async()=>{
  const cell=(tagName:string,text:string)=>({tagName,innerText:text});
  const table={map:{tr:[{children:[cell("TH","名稱"),cell("TH","名稱")]},{children:[cell("TD","001"),cell("TD","=1+1")]},{children:[cell("TD","002"),cell("TD","甲&乙")]}]}};
  const rows=await extractWebData(scope({table:[table]}),{dataMode:"table",dataRowSelector:"table",dataIncludeSource:false},expand,"https://example.com");
  assert.deepEqual(rows,[{名稱:"001",名稱_2:"=1+1"},{名稱:"002",名稱_2:"甲&乙"}]);
});
test("invalid fields, ambiguous selectors, malformed collections and Excel overlong cells fail explicitly",async()=>{
  assert.throws(()=>validateWebDataConfig({dataFields:[{name:"x",selector:"a"},{name:"x",selector:"b"}]}),/重複/);
  assert.throws(()=>parseDataCollection("not json"),/JSON/);
  assert.throws(()=>parseDataCollection('[{"a":12}]'),/格式錯誤/);
  await assert.rejects(extractWebData(scope({a:[{text:"a"},{text:"b"}]}),{dataFields:[{name:"a",selector:"a"}]},expand,"https://example.com"),/匹配 2/);
  assert.throws(()=>buildCollectedDocument([{a:"x".repeat(32768)}],{documentFormat:"xlsx"}),/32,767/);
  assert.throws(()=>buildCollectedDocument([],{documentFormat:"json"}),/空白/);
});
test("JSON, DOCX and XLSX keep Chinese, XML-special content and formula-like strings",()=>{
  const rows=[{代碼:"001",內容:'=HYPERLINK("https://example.com")',備註:"甲<&>乙\n第二行"}];
  const json=buildCollectedDocument(rows,{documentFormat:"json",documentColumns:["內容","代碼"]}); assert.deepEqual(JSON.parse(json.toString()),[{內容:rows[0].內容,代碼:"001"}]);
  const doc=entries(buildCollectedDocument(rows,{documentFormat:"docx",documentTitle:"測試&標題"}));
  assert.match(doc["word/document.xml"].toString(),/甲&lt;&amp;&gt;乙/);assert.match(doc["docProps/core.xml"].toString(),/測試&amp;標題/);
  const excel=entries(buildCollectedDocument(rows,{documentFormat:"xlsx",documentSheetName:"資料/彙整"}));const sheet=excel["xl/worksheets/sheet1.xml"].toString();
  assert.match(sheet,/inlineStr/);assert.match(sheet,/001/);assert.ok(!sheet.includes("<f>"));assert.match(excel["xl/workbook.xml"].toString(),/資料_彙整/);
});
test("saving uses exclusive files, safe filenames and column validation",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"studio-data-save-"));
  try{
    const vars={records:JSON.stringify([{代碼:"001",內容:"測試"}])};
    const cfg={dataCollection:"records",documentFormat:"json" as const,documentFileName:"../CON.json",documentUseLocalTime:false};
    const first=await saveCollectedDocument(cfg,vars,dir,expand),second=await saveCollectedDocument(cfg,vars,dir,expand);
    assert.notEqual(first,second);assert.equal(path.dirname(first),dir);assert.equal(JSON.parse(await fs.readFile(first,"utf8"))[0].代碼,"001");
    await assert.rejects(saveCollectedDocument({...cfg,documentColumns:["不存在"]},vars,dir,expand),/必須存在/);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test("native exports include the shared document helper and new workflow steps survive import",async()=>{
  const project=createDefaultProject({id:"test-web-data-export",name:"資料測試",steps:[{id:"capture",name:"擷取",kind:"extractWebData",enabled:true,dataCollection:"records",dataFields:[{name:"標題",selector:"h1"}]},{id:"save",name:"保存",kind:"saveDocument",enabled:true,dataCollection:"records",documentFormat:"xlsx"}]});
  const imported=createImportedProject(project);assert.deepEqual(imported.steps,project.steps);assert.equal(imported.id.length,52);
  const result=await new ExportService().create(project,{portableWorkflow:true,typescript:true,skill:false,includeTests:true,includeExamples:true});
  try{const files=entries(await fs.readFile(result.filePath));assert.ok(files["typescript-project/src/webData.ts"]);assert.ok(files["typescript-project/src/zip.ts"]);assert.match(files["typescript-project/src/run.ts"].toString(),/captureWebData/);assert.deepEqual(JSON.parse(files["portable-workflow/workflow.json"].toString()).steps,JSON.parse(JSON.stringify(project.steps)));}
  finally{await fs.rm(result.filePath,{force:true});}
});

test("native execution routes collection and document steps to the configured download folder", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-data-runner-"));
  try {
    const store = { getSettings: async () => ({ defaultDownloadDir: dir }) };
    const runner = new WorkflowRunner(store as any);
    const page = Object.assign(scope({ h1: [{ text: "實際執行整合" }] }), { url: () => "https://example.com" });
    const project = createDefaultProject({ id: "data-runner-test" });
    const vars: Record<string, string | boolean> = {};
    const run = { parameters: {} };
    await (runner as any).performStep(project, run, {}, page, { kind: "extractWebData", dataFields: [{ name: "標題", selector: "h1" }] }, vars);
    const output = await (runner as any).performStep(project, run, {}, page, { kind: "saveDocument", documentFormat: "json", documentFileName: "結果", documentUseLocalTime: false }, vars);
    assert.equal(path.dirname(output.downloadPath), dir);
    assert.equal(JSON.parse(await fs.readFile(output.downloadPath, "utf8"))[0].標題, "實際執行整合");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
