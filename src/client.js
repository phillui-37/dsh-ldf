/* Browser entry: loaded directly by DSH's Cordis module loader. */
window.__ModuleLoader__.load({
  id: 'dsh-ldf',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    function SettingsForm({ labels, state, onSave, onDiscard, children }) {
      if (!state.available) return h('p', null, labels.unavailable);
      return h('form', { onSubmit: event => { event.preventDefault(); onSave(); } },
        children,
        state.failed && h('p', { role: 'alert' }, labels.saveFailed),
        h('button', { type: 'submit', disabled: !state.dirty || state.invalid || state.saving }, state.saving ? labels.saving : labels.save),
        state.dirty && h('button', { type: 'button', onClick: onDiscard }, 'Discard'));
    }
    function SettingsValueField({ id, label, text, overridden, invalid, overriddenLabel, resetLabel, invalidLabel, disabled, numeric, onEdit, onReset }) {
      return h('div', null,
        h('label', { htmlFor: id }, label),
        h('input', { id, type: numeric ? 'number' : 'text', value: text, disabled, 'aria-invalid': invalid || undefined, onChange: event => onEdit(event.target.value) }),
        overridden && h('span', null, ` ${overriddenLabel}`),
        overridden && h('button', { type: 'button', disabled, onClick: onReset }, resetLabel),
        invalid && h('p', { role: 'alert' }, invalidLabel));
    }
    const fields = [
      ['enabled', 'Enabled (true / false)', '啟用（true / false）', 'boolean'],
      ['python', 'Python executable', 'Python 執行檔'],
      ['serverName', 'MCP server name', 'MCP 伺服器名稱'],
      ['baseUrl', 'OpenAI-compatible API URL', 'OpenAI 相容 API 網址'],
      ['model', 'Model', '模型'],
      ['apiKeyFile', 'API key file path', 'API 金鑰檔案路徑'],
      ['timeout', 'Model timeout (seconds)', '模型逾時（秒）', 1, 300],
      ['maxOutputTokens', 'Maximum output tokens', '輸出 Token 上限', 1, 8192],
      ['reasoningEffort', 'Reasoning effort', '推理強度'],
      ['outputMode', 'Output mode (json_schema / json_object / plain)', '輸出模式（json_schema / json_object / plain）'],
      ['clientName', 'Client name', '用戶端名稱'],
      ['capture', 'Capture evidence (true / false)', '記錄證據（true / false）', 'boolean'],
      ['captureResponse', 'Capture response (true / false)', '記錄回覆（true / false）', 'boolean'],
      ['dataDir', 'Evidence directory', '證據目錄'],
      ['toolCallTimeoutMs', 'Tool timeout (ms)', '工具逾時（毫秒）', 1000],
      ['prefix', 'Prompt prefix', '提示詞前綴'],
      ['suffix', 'Prompt suffix', '提示詞後綴'],
    ];
    const en = { description: 'Configure the local decision model, MCP server and evidence capture.', unavailable: 'Settings are unavailable.', readOnly: 'Settings are read-only.', saveFailed: 'Could not save. Review the latest settings and try again.', save: 'Save', saving: 'Saving…', overridden: 'Overridden', reset: 'Reset', invalid: 'Enter a valid value.' };
    const zh = { description: '設定本地決策模型、MCP 伺服器與證據記錄。', unavailable: '設定目前無法使用。', readOnly: '設定目前為唯讀。', saveFailed: '無法儲存。請檢查最新設定後重試。', save: '儲存', saving: '儲存中…', overridden: '已覆寫', reset: '重設', invalid: '請輸入有效值。' };
    for (const [key, english, chinese] of fields) { en[key] = english; zh[key] = chinese; }

    function Panel({ view, form, t }) {
      const [draft, setDraft] = React.useState({});
      const [saving, setSaving] = React.useState(false);
      const [failed, setFailed] = React.useState(false);
      const fence = React.useRef(undefined);
      const state = form?.state;
      const value = state?.value || {};
      const dirty = Object.keys(draft).length > 0;
      const available = state?.status === 'ready';
      const writable = Boolean(state?.writable);
      function edit(key, text) {
        if (!dirty) fence.current = state?.revision;
        setDraft(previous => ({ ...previous, [key]: { op: 'set', text } }));
        setFailed(false);
      }
      function reset(key) {
        if (!dirty) fence.current = state?.revision;
        setDraft(previous => ({ ...previous, [key]: { op: 'unset' } }));
        setFailed(false);
      }
      function parse(field, text) {
        if (field[3] === 'boolean') return text === 'true' ? true : text === 'false' ? false : undefined;
        if (field[0] === 'serverName' && !/^[A-Za-z0-9_-]{1,32}$/.test(text)) return undefined;
        if (field[0] === 'clientName' && !/^\S+$/.test(text)) return undefined;
        if (field[0] === 'outputMode' && !['json_schema', 'json_object', 'plain'].includes(text)) return undefined;
        if (field[3] === undefined) return text;
        if (!text.trim()) return undefined;
        const number = Number(text);
        return Number.isInteger(number) && number >= field[3] && (field[4] === undefined || number <= field[4]) ? number : undefined;
      }
      const invalid = fields.some(field => draft[field[0]]?.op === 'set' && parse(field, draft[field[0]].text) === undefined);
      function discard() { setDraft({}); setFailed(false); fence.current = undefined; }
      async function save() {
        if (!form || !writable || invalid || saving || !dirty) return;
        const ops = fields.filter(field => draft[field[0]]).map(field => {
          const key = field[0];
          return draft[key].op === 'unset' ? { op: 'unset', path: [key] } : { op: 'set', path: [key], value: parse(field, draft[key].text) };
        });
        setSaving(true);
        try { if (await form.mutate(ops, fence.current)) discard(); else setFailed(true); }
        catch { setFailed(true); }
        finally { setSaving(false); }
      }
      if (view === 'summary') return t('description');
      return h(SettingsForm, {
        labels: { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') },
        state: { available, writable, dirty, invalid: invalid || !writable, saving, failed }, onSave: save, onDiscard: discard,
      }, fields.map(field => {
        const key = field[0];
        const change = draft[key];
        const resolved = change?.op === 'unset' ? state?.base?.[key] : value[key];
        const text = change?.op === 'set' ? change.text : String(resolved ?? '');
        return h(SettingsValueField, { key, id: `dsh-ldf-${key}`, label: t(key), text,
          overridden: change ? change.op === 'set' : Object.prototype.hasOwnProperty.call(state?.user || {}, key),
          invalid: change?.op === 'set' && parse(field, text) === undefined,
          overriddenLabel: t('overridden'), resetLabel: t('reset'), invalidLabel: t('invalid'),
          disabled: !writable || saving, numeric: typeof field[3] === 'number',
          onEdit: text => edit(key, text), onReset: () => reset(key),
        });
      }));
    }
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const namespace = 'dsh-ldf-settings';
        const t = ctx.locale.bind(namespace);
        ctx.effect(() => ctx.locale.register(namespace, { en, zh }), 'dsh-ldf: settings dictionaries');
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config', key: ['dsh-ldf', 'ldf'].join('#'), inject: () => ({ t }),
        }, Panel));
      },
    };
  },
});
