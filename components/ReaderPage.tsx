'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PdfReader from '@/components/pdf/PdfReader';
import { Upload, BookA, Download, Maximize, Moon, Sun, Monitor, ArrowLeft } from 'lucide-react';
import { useTheme } from 'next-themes';
import screenfull from 'screenfull';

type TargetLanguage = {
  code: string;
  label: string;
};

const LANGUAGES: TargetLanguage[] = [
  { code: 'hi', label: 'Hindi' },
  { code: 'mr', label: 'Marathi' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
];

const STORAGE_KEY = 'readease.targetLanguage';
const VOCAB_KEY = 'readease.vocab';

type VocabItem = {
  text: string;
  translatedText: string;
  simpleEnglish: string;
  targetLang: string;
  savedAt: string;
};

export default function ReaderPage() {
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [targetLang, setTargetLang] = useState<string>('hi');
  const [vocab, setVocab] = useState<VocabItem[]>([]);
  const [vocabOpen, setVocabOpen] = useState(false);
  const vocabPanelRef = useRef<HTMLDivElement | null>(null);
  const loadVocabRef = useRef<() => void>(() => undefined);

  const loadVocab = useCallback(() => {
    try {
      const raw = window.localStorage.getItem(VOCAB_KEY);
      const parsed = raw ? (JSON.parse(raw) as unknown) : [];
      if (!Array.isArray(parsed)) {
        setVocab([]);
        return;
      }
      setVocab(parsed as VocabItem[]);
    } catch {
      setVocab([]);
    }
  }, []);

  useEffect(() => {
    loadVocabRef.current = loadVocab;
  }, [loadVocab]);

  const persistVocab = (next: VocabItem[]) => {
    try {
      const sliced = next.slice(0, 200);
      window.localStorage.setItem(VOCAB_KEY, JSON.stringify(sliced));
      setVocab(sliced);
      window.dispatchEvent(
        new CustomEvent('readease:vocab-updated', {
          detail: { items: sliced },
        })
      );
      document.dispatchEvent(
        new CustomEvent('readease:vocab-updated', {
          detail: { items: sliced },
        })
      );
    } catch {
      // ignore
    }
  };

  const deleteVocabItem = (savedAt: string) => {
    const next = vocab.filter((v) => v.savedAt !== savedAt);
    persistVocab(next);
  };

  const shareVocabPdf = async () => {
    try {
      const { jsPDF } = await import('jspdf');
      const doc = new jsPDF({ unit: 'pt', format: 'a4' });

      const margin = 40;
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const contentWidth = pageWidth - margin * 2;

      const date = new Date();
      const dateStr = date.toISOString().slice(0, 10);

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(16);
      doc.text('ReadEase Vocabulary', margin, 52);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      doc.setTextColor(100);
      doc.text(`${vocab.length} items • ${dateStr}`, margin, 70);
      doc.setTextColor(0);

      let y = 96;
      const addPageIfNeeded = (nextY: number) => {
        if (nextY <= pageHeight - margin) return;
        doc.addPage();
        y = margin;
      };

      const hasNonAscii = (value: string) => /[^\x00-\x7F]/.test(value);

      const wrapTextForCanvas = (
        ctx: CanvasRenderingContext2D,
        value: string,
        maxWidth: number
      ) => {
        const words = value.split(/\s+/).filter(Boolean);
        const lines: string[] = [];
        if (words.length === 0) return [''];

        let line = '';
        for (const w of words) {
          const next = line ? `${line} ${w}` : w;
          if (ctx.measureText(next).width <= maxWidth) {
            line = next;
            continue;
          }
          if (line) lines.push(line);

          // If a single "word" is too long (no spaces / long token), split by characters.
          if (ctx.measureText(w).width > maxWidth) {
            let chunk = '';
            for (const ch of Array.from(w)) {
              const nextChunk = chunk + ch;
              if (ctx.measureText(nextChunk).width <= maxWidth) {
                chunk = nextChunk;
              } else {
                if (chunk) lines.push(chunk);
                chunk = ch;
              }
            }
            line = chunk;
          } else {
            line = w;
          }
        }

        if (line) lines.push(line);
        return lines;
      };

      const addValuePossiblyAsImage = (
        value: string,
        fontSize: number,
        maxWidthPt: number
      ) => {
        const safeValue = value || '—';
        if (!hasNonAscii(safeValue)) {
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(fontSize);
          const lines = doc.splitTextToSize(safeValue, maxWidthPt);
          addPageIfNeeded(y + lines.length * 14);
          doc.text(lines, margin, y);
          y += lines.length * 14 + 10;
          return;
        }

        // Render unicode text via canvas to keep glyphs correct without bundling font files.
        const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          // Fallback: attempt plain text anyway.
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(fontSize);
          const lines = doc.splitTextToSize(safeValue, maxWidthPt);
          addPageIfNeeded(y + lines.length * 14);
          doc.text(lines, margin, y);
          y += lines.length * 14 + 10;
          return;
        }

        const padding = 2;
        const fontPx = Math.round(fontSize * 1.25);
        const lineHeightPx = Math.round(fontPx * 1.35);

        // Convert points to pixels roughly (96dpi baseline). Good enough for PDF embedding.
        const maxWidthPx = Math.max(1, Math.round((maxWidthPt * 96) / 72));

        ctx.font = `${fontPx}px system-ui, -apple-system, "Segoe UI", Arial, sans-serif`;
        ctx.textBaseline = 'top';

        const lines = wrapTextForCanvas(ctx, safeValue, maxWidthPx);
        const heightPx = lines.length * lineHeightPx + padding * 2;

        canvas.width = (maxWidthPx + padding * 2) * dpr;
        canvas.height = heightPx * dpr;

        // Re-apply after resize.
        const ctx2 = canvas.getContext('2d');
        if (!ctx2) return;
        ctx2.scale(dpr, dpr);
        ctx2.fillStyle = '#ffffff';
        ctx2.fillRect(0, 0, maxWidthPx + padding * 2, heightPx);
        ctx2.fillStyle = '#000000';
        ctx2.font = `${fontPx}px system-ui, -apple-system, "Segoe UI", Arial, sans-serif`;
        ctx2.textBaseline = 'top';

        let yy = padding;
        for (const line of lines) {
          ctx2.fillText(line, padding, yy);
          yy += lineHeightPx;
        }

        const dataUrl = canvas.toDataURL('image/png');

        // Compute image size in points to fit maxWidthPt.
        const heightPt = (heightPx * 72) / 96;
        addPageIfNeeded(y + heightPt);
        doc.addImage(dataUrl, 'PNG', margin, y, maxWidthPt, heightPt);
        y += heightPt + 10;
      };

      const addBlock = (label: string, value: string) => {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        addPageIfNeeded(y + 18);
        doc.text(label, margin, y);
        y += 14;

        addValuePossiblyAsImage(value, 11, contentWidth);
      };

      const items = vocab.slice(0, 200);
      if (items.length === 0) {
        doc.setFontSize(12);
        doc.text('No saved items yet.', margin, y);
      } else {
        for (const item of items) {
          addPageIfNeeded(y + 10);
          doc.setDrawColor(226);
          doc.line(margin, y, pageWidth - margin, y);
          y += 16;

          addBlock('Selected', item.text);
          addBlock('Translation', item.translatedText);
          addBlock('Simple English', item.simpleEnglish);
        }
      }

      const blob = doc.output('blob');
      const fileName = `readease-vocab-${dateStr}.pdf`;
      const file = new File([blob], fileName, { type: 'application/pdf' });

      const nav = navigator as unknown as {
        share?: (data: unknown) => Promise<void>;
        canShare?: (data: unknown) => boolean;
      };

      const downloadFallback = () => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      };

      // Try Web Share first; if it fails for any reason, fall back to download.
      if (typeof nav.share === 'function') {
        const canShareFiles =
          typeof nav.canShare === 'function'
            ? nav.canShare({ files: [file] })
            : true;

        if (canShareFiles) {
          try {
            await nav.share({ title: 'ReadEase Vocabulary', files: [file] });
            return;
          } catch (e) {
            // If user cancels share, don't download.
            if (e instanceof DOMException && e.name === 'AbortError') return;
            downloadFallback();
            return;
          }
        }
      }

      downloadFallback();
    } catch {
      // fail silently
    }
  };

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved) setTargetLang(saved);
  }, []);

  useEffect(() => {
    if (!vocabOpen) return;

    // Fallback: while the panel is open, keep it in sync even if
    // some environment blocks CustomEvent delivery.
    const interval = window.setInterval(() => {
      loadVocabRef.current();
    }, 500);

    const onPointerDown = (e: PointerEvent) => {
      const el = vocabPanelRef.current;
      if (!el) return;
      if (el.contains(e.target as Node)) return;
      setVocabOpen(false);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setVocabOpen(false);
    };

    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [vocabOpen]);

  useEffect(() => {
    loadVocab();

    const onUpdated = (e: Event) => {
      const ce = e as CustomEvent<{ items?: unknown } | undefined>;
      const items = ce.detail?.items;
      if (Array.isArray(items)) {
        setVocab(items as VocabItem[]);
        return;
      }
      loadVocab();
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === VOCAB_KEY) loadVocab();
    };

    window.addEventListener('readease:vocab-updated', onUpdated as EventListener);
    document.addEventListener(
      'readease:vocab-updated',
      onUpdated as unknown as EventListener
    );
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(
        'readease:vocab-updated',
        onUpdated as EventListener
      );
      document.removeEventListener(
        'readease:vocab-updated',
        onUpdated as unknown as EventListener
      );
      window.removeEventListener('storage', onStorage);
    };
  }, [loadVocab]);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, targetLang);
  }, [targetLang]);

  useEffect(() => {
    return () => {
      if (fileUrl) URL.revokeObjectURL(fileUrl);
    };
  }, [fileUrl]);

  const languageOptions = useMemo(
    () =>
      LANGUAGES.map((lang) => (
        <option key={lang.code} value={lang.code}>
          {lang.label}
        </option>
      )),
    []
  );

  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isFocusMode, setIsFocusMode] = useState(false);

  useEffect(() => {
    setMounted(true);
    if (screenfull.isEnabled) {
      screenfull.on('change', () => {
        setIsFullscreen(screenfull.isFullscreen);
        if (!screenfull.isFullscreen) {
          setIsFocusMode(false);
        }
      });
    }
  }, []);

  const toggleFullscreen = () => {
    if (screenfull.isEnabled) {
      screenfull.toggle();
    }
  };

  const toggleFocusMode = () => {
    setIsFocusMode((prev) => !prev);
  };

  return (
    <div className={`flex h-full flex-col ${isFocusMode ? 'focus-mode-active' : ''}`}>
      {/* Top Navbar */}
      <header
        className={`flex h-auto min-h-14 flex-nowrap shrink-0 items-center justify-between gap-2 border-b border-white/10 bg-slate-900 px-2 sm:px-4 py-2 sm:py-0 text-slate-200 transition-transform duration-300 overflow-x-auto readease-scrollbar-hide ${
          isFocusMode ? '-translate-y-full opacity-0 absolute w-full z-0' : 'translate-y-0 opacity-100 relative z-10'
        }`}
      >
        <div className="flex items-center gap-2 sm:gap-4 shrink-0">
          <div className="flex items-center gap-1 sm:gap-2">
            <BookA className="h-5 w-5 text-blue-400 shrink-0" />
            <span className="text-base sm:text-lg font-bold tracking-tight text-white">ReadEase</span>
          </div>

          <div className="hidden sm:block h-4 w-px bg-white/20" />
        </div>

        <div className="flex flex-1 sm:flex-none items-center justify-end gap-2 sm:gap-3 overflow-x-auto readease-scrollbar-hide">
          <div className="flex items-center gap-1 sm:gap-2 shrink-0">
            <span className="hidden sm:inline text-sm text-slate-400">Translate:</span>
            <select
              id="targetLang"
              name="targetLang"
              className="h-7 sm:h-8 rounded-md border border-white/20 bg-slate-800 px-1 sm:px-2 text-xs sm:text-sm text-white shadow-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
              value={targetLang}
              onChange={(e) => setTargetLang(e.target.value)}
              aria-label="Target translation language"
            >
              {languageOptions}
            </select>
          </div>

          <div className="h-4 w-px bg-white/20 shrink-0" />

          {mounted && (
            <div className="flex items-center gap-0.5 sm:gap-1 shrink-0">
              <button
                type="button"
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/10 hover:text-white shrink-0"
                title="Toggle theme"
              >
                {theme === 'dark' ? <Sun className="h-3 w-3 sm:h-4 sm:w-4" /> : <Moon className="h-3 w-3 sm:h-4 sm:w-4" />}
              </button>

              <button
                type="button"
                onClick={toggleFocusMode}
                className={`rounded-md p-1.5 transition-colors hover:bg-white/10 hover:text-white shrink-0 ${isFocusMode ? 'text-blue-400' : 'text-slate-400'}`}
                title="Toggle Focus Mode"
              >
                <BookA className="h-3 w-3 sm:h-4 sm:w-4" />
              </button>

              <button
                type="button"
                onClick={toggleFullscreen}
                className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/10 hover:text-white shrink-0"
                title="Toggle fullscreen"
              >
                {isFullscreen ? <Monitor className="h-3 w-3 sm:h-4 sm:w-4 text-blue-400" /> : <Maximize className="h-3 w-3 sm:h-4 sm:w-4" />}
              </button>
            </div>
          )}

          <div className="relative ml-1 sm:ml-2 shrink-0" ref={vocabPanelRef}>
            <button
              type="button"
              className="flex h-7 sm:h-8 items-center gap-1 sm:gap-2 rounded-md bg-blue-600 px-2 sm:px-3 text-xs sm:text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700"
              onClick={() => {
                loadVocab();
                setVocabOpen((v) => !v);
              }}
            >
              Vocab <span className="p-0.5 bg-white/20 rounded text-[10px] sm:text-xs leading-none">{vocab.length}</span>
            </button>

            {vocabOpen ? (
              <div className="absolute right-0 top-10 z-50 w-[min(520px,calc(100vw-24px))] overflow-hidden rounded-xl border border-white/10 bg-slate-800 shadow-2xl">
                <div className="flex items-start justify-between gap-3 border-b border-white/10 p-3">
                  <div>
                    <div className="text-sm font-medium text-white">Saved Vocabulary</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="flex items-center gap-1 rounded bg-blue-600 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-700"
                      onClick={shareVocabPdf}
                    >
                      <Download className="h-3 w-3" />
                      PDF
                    </button>
                    <button
                      type="button"
                      className="rounded px-2 py-1 text-xs text-slate-400 hover:bg-white/10 hover:text-white"
                      onClick={() => setVocabOpen(false)}
                    >
                      Close
                    </button>
                  </div>
                </div>

                {vocab.length === 0 ? (
                  <div className="p-6 text-center text-sm text-slate-400">
                    No saved items yet. Select text in the PDF to save.
                  </div>
                ) : (
                  <div className="max-h-96 overflow-auto">
                    <ul className="divide-y divide-white/5">
                      {vocab.slice(0, 200).map((item, idx) => (
                        <li key={`${item.savedAt}-${idx}`} className="group p-4 transition-colors hover:bg-white/5">
                          <div className="flex items-start justify-between gap-3">
                            <div className="text-sm font-medium text-blue-200">{item.text}</div>
                            <button
                              type="button"
                              className="shrink-0 rounded px-2 py-1 text-xs font-medium text-red-400 opacity-0 transition-opacity hover:bg-red-400/10 group-hover:opacity-100"
                              onClick={() => deleteVocabItem(item.savedAt)}
                            >
                              Remove
                            </button>
                          </div>
                          <div className="mt-1 text-sm text-white">{item.translatedText}</div>
                          <div className="mt-1 text-xs text-slate-400">{item.simpleEnglish}</div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <div className={`relative flex flex-1 flex-col overflow-hidden bg-slate-200 dark:bg-slate-900 transition-colors duration-300 ${isFocusMode ? '!bg-slate-950 dark:!bg-black pointer-events-auto z-20 absolute inset-0' : ''}`}>
        
        {/* Exit Focus Mode Floating Button */}
        {isFocusMode && (
          <button
            onClick={toggleFocusMode}
            className="absolute left-2 top-2 md:left-6 md:top-6 z-[100] flex items-center gap-1.5 md:gap-2 rounded-full border border-white/10 bg-slate-800/90 px-3 py-1.5 md:px-4 md:py-2 text-xs md:text-sm font-medium text-white shadow-xl backdrop-blur-md transition-all hover:bg-slate-700 hover:scale-105"
          >
            <ArrowLeft className="h-3.5 w-3.5 md:h-4 md:w-4" />
            <span className="hidden sm:inline">Exit Reading Mode</span>
            <span className="inline sm:hidden">Exit</span>
          </button>
        )}

        {!fileUrl ? (
          <label className="flex h-full w-full cursor-pointer flex-col items-center justify-center text-slate-500 transition-colors hover:text-slate-300">
            <Upload className="mb-4 h-12 w-12 opacity-50" />
            <p>Upload a PDF to start reading</p>
            <input
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null;
                if (!file) return;
                const url = URL.createObjectURL(file);
                setFileUrl(url);
              }}
            />
          </label>
        ) : (
          <PdfReader fileUrl={fileUrl} targetLang={targetLang} isFocusMode={isFocusMode} toggleFocusMode={toggleFocusMode} />
        )}
      </div>
    </div>
  );
}
