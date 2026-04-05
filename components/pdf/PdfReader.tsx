'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import SelectionTooltip, { TooltipData } from '@/components/tooltip/SelectionTooltip';
import { BookOpen } from 'lucide-react';
import PdfPageItem from './PdfPageItem';

import { useTheme } from 'next-themes';

type ReactPdfModule = {
  Document: (props: any) => ReactNode;
  Page: (props: any) => ReactNode;
  pdfjs: { GlobalWorkerOptions: { workerSrc: string } };
};

type Props = {
  fileUrl: string;
  targetLang: string;
  isFocusMode?: boolean;
  toggleFocusMode?: () => void;
};

const INITIAL_PAGES = 3;
const PAGE_BATCH = 3;
const NEAR_BOTTOM_PX = 1200;
const SELECTION_DEBOUNCE_MS = 200;
const CLICK_MOVE_THRESHOLD_PX = 6;
const LONG_PRESS_MS = 450;

function normalizeSelectedText(raw: string) {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  const withoutLeading = collapsed.replace(/^[\"“”'‘’\(\[\{<]+/g, '');

  // For short selections (single word / short phrase), strip trailing punctuation.
  // For longer selections (sentences), keep punctuation so it feels complete.
  const shouldStripTrailingPunct = withoutLeading.length <= 40;
  const withoutTrailing = shouldStripTrailingPunct
    ? withoutLeading.replace(/[\"“”'‘’\)\]\}>,;:!?\.]+$/g, '')
    : withoutLeading;

  return withoutTrailing.trim();
}

function getCaretRangeFromPoint(x: number, y: number): Range | null {
  const doc = document as unknown as {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (
      x: number,
      y: number
    ) => { offsetNode: Node; offset: number } | null;
  };

  if (typeof doc.caretRangeFromPoint === 'function') {
    return doc.caretRangeFromPoint(x, y);
  }

  if (typeof doc.caretPositionFromPoint === 'function') {
    const pos = doc.caretPositionFromPoint(x, y);
    if (!pos) return null;
    const range = document.createRange();
    range.setStart(pos.offsetNode, pos.offset);
    range.collapse(true);
    return range;
  }

  return null;
}

function isPdfTextLayerElement(el: Element) {
  return (el as HTMLElement).closest?.('.react-pdf__Page__textContent') != null;
}

function isWordChar(ch: string) {
  return /[A-Za-z0-9]/.test(ch) || ch === "'" || ch === '-';
}

function isSentenceBoundaryChar(ch: string) {
  // Keep it simple: most PDFs are English; include a few common sentence terminators.
  return ch === '.' || ch === '!' || ch === '?' || ch === '।' || ch === '…';
}

function isWhitespaceChar(ch: string) {
  return ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === '\f';
}

function getTextNodesUnder(root: HTMLElement): Text[] {
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (tw.nextNode()) {
    const n = tw.currentNode;
    if (n.nodeType === Node.TEXT_NODE) nodes.push(n as Text);
  }
  return nodes;
}

function coerceTextPosition(
  node: Node,
  offset: number,
  root: HTMLElement
): { textNode: Text; offset: number } | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const t = node as Text;
    return { textNode: t, offset: Math.max(0, Math.min(offset, t.data.length)) };
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as Element;

  // Try to pick a nearby child and then descend to a text node.
  const childNodes = Array.from(el.childNodes);
  const candidate =
    childNodes[Math.min(offset, Math.max(0, childNodes.length - 1))] ??
    childNodes[Math.max(0, offset - 1)] ??
    null;

  const start = (candidate ?? el) as Node;
  const tw = document.createTreeWalker(start, NodeFilter.SHOW_TEXT);
  const first = tw.nextNode() as Text | null;
  if (first) return { textNode: first, offset: 0 };

  // As a last resort, pick the closest text node in the entire root.
  const all = getTextNodesUnder(root);
  const fallback = all[0];
  if (!fallback) return null;
  return { textNode: fallback, offset: 0 };
}

function getTextLayerRoot(el: Element): HTMLElement | null {
  return ((el as HTMLElement).closest?.(
    '.react-pdf__Page__textContent'
  ) ?? null) as HTMLElement | null;
}

function expandRangeToWordAcrossTextNodes(
  caret: Range,
  root: HTMLElement
): Range | null {
  const container = caret.startContainer;
  if (container.nodeType !== Node.TEXT_NODE) return null;
  const node = container as Text;
  const nodeText = node.data;
  if (!nodeText) return null;

  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (tw.nextNode()) {
    const n = tw.currentNode;
    if (n.nodeType === Node.TEXT_NODE) textNodes.push(n as Text);
  }
  const nodeIndex = textNodes.indexOf(node);
  if (nodeIndex < 0) return null;

  let offset = caret.startOffset;
  if (offset > nodeText.length) offset = nodeText.length;

  // Find a word character at/near caret.
  let charIndex: number | null = null;
  if (offset > 0 && isWordChar(nodeText[offset - 1] ?? '')) {
    charIndex = offset - 1;
  } else if (offset < nodeText.length && isWordChar(nodeText[offset] ?? '')) {
    charIndex = offset;
  }
  if (charIndex == null) return null;

  let startNode: Text = node;
  let startNodeIndex = nodeIndex;
  let startOffset = charIndex;
  while (true) {
    if (startOffset === 0) {
      if (startNodeIndex === 0) break;
      startNodeIndex -= 1;
      startNode = textNodes[startNodeIndex]!;
      startOffset = startNode.data.length;
    }
    const prevChar = startNode.data[startOffset - 1] ?? '';
    if (!isWordChar(prevChar)) break;
    startOffset -= 1;
  }

  let endNode: Text = node;
  let endNodeIndex = nodeIndex;
  let endOffset = charIndex + 1;
  while (true) {
    if (endOffset >= endNode.data.length) {
      if (endNodeIndex >= textNodes.length - 1) break;
      endNodeIndex += 1;
      endNode = textNodes[endNodeIndex]!;
      endOffset = 0;
    }
    const nextChar = endNode.data[endOffset] ?? '';
    if (!isWordChar(nextChar)) break;
    endOffset += 1;
  }

  const wordRange = document.createRange();
  wordRange.setStart(startNode, startOffset);
  wordRange.setEnd(endNode, endOffset);
  return wordRange;
}

function expandRangeToSentenceAcrossTextNodes(
  caret: Range,
  root: HTMLElement
): Range | null {
  const textNodes = getTextNodesUnder(root);
  if (textNodes.length === 0) return null;

  const coerced = coerceTextPosition(caret.startContainer, caret.startOffset, root);
  if (!coerced) return null;

  const nodeIndex = textNodes.indexOf(coerced.textNode);
  if (nodeIndex < 0) return null;

  // Flatten text for robust scanning across many spans.
  const lengths = textNodes.map((n) => n.data.length);
  const prefix: number[] = new Array(lengths.length + 1);
  prefix[0] = 0;
  for (let i = 0; i < lengths.length; i += 1) prefix[i + 1] = prefix[i]! + lengths[i]!;

  const totalLen = prefix[prefix.length - 1] ?? 0;
  if (totalLen === 0) return null;

  const clamp = (v: number) => Math.max(0, Math.min(v, totalLen));
  const baseIndex = clamp(prefix[nodeIndex]! + Math.max(0, coerced.offset));

  const full = textNodes.map((n) => n.data).join('');

  const nextNonSpaceIndex = (from: number) => {
    for (let i = from; i < full.length; i += 1) {
      const ch = full[i] ?? '';
      if (!isWhitespaceChar(ch)) return i;
    }
    return -1;
  };

  const prevNonSpaceIndex = (from: number) => {
    for (let i = from; i >= 0; i -= 1) {
      const ch = full[i] ?? '';
      if (!isWhitespaceChar(ch)) return i;
    }
    return -1;
  };

  const isTrueSentenceEndAt = (boundaryIndex: number) => {
    const ch = full[boundaryIndex] ?? '';
    if (!isSentenceBoundaryChar(ch)) return false;
    if (ch === '!' || ch === '?' || ch === '।' || ch === '…') return true;

    // For '.', use a heuristic to avoid abbreviations/decimals:
    // Treat as sentence end if next non-space char is uppercase/quote/bracket or end-of-text.
    const prevIdx = prevNonSpaceIndex(boundaryIndex - 1);
    const nextIdx = nextNonSpaceIndex(boundaryIndex + 1);

    const prev = prevIdx >= 0 ? (full[prevIdx] ?? '') : '';
    const next = nextIdx >= 0 ? (full[nextIdx] ?? '') : '';

    // Decimal number: 3.14
    if (/[0-9]/.test(prev) && /[0-9]/.test(next)) return false;
    // Common abbreviation pattern: "e.g." -> next is lowercase.
    if (next && /[a-z]/.test(next)) return false;
    // End of text or next starts a new sentence.
    if (!next) return true;
    if (/[A-Z]/.test(next)) return true;
    if ('"“”\'‘’(['.includes(next)) return true;
    return false;
  };

  const maxScan = 1200;

  // Find sentence end.
  let endIndex = -1;
  const forwardStart = Math.max(0, baseIndex);
  for (let i = forwardStart; i < full.length && i < forwardStart + maxScan; i += 1) {
    if (isTrueSentenceEndAt(i)) {
      endIndex = i + 1; // include boundary
      break;
    }
  }
  if (endIndex < 0) endIndex = clamp(forwardStart + maxScan);

  // Find sentence start (search backward for previous true sentence end).
  let startIndex = 0;
  const backwardStart = Math.min(full.length - 1, baseIndex);
  for (let i = backwardStart; i >= 0 && i > backwardStart - maxScan; i -= 1) {
    if (isTrueSentenceEndAt(i)) {
      startIndex = i + 1;
      break;
    }
  }

  // Skip leading whitespace.
  const firstNonSpace = nextNonSpaceIndex(startIndex);
  if (firstNonSpace >= 0) startIndex = firstNonSpace;

  const toNodeOffset = (globalIndex: number) => {
    const idx = clamp(globalIndex);
    // Find largest j such that prefix[j] <= idx.
    let lo = 0;
    let hi = prefix.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if ((prefix[mid] ?? 0) <= idx) lo = mid;
      else hi = mid - 1;
    }

    const nodeIdx = Math.min(textNodes.length - 1, Math.max(0, lo - 1));
    const nodeStart = prefix[nodeIdx] ?? 0;
    const off = Math.max(0, Math.min(idx - nodeStart, textNodes[nodeIdx]!.data.length));
    return { node: textNodes[nodeIdx]!, offset: off };
  };

  const start = toNodeOffset(startIndex);
  const end = toNodeOffset(endIndex);

  const sentenceRange = document.createRange();
  sentenceRange.setStart(start.node, start.offset);
  sentenceRange.setEnd(end.node, end.offset);
  return sentenceRange;
}

function expandRangeToWord(range: Range): Range | null {
  const container = range.startContainer;
  if (container.nodeType !== Node.TEXT_NODE) return null;
  const node = container as Text;
  const text = node.data;
  if (!text) return null;

  let idx = range.startOffset;
  if (idx >= text.length) idx = Math.max(0, text.length - 1);
  if (!isWordChar(text[idx] ?? '')) return null;

  let start = idx;
  while (start > 0 && isWordChar(text[start - 1]!)) start -= 1;

  let end = idx;
  while (end < text.length && isWordChar(text[end]!)) end += 1;

  const wordRange = document.createRange();
  wordRange.setStart(node, start);
  wordRange.setEnd(node, end);
  return wordRange;
}

type SelectGranularity = 'word' | 'sentence';

function selectionIsInside(container: HTMLElement, selection: Selection) {
  if (selection.rangeCount < 1) return false;
  const range = selection.getRangeAt(0);
  const common = range.commonAncestorContainer;
  return container.contains(common);
}

export default function PdfReader({ fileUrl, targetLang, isFocusMode, toggleFocusMode }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sidebarRef = useRef<HTMLDivElement | null>(null);
  const [reactPdf, setReactPdf] = useState<ReactPdfModule | null>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [renderedPages, setRenderedPages] = useState<number>(0);

  const numPagesRef = useRef(0);
  const renderedPagesRef = useRef(0);
  const currentPageRef = useRef(1);
  // baseWidth = the container's pixel width, updated by ResizeObserver.
  // The PDF page renders at exactly this width (× committedZoom) so it always
  // fits the viewport without horizontal scroll on any device.
  const [baseWidth, setBaseWidth] = useState<number>(800);
  // zoomScale  = live visual scale — updated immediately on every wheel/pinch tick.
  // committedZoom = scale the canvas actually renders at — debounced 250 ms after input stops.
  // CSS transform bridges the gap between the two so the view feels instant.
  // Scroll correction fires ONCE (single RAF) only when committedZoom settles — no fighting.
  const [zoomScale, setZoomScale] = useState<number>(1);
  const [committedZoom, setCommittedZoom] = useState<number>(1);
  const zoomScaleRef = useRef(1);
  const committedZoomRef = useRef(1);
  const zoomAnchorRef = useRef<{
    contentX: number;
    contentY: number;
    viewportX: number;
    viewportY: number;
  } | null>(null);
  const isTransientZoomRef = useRef(false);
  const commitRafRef = useRef<number | null>(null);
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync refs so the wheel handler closure always has current values.
  useEffect(() => {
    zoomScaleRef.current = zoomScale;
  }, [zoomScale]);
  useEffect(() => {
    committedZoomRef.current = committedZoom;
  }, [committedZoom]);

  // When committedZoom changes (canvas re-renders at new size), correct scroll ONCE
  // using a single RAF so it runs in the same paint cycle as the new canvas layout.
  // IMPORTANT: isTransientZoomRef stays TRUE through this entire block so that
  // the 'scroll' event we dispatch at the end is ignored by handleScroll (preventing
  // the currentPage→sidebar→thumbRange reset chain).
  useEffect(() => {
    if (commitRafRef.current) cancelAnimationFrame(commitRafRef.current);
    // Mark transient BEFORE the RAF so any scroll events that fire during zoom
    // apply here are suppressed.
    isTransientZoomRef.current = true;
    commitRafRef.current = requestAnimationFrame(() => {
      commitRafRef.current = null;
      const container = containerRef.current;
      if (!container) {
        isTransientZoomRef.current = false;
        return;
      }
      const anchor = zoomAnchorRef.current;

      if (anchor) {
        // anchor.contentX/Y are in normalized page-space (pixels ÷ zoom at capture time).
        // Multiply by new committedZoom to get the correct pixel position in the new layout.
        container.scrollLeft = Math.max(0, anchor.contentX * committedZoom - anchor.viewportX);
        container.scrollTop  = Math.max(0, anchor.contentY * committedZoom - anchor.viewportY);
        zoomAnchorRef.current = null;
      }

      // Clear the transient flag AFTER a short delay so the scroll event
      // we're about to dispatch (and any layout-triggered scrolls) are suppressed.
      // Then fire a real scroll to sync currentPage with the settled position.
      setTimeout(() => {
        isTransientZoomRef.current = false;
        const c = containerRef.current;
        if (c) c.dispatchEvent(new Event('scroll'));
      }, 80);
    });
  }, [committedZoom]);

  const [currentPage, setCurrentPage] = useState<number>(1);

  // Keep stable refs in sync so callbacks don't need them in their dependency arrays.
  useEffect(() => { numPagesRef.current = numPages; }, [numPages]);
  useEffect(() => { renderedPagesRef.current = renderedPages; }, [renderedPages]);
  useEffect(() => { currentPageRef.current = currentPage; }, [currentPage]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [isReadingMode, setIsReadingMode] = useState(false);
  const [fontSize, setFontSize] = useState<number>(16);
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [pagesText, setPagesText] = useState<Record<number, string>>({});

  useEffect(() => {
    try {
      const saved = localStorage.getItem('readease.fontSize');
      if (saved) {
        const val = parseInt(saved, 10);
        if (!isNaN(val) && val >= 14 && val <= 28) {
          setFontSize(val);
        }
      }
    } catch {}
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('readease.fontSize', fontSize.toString());
    } catch {}
  }, [fontSize]);

  useEffect(() => {
    if (!isReadingMode || !pdfDoc) return;
    const extractText = async () => {
      for (let i = 1; i <= renderedPages; i++) {
        if (pagesText[i] !== undefined) continue;
        try {
          const page = await pdfDoc.getPage(i);
          const content = await page.getTextContent();
          let currentText = '';
          let lastY = -1;
            let lastX = -1;
            let lastWidth = 0;
            let isFirstInLine = true;
            content.items.forEach((item: any) => {
              const x = item.transform[4];
              const y = item.transform[5];
              const height = item.transform[0];

              if (lastY !== -1 && Math.abs(lastY - y) > 12) {
                currentText += '\n';
                isFirstInLine = true;
              } else if (!isFirstInLine && lastX !== -1) {
                if (x - (lastX + lastWidth) > height * 0.25) {
                  currentText += ' ';
                }
              }
              
              currentText += item.str;
              if (item.hasEOL) {
                currentText += '\n';
                isFirstInLine = true;
              } else {
                isFirstInLine = false;
              }
              
              lastY = y;
              lastX = x;
              lastWidth = item.width || 0;
            });

          // Cleanup overlapping lines and hyphenated breaks
          let cleanText = currentText
            .replace(/-\n\s*/g, '') // remove hyphens across lines
            .replace(/([^\n])\n([^\n])/g, '$1 $2') // stitch regular lines together
            .replace(/\n\n+/g, '\n\n') // preserve paragraph breaks
            .replace(/\s\s+/g, ' ') // condense spaces
            .trim();
            
          setPagesText(prev => ({ ...prev, [i]: cleanText || currentText }));
        } catch (err) {
          setPagesText(prev => ({ ...prev, [i]: 'Failed to extract text.' }));
        }
      }
    };
    extractText();
  }, [isReadingMode, pdfDoc, renderedPages, pagesText]);

  const [pageInput, setPageInput] = useState('1');
  const pageInputEditingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (typeof Promise !== 'undefined' && !(Promise as any).withResolvers) {
          (Promise as any).withResolvers = function withResolvers<T>() {
            let resolve!: (value: T | PromiseLike<T>) => void;
            let reject!: (reason?: unknown) => void;
            const promise = new Promise<T>((res, rej) => {
              resolve = res;
              reject = rej;
            });
            return { promise, resolve, reject };
          };
        }

        const mod = (await import('react-pdf')) as unknown as ReactPdfModule;
        if (cancelled) return;
        mod.pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          'pdfjs-dist/build/pdf.worker.min.mjs',
          import.meta.url
        ).toString();
        setReactPdf(mod);
      } catch {
        if (cancelled) return;
        setError('Failed to load PDF renderer');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const translationCacheRef = useRef(
    new Map<string, { translatedText: string; simpleEnglish: string }>()
  );
  const abortRef = useRef<AbortController | null>(null);
  const selectionTimerRef = useRef<number | null>(null);
  const lastScheduledKeyRef = useRef<string | null>(null);
  const scrollRafRef = useRef<number | null>(null);

  const pageRefs = useRef<Array<HTMLDivElement | null>>([]);
  const sidebarRafRef = useRef<number | null>(null);
  // Gate sidebar auto-scroll: only scrollIntoView when the user actually navigates
  // (not during zoom which can temporarily reset currentPage).
  const sidebarAutoScrollRef = useRef(false);
  const [sidebarScrollTop, setSidebarScrollTop] = useState(0);
  const [sidebarHeight, setSidebarHeight] = useState(600);

  const pointerDownRef = useRef<{ x: number; y: number } | null>(null);
  const pointerMovedRef = useRef(false);
  const longPressTimerRef = useRef<number | null>(null);
  const didLongPressSelectRef = useRef(false);
  const lastSelectionTextRef = useRef<string>('');

  const ignoreAbortTextLayerError = useCallback((err: unknown) => {
    const anyErr = err as { name?: string; message?: string } | null;
    const name = anyErr?.name ?? '';
    const message = anyErr?.message ?? String(err ?? '');
    const isAbort =
      name === 'AbortError' ||
      name === 'AbortException' ||
      message.includes('AbortException') ||
      message.includes('TextLayer task cancelled');

    if (isAbort) return;
    // Keep other errors visible in console for debugging.
    // eslint-disable-next-line no-console
    console.warn(err);
  }, []);

  useEffect(() => {
    const originalError = console.error;
    const originalWarn = console.warn;

    const shouldIgnore = (args: unknown[]) => {
      const msg = args.map((a) => String(a)).join(' ');
      return msg.includes('TextLayer task cancelled');
    };

    (console as unknown as { error: (...args: unknown[]) => void }).error = (
      ...args: unknown[]
    ) => {
      if (shouldIgnore(args)) return;
      originalError(...(args as []));
    };

    (console as unknown as { warn: (...args: unknown[]) => void }).warn = (
      ...args: unknown[]
    ) => {
      if (shouldIgnore(args)) return;
      originalWarn(...(args as []));
    };

    return () => {
      (console as unknown as { error: typeof originalError }).error = originalError;
      (console as unknown as { warn: typeof originalWarn }).warn = originalWarn;
    };
  }, []);

  const closeTooltip = useCallback(() => {
    if (selectionTimerRef.current) {
      window.clearTimeout(selectionTimerRef.current);
      selectionTimerRef.current = null;
    }
    abortRef.current?.abort();
    abortRef.current = null;
    setTooltip(null);
    setError(null);
    setLoading(false);
  }, []);

  // Keep baseWidth in sync with the container, leaving breathing room so the page
  // is visually centred via each page's flex justify-center wrapper.
  // IMPORTANT: only update when committedZoom === 1 to prevent the scrollbar
  // feedback loop that causes flickering during zoom.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const computeBaseWidth = (containerW: number) => {
      const isMobile = containerW < 640;
      if (isMobile) {
        // 4 px margin each side on mobile → page floats cleanly
        return Math.max(100, containerW - 8);
      }
      // Desktop: 24 px margin each side, capped at 900 px for comfortable reading
      return Math.max(100, Math.min(containerW - 48, 900));
    };

    const ro = new ResizeObserver((entries) => {
      // Skip while zoomed — scrollbar-induced width changes must not feed back.
      if (committedZoomRef.current !== 1) return;
      const entry = entries[0];
      if (!entry) return;
      const w = Math.floor(entry.contentRect.width);
      if (w > 0) setBaseWidth(computeBaseWidth(w));
    });
    ro.observe(container);
    // Seed immediately before first resize event fires.
    const initial = Math.floor(container.clientWidth);
    if (initial > 0) setBaseWidth(computeBaseWidth(initial));
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (pageInputEditingRef.current) return;
    setPageInput(String(currentPage));
  }, [currentPage]);

  const fetchMeaning = useCallback(
    async (text: string, clientRect: DOMRect) => {
      const cacheKey = `${targetLang}|${text}`;
      const cached = translationCacheRef.current.get(cacheKey);
      if (cached) {
        setError(null);
        setLoading(false);
        setTooltip({
          text,
          translatedText: cached.translatedText,
          simpleEnglish: cached.simpleEnglish,
          targetLang,
          rect: clientRect,
          saved: false,
        });
        return;
      }

      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      setLoading(true);
      setError(null);
      setTooltip({
        text,
        translatedText: '',
        simpleEnglish: '',
        targetLang,
        rect: clientRect,
        saved: false,
      });

      try {
        const res = await fetch('/api/translate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, targetLang }),
          signal: ac.signal,
        });

        const contentType = res.headers.get('content-type') ?? '';
        const body = contentType.includes('application/json')
          ? ((await res.json().catch(() => null)) as
              | { translatedText?: string; simpleEnglish?: string; error?: string }
              | null)
          : null;

        if (!res.ok) {
          throw new Error(body?.error ?? 'Translation failed');
        }

        if (!body?.translatedText || !body?.simpleEnglish) {
          throw new Error('Translation response was invalid');
        }

        translationCacheRef.current.set(cacheKey, {
          translatedText: body.translatedText,
          simpleEnglish: body.simpleEnglish,
        });

        setTooltip((prev) =>
          prev
            ? {
                ...prev,
                translatedText: body.translatedText ?? '',
                simpleEnglish: body.simpleEnglish ?? '',
              }
            : prev
        );
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof Error ? e.message : 'Something went wrong');
      } finally {
        setLoading(false);
      }
    },
    [targetLang]
  );

  const smartSelectAtPoint = useCallback(
    (clientX: number, clientY: number, granularity: SelectGranularity) => {
    const container = containerRef.current;
    if (!container) return;

    const el = document.elementFromPoint(clientX, clientY);
    if (!el) return;
    if (!container.contains(el)) return;
    if (!isPdfTextLayerElement(el)) return;

    const root = getTextLayerRoot(el);

    const caret = getCaretRangeFromPoint(clientX, clientY);
    if (!caret) return;

    const sel = window.getSelection();
    if (!sel) return;

    sel.removeAllRanges();
    sel.addRange(caret);

    // Prefer selection.modify when available: it expands across DOM nodes/spans.
    const anySel = sel as unknown as {
      modify?: (
        alter: 'move' | 'extend',
        direction: 'backward' | 'forward',
        granularity: 'word' | 'character' | 'sentence'
      ) => void;
    };

    if (typeof anySel.modify === 'function') {
      try {
        anySel.modify('move', 'backward', granularity);
        anySel.modify('extend', 'forward', granularity);
        const t = normalizeSelectedText(sel.toString());
        const ok = granularity === 'sentence' ? t.length >= 8 : t.length >= 2;
        if (ok) return;
      } catch {
        // ignore and fall back
      }
    }

    // Fallback only supports word (sentence across nodes is hard without selection.modify).
    if (!root) return;

    if (granularity === 'sentence') {
      const sentenceRange = expandRangeToSentenceAcrossTextNodes(caret, root);
      if (!sentenceRange) return;
      sel.removeAllRanges();
      sel.addRange(sentenceRange);
      return;
    }

    const wordRange =
      expandRangeToWordAcrossTextNodes(caret, root) ?? expandRangeToWord(caret);
    if (!wordRange) return;
    sel.removeAllRanges();
    sel.addRange(wordRange);
  },
    []
  );

  const scheduleSelection = useCallback((
    clientX?: number,
    clientY?: number,
    opts?: {
      preferSentence?: boolean;
      interaction?: 'click' | 'drag';
      immediate?: boolean;
    }
  ) => {
    const container = containerRef.current;
    if (!container) return;

    const selection = window.getSelection();
    const isClick =
      opts?.interaction === 'click'
        ? true
        : opts?.interaction === 'drag'
          ? false
          : clientX != null && clientY != null && !pointerMovedRef.current;

    // A click/tap should always select the word (or sentence on double-click),
    // regardless of any previous selection.
    if (isClick && clientX != null && clientY != null) {
      if (opts?.preferSentence) {
        smartSelectAtPoint(clientX, clientY, 'sentence');
      } else {
        smartSelectAtPoint(clientX, clientY, 'word');
      }
    }

    const text = normalizeSelectedText(window.getSelection()?.toString() ?? '');

    if (!selection || !text) {
      closeTooltip();
      return;
    }

    if (text.length > 300) {
      closeTooltip();
      return;
    }

    const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    if (!range) return;

    const common = range.commonAncestorContainer;
    if (!container.contains(common)) {
      closeTooltip();
      return;
    }

    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      closeTooltip();
      return;
    }

    const cacheKey = `${targetLang}|${text}`;
    lastScheduledKeyRef.current = cacheKey;

    if (selectionTimerRef.current) {
      window.clearTimeout(selectionTimerRef.current);
      selectionTimerRef.current = null;
    }

    if (opts?.immediate) {
      const currentText = normalizeSelectedText(
        window.getSelection()?.toString() ?? ''
      );
      if (currentText !== text) return;
      if (lastScheduledKeyRef.current !== cacheKey) return;
      void fetchMeaning(text, rect);
      return;
    }

    // Small debounce so dragging/adjusting selection stays smooth.
    selectionTimerRef.current = window.setTimeout(() => {
      const currentText = normalizeSelectedText(
        window.getSelection()?.toString() ?? ''
      );
      if (currentText !== text) return;
      if (lastScheduledKeyRef.current !== cacheKey) return;
      void fetchMeaning(text, rect);
    }, SELECTION_DEBOUNCE_MS);
  }, [closeTooltip, fetchMeaning, smartSelectAtPoint, targetLang]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      pointerDownRef.current = { x: e.clientX, y: e.clientY };
      pointerMovedRef.current = false;
      didLongPressSelectRef.current = false;

      if (longPressTimerRef.current) {
        window.clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }

      // Long-press (touch) selects sentence.
      if (e.pointerType === 'touch') {
        const x = e.clientX;
        const y = e.clientY;
        longPressTimerRef.current = window.setTimeout(() => {
          longPressTimerRef.current = null;
          if (pointerMovedRef.current) return;
          didLongPressSelectRef.current = true;
          scheduleSelection(x, y, {
            preferSentence: true,
            interaction: 'click',
            immediate: true,
          });
        }, LONG_PRESS_MS);
      }
    },
    [scheduleSelection]
  );

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const start = pointerDownRef.current;
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.hypot(dx, dy) > CLICK_MOVE_THRESHOLD_PX) {
      pointerMovedRef.current = true;

      if (longPressTimerRef.current) {
        window.clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
    }
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // For mouse, use onMouseUp (it aligns better with text selection updates in Chrome).
      if (e.pointerType === 'mouse') return;

      if (longPressTimerRef.current) {
        window.clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }

      // If a long-press already selected a sentence, don't override it on release.
      if (e.pointerType === 'touch' && didLongPressSelectRef.current) {
        didLongPressSelectRef.current = false;
        return;
      }

      const x = e.clientX;
      const y = e.clientY;

      const interaction = pointerMovedRef.current ? 'drag' : 'click';
      const immediate = interaction === 'click';

      // Defer to the next tick so we run *after* the browser updates selection.
      window.setTimeout(() => {
        scheduleSelection(
          interaction === 'click' ? x : undefined,
          interaction === 'click' ? y : undefined,
          { interaction, immediate }
        );
      }, 0);
    },
    [scheduleSelection]
  );

  const onMouseUp = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const x = e.clientX;
      const y = e.clientY;
      const interaction = pointerMovedRef.current ? 'drag' : 'click';
      const immediate = interaction === 'click';

      window.setTimeout(() => {
        scheduleSelection(
          interaction === 'click' ? x : undefined,
          interaction === 'click' ? y : undefined,
          { interaction, immediate }
        );
      }, 0);
    },
    [scheduleSelection]
  );

  const onDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const x = e.clientX;
      const y = e.clientY;
      window.setTimeout(() => {
        scheduleSelection(x, y, {
          preferSentence: true,
          interaction: 'click',
          immediate: true,
        });
      }, 0);
    },
    [scheduleSelection]
  );

  useEffect(() => {
    const onSelectionChange = () => {
      const container = containerRef.current;
      if (!container) return;

      const selection = window.getSelection();
      if (!selection) return;
      if (!selectionIsInside(container, selection)) return;

      const text = normalizeSelectedText(selection.toString());
      if (!text) return;
      if (text.length > 300) return;

      if (text === lastSelectionTextRef.current) return;
      lastSelectionTextRef.current = text;

      scheduleSelection(undefined, undefined, { interaction: 'drag' });
    };

    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [scheduleSelection]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateWidth = () => {
      // Fallback for initial render when clientWidth might be 0
      const w = Math.max(320, container.clientWidth > 0 ? container.clientWidth - 32 : 500);
      setBaseWidth(w);
    };

    updateWidth();
    const ro = new ResizeObserver(updateWidth);
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    const updateHeight = () => setSidebarHeight(sidebar.clientHeight);
    updateHeight();
    const ro = new ResizeObserver(updateHeight);
    ro.observe(sidebar);
    return () => ro.disconnect();
  }, [reactPdf]);

  useEffect(() => {
    const onWindowPointerDown = (e: PointerEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const target = e.target as Element | null;
      // Clicks inside the tooltip should not close it.
      if (target?.closest?.('[data-readease-tooltip]')) return;
      // Clicks inside the main PDF container are handled by other listeners;
      // this is only for clicks *outside* the PDF area.
      if (container.contains(e.target as Node)) return;
      closeTooltip();
    };
    window.addEventListener('pointerdown', onWindowPointerDown);
    return () => window.removeEventListener('pointerdown', onWindowPointerDown);
  }, [closeTooltip]);

  useEffect(() => {
    // If language changes while tooltip is open, re-translate.
    if (!tooltip?.text || !tooltip.rect) return;
    void fetchMeaning(tooltip.text, tooltip.rect);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetLang]);

  useEffect(() => {
    // Reset render/caches on new file.
    translationCacheRef.current.clear();
    setTooltip(null);
    setError(null);
    setLoading(false);
    setNumPages(0);
    setRenderedPages(0);
    setCurrentPage(1);
    setZoomScale(1);
    setCommittedZoom(1);
    setSidebarOpen(false);
    pageInputEditingRef.current = false;
    setPageInput('1');
    pageRefs.current = [];
  }, [fileUrl]);

  useEffect(() => {
    // Only auto-scroll the sidebar when the user has explicitly navigated
    // (clicked a thumbnail, used arrow keys, or jumped to a page).
    // Zoom-triggered currentPage changes are suppressed via sidebarAutoScrollRef.
    if (!sidebarAutoScrollRef.current) return;
    sidebarAutoScrollRef.current = false;
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    const btn = sidebar.querySelector(
      `[data-thumb-page="${currentPage}"]`
    ) as HTMLElement | null;
    btn?.scrollIntoView({ block: 'nearest' });
  }, [currentPage]);

  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    if (isTransientZoomRef.current) return;

    if (scrollRafRef.current) return;
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;

      const np = numPagesRef.current;
      const rp = renderedPagesRef.current;
      if (!np) return;

      // Update current page based on scroll position.
      const y = container.scrollTop + 24;
      let nextCurrent = currentPageRef.current;
      let sawMeasuredPage = false;
      const upto = Math.min(rp, pageRefs.current.length);
      for (let i = 0; i < upto; i += 1) {
        const el = pageRefs.current[i];
        if (!el) continue;
        sawMeasuredPage = true;
        if (el.offsetTop <= y) nextCurrent = i + 1;
        else break;
      }
      if (sawMeasuredPage) {
        setCurrentPage((prev) => (prev === nextCurrent ? prev : nextCurrent));
      }
      const nearBottom =
        container.scrollTop + container.clientHeight >=
        container.scrollHeight - NEAR_BOTTOM_PX;

      if (nearBottom) {
        setRenderedPages((prev) => Math.min(np, prev + PAGE_BATCH));
      }
    });
  // Empty deps: all values read through stable refs. Callback never recreates.
  }, []);

  const ensureRenderedThrough = useCallback(
    (pageNumber: number) => {
      setRenderedPages((prev) => {
        const target = Math.min(numPages, Math.max(prev, pageNumber + PAGE_BATCH));
        return target;
      });
    },
    [numPages]
  );

  const scrollToPage = useCallback(
    (pageNumber: number, behavior: ScrollBehavior = 'smooth') => {
      const container = containerRef.current;
      if (!container) return;
      if (!numPages) return;

      const clamped = Math.max(1, Math.min(numPages, pageNumber));
      ensureRenderedThrough(clamped);
      setCurrentPage(clamped);
      // Allow sidebar to auto-scroll for explicit navigation.
      sidebarAutoScrollRef.current = true;

      window.setTimeout(() => {
        const el = pageRefs.current[clamped - 1];
        if (!el) return;
        container.scrollTo({
          top: el.offsetTop - 8,
          behavior,
        });
      }, 0);
    },
    [ensureRenderedThrough, numPages]
  );

  const { theme } = useTheme();

  const pages = useMemo(() => {
    if (!reactPdf) return [];
    const { Page } = reactPdf;
    const result: ReactNode[] = [];

    // In dark mode, invert the PDF and rotate hue so colors aren't totally ruined
    const pdfFilterClass = theme === 'dark' ? 'dark:invert dark:hue-rotate-180' : '';
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
    const pageWidth = baseWidth * committedZoom;

    for (let i = 1; i <= renderedPages; i += 1) {
      if (isReadingMode) {
        result.push(
          <div
            key={i}
            className="mb-8 mx-auto w-full max-w-3xl rounded-xl bg-white p-6 sm:p-10 shadow-sm dark:bg-slate-900 border border-slate-200 dark:border-slate-800"
            ref={(el) => {
              pageRefs.current[i - 1] = el;
            }}
            data-page-number={i}
          >
            <div className="mb-6 text-center text-xs font-semibold text-slate-400 uppercase tracking-widest border-b border-slate-100 dark:border-slate-800 pb-3">
              Page {i}
            </div>
            {pagesText[i] === undefined ? (
              <div className="animate-pulse flex space-x-4">
                <div className="flex-1 space-y-4 py-1">
                  <div className="h-2 bg-slate-200 rounded"></div>
                  <div className="space-y-3">
                    <div className="grid grid-cols-3 gap-4">
                      <div className="h-2 bg-slate-200 rounded col-span-2"></div>
                      <div className="h-2 bg-slate-200 rounded col-span-1"></div>
                    </div>
                    <div className="h-2 bg-slate-200 rounded"></div>
                  </div>
                </div>
              </div>
            ) : (
              <div
                className="readease-reading-text font-serif text-slate-800 dark:text-slate-200 whitespace-pre-wrap select-text"
                style={{ fontSize: `${fontSize}px`, lineHeight: 1.7 }}
              >
                {pagesText[i]}
              </div>
            )}
          </div>
        );
      } else {
        // Use memoized PdfPageItem so that a currentPage change only re-renders
        // the ~6 pages near the visible boundary (text-layer toggle), not all pages.
        result.push(
          <PdfPageItem
            key={i}
            pageNumber={i}
            width={pageWidth}
            devicePixelRatio={dpr}
            renderTextLayer={Math.abs(i - currentPage) <= 3}
            pdfFilterClass={pdfFilterClass}
            PageComponent={Page}
            ignoreAbortTextLayerError={ignoreAbortTextLayerError}
            onRef={(el) => { pageRefs.current[i - 1] = el; }}
          />
        );
      }
    }
    return result;
    // currentPage IS in deps here so text-layer nearness updates,
    // but PdfPageItem.memo ensures only boundary pages actually re-render.
  }, [ignoreAbortTextLayerError, renderedPages, baseWidth, committedZoom, reactPdf, theme, isReadingMode, pagesText, fontSize, currentPage]);

  const THUMB_WIDTH = 92;
  const THUMB_ITEM_HEIGHT = 122;
  const thumbRange = useMemo(() => {
    if (!numPages) return { start: 1, end: 0 };
    const visible = Math.ceil(sidebarHeight / THUMB_ITEM_HEIGHT);
    // Wider buffer (±15 pages) so thumbnails near the edges don't go blank
    // when a zoom-triggered scroll temporarily shifts sidebarScrollTop.
    const start = Math.max(1, Math.floor(sidebarScrollTop / THUMB_ITEM_HEIGHT) - 15);
    const end = Math.min(numPages, start + visible + 30);
    return { start, end };
  }, [numPages, sidebarHeight, sidebarScrollTop]);

  const onSidebarScroll = useCallback(() => {
    const el = sidebarRef.current;
    if (!el) return;
    if (sidebarRafRef.current) return;
    sidebarRafRef.current = window.requestAnimationFrame(() => {
      sidebarRafRef.current = null;
      setSidebarScrollTop(el.scrollTop);
    });
  }, []);

  const zoomOut = useCallback(() => {
    const next = Math.max(0.5, Math.round((zoomScaleRef.current - 0.1) * 10) / 10);
    setZoomScale(next);
    setCommittedZoom(next);
  }, []);

  const zoomIn = useCallback(() => {
    const next = Math.min(3.0, Math.round((zoomScaleRef.current + 0.1) * 10) / 10);
    setZoomScale(next);
    setCommittedZoom(next);
  }, []);

  const fitToWidth = useCallback(() => {
    setZoomScale(1);
    setCommittedZoom(1);
  }, []);

  const handleTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 2) {
      const x1 = e.touches[0].clientX;
      const y1 = e.touches[0].clientY;
      const x2 = e.touches[1].clientX;
      const y2 = e.touches[1].clientY;
      const dist = Math.hypot(x2 - x1, y2 - y1);
      (containerRef.current as any).pinchStartDist = dist;
      (containerRef.current as any).pinchStartScale = zoomScale;
    }
  }, [zoomScale]);

  const handleTouchMove = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 2 && (containerRef.current as any)?.pinchStartDist) {
      e.preventDefault();
      isTransientZoomRef.current = true;
      const x1 = e.touches[0].clientX;
      const y1 = e.touches[0].clientY;
      const x2 = e.touches[1].clientX;
      const y2 = e.touches[1].clientY;
      const dist = Math.hypot(x2 - x1, y2 - y1);
      const startDist = (containerRef.current as any).pinchStartDist;
      const startScale = (containerRef.current as any).pinchStartScale;
      
      const scaleChange = dist / startDist;
      let newScale = startScale * scaleChange;
      
      // Restrict zooming limits
      newScale = Math.min(3.0, Math.max(0.6, newScale));

      const container = containerRef.current;
      if (container) {
        const containerRect = container.getBoundingClientRect();
        const viewportX = (x1 + x2) / 2 - containerRect.left;
        const viewportY = (y1 + y2) / 2 - containerRect.top;
        zoomAnchorRef.current = {
          contentX: container.scrollLeft + viewportX,
          contentY: container.scrollTop + viewportY,
          viewportX,
          viewportY,
        };
      }

      setZoomScale(newScale);
    }
  }, []);

  const handleTouchEnd = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length < 2) {
      const container = containerRef.current as any;
      if (container) {
        container.pinchStartDist = null;
      }
      isTransientZoomRef.current = false;
    }
  }, []);

  useEffect(() => {
    const isTypingTarget = (target: any) => {
      return (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable
      );
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeTooltip();
        return;
      }

      if (isTypingTarget(e.target)) return;

      if (e.key === 'ArrowRight') {
        if (!numPages) return;
        e.preventDefault();
        scrollToPage(currentPage + 1);
        return;
      }

      if (e.key === 'ArrowLeft') {
        if (!numPages) return;
        e.preventDefault();
        scrollToPage(currentPage - 1);
        return;
      }

      const metaOrCtrl = e.ctrlKey || e.metaKey;
      if (!metaOrCtrl) return;

      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        zoomIn();
        return;
      }

      if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        zoomOut();
        return;
      }

      if (e.key === '0') {
        e.preventDefault();
        fitToWidth();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeTooltip, currentPage, fitToWidth, numPages, scrollToPage, zoomIn, zoomOut]);

  useEffect(() => {
    // GLOBAL wheel handler — intercepts Ctrl+scroll everywhere (sidebar, navbar, empty areas)
    // so the browser never zooms the whole UI. Only the PDF canvas changes size.
    let pendingZoom: number | null = null;
    let commitTimer: ReturnType<typeof setTimeout> | null = null;

    const handleWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault(); // Block browser-level zoom globally.

      isTransientZoomRef.current = true;

      // Accumulate delta against the live zoom ref (not state, to avoid closure staleness).
      const delta = e.deltaY * -0.004;
      const base = pendingZoom ?? zoomScaleRef.current;
      pendingZoom = Math.min(3.0, Math.max(0.5, base + delta));

      // Record anchor point (content coordinate under cursor) for scroll correction.
      const container = containerRef.current;
      if (container) {
        const rect = container.getBoundingClientRect();
        const vx = e.clientX - rect.left;
        const vy = e.clientY - rect.top;
        if (vx >= 0 && vy >= 0 && vx <= rect.width && vy <= rect.height) {
          zoomAnchorRef.current = {
            contentX: (container.scrollLeft + vx) / zoomScaleRef.current,
            contentY: (container.scrollTop  + vy) / zoomScaleRef.current,
            viewportX: vx,
            viewportY: vy,
          };
        }
      }

      // Update CSS-transform zoom immediately on every wheel tick → silky smooth.
      setZoomScale(pendingZoom);

      // Commit canvas re-render 250 ms after the last wheel event.
      if (commitTimer) clearTimeout(commitTimer);
      commitTimer = setTimeout(() => {
        if (pendingZoom !== null) {
          // Round to nearest 0.05 for clean values.
          const snapped = Math.round(pendingZoom * 20) / 20;
          const final = Math.min(3.0, Math.max(0.5, snapped));
          setZoomScale(final);
          setCommittedZoom(final);
          pendingZoom = null;
        }
        isTransientZoomRef.current = false;
      }, 250);
    };

    document.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      document.removeEventListener('wheel', handleWheel);
      if (commitTimer) clearTimeout(commitTimer);
    };
  }, []);

  const mainOffsetClass = '';

  const commitPageInput = useCallback(() => {
    if (!numPages) return;
    const n = Number.parseInt(pageInput, 10);
    if (!Number.isFinite(n)) {
      setPageInput(String(currentPage));
      return;
    }
    scrollToPage(Math.max(1, Math.min(numPages, n)));
  }, [currentPage, numPages, pageInput, scrollToPage]);

  return (
    <div className="relative h-full w-full overflow-hidden">
      {!reactPdf ? (
        <div
          ref={containerRef}
          className={
            `h-full w-full overflow-y-auto overflow-x-hidden p-2 pb-24 ${mainOffsetClass}`
          }
        >
          <div className="p-6 text-sm text-slate-600">Loading reader…</div>
        </div>
      ) : (
        <reactPdf.Document
          className="h-full w-full"
          file={fileUrl}
          onLoadSuccess={(doc: any) => {
            setPdfDoc(doc);
            setNumPages(doc.numPages);
            setRenderedPages(Math.min(doc.numPages, INITIAL_PAGES));
            setCurrentPage(1);
          }}
          onLoadError={() => setError('Failed to load PDF')}
          loading={
            <div
              ref={containerRef}
              className={
                `h-full w-full overflow-y-auto overflow-x-hidden p-2 pb-24 ${mainOffsetClass}`
              }
            >
              <div className="p-6 text-sm text-slate-600">Loading PDF…</div>
            </div>
          }
          error={
            <div
              ref={containerRef}
              className={
                `h-full w-full overflow-y-auto overflow-x-hidden p-2 pb-24 ${mainOffsetClass}`
              }
            >
              <div className="p-6 text-sm text-slate-600">Failed to load PDF.</div>
            </div>
          }
        >
          {/* Integrated viewer container: sidebar + main content */}
          <div className="relative flex h-full w-full overflow-hidden bg-slate-200 shadow-inner dark:bg-slate-900 transition-colors duration-300">
            {/* Thumbnails panel (desktop) */}
            <div
              ref={sidebarRef}
              className={`readease-scrollbar-hide hidden w-[120px] shrink-0 overflow-y-auto overflow-x-hidden border-r border-slate-300 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-2 scroll-smooth md:block transition-all duration-300 ${
                isFocusMode ? 'w-0 opacity-0 px-0 border-0' : ''
              }`}
              onScroll={onSidebarScroll}
              aria-label="Page thumbnails"
            >
              {!numPages ? (
                <div className="p-2 text-center text-xs text-slate-300">Loading…</div>
              ) : (
                <div className="space-y-2">
                  {Array.from({ length: numPages }, (_, idx) => {
                    const page = idx + 1;
                    const isActive = page === currentPage;
                    const inRange = page >= thumbRange.start && page <= thumbRange.end;
                    return (
                      <button
                        key={page}
                        type="button"
                        data-thumb-page={page}
                        aria-current={isActive ? 'page' : undefined}
                        className={
                          "group relative w-full rounded-xl border p-2 text-left transition-transform transition-shadow duration-150 hover:shadow-lg hover:scale-[1.03] active:scale-[0.99] " +
                          (isActive
                            ? 'border-sky-400/80 bg-slate-800/60 ring-2 ring-sky-400/40 scale-[1.04] shadow-lg opacity-100'
                            : 'border-slate-800 bg-slate-800/30 opacity-80')
                        }
                        onClick={() => scrollToPage(page)}
                        aria-label={`Go to page ${page}`}
                        title={`Page ${page}`}
                        style={{ height: THUMB_ITEM_HEIGHT }}
                      >
                        <div className="flex h-[92px] items-center justify-center overflow-hidden rounded-lg bg-white shadow-sm">
                          {inRange ? (
                            <reactPdf.Page
                              pageNumber={page}
                              width={THUMB_WIDTH}
                              renderTextLayer={false}
                              renderAnnotationLayer={false}
                              onGetTextError={ignoreAbortTextLayerError}
                              onRenderTextLayerError={ignoreAbortTextLayerError}
                            />
                          ) : (
                            <div className="text-[10px] text-slate-400">…</div>
                          )}
                        </div>

                        <div
                          className={
                            'mt-1 text-center text-[11px] tabular-nums ' +
                            (isActive
                              ? 'font-semibold text-white'
                              : 'text-slate-300')
                          }
                        >
                          {page}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Fixed top-left thumbnail toggle button – mobile only */}
            <button
              type="button"
              className={`absolute top-2 left-2 z-50 md:hidden inline-flex h-9 w-9 items-center justify-center rounded-xl border shadow-lg backdrop-blur-md transition-all duration-150 ${
                sidebarOpen
                  ? 'border-sky-400/50 bg-sky-500/20 text-sky-400'
                  : 'border-white/20 bg-slate-900/80 text-white hover:bg-slate-800'
              }`}
              onClick={() => setSidebarOpen((v) => !v)}
              aria-label={sidebarOpen ? 'Close thumbnails' : 'Open thumbnails'}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M4 6h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <path d="M4 12h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <path d="M4 18h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>

            {/* Thumbnails panel (mobile overlay) */}
            {sidebarOpen ? (
              <div
                className="readease-scrollbar-hide absolute inset-y-0 left-0 z-40 w-[108px] overflow-y-auto overflow-x-hidden border-r border-slate-800 bg-slate-900/95 pt-12 p-2 shadow-xl scroll-smooth md:hidden"
                onScroll={onSidebarScroll}
                aria-label="Page thumbnails"
              >
                {!numPages ? (
                  <div className="p-2 text-center text-xs text-slate-300">Loading…</div>
                ) : (
                  <div className="space-y-2">
                    {Array.from({ length: numPages }, (_, idx) => {
                      const page = idx + 1;
                      const isActive = page === currentPage;
                      const inRange = page >= thumbRange.start && page <= thumbRange.end;
                      return (
                        <button
                          key={page}
                          type="button"
                          data-thumb-page={page}
                          aria-current={isActive ? 'page' : undefined}
                          className={
                            "group relative w-full rounded-xl border p-1 text-left transition-transform transition-shadow duration-150 hover:shadow-lg hover:scale-[1.03] active:scale-[0.99] overflow-hidden " +
                            (isActive
                              ? 'border-sky-400/80 bg-slate-800/60 ring-2 ring-sky-400/40 scale-[1.04] shadow-lg opacity-100'
                              : 'border-slate-800 bg-slate-800/30 opacity-80')
                          }
                          onClick={() => {
                            setSidebarOpen(false);
                            scrollToPage(page);
                          }}
                          aria-label={`Go to page ${page}`}
                          
                          style={{ height: THUMB_ITEM_HEIGHT }}
                        >
                          <div className="flex h-[80px] items-center justify-center overflow-hidden rounded-lg bg-white shadow-sm">
                            {inRange ? (
                              <reactPdf.Page
                                pageNumber={page}
                                width={THUMB_WIDTH}
                                renderTextLayer={false}
                                renderAnnotationLayer={false}
                                onGetTextError={ignoreAbortTextLayerError}
                                onRenderTextLayerError={ignoreAbortTextLayerError}
                              />
                            ) : (
                              null
                            )}
                          </div>

                          {/* page number hidden */}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : null}
            {/* Backdrop: tap outside to close mobile sidebar */}
            {sidebarOpen && (
              <div
                className="absolute inset-0 z-30 bg-black/40 md:hidden"
                onClick={() => setSidebarOpen(false)}
                aria-hidden="true"
              />
            )}

            {/* Main PDF scroll area */}
            <div
              ref={containerRef}
              className="relative flex-1 overflow-auto transition-colors duration-300"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onMouseUp={onMouseUp}
              onDoubleClick={onDoubleClick}
              onScroll={handleScroll}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
            >
              <div className="flex flex-col items-center w-full min-h-max pt-2 sm:pt-4 pb-24">


                <div
                  id="readease-pdf-layout"
                  style={{
                    transform: `scale(${committedZoom > 0 ? zoomScale / committedZoom : 1})`,
                    transformOrigin: 'top center',
                    willChange: 'transform',
                  }}
                >
                  {pages}
                </div>

                {numPages > 0 && renderedPages < numPages ? (
                  <div className="p-3 text-center text-sm text-slate-600">
                    Loading more pages…
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </reactPdf.Document>
      )}

      {/* Fixed bottom navigation */}
      <div
        className={`fixed bottom-5 left-1/2 z-50 -translate-x-1/2 transition-all duration-300 ${
          isFocusMode ? 'translate-y-24 opacity-0 pointer-events-none' : 'translate-y-0 opacity-100'
        }`}
      >
        <div className="flex max-w-[calc(100vw-16px)] items-center justify-between gap-1 sm:gap-2 rounded-[30px] border border-white/10 bg-gradient-to-r from-slate-950/85 via-slate-900/75 to-slate-950/85 px-1 sm:px-2 py-1.5 sm:py-2 text-white shadow-xl backdrop-blur-[10px] sm:gap-3 sm:px-3 overflow-x-auto readease-scrollbar-hide">
          <div className="flex items-center shrink-0 md:hidden">
            <button
              type="button"
              className={`inline-flex h-8 w-8 items-center justify-center rounded-xl transition-all duration-150 sm:h-9 sm:w-9 shrink-0 ${
                sidebarOpen
                  ? 'bg-sky-500/20 text-sky-400 hover:bg-sky-500/30'
                  : 'hover:scale-[1.06] hover:bg-white/10 active:scale-[0.98]'
              }`}
              onClick={() => setSidebarOpen((v) => !v)}
              aria-label={sidebarOpen ? 'Close thumbnails' : 'Open thumbnails'}
              title={sidebarOpen ? 'Close thumbnails' : 'Open thumbnails'}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M4 6h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <path d="M4 12h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <path d="M4 18h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
            <div className="mx-1 h-4 w-px bg-white/20"></div>
          </div>

          <div className="flex items-center shrink-0">
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-xl transition-transform transition-colors duration-150 hover:scale-[1.06] hover:bg-white/10 active:scale-[0.98] disabled:opacity-40 sm:h-9 sm:w-9 shrink-0"
              onClick={() => scrollToPage(currentPage - 1)}
              disabled={!numPages || currentPage <= 1}
              aria-label="Previous page"
              title="Previous"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            <div className="flex items-center gap-1 sm:gap-2 px-1 shrink-0">
              <label className="sr-only" htmlFor="readease-page-input">
                Page number
              </label>
              <input
                id="readease-page-input"
                type="number"
                inputMode="numeric"
                min={1}
                max={numPages || 1}
                value={pageInput}
                onFocus={() => {
                  pageInputEditingRef.current = true;
                }}
                onBlur={() => {
                  pageInputEditingRef.current = false;
                  commitPageInput();
                }}
                onChange={(e) => setPageInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                className="h-8 w-[50px] sm:w-[64px] rounded-xl border border-white/15 bg-white/10 px-1 sm:px-2 text-center text-sm font-medium tabular-nums text-white outline-none transition focus:border-white/30 focus:bg-white/15"
                aria-label="Go to page"
                title="Go to page"
              />
              <div className="min-w-[40px] sm:min-w-[48px] text-center text-sm font-medium tabular-nums text-white/85">
                <span className="opacity-60 text-xs mr-1">/</span>
                {numPages ? numPages : '—'}
              </div>
            </div>

            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-xl transition-transform transition-colors duration-150 hover:scale-[1.06] hover:bg-white/10 active:scale-[0.98] disabled:opacity-40 sm:h-9 sm:w-9 shrink-0"
              onClick={() => scrollToPage(currentPage + 1)}
              disabled={!numPages || currentPage >= numPages}
              aria-label="Next page"
              title="Next"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>

          <div className="flex items-center shrink-0">
            <button
              type="button"
              className={`inline-flex h-8 w-8 items-center justify-center rounded-xl transition-all duration-150 sm:h-9 sm:w-9 shrink-0 ${
                isReadingMode
                  ? 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30'
                  : 'hover:scale-[1.06] hover:bg-white/10 active:scale-[0.98]'
              }`}
              onClick={() => setIsReadingMode((prev) => !prev)}
              title={isReadingMode ? "Exit Reading Mode" : "Enter Reading Mode"}
              aria-label="Toggle Reading Mode"
            >
              <BookOpen size={18} />
            </button>

            <div className="mx-1 sm:mx-2 h-4 w-px bg-white/20"></div>

            {isReadingMode ? (
              <>
                <button
                  type="button"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-xl transition-transform transition-colors duration-150 hover:scale-[1.06] hover:bg-white/10 active:scale-[0.98] disabled:opacity-40 sm:h-9 sm:w-9 text-xs font-bold shrink-0"
                  onClick={() => setFontSize((s) => Math.max(14, s - 2))}
                  disabled={fontSize <= 14}
                  title="Decrease font size"
                >
                  A-
                </button>
                <button
                  type="button"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-xl transition-transform transition-colors duration-150 hover:scale-[1.06] hover:bg-white/10 active:scale-[0.98] disabled:opacity-40 sm:h-9 sm:w-9 text-base font-bold shrink-0"
                  onClick={() => setFontSize((s) => Math.min(28, s + 2))}
                  disabled={fontSize >= 28}
                  title="Increase font size"
                >
                  A+
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-xl transition-transform transition-colors duration-150 hover:scale-[1.06] hover:bg-white/10 active:scale-[0.98] disabled:opacity-40 sm:h-9 sm:w-9 shrink-0"
                  onClick={zoomOut}
                  disabled={zoomScale <= 0.6}
                  aria-label="Zoom out"
                  title="Zoom out"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </button>

                <button
                  type="button"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-xl transition-transform transition-colors duration-150 hover:scale-[1.06] hover:bg-white/10 active:scale-[0.98] disabled:opacity-40 sm:h-9 sm:w-9 shrink-0"
                  onClick={zoomIn}
                  disabled={zoomScale >= 2.2}
                  aria-label="Zoom in"
                  title="Zoom in"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M12 5v14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    <path d="M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </button>

                <button
                  type="button"
                  className="hidden sm:inline-flex h-8 w-8 items-center justify-center rounded-xl transition-transform transition-colors duration-150 hover:scale-[1.06] hover:bg-white/10 active:scale-[0.98] sm:h-9 sm:w-9 shrink-0"
                  onClick={fitToWidth}
                  aria-label="Fit to width"
                  title="Fit to width"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M4 7h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    <path d="M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    <path d="M8 12h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    <path d="M10 10l-2 2 2 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M14 10l2 2-2 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {tooltip ? (
        <SelectionTooltip
          data={tooltip}
          loading={loading}
          error={error}
          onClose={closeTooltip}
          onSaved={() => setTooltip((prev) => (prev ? { ...prev, saved: true } : prev))}
        />
      ) : null}
    </div>
  );
}
