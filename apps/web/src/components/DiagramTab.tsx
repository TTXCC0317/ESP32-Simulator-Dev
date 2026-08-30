import { useEffect, useState } from 'react';
import { useCircuitStore } from '../circuit/circuitStore';
import { applyDiagramText, buildDiagramText, WOKWI_BLINK_SAMPLE } from '../circuit/diagram';

/**
 * diagram.json Tab（02-M2、04-§7）：
 * - 打开/画布变更且未手动编辑时，以画布为准生成文本（画布 → JSON）；
 * - 「应用到画布」校验通过才替换（JSON → 画布）；非法 JSON 报错且不破坏画布；
 * - 「格式化」仅重排 JSON；「放弃修改」回滚到画布当前状态；「载入示例」注入 Wokwi blink。
 * 当前用 textarea，Monaco 换装待排期（04-§7.1/§7.2）。
 */

export default function DiagramTab() {
  const doc = useCircuitStore((s) => s.doc);
  const [text, setText] = useState(() => buildDiagramText(doc));
  const [edited, setEdited] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState('');

  // 画布变化且文本未被手动编辑 → 跟随画布
  useEffect(() => {
    if (!edited) setText(buildDiagramText(doc));
  }, [doc, edited]);

  const apply = () => {
    const r = applyDiagramText(text);
    if (r.ok) {
      useCircuitStore.getState().replaceDoc(r.doc);
      setEdited(false);
      setErrors([]);
      setNotice(
        r.skipped.length > 0 ? `已应用（跳过未收录类型: ${r.skipped.join(', ')}）` : '已应用',
      );
    } else {
      setErrors(r.errors); // 不 replaceDoc，画布保持不变
    }
  };

  const format = () => {
    try {
      setText(JSON.stringify(JSON.parse(text), null, 2));
      setErrors([]);
    } catch {
      setErrors(['JSON 解析失败，无法格式化']);
    }
  };

  const discard = () => {
    setText(buildDiagramText(useCircuitStore.getState().doc));
    setEdited(false);
    setErrors([]);
    setNotice('已放弃修改');
  };

  const loadSample = () => {
    setText(WOKWI_BLINK_SAMPLE);
    setEdited(true);
    setErrors([]);
    setNotice('已载入 Wokwi blink 示例，点击「应用到画布」生效');
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 border-b border-panel-border px-2 py-1.5">
        <button
          type="button"
          onClick={apply}
          data-testid="diagram-apply"
          className="rounded bg-accent/15 px-2 py-1 text-xs text-accent hover:bg-accent/25"
        >
          应用到画布
        </button>
        <button
          type="button"
          onClick={format}
          className="rounded border border-panel-border px-2 py-1 text-xs text-text-primary hover:border-accent"
        >
          格式化
        </button>
        <button
          type="button"
          onClick={discard}
          disabled={!edited}
          className="rounded border border-panel-border px-2 py-1 text-xs text-text-primary hover:border-accent disabled:opacity-40"
        >
          放弃修改
        </button>
        <button
          type="button"
          onClick={loadSample}
          className="rounded border border-panel-border px-2 py-1 text-xs text-text-primary hover:border-accent"
        >
          载入示例
        </button>
        {edited && <span className="text-[10px] text-warn">未应用修改</span>}
        {notice && !errors.length && (
          <span className="text-[10px] text-success" data-testid="diagram-notice" role="status">
            {notice}
          </span>
        )}
      </div>

      {errors.length > 0 && (
        <div className="bg-danger/10 px-3 py-1.5" data-testid="diagram-errors" role="alert">
          {errors.map((e, i) => (
            <p key={i} className="text-xs text-danger">
              {e}
            </p>
          ))}
        </div>
      )}

      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setEdited(true);
        }}
        spellCheck={false}
        aria-label="diagram.json 内容"
        data-testid="diagram-text"
        className="min-h-0 flex-1 resize-none bg-bg p-3 font-mono text-xs leading-relaxed text-text-primary outline-none"
      />
    </div>
  );
}
