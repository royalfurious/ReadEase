'use client';
import React from 'react';

interface PdfPageItemProps {
  pageNumber: number;
  width: number;
  devicePixelRatio: number;
  renderTextLayer: boolean;
  pdfFilterClass: string;
  PageComponent: any;
  ignoreAbortTextLayerError: (e: any) => void;
  onRef: (el: HTMLDivElement | null) => void;
}

/**
 * Memoized wrapper for a single PDF page canvas.
 *
 * By isolating each page in its own memo, a currentPage change  (which only
 * toggles renderTextLayer for ~6 boundary pages) does NOT re-render the entire
 * rendered pages list — only the ~6 pages whose renderTextLayer value changes.
 */
const PdfPageItem = React.memo(function PdfPageItem({
  pageNumber,
  width,
  devicePixelRatio,
  renderTextLayer,
  pdfFilterClass,
  PageComponent,
  ignoreAbortTextLayerError,
  onRef,
}: PdfPageItemProps) {
  return (
    <div
      className="mb-6 flex justify-center"
      ref={onRef}
      data-page-number={pageNumber}
    >
      <div className="overflow-hidden rounded-lg shadow-[0_20px_40px_-5px_rgba(0,0,0,0.4)] ring-1 ring-slate-200 dark:ring-slate-800 bg-white/10 dark:bg-white/[0.02]">
        <div className={`${pdfFilterClass} relative`}>
          <PageComponent
            pageNumber={pageNumber}
            width={width}
            devicePixelRatio={devicePixelRatio}
            renderAnnotationLayer={false}
            renderTextLayer={renderTextLayer}
            onGetTextError={ignoreAbortTextLayerError}
            onRenderTextLayerError={ignoreAbortTextLayerError}
          />
        </div>
      </div>
    </div>
  );
});

export default PdfPageItem;
