import test from 'node:test';
import assert from 'node:assert/strict';
import {createStudioStore} from '../frontend/src/studioState.ts';
import {reorderWorkflowSteps,type Step} from '../frontend/src/model.ts';
import {createHoverIntent,PALETTE_HOVER_DELAY_MS} from '../frontend/src/hoverIntent.ts';
import type {Snapshot} from '../frontend/src/bridge.ts';

test('selection notifications do not open settings; explicit double-click intent survives a later notification',()=>{
  let selected='a',projectId='project-1';
  const adapter={snapshot:()=>({revision:1,view:'designer',theme:'light',state:{project:{id:projectId},selectedStepId:selected}} as Snapshot)};
  const store=createStudioStore(adapter,{getItem:()=>null,setItem:()=>{}});
  selected='b';store.getState().refresh();
  assert.equal(store.getState().sheet,false,'single-click selection must stay closed after bridge notification');
  store.getState().setSheet(true);store.getState().refresh();
  assert.equal(store.getState().sheet,true,'explicit edit must remain open');
  store.getState().setSheet(false);selected='c';store.getState().refresh();
  assert.equal(store.getState().sheet,false,'next single click must not reopen settings');
  selected='d';store.getState().setSheet(true);store.getState().refresh();
  assert.equal(store.getState().sheet,true,'double-click on another step opens after selection notification');
  projectId='project-2';store.getState().refresh();
  assert.equal(store.getState().sheet,false,'switching projects closes stale settings');
});
const step=(id:string,extra:Partial<Step>={}):Step=>({id,name:id,kind:'wait',enabled:true,...extra});
const ids=(steps:Step[]|null)=>steps?.map(s=>s.id);
test('insert before and after preserves intervening order; swap only exchanges the chosen steps',()=>{
  const steps=['a','b','c','d'].map(id=>step(id));
  assert.deepEqual(ids(reorderWorkflowSteps(steps,'a','d','before')),['b','c','a','d']);
  assert.deepEqual(ids(reorderWorkflowSteps(steps,'a','d','after')),['b','c','d','a']);
  assert.deepEqual(ids(reorderWorkflowSteps(steps,'d','a','before')),['d','a','b','c']);
  assert.deepEqual(ids(reorderWorkflowSteps(steps,'d','a','after')),['a','d','b','c']);
  assert.deepEqual(ids(reorderWorkflowSteps(steps,'a','d','swap')),['d','b','c','a']);
  assert.deepEqual(ids(steps),['a','b','c','d']);
});
test('nested reorder keeps subtrees intact and rejects dragging between unrelated branches',()=>{
  const steps=[step('condition',{kind:'condition',thenSteps:[step('a',{kind:'loop',steps:[step('child')]}),step('b'),step('c')],elseSteps:[step('other')]}),step('end')];
  const result=reorderWorkflowSteps(steps,'a','c','after')!;
  assert.deepEqual(ids(result[0].thenSteps!),['b','c','a']);
  assert.equal(result[0].thenSteps![2].steps![0].id,'child');
  assert.equal(reorderWorkflowSteps(steps,'a','other','swap'),null);
  assert.equal(reorderWorkflowSteps(steps,'a','end','before'),null);
  assert.equal(reorderWorkflowSteps(steps,'a','a','after'),null);
});
test('palette waits for continuous hover and cancels a brief pass',context=>{
  context.mock.timers.enable({apis:['setTimeout']});
  let visible=false;
  const hover=createHoverIntent(()=>{visible=true;},()=>{visible=false;});
  hover.enter();context.mock.timers.tick(PALETTE_HOVER_DELAY_MS-1);assert.equal(visible,false);
  hover.leave();context.mock.timers.tick(1);assert.equal(visible,false);
  hover.enter();context.mock.timers.tick(PALETTE_HOVER_DELAY_MS);assert.equal(visible,true);
  hover.leave();assert.equal(visible,false);hover.dispose();
});
