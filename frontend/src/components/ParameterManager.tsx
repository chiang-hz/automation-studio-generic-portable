import { useEffect, useState, type FormEvent } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { runtimeSdk } from '../sdk/runtimeSdk';
import type { Parameter } from '../model';
import { useStudio } from '../store';
import { Button } from './ui/button';

interface ParameterDraft {
  id: string;
  label: string;
  name: string;
  type: string;
  defaultValue: string;
  options: string;
  dependsOn: string;
  dependentOptions: string;
  required: boolean;
  sensitive: boolean;
}

const emptyDraft = (): ParameterDraft => ({ id: '', label: '', name: '', type: 'text', defaultValue: '', options: '', dependsOn: '', dependentOptions: '', required: false, sensitive: false });

function readDependentOptions(value: string): Record<string, string[]> {
  return Object.fromEntries(value.split(/\r?\n/).map(line => line.trim()).filter(Boolean).flatMap(line => {
    const splitAt = line.indexOf('=');
    if (splitAt < 1) return [];
    const parent = line.slice(0, splitAt).trim();
    const options = line.slice(splitAt + 1).split('|').map(item => item.trim()).filter(Boolean);
    return parent && options.length ? [[parent, options] as const] : [];
  }));
}

function writeDependentOptions(value?: Record<string, string[]>): string {
  return Object.entries(value ?? {}).map(([parent, options]) => `${parent}=${options.join('|')}`).join('\n');
}

function toDraft(parameter: Parameter): ParameterDraft {
  return {
    id: parameter.id,
    label: parameter.label,
    name: parameter.name,
    type: parameter.type,
    defaultValue: parameter.sensitive ? '' : String(parameter.defaultValue ?? ''),
    options: (parameter.options ?? []).join(', '),
    dependsOn: parameter.dependsOn ?? '',
    dependentOptions: writeDependentOptions(parameter.dependentOptions),
    required: parameter.required,
    sensitive: parameter.sensitive === true
  };
}

const typeLabels: Record<string, string> = { text: '文字', number: '數字', date: '日期', boolean: '布林值', select: '選項', secret: '敏感文字' };

export function ParameterManager() {
  const snapshot = useStudio(state => state.snapshot);
  const project = snapshot.state.project;
  const parameters = project?.parameters ?? [];
  const [draft, setDraft] = useState<ParameterDraft>(emptyDraft);
  const [error, setError] = useState('');

  useEffect(() => { setDraft(emptyDraft()); setError(''); }, [project?.id]);

  const patch = <K extends keyof ParameterDraft>(key: K, value: ParameterDraft[K]) => setDraft(current => ({ ...current, [key]: value }));
  const edit = (parameter: Parameter) => { setDraft(toDraft(parameter)); setError(''); };
  const reset = () => { setDraft(emptyDraft()); setError(''); };
  const remove = (id: string) => {
    if (!project) return;
    runtimeSdk.setParameters(parameters.filter(parameter => parameter.id !== id));
    if (draft.id === id) reset();
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!project) return;
    const name = draft.name.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) { setError('參數 Key 格式不正確。'); return; }
    if (parameters.some(parameter => parameter.name === name && parameter.id !== draft.id)) { setError('參數 Key 不可重複。'); return; }
    const id = draft.id || `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const dependentOptions = readDependentOptions(draft.dependentOptions);
    const parameter: Parameter = {
      id,
      label: draft.label.trim(),
      name,
      type: draft.type,
      defaultValue: draft.sensitive ? '' : draft.defaultValue,
      options: draft.options.split(',').map(value => value.trim()).filter(Boolean),
      dependsOn: draft.dependsOn || undefined,
      dependentOptions: draft.dependsOn && Object.keys(dependentOptions).length ? dependentOptions : undefined,
      required: draft.required,
      sensitive: draft.sensitive || draft.type === 'secret'
    };
    const index = parameters.findIndex(item => item.id === id);
    const next = [...parameters];
    if (index >= 0) next[index] = parameter;
    else next.push(parameter);
    runtimeSdk.setParameters(next);
    reset();
    runtimeSdk.toast('參數已加入專案');
  };

  if (!project) return <section className="card"><p className="muted">請先選取或建立專案，再管理流程參數。</p></section>;

  const choices = parameters.filter(parameter => parameter.id !== draft.id && parameter.type === 'select');
  return <div className="parameter-manager two-column wide-left">
    <section className="card">
      <div className="section-heading"><div><h2>流程參數</h2><p>將年度、階段、報表及格式等值抽離流程。</p></div><Button size="sm" onClick={reset}><Plus size={14}/>新增參數</Button></div>
      <div className="data-table-wrap"><table className="data-table"><thead><tr><th>顯示名稱</th><th>Key</th><th>類型</th><th>預設值</th><th>必填</th><th>操作</th></tr></thead><tbody>
        {parameters.length ? parameters.map(parameter => <tr key={parameter.id}>
          <td><b>{parameter.label}</b>{parameter.sensitive && <small>敏感資料</small>}</td><td><code>{parameter.name}</code></td><td>{typeLabels[parameter.type] ?? parameter.type}</td><td>{parameter.sensitive ? '••••••' : String(parameter.defaultValue ?? '')}</td><td>{parameter.required ? '是' : '否'}</td>
          <td className="row-actions"><Button size="icon" variant="ghost" title={`編輯 ${parameter.label}`} aria-label={`編輯 ${parameter.label}`} onClick={() => edit(parameter)}><Pencil size={14}/></Button><Button size="icon" variant="danger" title={`刪除 ${parameter.label}`} aria-label={`刪除 ${parameter.label}`} onClick={() => remove(parameter.id)}><Trash2 size={14}/></Button></td>
        </tr>) : <tr><td colSpan={6}><div className="empty-state compact">尚未建立參數。</div></td></tr>}
      </tbody></table></div>
    </section>
    <section className="card sticky-card">
      <div className="section-heading"><div><h2>{draft.id ? '編輯參數' : '新增參數'}</h2><p>敏感參數不會寫入匯出檔。</p></div></div>
      <form className="parameter-form" onSubmit={submit}>
        <label className="field"><span>顯示名稱</span><input required value={draft.label} onChange={event => patch('label', event.target.value)}/></label>
        <label className="field"><span>Key</span><input required pattern="[A-Za-z_][A-Za-z0-9_]*" value={draft.name} onChange={event => patch('name', event.target.value)}/></label>
        <label className="field"><span>類型</span><select value={draft.type} onChange={event => patch('type', event.target.value)}>{Object.entries(typeLabels).map(([type, label]) => <option key={type} value={type}>{label}</option>)}</select></label>
        <label className="field"><span>預設值</span><input value={draft.defaultValue} disabled={draft.sensitive || draft.type === 'secret'} onChange={event => patch('defaultValue', event.target.value)}/></label>
        <label className="field"><span>選項（逗號分隔）</span><input value={draft.options} onChange={event => patch('options', event.target.value)}/></label>
        <label className="field"><span>相依參數（選填）</span><select value={draft.dependsOn} onChange={event => patch('dependsOn', event.target.value)}><option value="">無</option>{choices.map(parameter => <option key={parameter.id} value={parameter.name}>{parameter.label} ({parameter.name})</option>)}</select><small>只有選項類型需要使用；子選單會依此參數的值動態篩選。</small></label>
        <label className="field"><span>相依選項（每行：父值=子選項1|子選項2）</span><textarea rows={5} placeholder={'決算主要表=損益表|盈虧撥補表\n決算明細表=收入明細表|成本彙總表'} value={draft.dependentOptions} onChange={event => patch('dependentOptions', event.target.value)}/></label>
        <label className="switch-field"><input type="checkbox" checked={draft.required} onChange={event => patch('required', event.target.checked)}/><span><b>必填參數</b></span></label>
        <label className="switch-field"><input type="checkbox" checked={draft.sensitive || draft.type === 'secret'} onChange={event => patch('sensitive', event.target.checked)}/><span><b>敏感資料</b><small>Debug 與匯出時遮罩或移除。</small></span></label>
        {error && <p className="parameter-form-error" role="alert">{error}</p>}
        <div className="parameter-form-actions">{draft.id && <Button type="button" onClick={reset}>取消編輯</Button>}<Button variant="default" type="submit">儲存參數</Button></div>
      </form>
    </section>
  </div>;
}
