/** Just enough tools's configuration card on dsh's Plugins page. */
import { createElement as h, useState, useRef, useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type { ConfigForm, SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client';
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';

const en = {
  title: 'Just enough tools', description: 'Configure Jev to select tools and skills in Just enough tools mode.',
  apiKey: 'Jev API key', keySet: 'A key is saved.', keyUnset: 'No key is saved. TYPESAFE_API_KEY can also supply it.',
  keyHint: 'Leave blank to keep the saved key. Saved keys are not returned to this page.',
  baseUrl: 'Jev API base URL', model: 'Jev model', threshold: 'Tool / skill threshold', maxSteps: 'Steps per user turn', timeout: 'Scoring timeout (ms)',
  save: 'Save', saved: 'Saved.', saving: 'Saving…', discard: 'Discard changes', clear: 'Reset saved key',
  failed: 'Could not save. Reload this page and try again.', loading: 'Loading settings…', readonly: 'Settings are read-only for this connection.',
  hint: 'Choose Just enough tools when starting a new conversation. API key, URL and model apply on the next scoring call; routing limits apply to new conversations.',
};
const zh: Record<keyof typeof en, string> = {
  title: 'Just enough tools', description: '配置 Jev，在 Just enough tools 模式中统一选择 tools 与 skills。',
  apiKey: 'Jev API Key', keySet: '已保存密钥。', keyUnset: '尚未保存密钥，也可以通过 TYPESAFE_API_KEY 提供。',
  keyHint: '留空保留已保存密钥；页面不会读取或显示已有密钥。',
  baseUrl: 'Jev API 地址', model: 'Jev 模型', threshold: 'Tool / Skill 开放阈值', maxSteps: '每轮对话的最大步骤', timeout: '评分超时（毫秒）',
  save: '保存', saved: '已保存。', saving: '保存中…', discard: '放弃修改', clear: '重置已保存密钥',
  failed: '保存失败，请重新打开页面后重试。', loading: '正在加载设置…', readonly: '当前连接只能读取设置。',
  hint: '新建对话时选择 Just enough tools 模式。API Key、地址和模型在下次评分生效；路由限制在新对话生效。',
};
type TextKey = keyof typeof en;
declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'just-enough-tools.ui': TextKey } }
interface Values { baseUrl?: string; model?: string; threshold?: number; maxSteps?: number; scoreTimeoutMs?: number }
type CardProps = PropsRuntime<'plugins.bundle.config'> & PropsLocale<'just-enough-tools.ui'> & {
  scope: ConfigForm<Values>; mirror: SettingsDescribeFace;
};

/** Save only edited fields, preserving the redacted secret on unrelated edits. */
export function JustEnoughToolsCard({ scope, mirror, t, view }: CardProps) {
  const snapshot = useSyncExternalStore(cb => scope.subscribe(cb), () => scope.getSnapshot());
  const overview = useSyncExternalStore(cb => mirror.subscribe(cb), () => mirror.getSnapshot());
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const revision = useRef<number | undefined>(undefined);
  const dirty = Object.keys(draft).length > 0;
  const values = snapshot.value ?? {};
  const disabled = !snapshot.writable || status === 'saving';
  const configured = overview.view?.namespaces.find(n => n.ns === 'just-enough-tools')?.secrets.some(s => s.path.join('.') === 'apiKey' && s.set);
  const edit = (name: string, value: string) => {
    if (!dirty) revision.current = snapshot.revision;
    setDraft(old => {
      const next = { ...old, [name]: value };
      if (name === 'apiKey' && !value) delete next.apiKey;
      return next;
    });
    setStatus('idle');
  };
  const numeric = new Set(['threshold', 'maxSteps', 'scoreTimeoutMs']);
  const invalid = Object.entries(draft).some(([key, value]) => numeric.has(key) && (
    !value.trim() || !Number.isFinite(Number(value)) || (key === 'threshold' ? Number(value) < 0 || Number(value) > 1
      : !Number.isInteger(Number(value)) || Number(value) < (key === 'maxSteps' ? 2 : 1))));
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (disabled || invalid || !dirty) return;
    setStatus('saving');
    try {
      const accepted = await scope.mutate(Object.entries(draft).map(([key, value]) => ({
        ...(key === 'apiKey' && value === '' ? { op: 'unset' as const, path: [key] }
          : { op: 'set' as const, path: [key], value: numeric.has(key) ? Number(value) : value }),
      })), revision.current);
      if (accepted) { setDraft({}); setStatus('saved'); } else setStatus('failed');
    } catch { setStatus('failed'); }
  }
  if (view === 'summary') return t('description');
  if (snapshot.status !== 'ready') return h('p', null, t('loading'));
  const buttonStyle = { padding: '8px 12px', border: '1px solid #8886', borderRadius: 6, background: 'transparent', color: 'inherit', width: 'fit-content' };
  const field = (key: keyof Values | 'apiKey', label: TextKey, type = 'text') => h('label', {
    key, style: { display: 'grid', gap: 6 },
  }, t(label), h('input', {
    id: `just-enough-tools-${key}`, type, autoComplete: key === 'apiKey' ? 'new-password' : 'off',
    value: draft[key] ?? (key === 'apiKey' ? '' : String(values[key] ?? '')),
    disabled, step: key === 'threshold' ? '0.05' : '1',
    min: key === 'threshold' ? 0 : key === 'maxSteps' ? 2 : type === 'number' ? 1 : undefined,
    max: key === 'threshold' ? 1 : undefined,
    required: key !== 'apiKey',
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => edit(key, event.target.value),
    style: { padding: '8px 10px', border: '1px solid #8886', borderRadius: 6, background: 'transparent', color: 'inherit' },
  }));
  return h('form', { onSubmit: save, style: { display: 'grid', gap: 16, maxWidth: 640, padding: '12px 0' } },
    h('p', null, t('hint')),
    field('apiKey', 'apiKey', 'password'),
    h('small', { role: 'status' }, t(configured ? 'keySet' : 'keyUnset'), ' ', t('keyHint')),
    h('button', { type: 'button', style: buttonStyle, disabled, onClick: () => { revision.current = snapshot.revision; setDraft(old => ({ ...old, apiKey: '' })); setStatus('idle'); } }, t('clear')),
    field('baseUrl', 'baseUrl', 'url'), field('model', 'model'),
    field('threshold', 'threshold', 'number'), field('maxSteps', 'maxSteps', 'number'), field('scoreTimeoutMs', 'timeout', 'number'),
    !snapshot.writable ? h('p', null, t('readonly')) : null,
    h('div', { style: { display: 'flex', gap: 12 } },
      h('button', { type: 'submit', style: buttonStyle, disabled: disabled || invalid || !dirty }, t(status === 'saving' ? 'saving' : 'save')),
      h('button', { type: 'button', style: buttonStyle, disabled: status === 'saving' || !dirty, onClick: () => { setDraft({}); setStatus('idle'); } }, t('discard'))),
    status === 'failed' || status === 'saved' ? h('p', { role: status === 'failed' ? 'alert' : 'status' }, t(status)) : null,
  );
}

export const inject = ['slots', 'locale', 'configForms'];
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('just-enough-tools.ui', { en, zh }));
  const scope = ctx.configForms.get<Values>('just-enough-tools');
  const mirror = ctx.configForms.describe();
  ctx.effect(() => ctx.configForms.whileServed(['just-enough-tools'], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config', key: 'dsh-just-enough-tools', locale: 'just-enough-tools.ui', inject: () => ({ scope, mirror }),
  }, JustEnoughToolsCard))));
}
