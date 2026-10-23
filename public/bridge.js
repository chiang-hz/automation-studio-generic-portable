/* Compatibility adapter for workflows still owned by the established controller.
 * New React pages use the typed runtime SDK; routes and automation protocols stay stable. */
(() => {
  let pending=false, revision=0, designerRenders=0;
  const publish=()=>{if(pending)return;pending=true;queueMicrotask(()=>{pending=false;revision++;window.dispatchEvent(new CustomEvent('studio:change'));});};
  const wrap=(fn)=>function(...args){const result=fn.apply(this,args);publish();if(result?.finally)result.finally(publish).catch(()=>{});return result;};
  const originalDesigner=renderDesigner;renderDesigner=wrap(function(...args){designerRenders++;return originalDesigner(...args);});renderProject=wrap(renderProject);renderBatch=wrap(renderBatch);
  renderRunHistoryDetails=wrap(renderRunHistoryDetails);renderRunSelectionToolbar=wrap(renderRunSelectionToolbar);renderRun=wrap(renderRun);renderDesignerDebug=wrap(renderDesignerDebug);renderRuns=wrap(renderRuns);
  renderAIWorkflowAssistant=wrap(renderAIWorkflowAssistant);renderAIWorkflowPreview=wrap(renderAIWorkflowPreview);
  renderAIWorkflowConversation=wrap(renderAIWorkflowConversation);renderDebugAIAnalysis=wrap(renderDebugAIAnalysis);
  renderDashboard=wrap(renderDashboard);renderRecorder=wrap(renderRecorder);renderSettings=wrap(renderSettings);saveProject=wrap(saveProject);saveWorkstation=wrap(saveWorkstation);saveSettings=wrap(saveSettings);markDirty=wrap(markDirty);
  showView=wrap(showView);applyTheme=wrap(applyTheme);renderRawJson=wrap(renderRawJson);
  const originalSaveStep=saveStepProperties;
  saveStepProperties=function(){const input=document.getElementById('modernRetryCount');const step=findStepById(state.project?.steps??[],state.selectedStepId);if(!input||!step)return originalSaveStep();const count=Number(input.value);if(!Number.isSafeInteger(count)||count<0||count>99){toast('重試次數須為 0 至 99 的整數。',true);return false;}const previous=step.retryCount;const before=designerRenders;step.retryCount=count;const saved=originalSaveStep();if(designerRenders===before)step.retryCount=previous;return saved;};
  const originalProperties=renderStepProperties;
  renderStepProperties=function(...args){
    const existingBox=document.querySelector('#stepProperties');
    const previousOpen=new Map([...(existingBox?.querySelectorAll('details.property-section')??[])].map(details=>[details.dataset.section,details.open]));
    originalProperties(...args);groupProperties(previousOpen);publish();
  };
  function groupProperties(previousOpen=new Map()){
    const box=document.querySelector('#stepProperties');if(!box||!state.selectedStepId||!box.querySelector('#stepName'))return;
    const sections={basic:[],locator:[],wait:[],advanced:[]};
    const actions=[];
    for(const child of [...box.children]){
      if(child.matches('.action-row,.shortcut-hint')){actions.push(child);continue;}
      const ids=[...child.querySelectorAll('[id]')].map(el=>el.id).join(' ');
      const section=/stepSelectors|componentPath|frameUrl|autoFrameSearch|stepMatch/.test(ids)?'locator':/waitKind|waitValue|verifyKind|stepTimeout/.test(ids)?'wait':/stepEnabled/.test(ids)?'advanced':'basic';
      sections[section].push(child);
    }
    const step=findStepById(state.project?.steps??[],state.selectedStepId);
    const retry=document.createElement('label');retry.className='field';
    const retryLabel=document.createElement('span');retryLabel.textContent='失敗重試次數';
    const retryInput=document.createElement('input');retryInput.id='modernRetryCount';retryInput.type='number';retryInput.min='0';retryInput.max='99';retryInput.value=String(step?.retryCount??1);retry.append(retryLabel,retryInput);sections.wait.push(retry);
    const protection=document.createElement('p');protection.className='field-hint';protection.textContent='Stealth 與瀏覽器模式沿用專案設定；可在「網站與工作站」調整。';sections.advanced.push(protection);
    box.replaceChildren();
    for(const [key,label] of Object.entries({basic:'基本參數',locator:'定位規則',wait:'等待、重試與驗證',advanced:'進階防護'})){
      const details=document.createElement('details');details.className='property-section';details.dataset.section=key;details.open=previousOpen.get(key)??key==='basic';
      const summary=document.createElement('summary');summary.textContent=label;details.append(summary,...sections[key]);box.append(details);
    }
    box.append(...actions);
  }
  const selected=()=>findStepById(state.project?.steps??[],state.selectedStepId);
  window.studioBridge={
    snapshot:()=>({revision,state,view:document.querySelector('.view.active')?.id.replace(/View$/,'')??'dashboard',theme:document.documentElement.dataset.theme??'light'}),
    subscribe(listener){window.addEventListener('studio:change',listener);return()=>window.removeEventListener('studio:change',listener);},
    labels:viewLabels,kindLabel:stepKindWrite,options:parameterAllowedOptions,
    navigate:showView,loadProject,refresh:async()=>{await initialize();publish();},
    setParameters(parameters){if(!state.project)return;state.project.parameters=parameters;ensureParameterIds();syncBatchRowsWithParameters();markDirty();renderParameters();renderTestParameters();renderBatch();publish();},
    patchProject(patch,immediateSave=false){if(!state.project)return;Object.assign(state.project,patch);if(patch.version!==undefined)document.getElementById('projectVersion').value=state.project.version;if(patch.releaseNotes!==undefined)document.getElementById('releaseNotes').value=state.project.releaseNotes;if(patch.status!==undefined)document.getElementById('projectStatus').value=state.project.status;markDirty();renderPublishChecks();if(immediateSave)void saveReleaseFields(true);else if(patch.version!==undefined||patch.releaseNotes!==undefined)scheduleReleaseAutoSave();publish();},
    run:runWorkflow,save:saveProject,toast,
    syncWorkstationDraft(project){if(!state.project||project?.id!==state.project.id)return false;state.project=structuredClone(project);renderProject();markDirty();publish();return true;},
    syncWorkstationFields(project){
      if(!state.project||project?.id!==state.project.id)return false;
      const put=(id,value)=>{const node=document.getElementById(id);if(node)node.value=String(value??'');};
      const check=(id,value)=>{const node=document.getElementById(id);if(node)node.checked=value===true;};
      put('projectName',project.name);put('projectUrl',project.targetUrl);put('allowedDomains',(project.allowedDomains??[]).join('\n'));
      put('browserConnectionMode',project.browser?.connectionMode??'managed');put('browserChannel',project.browser?.channel??'bundled');put('projectAdapter',project.adapter??'generic');
      put('cdpEndpoint',project.browser?.cdpEndpoint??'http://127.0.0.1:9222');put('cdpInitialPageMode',project.browser?.cdpInitialPageMode??'first');put('cdpInitialPageTarget',project.browser?.cdpInitialPageTarget??'');put('cdpInitialPageIndex',project.browser?.cdpInitialPageIndex??1);
      check('cdpAutoLaunch',project.browser?.cdpAutoLaunch!==false);check('stealth',project.browser?.stealth===true);check('reuseProfile',project.browser?.reuseProfile===true);check('downloadPdfInsteadOfPreview',project.browser?.downloadPdfInsteadOfPreview===true);check('headless',project.browser?.headless===true);
      return true;
    },
    async saveWorkstationDraft(project){if(!this.syncWorkstationDraft(project))return false;return await saveWorkstation();},
    async workstationAction(action,payload){
      const actions={
        testCdp:()=>testCdpConnection(),copyCdpCommand:()=>copyCdpLaunchCommand(),
        startRecorder:()=>startRecorder({save:false}),focusRecorder:()=>focusRecorder(),stopRecorder:()=>stopRecorder(),
        setRecorderAssertion:()=>{const mode=payload?.mode??'';const select=document.getElementById('recorderAssertionKind');if(select&&mode)select.value=mode;return setRecorderAssertion(Boolean(mode));},
        commitRecording:()=>commitRecording(),clearRecording:()=>clearRecording(),clearProfile:()=>clearBrowserProfile(),
        duplicateProject:()=>duplicateProject(),deleteProject:()=>deleteProject()
      };
      if(!actions[action])throw new Error(`未知工作站操作：${action}`);
      try{return await actions[action]();}finally{publish();}
    },
    adoptProject(project){if(!project||project.id!==state.project?.id)return false;state.project=structuredClone(project);const index=state.projects.findIndex(item=>item.id===project.id);if(index>=0)state.projects[index]=state.project;state.dirty=false;setSaveState('所有變更已儲存');renderProject();publish();return true;},
    syncSettingsDraft(settings){
      const fields={themeSetting:'theme',retentionDays:'retentionDays',runHistoryRetentionDays:'runHistoryRetentionDays',downloadDirectory:'defaultDownloadDir',debugRetention:'debugRetention',issueReportEmail:'issueReportEmail'};
      for(const [id,key] of Object.entries(fields)){const input=document.getElementById(id);if(input)input.value=String(settings?.[key]??'');}
    },
    readAISettingsDraft(){return readAISettingsFromForm();},
    adoptSettings(settings){state.settings=structuredClone(settings??{});const theme=state.settings.theme??'system';applyTheme(theme);renderSettings();publish();},
    prepareIssueReport(values){
      const fields={reportSubject:'subject',reportCategory:'category',reportSeverity:'severity',reportDescription:'description',reportSteps:'steps',reportExpected:'expected',reportActual:'actual',reportContact:'contact'};
      for(const [id,key] of Object.entries(fields)){const input=document.getElementById(id);if(input)input.value=String(values?.[key]??'');}
      return {to:issueReportEmail(),subject:issueReportSubject(),body:buildIssueReportText()};
    },
    select(id){if(!applyPendingStepProperties())return;state.selectedStepId=id;renderDesigner();},
    restoreSteps(steps,selectedStepId){
      if(!state.project||!Array.isArray(steps))return false;
      state.project.steps=structuredClone(steps);
      state.selectedStepId=selectedStepId&&findStepById(state.project.steps,selectedStepId)?selectedStepId:state.project.steps[0]?.id??'';
      markDirty();renderDesigner();return true;
    },
    action(id,action){handleCanvasClick({target:{closest(selector){if(selector==='[data-step-id]')return{dataset:{stepId:id}};if(selector==='[data-step-action]')return{dataset:{stepAction:action}};return null;}}});},
    insert(kind,owner,branch,index){
      if(!state.project)return;
      const parent=owner?findStepById(state.project.steps,owner):null;
      const list=owner?parent?.[branch]:state.project.steps;
      if(!Array.isArray(list)||!Number.isInteger(index)||index<0||index>list.length)throw new Error('插入位置已變更，請重新選取。');
      addStep(kind);const step=state.project.steps.pop();list.splice(index,0,step);state.selectedStepId=step.id;markDirty();renderDesigner();
    },
    move:moveStepByOffset,
    newBatchRow:createBatchRow,
    setBatchRows(rows){state.batchRows=rows;renderBatch();},
    runBatch(rows){state.batchRows=rows;renderBatch();return runBatch();},
    click(id){const button=document.getElementById(id);if(button&&!button.disabled&&!button.hidden)button.click();},
    publish,
    filteredRuns:getFilteredRuns,
    selectRun(id,on){if(on)state.selectedRunIds.add(id);else state.selectedRunIds.delete(id);renderRunSelectionToolbar();publish();},
    openHistory:wrap(openRunHistoryDetails),
    closeHistory:wrap(closeRunHistoryDetails),
    historyMarkup(){return state.selectedHistoryRun?buildRunHistoryDetailsMarkup(state.selectedHistoryRun,state.selectedHistoryDebug):'';},
    historyClick(event){void handleRunsTableClick(event);},
    runHistoryAction(id,action){const button=document.querySelector(`#runsTable [data-run-id="${CSS.escape(id)}"][data-run-action="${CSS.escape(action)}"]`);button?.click();},
    openDownloadFolder(){const button=document.querySelector('#downloadResults [data-download-action="open-folder"]');button?.click();},
    async invoke(id){const button=document.getElementById(id);if(!button||button.disabled||button.hidden)return;const actions={acceptAndApplyAIWorkflowRevisionButton:acceptAndApplyAIWorkflowRevision,acceptAIWorkflowRevisionButton:acceptAIWorkflowRevision,discardAIWorkflowRevisionButton:discardAIWorkflowRevision,undoAIWorkflowRevisionButton:undoAIWorkflowRevision,applyAIWorkflowProjectButton:applyAIWorkflowToCurrentProject,createAIWorkflowProjectButton:createAIWorkflowProject};try{await actions[id]?.();}finally{publish();}},
    selected,
    setTheme(theme){applyTheme(theme);const setting=document.querySelector('#themeSetting');if(setting)setting.value=theme;publish();},
    debugText(tab){return state.currentRun?buildRunDebugText(state.currentRun,state.currentRunDebug,tab):'尚未執行。';}
  };
  document.addEventListener('DOMContentLoaded',()=>{publish();});
})();
