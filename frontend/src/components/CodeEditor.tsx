import {useEffect,useState} from 'react';import Editor,{loader} from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import 'monaco-editor/esm/vs/language/json/monaco.contribution.js';
import 'monaco-editor/esm/vs/language/typescript/monaco.contribution.js';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import {useStudio} from '../store';
(self as any).MonacoEnvironment={getWorker:(_id:string,label:string)=>label==='json'?new JsonWorker():['typescript','javascript'].includes(label)?new TsWorker():new EditorWorker()};
loader.config({monaco});
monaco.languages.json.jsonDefaults.setDiagnosticsOptions({validate:true,schemas:[{uri:'studio://selector-rules',fileMatch:['*stepSelectors.json'],schema:{type:'array',items:{type:'object',properties:{strategy:{enum:['role','label','name','text','css','xpath','component']},value:{type:'string'},role:{type:'string'},exact:{type:'boolean'}},required:['strategy']}}}]});
monaco.languages.register({id:'regex'});monaco.languages.setMonarchTokensProvider('regex',{tokenizer:{root:[[/\\[a-zA-Z0-9]/,'keyword'],[/\[[^\]]*\]/,'string'],[/[()*+?{}|.^$]/,'operator']]}});
const editorOptions: monaco.editor.IStandaloneEditorConstructionOptions = {
  fontSize: 13,
  fontFamily: 'Consolas, "SFMono-Regular", monospace',
  minimap: { enabled: false },
  scrollbar: { alwaysConsumeMouseWheel: false },
  scrollBeyondLastLine: false,
  wordWrap: 'on',
  automaticLayout: true,
  tabSize: 2,
  renderLineHighlight: 'line',
  renderWhitespace: 'selection',
  fixedOverflowWidgets: true,
  padding: { top: 10, bottom: 10 },
  lineNumbers: 'on'
};

export function StudioCodeEditor({value,onChange,language='json',height=180,path='studio://editor/document',ariaLabel='程式編輯器',theme}:{value:string;onChange:(value:string)=>void;language?:string;height?:number|string;path?:string;ariaLabel?:string;theme?:'light'|'dark'}) {
  const {snapshot}=useStudio();
  return <div className="modern-code-editor" onKeyDown={e=>{if(e.ctrlKey||e.metaKey||e.key==='Delete')e.stopPropagation();}}><Editor height={height} language={language} path={path} value={value} theme={(theme??snapshot.theme)==='dark'?'vs-dark':'vs'} onMount={editor=>editor.updateOptions({ariaLabel})} onChange={v=>onChange(v??'')} options={editorOptions}/></div>;
}

// The original textarea is the authoritative form field. Editor changes use its
// existing input/change events; disposal never writes stale values back.
export function CodeEditor({target,language='json'}:{target:HTMLTextAreaElement|HTMLInputElement;language?:string}){const {snapshot}=useStudio();const [value,setValue]=useState(target.value);
  useEffect(()=>{setValue(target.value);},[snapshot.revision,target]);
  useEffect(()=>{target.classList.add('modern-code-source');const update=()=>setValue(target.value);target.addEventListener('input',update);target.addEventListener('change',update);return()=>{target.classList.remove('modern-code-source');target.removeEventListener('input',update);target.removeEventListener('change',update);};},[target]);
  const height=language==='regex'?80:target.id==='workflowJson'?520:target.id==='parameterDependentOptions'?120:180;
  const path=`studio://${snapshot.state.project?.id??'workspace'}/${snapshot.state.selectedStepId}/${target.id}.${language==='json'?'json':'txt'}`;
  return <StudioCodeEditor value={value} onChange={next=>{setValue(next);target.value=next;target.dispatchEvent(new Event('input',{bubbles:true}));target.dispatchEvent(new Event('change',{bubbles:true}));}} language={language} height={height} path={path} ariaLabel={target.closest('label')?.querySelector('span')?.textContent??'程式編輯器'}/>;
}
