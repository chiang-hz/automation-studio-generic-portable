import assert from 'node:assert/strict';
import test from 'node:test';
import {exportBatchContent,importBatchContent} from '../frontend/src/batchFiles.ts';
import type {BatchRow,Parameter,Project} from '../frontend/src/model.ts';

const parameters:Parameter[]=[
  {id:'code',name:'code',label:'代碼',type:'text',required:true},
  {id:'note',name:'note',label:'備註',type:'text',required:false},
  {id:'flag',name:'flag',label:'旗標',type:'boolean',required:false},
  {id:'amount',name:'amount',label:'金額',type:'number',required:false}
];
const project:Project={id:'project-a',name:'測試批次',parameters,steps:[]};
const rows:BatchRow[]=[
  {id:'old-1',enabled:true,parameters:{code:'00123',note:'甲,乙\r\n"引號"',flag:false,amount:'123.50'}},
  {id:'old-2',enabled:false,parameters:{code:'00009',note:' 尾端空白 ',flag:true,amount:'0'}}
];
function factory(parametersToUse=parameters){let next=0;return()=>({id:`new-${++next}`,enabled:true,parameters:Object.fromEntries(parametersToUse.map(p=>[p.name,p.defaultValue??'']))});}

test('批次 JSON 保留各列執行勾選、布林、前導零與多行文字，重新產生列識別碼',()=>{
  const result=importBatchContent(exportBatchContent(project,rows,'json'),'json',parameters,factory());
  assert.deepEqual(result.errors,[]);
  assert.deepEqual(result.rows.map(({id,...row})=>row),rows.map(({id,...row})=>row));
  assert.deepEqual(result.rows.map(row=>row.id),['new-1','new-2']);
});

test('CSV 使用 UTF-8 BOM 並正確往返逗號、引號、多行文字與前導零',()=>{
  const csv=exportBatchContent(project,rows,'csv');
  assert.equal(csv.charCodeAt(0),0xFEFF);
  const result=importBatchContent(csv,'csv',parameters,factory());
  assert.deepEqual(result.errors,[]);
  assert.deepEqual(result.rows.map(({id,...row})=>row),rows.map(({id,...row})=>row));
});

test('敏感值不匯出，必要敏感欄位可以匯入後補填，不使用專案的敏感預設值',()=>{
  const secret:Parameter={id:'secret',name:'password',label:'密碼',type:'secret',required:true,defaultValue:'default-secret'};
  const sensitive:Parameter={id:'token',name:'token',label:'Token',type:'text',sensitive:true,required:false};
  const params=[...parameters,secret,sensitive];
  const source={...project,parameters:params};
  const data=rows.map(row=>({...row,parameters:{...row.parameters,password:'actual-secret',token:'private-token'}}));
  for(const format of ['json','csv'] as const){
    const text=exportBatchContent(source,data,format);
    assert.doesNotMatch(text,/actual-secret|private-token|default-secret/);
    const result=importBatchContent(text,format,params,factory(params));
    assert.deepEqual(result.errors,[]);
    assert.equal(result.rows[0].parameters.password,'');
    assert.equal(result.rows[0].parameters.token,'');
    assert.match(result.warnings.join(' '),/敏感/);
  }
});

test('未完成的批次清單可往返保存，缺少必填內容時提醒執行前補填',()=>{
  const draft=[{id:'draft',enabled:false,parameters:{code:'',note:'',flag:'',amount:''}}];
  const result=importBatchContent(exportBatchContent(project,draft,'json'),'json',parameters,factory());
  assert.equal(result.rows.length,1);
  assert.deepEqual(result.errors,[]);
  assert.match(result.warnings.join(' '),/必填/);
});

test('匯入驗證相依選項及資料類型；其中一列錯誤時整份不套用',()=>{
  const params:Parameter[]=[
    {id:'parent',name:'year',label:'年度',type:'select',required:true,options:['115','116']},
    {id:'child',name:'report',label:'報表',type:'select',required:true,dependsOn:'year',dependentOptions:{'115':['A'],'116':['B']}}
  ];
  const text='__studio_enabled,year,report\r\ntrue,115,A\r\nfalse,116,A';
  const result=importBatchContent(text,'csv',params,factory(params));
  assert.equal(result.rows.length,0);
  assert.match(result.errors.join(' '),/第 2 列.*報表/);
  const bad=JSON.parse(exportBatchContent(project,rows,'json'));
  bad.rows[0].parameters.amount='非數字';
  assert.match(importBatchContent(JSON.stringify(bad),'json',parameters,factory()).errors.join(' '),/金額/);
  assert.equal(rows[0].parameters.amount,'123.50');
});

test('拒絕錯誤格式、未知欄位、參數類型不符與破損 CSV',()=>{
  const schema=JSON.parse(exportBatchContent(project,rows,'json'));
  schema.parameters[0].type='date';
  assert.match(importBatchContent(JSON.stringify(schema),'json',parameters,factory()).errors[0],/類型/);
  for(const [text,format] of [
    ['{}','json'],['__studio_enabled,unknown\ntrue,test','csv'],
    ['code,code\n1,2','csv'],['code,note\n1,"broken','csv'],
    ['code,note\n1','csv'],['__studio_enabled,code\nmaybe,1','csv']
  ] as const){const result=importBatchContent(text,format,parameters,factory());assert.equal(result.rows.length,0);assert.ok(result.errors.length);}
});

test('CSV 可省略執行欄位，依目前專案參數 Key 匯入且預設啟用',()=>{
  const result=importBatchContent('code,note\n0007,說明','csv',parameters,factory());
  assert.deepEqual(result.errors,[]);
  assert.equal(result.rows[0].enabled,true);
  assert.equal(result.rows[0].parameters.code,'0007');
});
