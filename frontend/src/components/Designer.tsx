import {useEffect,useMemo,useRef,useState,useCallback} from 'react';
import {ReactFlow,Background,Controls,MiniMap,Handle,Position,BaseEdge,EdgeLabelRenderer,getBezierPath,applyNodeChanges,type EdgeProps,type NodeProps,type Node,type NodeChange} from '@xyflow/react';
import {Globe,MousePointer2,Download,FileDown,Shield,GitBranch,Repeat2,TextCursorInput,Clock,Plus,Copy,Trash2,Play,SkipForward,ArrowDown,ArrowUp,Power,Settings2,List,Workflow,Undo2,ChevronDown,Maximize2,Minimize2,Search,CheckCircle2,Upload,Terminal,Braces} from 'lucide-react';
import { runtimeSdk } from '../sdk/runtimeSdk';import {useStudio} from '../store';import {buildGraph,type Step,type StepDropMode} from '../model';
import {Button} from './ui/button';import {Dialog} from './ui/dialog';
export const kindIcons:Record<string,typeof Globe>={
  navigate:Globe,newTab:Globe,switchTab:Globe,
  click:MousePointer2,dblclick:MousePointer2,hover:MousePointer2,
  fill:TextCursorInput,select:List,check:CheckCircle2,press:Terminal,upload:Upload,
  extractText:Braces,extractPattern:Search,clipboard:Copy,
  wait:Clock,waitNewFirst:Clock,captureListSnapshot:List,waitNewListItem:Clock,assert:CheckCircle2,
  download:Download,savePagePdf:FileDown,manual:Shield,condition:GitBranch,loop:Repeat2
};
function StepIcon({kind}:{kind:string}){const Icon=kindIcons[kind]??Workflow;return <span className={`action-icon kind-${kind}`}><Icon size={17}/></span>;}
function selectStep(id:string){runtimeSdk.select(id);}
function openStepSettings(id:string){runtimeSdk.select(id);useStudio.getState().setSheet(true);}
function StepActions({step}:{step:Step}){return <div className="modern-step-actions nodrag nopan" onClick={e=>e.stopPropagation()}>{[['run-single',Play,'只執行此步驟'],['run-from',SkipForward,'從此步驟執行'],['duplicate',Copy,'複製步驟'],['toggle',Power,step.enabled?'停用':'啟用'],['delete',Trash2,'刪除步驟']].map(([action,Icon,label])=>{const I=Icon as typeof Play;return <Button key={String(action)} size="icon" variant={action==='delete'?'danger':'ghost'} title={String(label)} aria-label={String(label)} disabled={(action==='run-single'||action==='run-from')&&!step.enabled} onClick={()=>{runtimeSdk.action(step.id,String(action));if(action==='delete')queueMicrotask(()=>useStudio.getState().setSheet(false));}}><I size={15}/></Button>;})}</div>;}
function InsertMenu({owner=null,branch='steps',index}:{owner?:string|null;branch?:string;index:number}){
  const [open,setOpen]=useState(false);
  const [query,setQuery]=useState('');
  useEffect(()=>{if(!open)setQuery('');},[open]);
  const kinds=Array.from(document.querySelectorAll<HTMLButtonElement>('#stepPalette [data-kind]')).map(button=>button.dataset.kind!);
  const normalized=query.trim().toLowerCase();
  const filtered=normalized?kinds.filter(kind=>`${runtimeSdk.kindLabel(kind)} ${kind}`.toLowerCase().includes(normalized)):kinds;
  return <><Button variant="ghost" size="sm" className="insert-button nodrag nopan" aria-label="在此插入動作" title="在此插入動作" onClick={()=>setOpen(true)}><Plus size={14}/></Button><Dialog open={open} onOpenChange={setOpen} title="插入動作" description="新步驟會插入您選取的位置，保留原有流程順序。"><div className="insert-search"><Search size={15}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜尋動作元件…" aria-label="搜尋要插入的動作元件"/></div><div className="insert-options">{filtered.map(kind=><button key={kind} onClick={()=>{try{runtimeSdk.insert(kind,owner,branch,index);setOpen(false);useStudio.getState().setSheet(true);}catch(error){runtimeSdk.toast(String(error),true);}}}><StepIcon kind={kind}/>{runtimeSdk.kindLabel(kind)}</button>)}</div></Dialog></>;
}
function nestedStepCount(steps:Step[]):number{return steps.reduce((count,step)=>count+1+(step.kind==='condition'?nestedStepCount(step.thenSteps??[])+nestedStepCount(step.elseSteps??[]):step.kind==='loop'?nestedStepCount(step.steps??[]):0),0);}
// UI-only expansion preferences; deliberately kept outside exported workflow JSON.
const COLLAPSE_PREFIX='automation-studio:branch-collapsed:v1:';
function collapseKey(projectId:string,stepId:string,branch:string){return `${COLLAPSE_PREFIX}${encodeURIComponent(projectId)}:${encodeURIComponent(stepId)}:${branch}`;}
function readCollapse(key:string){try{return window.localStorage.getItem(key)==='1';}catch{return false;}}
function writeCollapse(key:string,value:boolean){try{if(value)window.localStorage.setItem(key,'1');else window.localStorage.removeItem(key);}catch{/* Private browsing / storage disabled: retain in-memory state. */}}
function collectStepIds(steps:Step[],ids:Set<string>){for(const step of steps){ids.add(step.id);if(step.thenSteps)collectStepIds(step.thenSteps,ids);if(step.elseSteps)collectStepIds(step.elseSteps,ids);if(step.steps)collectStepIds(step.steps,ids);}}
function removeDeletedBranchPreferences(projectId:string,steps:Step[]){
  if(!projectId)return;
  try{
    const ids=new Set<string>();collectStepIds(steps,ids);
    const prefix=`${COLLAPSE_PREFIX}${encodeURIComponent(projectId)}:`;
    for(let i=window.localStorage.length-1;i>=0;i--){
      const key=window.localStorage.key(i);
      if(!key?.startsWith(prefix))continue;
      const rest=key.slice(prefix.length),lastColon=rest.lastIndexOf(':');
      if(lastColon<0)continue;
      let id:string;try{id=decodeURIComponent(rest.slice(0,lastColon));}catch{continue;}
      if(!ids.has(id))window.localStorage.removeItem(key);
    }
  }catch{/* Storage may be unavailable. */}
}
function ConditionBranch({step,branch,label,variant,depth}:{step:Step;branch:'thenSteps'|'elseSteps';label:string;variant:'true'|'false';depth:number}){
  const projectId=useStudio(s=>s.snapshot.state.project?.id??'');
  const preferenceKey=collapseKey(projectId,step.id,branch);
  const [savedState,setSavedState]=useState(()=>({key:preferenceKey,collapsed:readCollapse(preferenceKey)}));
  const collapsed=savedState.key===preferenceKey?savedState.collapsed:readCollapse(preferenceKey);
  const toggleCollapsed=()=>{const next=!collapsed;writeCollapse(preferenceKey,next);setSavedState({key:preferenceKey,collapsed:next});};
  const steps=branch==='thenSteps'?(step.thenSteps??[]):(step.elseSteps??[]);
  const regionId=`${step.id}-${branch}-content`;
  const countLabel=`${nestedStepCount(steps)} 個步驟`;
  return <section className={collapsed?'is-collapsed':''}><button type="button" className={`branch-label branch-toggle ${variant}`} aria-controls={regionId} aria-expanded={!collapsed} aria-label={`${collapsed?'展開':'收合'}${label}分支，${countLabel}`} onClick={toggleCollapsed}><ChevronDown size={14} aria-hidden="true"/><span>{label}</span><span className="branch-count">{countLabel}</span></button><div id={regionId} className="branch-content" hidden={collapsed}><StepSequence steps={steps} owner={step.id} branch={branch} depth={depth}/></div></section>;
}
function stepDropMode(event:React.DragEvent<HTMLElement>):StepDropMode {
  const rect=event.currentTarget.getBoundingClientRect();
  const ratio=(event.clientY-rect.top)/rect.height;
  return ratio<.3?'before':ratio>.7?'after':'swap';
}
function StepSequence({steps,owner=null,branch='steps',depth=0}:{steps:Step[];owner?:string|null;branch?:string;depth?:number}){
  const selected=useStudio(s=>s.snapshot.state.selectedStepId);
  const dragged=useRef<string|null>(null);
  const [dragReady,setDragReady]=useState<string|null>(null);
  const [dropHint,setDropHint]=useState<{id:string;mode:StepDropMode}|null>(null);
  const suppressClickUntil=useRef(0);
  const dragReadyRef=useRef<string|null>(null);
  const pointerStart=useRef<{x:number;y:number}|null>(null);
  const dragTimer=useRef<number|null>(null);
  const clearDragArm=useCallback(()=>{
    if(dragTimer.current!==null)window.clearTimeout(dragTimer.current);
    dragTimer.current=null;
    dragReadyRef.current=null;
    pointerStart.current=null;
    setDragReady(null);
    setDropHint(null);
  },[]);
  useEffect(()=>{
    const cancelOnMove=(event:PointerEvent)=>{
      const start=pointerStart.current;
      if(!start||dragReadyRef.current||Math.hypot(event.clientX-start.x,event.clientY-start.y)<8)return;
      clearDragArm();
    };
    window.addEventListener('pointermove',cancelOnMove);
    window.addEventListener('pointerup',clearDragArm);
    window.addEventListener('pointercancel',clearDragArm);
    window.addEventListener('blur',clearDragArm);
    return()=>{
      window.removeEventListener('pointermove',cancelOnMove);
      window.removeEventListener('pointerup',clearDragArm);
      window.removeEventListener('pointercancel',clearDragArm);
      window.removeEventListener('blur',clearDragArm);
    };
  },[clearDragArm]);
  return <div className="step-sequence" style={{'--depth':depth} as React.CSSProperties}><div className="insert-slot"><InsertMenu owner={owner} branch={branch} index={0}/></div>{steps.map((step,i)=><div key={step.id}><article tabIndex={0} draggable title="單擊選取（設定面板開啟時直接切換設定），雙擊開啟步驟設定；按住後拖曳：上緣插入前方、中央交換、下緣插入後方" data-modern-step={step.id} className={`modern-step ${selected===step.id?'selected':''} ${step.enabled?'':'disabled'} ${dragReady===step.id?'drag-ready':''} ${dropHint?.id===step.id?'drop-'+dropHint.mode:''}`} onPointerDown={e=>{
    if(e.button!==0||(e.target as HTMLElement).closest('button,a,input,select,textarea'))return;
    if(dragTimer.current!==null)window.clearTimeout(dragTimer.current);
    setDragReady(null);
    dragReadyRef.current=null;
    pointerStart.current={x:e.clientX,y:e.clientY};
    dragTimer.current=window.setTimeout(()=>{dragTimer.current=null;dragReadyRef.current=step.id;setDragReady(step.id);},420);
  }} onClick={()=>{if(Date.now()>=suppressClickUntil.current)selectStep(step.id);}} onDoubleClick={()=>{if(Date.now()>=suppressClickUntil.current)openStepSettings(step.id);}} onKeyDown={e=>{if(e.target!==e.currentTarget)return;if(e.key==='Enter'){e.stopPropagation();openStepSettings(step.id);}if(e.altKey&&['ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();e.stopPropagation();runtimeSdk.move(step.id,e.key==='ArrowUp'?-1:1);}}} onDragStart={e=>{
    if(dragReadyRef.current!==step.id){e.preventDefault();clearDragArm();return;}
    dragged.current=step.id;
    e.dataTransfer.effectAllowed='move';
    e.dataTransfer.setData('text/plain',step.id);
  }} onDragEnd={()=>{suppressClickUntil.current=Date.now()+350;dragged.current=null;clearDragArm();}} onDragOver={e=>{if(!dragged.current||dragged.current===step.id)return;e.preventDefault();e.dataTransfer.dropEffect='move';setDropHint({id:step.id,mode:stepDropMode(e)});}} onDragLeave={e=>{if(!(e.relatedTarget instanceof window.Node&&e.currentTarget.contains(e.relatedTarget)))setDropHint(null);}} onDrop={e=>{e.preventDefault();const id=dragged.current;if(!id)return;runtimeSdk.reorder(id,step.id,stepDropMode(e));suppressClickUntil.current=Date.now()+350;dragged.current=null;clearDragArm();}}><span className="mono step-number">{String(i+1).padStart(2,'0')}</span><StepIcon kind={step.kind}/><div className="step-title"><b>{step.name}</b><span>{runtimeSdk.kindLabel(step.kind)}{!step.enabled?' · 已停用':''}</span></div>{dropHint?.id===step.id&&<span className="step-drop-hint">{dropHint.mode==='before'?'插入此步驟前方':dropHint.mode==='after'?'插入此步驟後方':'交換兩個步驟的位置'}</span>}<StepActions step={step}/><div className="step-order"><Button size="icon" variant="ghost" aria-label="上移" disabled={i===0} onClick={e=>{e.stopPropagation();runtimeSdk.move(step.id,-1);}}><ArrowUp size={14}/></Button><Button size="icon" variant="ghost" aria-label="下移" disabled={i===steps.length-1} onClick={e=>{e.stopPropagation();runtimeSdk.move(step.id,1);}}><ArrowDown size={14}/></Button></div></article>{step.kind==='condition'&&<div className="modern-branches"><ConditionBranch step={step} branch="thenSteps" label="True · 條件成立" variant="true" depth={depth+1}/><ConditionBranch step={step} branch="elseSteps" label="False · 條件不成立" variant="false" depth={depth+1}/></div>}{step.kind==='loop'&&<div className="modern-loop"><span className="branch-label"><Repeat2 size={14}/> 每次迴圈</span><StepSequence steps={step.steps??[]} owner={step.id} branch="steps" depth={depth+1}/></div>}<div className="insert-slot"><InsertMenu owner={owner} branch={branch} index={i+1}/></div></div>)}</div>;
}
function StepNode({data,selected}:NodeProps){const step=data.step as Step;return <div className={`flow-step ${selected?'selected':''} ${step.enabled?'':'disabled'} ${step.kind==='condition'?'diamond-node':''}`}><Handle type="target" position={Position.Top} isConnectable={false}/>{step.kind==='condition'?<div className="condition-diamond"><div><GitBranch size={20}/><b>{step.name}</b></div></div>:<div className="flow-node-title"><StepIcon kind={step.kind}/><b>{step.name}</b></div>}<span className="flow-node-kind">{runtimeSdk.kindLabel(step.kind)}{!step.enabled?' · 已停用':''}</span><StepActions step={step}/>{step.kind==='condition'?<><Handle id="true" type="source" position={Position.Bottom} style={{left:'25%'}} isConnectable={false}/><Handle id="false" type="source" position={Position.Bottom} style={{left:'75%'}} isConnectable={false}/></>:step.kind==='loop'?<><Handle id="body" type="source" position={Position.Right} isConnectable={false}/><Handle id="done" type="source" position={Position.Bottom} isConnectable={false}/></>:<Handle id="out" type="source" position={Position.Bottom} isConnectable={false}/>}</div>;}
function AnchorNode({data}:NodeProps){return <div className="flow-anchor"><Handle type="target" position={Position.Top} isConnectable={false}/>{String(data.label)}<Handle type="source" position={Position.Bottom} isConnectable={false}/></div>;}
function InsertEdge(props:EdgeProps){const [path,x,y]=getBezierPath(props);const d=props.data as {owner:string|null;branch:string;index:number}|undefined;return <><BaseEdge path={path} markerEnd={props.markerEnd} style={props.label==='False'?{stroke:'var(--danger)'}:props.label==='True'?{stroke:'var(--accent)'}:undefined}/><EdgeLabelRenderer><div className="flow-edge-label nodrag nopan" data-owner={d?.owner??'root'} data-branch={d?.branch} data-index={d?.index} style={{transform:`translate(-50%,-50%) translate(${x}px,${y}px)`}}>{props.label&&<span>{String(props.label)}</span>}{d&&<InsertMenu {...d}/>}</div></EdgeLabelRenderer></>;}
const nodeTypes={step:StepNode,anchor:AnchorNode},edgeTypes={insert:InsertEdge};
function FlowCanvas(){const {snapshot}=useStudio();const graph=useMemo(()=>buildGraph(snapshot.state.project?.steps??[]),[snapshot.revision]);const [nodes,setNodes]=useState<Node[]>(graph.nodes as Node[]);const positions=useRef<Record<string,{x:number;y:number}>>({});const canvasRef=useRef<HTMLDivElement>(null);const [fullscreen,setFullscreen]=useState(false);const projectId=snapshot.state.project?.id;
  useEffect(()=>{positions.current={};},[projectId]);
  useEffect(()=>setNodes(graph.nodes.map(n=>({...n,selected:n.id===snapshot.state.selectedStepId,position:positions.current[n.id]??n.position})) as Node[]),[graph,snapshot.state.selectedStepId]);
  useEffect(()=>{const sync=()=>setFullscreen(document.fullscreenElement===canvasRef.current);document.addEventListener('fullscreenchange',sync);sync();return()=>document.removeEventListener('fullscreenchange',sync);},[]);
  const toggleFullscreen=async()=>{const canvas=canvasRef.current;if(!canvas)return;try{if(document.fullscreenElement===canvas)await document.exitFullscreen();else await canvas.requestFullscreen();}catch{runtimeSdk.toast('無法切換全螢幕檢視，請確認瀏覽器允許全螢幕功能。',true);}};
  const change=(changes:NodeChange[])=>{setNodes(ns=>applyNodeChanges(changes,ns));for(const c of changes)if(c.type==='position'&&c.position)positions.current[c.id]=c.position;};
  return <div ref={canvasRef} className="flow-container"><Button size="sm" variant="secondary" className="canvas-fullscreen-toggle nodrag nopan" onClick={toggleFullscreen} aria-label={fullscreen?'退出全螢幕檢視':'全螢幕檢視'} title={fullscreen?'退出全螢幕檢視':'全螢幕檢視'}>{fullscreen?<Minimize2 size={15}/>:<Maximize2 size={15}/>}<span>{fullscreen?'退出全螢幕':'全螢幕'}</span></Button><ReactFlow nodes={nodes} edges={graph.edges} onNodesChange={change} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodeClick={(_,n)=>{if(n.type==='step')selectStep(n.id);}} onPaneClick={()=>useStudio.getState().setSheet(false)} onNodeDoubleClick={(_,n)=>{if(n.type==='step')openStepSettings(n.id);}} fitView fitViewOptions={{padding:.2}} minZoom={.15} maxZoom={1.8} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null} colorMode={snapshot.theme==='dark'?'dark':'light'} aria-label="流程畫布"><Background gap={22} size={1}/><Controls showInteractive={false}/><MiniMap pannable zoomable nodeColor={()=>snapshot.theme==='dark'?'#475569':'#cbd5e1'}/></ReactFlow></div>;
}
type StepHistoryFrame={projectId:string;steps:Step[];selectedStepId:string;signature:string};
export function Designer(){
  const {snapshot,mode,setMode,setSheet,sheet}=useStudio();
  const [undoCount,setUndoCount]=useState(0);
  const undoHistory=useRef<StepHistoryFrame[]>([]);
  const lastStepState=useRef<StepHistoryFrame|null>(null);
  const skipUndoCapture=useRef(false);
  useEffect(()=>{
    const projectId=snapshot.state.project?.id??'';
    const steps=structuredClone(snapshot.state.project?.steps??[]);
    const current={projectId,steps,selectedStepId:snapshot.state.selectedStepId??'',signature:JSON.stringify(steps)};
    const previous=lastStepState.current;
    if(!previous||previous.projectId!==projectId){undoHistory.current=[];setUndoCount(0);}
    else if(previous.signature!==current.signature){
      if(skipUndoCapture.current)skipUndoCapture.current=false;
      else{undoHistory.current.push(previous);if(undoHistory.current.length>50)undoHistory.current.shift();setUndoCount(undoHistory.current.length);}
    }
    lastStepState.current=current;
  },[snapshot.revision,snapshot.state.project?.id]);
  const undo=()=>{
    const previous=undoHistory.current.pop();
    if(!previous||previous.projectId!==snapshot.state.project?.id)return;
    skipUndoCapture.current=true;
    if(!runtimeSdk.restoreSteps(previous.steps,previous.selectedStepId)){
      skipUndoCapture.current=false;undoHistory.current.push(previous);return;
    }
    setUndoCount(undoHistory.current.length);
    queueMicrotask(()=>useStudio.getState().setSheet(false));
    runtimeSdk.toast('已復原上一個步驟變更');
  };
  useEffect(()=>{
    const project=snapshot.state.project;
    if(project)removeDeletedBranchPreferences(project.id,project.steps);
  },[snapshot.state.project?.id,snapshot.revision]);
  const selectedStep=runtimeSdk.selected();
  return <><div className="modern-designer-toolbar"><div className="designer-toolbar-left"><div className="segmented"><Button variant={mode==='list'?'secondary':'ghost'} size="sm" onClick={()=>setMode('list')}><List size={15}/>階層清單</Button><Button variant={mode==='canvas'?'secondary':'ghost'} size="sm" onClick={()=>setMode('canvas')}><Workflow size={15}/>視覺畫布</Button></div><Button size="sm" variant="ghost" title="復原最近一次步驟變更" aria-label="復原最近一次步驟變更" disabled={!undoCount} onClick={undo}><Undo2 size={15}/>復原</Button>{selectedStep&&<span className="designer-selected-pill"><span className="mono">{selectedStep.name}</span><small>{runtimeSdk.kindLabel(selectedStep.kind)}</small></span>}</div><Button size="sm" variant={sheet?'primary':'secondary'} disabled={!snapshot.state.selectedStepId} onClick={()=>setSheet(!sheet)}><Settings2 size={15}/>步驟設定</Button></div>{!snapshot.state.project?<div className="modern-empty">建立或選取專案，即可開始設計。</div>:mode==='canvas'?<FlowCanvas/>:<div className="modern-list" onClick={e=>{const target=e.target as HTMLElement;if(!target.closest('[data-modern-step],.modern-branches,.modern-loop,.insert-slot,button,a,input,select,textarea,[role="dialog"]'))setSheet(false);}}><div className="workflow-boundary">開始</div><StepSequence steps={snapshot.state.project.steps}/><div className="workflow-boundary">完成</div></div>}</>;
}
export function PropertySheet(){const {sheet,setSheet,snapshot}=useStudio();const original=useRef<Element|null>(null);const placeholder=useRef<Element|null>(null);
  const isOpen=sheet&&snapshot.view==='designer';
  useEffect(()=>{
    document.documentElement.classList.toggle('designer-sheet-open',isOpen);
    return()=>document.documentElement.classList.remove('designer-sheet-open');
  },[isOpen]);
  const attach=useCallback((node:HTMLDivElement|null)=>{if(node){const pane=document.querySelector('.properties-pane');if(!pane)return;const anchor=document.createElement('div');pane.before(anchor);original.current=pane;placeholder.current=anchor;node.append(pane);}else if(original.current&&placeholder.current){placeholder.current.replaceWith(original.current);original.current=null;placeholder.current=null;}},[]);
  const current=runtimeSdk.selected();
  return <Dialog open={isOpen} onOpenChange={setSheet} sheet title="步驟設定" description={current?`${current.name} · ${runtimeSdk.kindLabel(current.kind)}`:'選取步驟後編輯'}><div ref={attach} className="property-mount"/></Dialog>;
}
