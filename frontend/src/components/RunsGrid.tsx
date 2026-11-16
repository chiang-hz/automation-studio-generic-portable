import {useEffect,useMemo,useRef,useState} from 'react';import {useReactTable,getCoreRowModel,flexRender,type ColumnDef} from '@tanstack/react-table';import {useVirtualizer} from '@tanstack/react-virtual';import {Search,ArrowUpDown,FileArchive,Info,Trash2,Play,CheckCircle2,XCircle,LoaderCircle,Clock,Pause,Ban} from 'lucide-react';import { runtimeSdk } from '../sdk/runtimeSdk';import {useStudio} from '../store';import {Button} from './ui/button';import {Dialog} from './ui/dialog';
const labels:Record<string,string>={completed:'完成',failed:'失敗',cancelled:'已取消',running:'執行中',queued:'等待中',paused:'等待人工操作'};
const modeLabels:Record<string,string>={full:'完整流程','single-step':'單步','from-step':'從此步驟',batch:'批次'};
const debugTabs=[['log','執行日誌'],['console','Console'],['network','Network'],['popup','Popup / Download'],['variables','變數']] as const;
function StatusGlyph({status}:{status:string}){
  if(status==='completed')return <CheckCircle2 size={15} aria-hidden="true"/>;
  if(status==='failed')return <XCircle size={15} aria-hidden="true"/>;
  if(status==='running')return <LoaderCircle size={15} className="spin" aria-hidden="true"/>;
  if(status==='paused')return <Pause size={15} aria-hidden="true"/>;
  if(status==='cancelled')return <Ban size={15} aria-hidden="true"/>;
  return <Clock size={15} aria-hidden="true"/>;
}
function formatDateText(iso?:string){
  if(!iso)return '—';
  const d=new Date(iso);
  return Number.isNaN(d.getTime())?iso:d.toLocaleString('zh-TW',{hour12:false});
}
function formatDurationText(start?:string,end?:string){
  if(!start||!end)return '—';
  const ms=new Date(end).getTime()-new Date(start).getTime();
  if(!Number.isFinite(ms)||ms<0)return '—';
  return ms<1000?`${ms} ms`:`${(ms/1000).toFixed(2)} s`;
}
function fileBaseName(filePath:string){
  return filePath.split(/[\\/]/).pop()||filePath;
}
function RunHistoryDetailPanel({run,debug,onClose}:{run:any;debug:any;onClose:()=>void}){
  const [tab,setTab]=useState<string>('log');
  useEffect(()=>{setTab('log');},[run?.id]);
  if(!run)return <div className="run-history-loading"><LoaderCircle size={16} className="spin" aria-hidden="true"/><span>正在載入執行詳情…</span></div>;
  const downloads:string[]=run.downloads??debug?.downloads??[];
  const steps:any[]=run.steps??[];
  const debugText=runtimeSdk.historyDebugText(tab);
  return <section className="run-history-details" data-run-detail={run.id}>
    <div className="section-heading run-history-heading"><div><h3>{run.projectName} · 執行詳情</h3><p>{run.id} · 開始 {formatDateText(run.startedAt)}{run.endedAt?` · 結束 ${formatDateText(run.endedAt)}`:''}</p></div><button className="icon-button run-detail-close" data-run-detail-close type="button" aria-label="收合執行詳情" onClick={onClose}>⌃</button></div>
    <div className="run-detail-grid">
      <div className="run-detail-item"><span>狀態</span><div className={`run-detail-status ${run.status}`}><span className={`status-icon ${run.status}`} aria-hidden="true"><StatusGlyph status={run.status}/></span><b>{labels[run.status]??run.status}</b></div></div>
      <div className="run-detail-item"><span>執行模式</span><b>{modeLabels[run.mode]??run.mode}{run.batchWorker?` #${run.batchWorker}`:''}</b></div>
      <div className="run-detail-item"><span>完成進度</span><b>{run.completedSteps} / {run.totalSteps}</b></div>
      <div className="run-detail-item"><span>執行時間</span><b>{formatDurationText(run.startedAt,run.endedAt??run.updatedAt)}</b></div>
    </div>
    <div className="run-history-columns">
      <section><div className="mini-heading"><b>步驟執行結果</b><small>{steps.length} 筆</small></div><div className="step-results run-history-steps">{steps.length?steps.map((step,i)=><article className={`step-result ${step.status}`} key={`${step.stepId??i}-${i}`}><span className={`status-icon ${step.status}`} aria-hidden="true"><StatusGlyph status={step.status}/></span><div><b>{step.name}</b><small>{step.message??step.kind}{step.attempt&&step.attempt>1?` · 第 ${step.attempt} 次嘗試`:''}</small></div><time>{step.durationMs?`${step.durationMs} ms`:step.status==='running'?'執行中':'—'}</time></article>):<div className="empty-state compact">本次執行尚無步驟結果。</div>}</div></section>
      <section><div className="mini-heading"><b>下載成果</b><small>{downloads.length} 個</small></div><div className="download-results run-history-downloads">{downloads.length?downloads.map((download,index)=><article className="download-result" key={`${download}-${index}`}><div><b title={download}>{fileBaseName(download)}</b><small title={download}>{download}</small></div><div className="download-actions"><Button size="sm" variant="secondary" onClick={async()=>{try{const r=await fetch(`/api/studio/runs/${encodeURIComponent(run.id)}/downloads/${index}/open-file`,{method:'POST'});const data=await r.json();if(!r.ok)throw new Error(data.error||'開啟失敗');runtimeSdk.toast(`已開啟檔案：${fileBaseName(data.filePath??download)}`);}catch(err){runtimeSdk.toast(err instanceof Error?err.message:String(err),true);}}}>開啟檔案</Button><Button size="sm" variant="secondary" onClick={async()=>{try{const r=await fetch(`/api/studio/runs/${encodeURIComponent(run.id)}/downloads/${index}/open-folder`,{method:'POST'});const data=await r.json();if(!r.ok)throw new Error(data.error||'開啟失敗');runtimeSdk.toast(`已開啟資料夾：${data.directory??''}`);}catch(err){runtimeSdk.toast(err instanceof Error?err.message:String(err),true);}}}>開啟資料夾</Button></div></article>):<div className="empty-state compact">本次執行沒有下載成果。</div>}</div></section>
    </div>
    <div className="debug-drawer run-history-debug"><div className="debug-tabs" role="tablist" aria-label="執行除錯分頁">{debugTabs.map(([key,label])=><button key={key} type="button" role="tab" aria-selected={tab===key} className={tab===key?'active':''} onClick={()=>setTab(key)}>{label}</button>)}</div><pre>{debugText}</pre></div>
  </section>;
}
export function RunsGrid(){const {snapshot}=useStudio();const [search,setSearch]=useState('');const [descending,setDescending]=useState(true);const [detail,setDetail]=useState('');const scroll=useRef<HTMLDivElement>(null);const runs=useMemo(()=>runtimeSdk.filteredRuns().filter((r:any)=>[r.projectName,r.errorMessage,r.id].join(' ').toLowerCase().includes(search.toLowerCase())).sort((a:any,b:any)=>(new Date(a.startedAt).getTime()-new Date(b.startedAt).getTime())*(descending?-1:1)),[snapshot.revision,search,descending]);const selected=snapshot.state.selectedRunIds as Set<string>;
  const columns=useMemo<ColumnDef<any>[]>(()=>[{id:'select',header:'選取',cell:({row})=><input aria-label={`選取執行紀錄 ${row.original.id}`} type="checkbox" checked={selected.has(row.original.id)} disabled={!['completed','failed','cancelled'].includes(row.original.status)} onChange={e=>runtimeSdk.selectRun(row.original.id,e.target.checked)}/>,size:56},{id:'time',header:()=> <button type="button" className="sort-button" onClick={()=>setDescending(d=>!d)}>開始時間<ArrowUpDown size={14}/></button>,accessorFn:r=>new Date(r.startedAt).toLocaleString('zh-TW',{hour12:false}),size:195},{id:'project',header:'專案',accessorKey:'projectName',size:230},{id:'mode',header:'模式',accessorFn:r=>modeLabels[r.mode]??r.mode,size:100},{id:'progress',header:'進度',accessorFn:r=>`${r.completedSteps} / ${r.totalSteps}`,size:90},{id:'status',header:'狀態',cell:({row})=><span className={`run-pill ${row.original.status}`}>{labels[row.original.status]??row.original.status}</span>,size:130},{id:'error',header:'錯誤摘要',accessorKey:'errorMessage',cell:({getValue})=><span className="run-error-summary" title={String(getValue()??'')}>{String(getValue()??'—')}</span>,size:240},{id:'actions',header:'操作',cell:({row})=><div className="flex gap-1"><Button size="icon" title="執行詳情" aria-label="執行詳情" onClick={()=>{setDetail(row.original.id);void runtimeSdk.openHistory(row.original.id);}}><Info size={15}/></Button>{row.original.status==='failed'&&<Button size="icon" title="下載失敗診斷包 ZIP" aria-label="下載失敗診斷包 ZIP" onClick={()=>runtimeSdk.runHistoryAction(row.original.id,'diagnostics')}><FileArchive size={15}/></Button>}{row.original.status==='paused'&&<Button size="icon" title="人工操作完成，繼續執行" aria-label="人工操作完成，繼續執行" onClick={()=>runtimeSdk.runHistoryAction(row.original.id,'continue')}><Play size={15}/></Button>}{['completed','failed','cancelled'].includes(row.original.status)&&<Button size="icon" variant="danger" title="刪除此紀錄" aria-label="刪除此紀錄" onClick={()=>runtimeSdk.runHistoryAction(row.original.id,'delete')}><Trash2 size={15}/></Button>}</div>,size:130}], [snapshot.revision]);
  const table=useReactTable({data:runs,columns,autoResetPageIndex:false,getCoreRowModel:getCoreRowModel(),getRowId:r=>r.id});const virtual=useVirtualizer({count:runs.length,getScrollElement:()=>scroll.current,estimateSize:()=>56,overscan:8});const items=virtual.getVirtualItems();
  useEffect(()=>{if(detail&&!snapshot.state.runs.some(r=>r.id===detail))setDetail('');},[snapshot.revision,detail]);
  return <><div className="runs-grid-filter"><Search size={16}/><input aria-label="搜尋執行紀錄" value={search} placeholder="搜尋專案、錯誤或紀錄 ID…" onChange={e=>setSearch(e.target.value)}/><span className="pill">{runs.length} 筆</span></div><div className="grid-scroll runs-modern-scroll" ref={scroll} tabIndex={0} role="region" aria-label="執行紀錄表格"><table className="modern-data-grid" style={{width:table.getTotalSize()}}><caption className="visually-hidden">自動化流程執行紀錄</caption><thead>{table.getHeaderGroups().map(g=><tr key={g.id}>{g.headers.map(h=><th key={h.id} scope="col" style={{width:h.getSize()}}>{flexRender(h.column.columnDef.header,h.getContext())}</th>)}</tr>)}</thead><tbody>{items.length>0&&items[0].start>0&&<tr><td colSpan={8} style={{height:items[0].start,padding:0}}/></tr>}{items.map(v=>{const r=table.getRowModel().rows[v.index];return <tr key={r.id} style={{height:56}}>{r.getVisibleCells().map(c=><td key={c.id}>{flexRender(c.column.columnDef.cell,c.getContext())}</td>)}</tr>;})}{items.length>0&&<tr><td colSpan={8} style={{height:Math.max(0,virtual.getTotalSize()-(items.at(-1)?.end??0)),padding:0}}/></tr>}</tbody></table>{!runs.length&&<div className="modern-empty">沒有符合條件的執行紀錄。</div>}</div><Dialog open={!!detail} onOpenChange={v=>{if(!v){setDetail('');runtimeSdk.closeHistory();}}} title="執行詳情" description={detail}><div className="history-modern-detail"><RunHistoryDetailPanel run={snapshot.state.selectedHistoryRun?.id===detail?snapshot.state.selectedHistoryRun:null} debug={snapshot.state.selectedHistoryDebug} onClose={()=>{setDetail('');runtimeSdk.closeHistory();}}/></div></Dialog></>;
}
