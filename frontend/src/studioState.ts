import {create} from 'zustand';
import type {Bridge,Snapshot} from './bridge';

export function createStudioStore(adapter:Pick<Bridge,'snapshot'>,storage:Pick<Storage,'getItem'|'setItem'>){
  const initial=adapter.snapshot();
  let lastProject=initial.state.project?.id;
  return create<{snapshot:Snapshot;mode:'list'|'canvas';sheet:boolean;command:boolean;setMode:(mode:'list'|'canvas')=>void;setSheet:(sheet:boolean)=>void;setCommand:(command:boolean)=>void;refresh:()=>void}>((set)=>({
    snapshot:initial,mode:storage.getItem('studio-designer-view')==='canvas'?'canvas':'list',sheet:false,command:false,
    setMode:mode=>{storage.setItem('studio-designer-view',mode);set({mode});},
    setSheet:sheet=>set({sheet}),setCommand:command=>set({command}),
    refresh:()=>{
      const next=adapter.snapshot();
      const projectChanged=next.state.project?.id!==lastProject;
      lastProject=next.state.project?.id;
      // Selection updates must never imply opening settings. Only explicit edit actions do.
      set({snapshot:{...next},...(projectChanged?{sheet:false}:{})});
    }
  }));
}
