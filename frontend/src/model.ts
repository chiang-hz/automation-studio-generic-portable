export interface Step { id: string; name: string; kind: string; enabled: boolean; pdfFileName?: string; pdfPageSize?: 'A4'|'Letter'; pdfOrientation?: 'portrait'|'landscape'; pdfPrintBackground?: boolean; pdfMarginTopMm?: number; pdfMarginRightMm?: number; pdfMarginBottomMm?: number; pdfMarginLeftMm?: number; pdfDisplayHeaderFooter?: boolean; pdfHeaderTemplate?: string; pdfFooterTemplate?: string; pdfScale?: number; pdfFullPage?: boolean; pdfUseLocalTime?: boolean; thenSteps?: Step[]; elseSteps?: Step[]; steps?: Step[]; [key: string]: unknown }
export interface Parameter { id: string; name: string; label: string; type: string; required: boolean; sensitive?: boolean; defaultValue?: string|boolean; options?: string[]; dependsOn?: string; dependentOptions?: Record<string,string[]> }
export interface BatchRow { id: string; enabled: boolean; parameters: Record<string,string|boolean> }
export interface Project { id: string; name: string; description?: string; targetUrl: string; status?: string; allowedDomains?: string[]; steps: Step[]; parameters: Parameter[]; [key: string]: unknown }
export interface GraphNode { id: string; type: string; position: {x:number;y:number}; data: Record<string,unknown> }
export interface GraphEdge { id:string; source:string; target:string; label?:string; sourceHandle?:string; type:string; data?:Record<string,unknown> }
export type StepDropMode='before'|'after'|'swap';
export function reorderWorkflowSteps(steps:Step[],sourceId:string,targetId:string,mode:StepDropMode):Step[]|null{
  if(sourceId===targetId)return null;
  const result=structuredClone(steps);
  const locate=(list:Step[],id:string):{list:Step[];index:number}|null=>{
    for(let index=0;index<list.length;index++){
      const step=list[index];
      if(step.id===id)return{list,index};
      for(const children of [step.thenSteps,step.elseSteps,step.steps]){
        if(children){const found=locate(children,id);if(found)return found;}
      }
    }
    return null;
  };
  const source=locate(result,sourceId),target=locate(result,targetId);
  if(!source||!target||source.list!==target.list)return null;
  const list=source.list;
  if(mode==='swap') [list[source.index],list[target.index]]=[list[target.index],list[source.index]];
  else {
    const [moving]=list.splice(source.index,1);
    const index=list.findIndex(step=>step.id===targetId)+(mode==='after'?1:0);
    list.splice(index,0,moving);
  }
  return result;
}
export function flattenSteps(steps: Step[], depth=0): Array<{step:Step;depth:number}> {
  return steps.flatMap(step => [{step,depth}, ...flattenSteps(step.thenSteps ?? [],depth+1), ...flattenSteps(step.elseSteps ?? [],depth+1), ...flattenSteps(step.steps ?? [],depth+1)]);
}
// Graph is a projection of the workflow tree. Junctions and loop anchors are UI-only.
// No graph metadata is ever written into the workflow or its exports.
export function buildGraph(steps: Step[]) {
  const nodes: GraphNode[] = [], edges: GraphEdge[] = [];
  const node = (id:string,type:string,x:number,y:number,data:Record<string,unknown>) => nodes.push({id,type,position:{x,y},data});
  const edge = (a:string,b:string,label?:string,handle?:string,data?:Record<string,unknown>) => edges.push({id:`edge-${edges.length}`,source:a,target:b,label,sourceHandle:handle,type:'insert',data});
  const width = (list:Step[]):number => Math.max(1,...list.map(s=>s.kind==='condition'?width(s.thenSteps??[])+width(s.elseSteps??[]):s.kind==='loop'?1+width(s.steps??[]):1));
  function sequence(list:Step[],x:number,y:number,prev:string,owner:string|null,branch:string,label?:string,handle?:string): {tail:string;y:number} {
    let tail=prev, currentY=y, first=true;
    for(let i=0;i<list.length;i++) {
      const s=list[i]; node(s.id,'step',x,currentY,{step:s});
      edge(tail,s.id,first?label:undefined,first?handle:undefined,{owner,branch,index:i}); first=false;
      tail=s.id; currentY+=160;
      if(s.kind==='condition') {
        const leftW=width(s.thenSteps??[]),rightW=width(s.elseSteps??[]);
        const leftX=x-rightW*170,rightX=x+leftW*170;
        const yes=sequence(s.thenSteps??[],leftX,currentY,s.id,s.id,'thenSteps','True','true');
        const no=sequence(s.elseSteps??[],rightX,currentY,s.id,s.id,'elseSteps','False','false');
        const join=`ui-join-${s.id}`; const joinY=Math.max(yes.y,no.y)+30;
        node(join,'anchor',x,joinY,{label:'分支匯合'});
        edge(yes.tail,join,s.thenSteps?.length?undefined:'True',s.thenSteps?.length?undefined:'true',{owner:s.id,branch:'thenSteps',index:s.thenSteps?.length??0});
        edge(no.tail,join,s.elseSteps?.length?undefined:'False',s.elseSteps?.length?undefined:'false',{owner:s.id,branch:'elseSteps',index:s.elseSteps?.length??0});
        tail=join;currentY=joinY+110;
      } else if(s.kind==='loop') {
        const body=sequence(s.steps??[],x+340,currentY,s.id,s.id,'steps','每次迴圈','body');
        if(s.steps?.length) edge(body.tail,s.id,'下一次','out');
        const exit=`ui-exit-${s.id}`;node(exit,'anchor',x,body.y+30,{label:'迴圈完成'});
        edge(s.id,exit,'完成','done');
        if(!s.steps?.length) {const empty=`ui-empty-${s.id}`;node(empty,'anchor',x+340,currentY,{label:'新增迴圈步驟'});edge(s.id,empty,'每次迴圈','body',{owner:s.id,branch:'steps',index:0});}
        tail=exit;currentY=body.y+140;
      }
    }
    return {tail,y:currentY};
  }
  node('ui-start','anchor',0,0,{label:'開始'});
  const result=sequence(steps,0,110,'ui-start',null,'steps');
  node('ui-end','anchor',0,result.y,{label:'完成'});
  edge(result.tail,'ui-end',undefined,undefined,{owner:null,branch:'steps',index:steps.length});
  return {nodes,edges};
}
export function allowedOptions(p:Parameter,values:Record<string,string|boolean>):string[] {
  const mapped=p.dependsOn?p.dependentOptions?.[String(values[p.dependsOn]??'')]:undefined;
  return mapped?.length?[...mapped]:[...(p.options??[])];
}
export function quickRunParameters(project:Project):Record<string,string|boolean> {
  const values=Object.fromEntries((project.parameters??[]).map(parameter=>{
    if(parameter.sensitive||parameter.type==='secret')return [parameter.name,''];
    if(parameter.type==='boolean')return [parameter.name,parameter.defaultValue===true||String(parameter.defaultValue).toLowerCase()==='true'];
    return [parameter.name,parameter.defaultValue??''];
  })) as Record<string,string|boolean>;
  for(const parameter of project.parameters??[]){
    if(parameter.type!=='select')continue;
    const parentValue=parameter.dependsOn?String(values[parameter.dependsOn]??''):'';
    const mapped=parameter.dependsOn?parameter.dependentOptions?.[parentValue]:undefined;
    const options=Array.isArray(mapped)&&mapped.length?mapped:parameter.options??[];
    if(!options.some(option=>String(option)===String(values[parameter.name])))values[parameter.name]=options[0]??values[parameter.name]??'';
  }
  return values;
}
function normalizeDomainEntry(value:unknown):string {
  const raw=String(value??'').trim().toLowerCase();
  if(!raw)return '';
  if(raw.startsWith('*.'))return `*.${raw.slice(2).replace(/^\.+|\.+$/g,'')}`;
  try{return new URL(raw.includes('://')?raw:`https://${raw}`).hostname.toLowerCase();}
  catch{return raw.replace(/^\.+|\.+$/g,'');}
}
function domainEntryAllows(host:string,entry:string):boolean {
  const domain=normalizeDomainEntry(entry);
  return domain.startsWith('*.')?host!==domain.slice(2)&&host.endsWith(`.${domain.slice(2)}`):host===domain;
}
export function projectIsQuickRunnable(project:Project):boolean {
  if(project.status==='archived'||!(project.steps??[]).some(step=>step.enabled))return false;
  const parameters=quickRunParameters(project);
  for(const parameter of project.parameters??[]){
    const value=parameters[parameter.name];
    if(parameter.required&&(value===undefined||value===null||String(value).trim()===''))return false;
  }
  const expand=(value:unknown)=>String(value??'').replace(/{{\s*([^}]+)\s*}}/g,(_match,name:string)=>String(parameters[name.trim()]??''));
  const allowedDomains=project.allowedDomains??[];
  let runnable=true;
  const visit=(steps:Step[]=[]):void=>{
    for(const step of steps){
      if(!step.enabled)continue;
      if(step.kind==='navigate'||step.kind==='newTab'){
        const raw=expand(step.url||step.value||(step.kind==='navigate'?project.targetUrl:''));
        try{const url=new URL(raw);if(!/^https?:$/.test(url.protocol)||allowedDomains.length&&!allowedDomains.some(entry=>domainEntryAllows(url.hostname.toLowerCase(),entry))){runnable=false;return;}}
        catch{runnable=false;return;}
      }
      visit(step.thenSteps??[]);if(!runnable)return;
      visit(step.elseSteps??[]);if(!runnable)return;
      visit(step.steps??[]);if(!runnable)return;
    }
  };
  visit(project.steps??[]);
  return runnable;
}
export function validateValue(p:Parameter,v:string|boolean,values:Record<string,string|boolean>):string|null {
  if(p.required && String(v).trim()==='') return `${p.label}必填`;
  if(String(v)==='') return null;
  if(p.type==='select'&&!allowedOptions(p,values).includes(String(v))) return `${p.label}不在目前允許選項中`;
  if(p.type==='number'&&!Number.isFinite(Number(v))) return `${p.label}須為有效數字`;
  if(p.type==='boolean'&&![true,false,'true','false'].includes(v)) return `${p.label}須為 true 或 false`;
  if(p.type==='date') {const s=String(v);const d=new Date(s+'T00:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==s)return `${p.label}須為有效日期 YYYY-MM-DD`;}
  return null;
}
export function validateRow(parameters:Parameter[],values:Record<string,string|boolean>) {
  return parameters.flatMap(p=>{const e=validateValue(p,values[p.name]??'',values);return e?[e]:[];});
}
// All-or-nothing paste. Validate the finished row, so parents pasted in the same
// operation take effect before dependent children are checked.
export function applyGridPatch(rows:BatchRow[],parameters:Parameter[],startRow:number,startCol:number,matrix:string[][],makeRow:()=>BatchRow) {
  const result=structuredClone(rows),errors:string[]=[];
  matrix.forEach((cells,offset)=>{
    const rowIndex=startRow+offset;
    while(result.length<=rowIndex)result.push(makeRow());
    const row=result[rowIndex];
    cells.forEach((v,col)=>{const p=parameters[startCol+col];if(!p){errors.push(`第 ${rowIndex+1} 列超出欄位範圍`);return;}row.parameters[p.name]=p.type==='boolean'&&['true','false'].includes(v.toLowerCase())?v.toLowerCase()==='true':v;});
    for(const e of validateRow(parameters,row.parameters))errors.push(`第 ${rowIndex+1} 列：${e}`);
  });
  return {rows:result,errors};
}
export function parseTSV(text:string):string[][] {
  const rows:string[][]=[],row:string[]= []; let value='',quoted=false;
  for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){value+='"';i++;}else if(quoted||value==='')quoted=!quoted;else value+=c;}else if(c==='\t'&&!quoted){row.push(value);value='';}else if((c==='\r'||c==='\n')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(value);rows.push([...row]);row.length=0;value='';}else value+=c;}
  if(value!==''||row.length){row.push(value);rows.push([...row]);}return rows;
}
export function fieldChanges(before:Step|undefined,after:Step|undefined) {
  const keys=[...new Set([...Object.keys(before??{}),...Object.keys(after??{})])].filter(k=>!['steps','thenSteps','elseSteps','id'].includes(k));
  return keys.filter(k=>JSON.stringify(before?.[k])!==JSON.stringify(after?.[k])).map(key=>({key,before:before?.[key],after:after?.[key]}));
}
