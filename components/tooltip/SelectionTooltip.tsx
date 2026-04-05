'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

export type TooltipData = {
  text: string;
  translatedText: string;
  simpleEnglish: string;
  targetLang: string;
  rect: DOMRect;
  saved: boolean;
};

type Props = {
  data: TooltipData;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onSaved: () => void;
};

type VocabItem = {
  text: string;
  translatedText: string;
  simpleEnglish: string;
  targetLang: string;
  savedAt: string;
};

const VOCAB_KEY = 'readease.vocab';

export default function SelectionTooltip({
  data,
  loading,
  error,
  onClose,
  onSaved,
}: Props) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // We use requestAnimationFrame to allow the browser to paint it invisibly
    // first so we can measure the *actual* height of the tooltip before showing it.
    const raf = requestAnimationFrame(() => {
      if (!rootRef.current) return;
      const el = rootRef.current;
      
      const rect = data.rect;
      const padding = 12;
      
      // Temporarily remove opacity to measure true height
      const originalOpacity = el.style.opacity;
      el.style.opacity = '0';
      
      const tooltipHeight = el.offsetHeight;
      const tooltipWidth = el.offsetWidth;
      
      el.style.opacity = originalOpacity;

      // Try placing it below the text
      let top = Math.min(window.innerHeight - padding - tooltipHeight, rect.bottom + 8);
      
      // If placing it below cuts it off, flip it ABOVE the text
      if (rect.bottom + 8 + tooltipHeight > window.innerHeight - padding) {
        top = Math.max(padding, rect.top - tooltipHeight - 8);
      }

      // Try centering it to the left of the selection
      let left = Math.min(
        window.innerWidth - padding - tooltipWidth,
        Math.max(padding, rect.left)
      );

      setPos({ top, left });
    });

    return () => cancelAnimationFrame(raf);
  }, [data.rect, data.translatedText, data.simpleEnglish, error, loading]);

  const canSave = useMemo(() => Boolean(data.text), [data.text]);

  const save = () => {
    if (!canSave) return;

    const item: VocabItem = {
      text: data.text,
      translatedText: data.translatedText || '',
      simpleEnglish: data.simpleEnglish || '',
      targetLang: data.targetLang,
      savedAt: new Date().toISOString(),
    };

    let list: VocabItem[] = [];
    try {
      const existing = window.localStorage.getItem(VOCAB_KEY);
      const parsed = existing ? (JSON.parse(existing) as unknown) : [];
      list = Array.isArray(parsed) ? (parsed as VocabItem[]) : [];
    } catch {
      list = [];
    }

    list.unshift(item);
    const next = list.slice(0, 200);
    window.localStorage.setItem(VOCAB_KEY, JSON.stringify(next));
    window.dispatchEvent(
      new CustomEvent('readease:vocab-updated', {
        detail: { items: next },
      })
    );
    document.dispatchEvent(
      new CustomEvent('readease:vocab-updated', {
        detail: { items: next },
      })
    );
    onSaved();
  };

  return (
    <div
      ref={rootRef}
      data-readease-tooltip
      className="fixed z-50 w-[min(460px,calc(100vw-24px))] rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl transition-opacity duration-150"
      style={{
        top: pos ? Math.max(12, pos.top) : '-9999px',
        left: pos ? Math.max(12, pos.left) : '-9999px',
        opacity: pos ? 1 : 0,
        pointerEvents: pos ? 'auto' : 'none',
      }}
      role="dialog"
      aria-label="Instant translation"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-medium text-slate-500">Selected</div>
          <div className="mt-1 max-h-14 overflow-hidden text-sm leading-snug text-slate-900">
            {data.text}
          </div>
        </div>
        <button
          type="button"
          className="rounded-lg px-2.5 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
          onClick={onClose}
        >
          Close
        </button>
      </div>

      <div className="mt-4 space-y-3">
        <div>
          <div className="text-xs font-medium text-slate-500">Translation</div>
          <div className="mt-1 text-sm leading-snug text-slate-900">
            {loading ? 'Translating…' : data.translatedText || '—'}
          </div>
        </div>

        <div>
          <div className="text-xs font-medium text-slate-500">Simple English</div>
          <div className="mt-1 text-sm leading-snug text-slate-900">
            {loading ? 'Explaining…' : data.simpleEnglish || '—'}
          </div>
        </div>

        {error ? <div className="text-sm text-red-600">{error}</div> : null}

        <div className="flex items-center justify-between pt-2">
          <button
            type="button"
            className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-900 shadow-sm hover:bg-slate-50 disabled:opacity-50"
            disabled={!canSave || data.saved}
            onClick={save}
          >
            {data.saved ? 'Saved' : 'Save to Vocabulary'}
          </button>
          <div className="text-xs text-slate-500">Esc to dismiss</div>
        </div>
      </div>
    </div>
  );
}
