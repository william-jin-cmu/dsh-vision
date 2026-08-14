/**
 * dsh-vision browser half: a "视觉模型" page in the settings center that
 * visualizes and edits the view_image backend configuration (baseURL / model /
 * apiKey / limits). The settings center's standard settings namespace channel
 * is gated by the host api-proxy allowlist, so this page talks to the plugin's
 * own host half through a package-private JSON route (`/dsh-vision/config`).
 * @module dsh-vision/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-vision',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');

    const CONFIG_PATH = '/dsh-vision/config';
    const CLIP_PATH = '/dsh-vision/clip';

    const FIELDS = [
      { key: 'baseURL', label: 'Base URL', type: 'text', placeholder: 'https://open.bigmodel.cn/api/paas/v4' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'glm-4.6v-flash' },
      { key: 'apiKey', label: 'API Key', type: 'password' },
      { key: 'fallbackModels', label: '降级模型（逗号分隔）', type: 'text' },
      { key: 'maxTokens', label: 'maxTokens', type: 'number' },
      { key: 'timeoutMs', label: 'timeoutMs', type: 'number' },
      { key: 'maxImageBytes', label: 'maxImageBytes', type: 'number' },
      { key: 'clipDir', label: '粘贴图片保存目录（留空 = 工作区/.dsh/tmp）', type: 'text' },
      { key: 'clipLimit', label: '粘贴图片缓存数量上限（超出自动清理最早的）', type: 'number' },
    ];

    const rowStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      padding: '12px 0',
      borderBottom: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.25))',
    };
    const labelStyle = {
      fontSize: '13px',
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,.9))',
    };
    const inputStyle = {
      boxSizing: 'border-box',
      width: '100%',
      height: '34px',
      padding: '0 10px',
      color: 'var(--dsw-alias-label-primary, inherit)',
      background: 'var(--dsw-alias-bg-input, rgba(127,127,127,.1))',
      border: '1px solid var(--dsw-alias-border-input, rgba(127,127,127,.35))',
      borderRadius: '8px',
      fontFamily: 'inherit',
      fontSize: '13px',
      lineHeight: '22px',
    };
    const buttonStyle = {
      cursor: 'pointer',
      height: '34px',
      padding: '0 16px',
      color: 'var(--dsw-alias-label-on-accent, #fff)',
      background: 'var(--dsw-alias-interactive-accent, #4f6ef2)',
      border: 'none',
      borderRadius: '8px',
      fontFamily: 'inherit',
      fontSize: '13px',
      fontWeight: '500',
    };
    const hintStyle = {
      margin: '0 0 8px',
      color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,.7))',
      fontSize: '12px',
      lineHeight: '18px',
    };

    /** One text/number field row. */
    function FieldRow({ field, value, placeholder, disabled, onChange }) {
      const val = field.key === 'fallbackModels' && Array.isArray(value)
        ? value.join(', ')
        : (value === undefined || value === null ? '' : String(value));
      return React.createElement('div', { style: rowStyle },
        React.createElement('label', { style: labelStyle }, field.label),
        React.createElement('input', {
          style: inputStyle,
          type: field.type,
          value: val,
          placeholder: placeholder !== undefined ? placeholder : field.placeholder,
          disabled: disabled,
          onChange: (e) => onChange(field.key, field.key === 'fallbackModels'
            ? e.target.value.split(',').map((s) => s.trim()).filter((s) => s !== '')
            : e.target.value),
        }),
      );
    }

    /**
     * The settings page body. Loads the current config from the host route,
     * keeps a local draft, and writes it back on save. Secret role: the apiKey
     * is never echoed back; an empty draft keeps the stored key.
     */
    function VisionSection() {
      const [phase, setPhase] = React.useState('loading'); // loading | ready | error
      const [value, setValue] = React.useState({});
      const [hasApiKey, setHasApiKey] = React.useState(false);
      const [saving, setSaving] = React.useState(false);
      const [feedback, setFeedback] = React.useState(null); // {kind:'ok'|'error', text}

      React.useEffect(() => {
        let cancelled = false;
        fetch(CONFIG_PATH)
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
          .then((data) => {
            if (cancelled) return;
            setValue(data.value || {});
            setHasApiKey(data.hasApiKey === true);
            setPhase('ready');
          })
          .catch((error) => {
            if (cancelled) return;
            setFeedback({ kind: 'error', text: '读取配置失败：' + (error && error.message ? error.message : String(error)) });
            setPhase('error');
          });
        return () => { cancelled = true; };
      }, []);

      const setField = (key, next) => {
        setValue((prev) => ({ ...prev, [key]: next }));
        setFeedback(null);
      };

      const save = () => {
        setSaving(true);
        setFeedback(null);
        const payload = {};
        for (const field of FIELDS) {
          if (field.key === 'apiKey') {
            // Empty draft keeps the stored key; non-empty replaces it.
            const raw = value.apiKey;
            if (raw && String(raw).length > 0) payload.apiKey = String(raw);
            continue;
          }
          const raw = value[field.key];
          if (field.type === 'number') {
            if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
              const n = Number(raw);
              payload[field.key] = Number.isFinite(n) ? n : undefined;
            }
            continue;
          }
          if (field.key === 'fallbackModels') {
            payload[field.key] = Array.isArray(raw) ? raw : [];
            continue;
          }
          if (raw !== undefined && raw !== null) payload[field.key] = String(raw);
        }
        fetch(CONFIG_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
          .then(() => {
            setSaving(false);
            setFeedback({ kind: 'ok', text: '已保存' });
          })
          .catch((error) => {
            setSaving(false);
            setFeedback({ kind: 'error', text: '保存失败：' + (error && error.message ? error.message : String(error)) });
          });
      };

      const disabled = phase !== 'ready' || saving;
      const apiKeyPlaceholder = hasApiKey ? '已设置（留空保持不变）' : '未设置';

      return React.createElement('div', { style: { width: '100%', maxWidth: '560px' } },
        React.createElement('p', { style: hintStyle },
          'view_image 工具使用的视觉模型后端。默认智谱免费 glm-4.6v-flash（无需付费）；' +
          '也支持通义 qwen3-vl、本地 Ollama（baseURL http://localhost:11434/v1）等任意 OpenAI 兼容端点。'),
        FIELDS.map((field) => React.createElement(FieldRow, {
          key: field.key,
          field: field,
          value: value[field.key],
          placeholder: field.key === 'apiKey' ? apiKeyPlaceholder : undefined,
          disabled: disabled,
          onChange: setField,
        })),
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '16px 0' } },
          React.createElement('button', { style: buttonStyle, disabled: disabled, onClick: save },
            saving ? '保存中…' : '保存'),
          feedback !== null && React.createElement('span', {
            style: feedback.kind === 'ok'
              ? { color: 'var(--dsw-alias-state-success-primary, #2e9e5b)', fontSize: '13px' }
              : { color: 'var(--dsw-alias-state-error-primary, #d64545)', fontSize: '13px' },
          }, feedback.text),
        ),
      );
    }

    /**
     * Paste-to-path mode: when the user pastes an image into the composer,
     * save it to disk through the host route and insert a "[图片: <path>]"
     * token into the draft instead of attaching it, so a text-only chat model
     * can call view_image on the saved file. Module-level flag keeps the mode
     * across session switches; the small toggle in the composer tool row flips
     * back to normal image attachments (for vision-capable chat models).
     */
    const pasteMode = { on: true };

    function ClipPasteControl(props) {
      const inputActions = props.inputActions;
      const [mode, setMode] = React.useState(pasteMode.on);
      const [error, setError] = React.useState(null);

      React.useEffect(() => {
        if (inputActions === undefined || typeof inputActions.setDraft !== 'function') return;
        const onPaste = (e) => {
          if (!pasteMode.on) return;
          const target = e.target;
          if (!(target instanceof HTMLElement)) return;
          if (target.closest('[data-composer-card]') === null && target.closest('[data-composer-seat]') === null) return;
          const clipboard = e.clipboardData;
          if (clipboard === null || clipboard === undefined) return;
          const files = [];
          for (let i = 0; i < clipboard.files.length; i += 1) {
            const file = clipboard.files.item(i);
            if (file !== null && typeof file.type === 'string' && file.type.startsWith('image/')) files.push(file);
          }
          if (files.length === 0) return;
          // Take over the paste: the default flow would attach the image,
          // which text-only chat models reject at send time.
          e.preventDefault();
          e.stopPropagation();
          const el = target;
          const value = typeof el.value === 'string' ? el.value : '';
          const start = typeof el.selectionStart === 'number' ? el.selectionStart : value.length;
          const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : start;
          const before = value.slice(0, start);
          const after = value.slice(end);
          let pending = files.length;
          const tokens = new Array(files.length);
          const finish = () => {
            pending -= 1;
            if (pending !== 0) return;
            const parts = tokens.filter((t) => t !== null);
            if (parts.length > 0) inputActions.setDraft(before + parts.join('\n') + after);
          };
          files.forEach((file, index) => {
            const reader = new FileReader();
            reader.onload = () => {
              fetch(CLIP_PATH, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ data: reader.result, name: file.name }),
              })
                .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
                .then((saved) => {
                  tokens[index] = '[图片: ' + saved.path + ']';
                  finish();
                })
                .catch((err) => {
                  tokens[index] = null;
                  setError('图片保存失败：' + (err && err.message ? err.message : String(err)));
                  finish();
                });
            };
            reader.onerror = () => {
              tokens[index] = null;
              finish();
            };
            reader.readAsDataURL(file);
          });
        };
        document.addEventListener('paste', onPaste, true);
        return () => document.removeEventListener('paste', onPaste, true);
      }, [inputActions]);

      const toggle = () => {
        pasteMode.on = !pasteMode.on;
        setMode(pasteMode.on);
        setError(null);
      };

      return React.createElement('button', {
        style: {
          cursor: 'pointer',
          height: '28px',
          padding: '0 10px',
          background: '#ffffff',
          color: mode ? '#1f2328' : 'rgba(31,35,40,.55)',
          border: mode ? '1px solid rgba(31,35,40,.45)' : '1px solid rgba(31,35,40,.18)',
          borderRadius: '8px',
          fontFamily: 'inherit',
          fontSize: '12px',
          lineHeight: '18px',
          whiteSpace: 'nowrap',
        },
        title: (mode
          ? '路径模式：粘贴图片 → 保存到 .dsh/tmp 并插入 [图片: 路径] 标记，模型用 view_image 看图。点击切换为附件模式。'
          : '附件模式：粘贴图片作为普通附件发送（需要聊天模型支持图片）。点击切换为路径模式。')
          + (error !== null ? '\n上次错误：' + error : ''),
        onClick: toggle,
      }, mode ? '图片→路径' : '图片附件');
    }

    /**
     * Register the "视觉模型" settings page. The slot shell renders one page
     * per settings.section entry; this registration is additive and owned by
     * the plugin fiber, so stopping the plugin removes the page.
     */
    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-vision',
        order: 30,
        label: () => '视觉模型',
      }, VisionSection));
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'dsh-vision-clip',
        order: 0,
      }, ClipPasteControl));
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    return module.exports;
  }
});
