import test from 'node:test';import assert from 'node:assert/strict';
import {buildGraph,applyGridPatch,parseTSV,validateRow,allowedOptions,quickRunParameters,projectIsQuickRunnable,type Step,type Parameter,type BatchRow,type Project} from '../frontend/src/model.ts';
const step=(id:string,kind='click',extra={}):Step=>({id,name:id,kind,enabled:true,...extra});
test('visual graph preserves both branches, empty branches, joins and subsequent order without mutating workflow',()=>{
 const tree=[step('if','condition',{thenSteps:[step('yes')],elseSteps:[]}),step('next')];const original=structuredClone(tree);const g=buildGraph(tree);assert.deepEqual(tree,original);assert(g.edges.some(e=>e.source==='if'&&e.target==='yes'&&e.label==='True'));assert(g.edges.some(e=>e.source==='if'&&e.target==='ui-join-if'&&e.label==='False'));assert(g.edges.some(e=>e.source==='ui-join-if'&&e.target==='next'));assert.equal(new Set(g.nodes.map(n=>n.id)).size,g.nodes.length);
});
test('loop graph returns to loop and exits to subsequent step, with scoped inserts',()=>{
 const g=buildGraph([step('loop','loop',{steps:[step('body')]}),step('next')]);assert(g.edges.some(e=>e.source==='body'&&e.target==='loop'));assert(g.edges.some(e=>e.source==='loop'&&e.target==='ui-exit-loop'&&e.label==='完成'));assert(g.edges.some(e=>e.source==='ui-exit-loop'&&e.target==='next'));assert(g.edges.some(e=>e.source==='loop'&&e.target==='body'&&e.data?.owner==='loop'&&e.data?.branch==='steps'));
});
test('nested branches are laid out separately and remain connected',()=>{const g=buildGraph([step('outer','condition',{thenSteps:[step('inner','condition',{thenSteps:[step('a')],elseSteps:[step('b')]})],elseSteps:[step('c')]}),step('d')]);assert(g.nodes.find(n=>n.id==='a')!.position.x<g.nodes.find(n=>n.id==='b')!.position.x);assert(g.edges.some(e=>e.source==='ui-join-outer'&&e.target==='d'));});
const parameters:Parameter[]=[{id:'y',name:'year',label:'年度',type:'select',required:true,options:['114','115']},{id:'s',name:'stage',label:'階段',type:'select',required:true,options:['1','2','3'],dependsOn:'year',dependentOptions:{'114':['1'],'115':['2','3']}},{id:'n',name:'number',label:'金額',type:'number',required:true},{id:'b',name:'bool',label:'啟用',type:'boolean',required:true}];
const makeRow=():BatchRow=>({id:crypto.randomUUID(),enabled:true,parameters:{year:'114',stage:'1',number:'0',bool:false}});
test('Excel paste validates complete rows after parent updates and creates missing rows',()=>{const original=[makeRow()];const {rows,errors}=applyGridPatch(original,parameters,0,0,[['115','2','42','true'],['114','1','2','false']],makeRow);assert.deepEqual(errors,[]);assert.equal(rows.length,2);assert.equal(rows[0].parameters.bool,true);assert.equal(original[0].parameters.year,'114');});
test('invalid dependent child, overflow columns and invalid number reject all-or-nothing paste',()=>{const original=[makeRow()];const p=applyGridPatch(original,parameters,0,0,[['115','1','NaN','true','extra']],makeRow);assert(p.errors.some(e=>e.includes('階段')));assert(p.errors.some(e=>e.includes('金額')));assert(p.errors.some(e=>e.includes('超出')));assert.equal(original[0].parameters.year,'114');});
test('dependent options retain legacy fallback to all options for unmapped parent',()=>{assert.deepEqual(allowedOptions(parameters[1],{year:'unknown'}),['1','2','3']);});
test('dashboard quick-run defaults select dependencies and never prefill sensitive parameters',()=>{
 const project:Project={id:'p',name:'p',targetUrl:'https://example.com',steps:[step('open','navigate')],parameters:[
  {id:'year',name:'year',label:'年度',type:'select',required:true,defaultValue:'115',options:['114','115']},
  {id:'kind',name:'kind',label:'類型',type:'select',required:true,dependsOn:'year',options:['all'],dependentOptions:{'115':['annual']}},
  {id:'enabled',name:'enabled',label:'啟用',type:'boolean',required:false,defaultValue:true},
  {id:'secret',name:'secret',label:'密碼',type:'secret',required:false,defaultValue:'do-not-use'}
 ]};
 assert.deepEqual(quickRunParameters(project),{year:'115',kind:'annual',enabled:true,secret:''});
});
test('dashboard quick-run preflight preserves exact and wildcard allowed-domain rules',()=>{
 const base:Project={id:'p',name:'p',targetUrl:'https://example.com',steps:[step('open','navigate')],parameters:[],allowedDomains:['example.com']};
 assert.equal(projectIsQuickRunnable(base),true);
 assert.equal(projectIsQuickRunnable({...base,steps:[step('open','navigate',{url:'https://sub.example.com'})]}),false);
 assert.equal(projectIsQuickRunnable({...base,allowedDomains:['*.example.com'],steps:[step('open','navigate',{url:'https://sub.example.com'})]}),true);
 assert.equal(projectIsQuickRunnable({...base,allowedDomains:['*.example.com']}),false);
 assert.equal(projectIsQuickRunnable({...base,parameters:[{id:'required',name:'required',label:'必要值',type:'text',required:true}]}),false);
});
test('TSV supports Excel quoted multiline cells, escaped quotes and CRLF',()=>{assert.deepEqual(parseTSV('115\t"a\nb"\r\n114\t"a""b"\r\n'),[['115','a\nb'],['114','a"b']]);});
test('required, numeric, Boolean and calendar-date errors are checked before execution',()=>{assert(validateRow(parameters,{year:'115',stage:'3',number:'NaN',bool:'yes'}).length===2);assert(validateRow([{id:'d',name:'d',label:'日期',type:'date',required:true}],{d:'2026-02-30'}).length===1);});
