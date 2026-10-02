import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});

// jsdom implements <dialog> without its methods. A minimal model of the browser's, for BIB-22's
// confirm dialog: showModal opens it; close closes it and fires `close`, as the browser does.
if (typeof HTMLDialogElement !== 'undefined' && !('showModal' in HTMLDialogElement.prototype)) {
  Object.assign(HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
    close(this: HTMLDialogElement) {
      if (!this.hasAttribute('open')) return;
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    },
  });
}

// jsdom has no layout, so Range lacks the geometry ProseMirror (the Tiptap note editor, BIB-23)
// asks for when it scrolls a selection into view. Empty rectangles are what a layout-free
// document would report.
if (typeof Range !== 'undefined' && !('getClientRects' in Range.prototype)) {
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => Object.assign([], { item: () => null }) },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
  });
}

// React Flow (BIB-28) measures its pane and nodes, which jsdom cannot lay out. Minimal stand-ins
// after React Flow's testing guide: a ResizeObserver that reports once, the transform parser it
// reads the zoom from, and an empty SVG box. Sizes come from inline styles (nodes have explicit
// ones); React Flow's own containers otherwise report a desktop-sized pane, everything else keeps
// jsdom's 0.
const PANE = { width: 1000, height: 700 };
const flowSize = (element: HTMLElement, axis: 'width' | 'height'): number => {
  const own = element.style[axis];
  if (own.endsWith('px')) return parseFloat(own);
  return element.closest('.react-flow') ? PANE[axis] : 0;
};
if (typeof HTMLElement !== 'undefined') {
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: {
      configurable: true,
      get(this: HTMLElement) {
        return flowSize(this, 'width');
      },
    },
    offsetHeight: {
      configurable: true,
      get(this: HTMLElement) {
        return flowSize(this, 'height');
      },
    },
  });
}
if (typeof window !== 'undefined' && typeof window.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
      const element = target as HTMLElement;
      const contentRect = {
        width: flowSize(element, 'width'),
        height: flowSize(element, 'height'),
      } as DOMRectReadOnly;
      this.callback([{ target, contentRect } as ResizeObserverEntry], this);
    }
    unobserve() {}
    disconnect() {}
  }
  window.ResizeObserver = ResizeObserverStub;
}
if (typeof window !== 'undefined' && !('DOMMatrixReadOnly' in window)) {
  class DOMMatrixReadOnlyStub {
    m22: number;
    constructor(transform?: string) {
      const scale = /scale\(([\d.]+)\)/.exec(transform ?? '')?.[1];
      this.m22 = scale !== undefined ? Number(scale) : 1;
    }
  }
  Object.assign(window, { DOMMatrixReadOnly: DOMMatrixReadOnlyStub });
}
if (typeof SVGElement !== 'undefined' && !('getBBox' in SVGElement.prototype)) {
  Object.assign(SVGElement.prototype, { getBBox: () => ({ x: 0, y: 0, width: 0, height: 0 }) });
}
