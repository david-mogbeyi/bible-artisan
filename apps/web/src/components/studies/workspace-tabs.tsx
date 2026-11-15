'use client';

import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { useGraphViewStore } from '@/lib/graph-store';

/** The narrow-screen workspace tabs, in the PRD's order (section 11, Study Workspace). */
export const WORKSPACE_TABS = ['reader', 'notes', 'thread', 'summary', 'graph'] as const;
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

export const WORKSPACE_TAB_LABELS: Record<WorkspaceTab, string> = {
  reader: 'Reader',
  notes: 'Notes',
  thread: 'Thread',
  summary: 'Summary',
  graph: 'Graph Preview',
};

/** The sticky tab list's height, which the page keeps as scroll padding (globals.css). */
export const STICKY_HEIGHT_VAR = '--workspace-tabs-height';

/**
 * The tab list sticks to the top only while it takes at most this share of the viewport height.
 * At 200% text on a phone it wraps to one tab per row (about half the screen at 375 px, most of
 * it at 320 px), and a sticky list that tall would leave almost no room for the panel (BIB-53).
 */
export const MAX_STICKY_SHARE = 0.25;

export const tabId = (base: string, tab: WorkspaceTab) => `${base}-tab-${tab}`;
export const panelId = (base: string, tab: WorkspaceTab) => `${base}-panel-${tab}`;

/**
 * The WAI-ARIA tab list for the study workspace below 900 px (BIB-38). Automatic activation:
 * Left/Right (wrapping), Home and End move focus and select; only the selected tab is in the Tab
 * order. `unsaved` names tabs holding unsaved work, in text (never colour alone).
 */
export function WorkspaceTabList({
  idBase,
  selected,
  onSelect,
  unsaved,
}: {
  idBase: string;
  selected: WorkspaceTab;
  onSelect: (tab: WorkspaceTab) => void;
  unsaved: ReadonlySet<WorkspaceTab>;
}) {
  const refs = useRef(new Map<WorkspaceTab, HTMLButtonElement>());
  const list = useRef<HTMLDivElement>(null);
  const [sticky, setSticky] = useState(true);

  // BIB-53 (WCAG 2.4.11): while the tab list sticks to the top, the page keeps that much scroll
  // padding (globals.css) so a focused control is never scrolled in under it. It is measured, as
  // it wraps to more rows at 200% text or on a phone; once it would cover more than
  // MAX_STICKY_SHARE of the viewport it scrolls away with the page instead (and needs no padding).
  useEffect(() => {
    const element = list.current;
    if (!element) return;
    const root = document.documentElement;
    const measure = () => {
      const height = element.offsetHeight;
      const fits = height <= window.innerHeight * MAX_STICKY_SHARE;
      setSticky(fits);
      root.style.setProperty(STICKY_HEIGHT_VAR, `${fits ? height : 0}px`);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      root.style.removeProperty(STICKY_HEIGHT_VAR);
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = WORKSPACE_TABS.indexOf(selected);
    const last = WORKSPACE_TABS.length - 1;
    const next =
      event.key === 'ArrowRight'
        ? index === last
          ? 0
          : index + 1
        : event.key === 'ArrowLeft'
          ? index === 0
            ? last
            : index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    const tab = next === null ? undefined : WORKSPACE_TABS[next];
    if (tab === undefined) return;
    event.preventDefault();
    onSelect(tab);
    refs.current.get(tab)?.focus();
  };

  return (
    <div
      ref={list}
      role="tablist"
      aria-label="Study workspace"
      onKeyDown={onKeyDown}
      className={`${sticky ? 'sticky top-0 z-10 ' : ''}-mx-4 flex flex-wrap gap-2 border-b border-muted bg-canvas px-4 py-2`}
    >
      {WORKSPACE_TABS.map((tab) => {
        const isSelected = tab === selected;
        return (
          <button
            key={tab}
            ref={(element) => {
              if (element) refs.current.set(tab, element);
              else refs.current.delete(tab);
            }}
            type="button"
            role="tab"
            id={tabId(idBase, tab)}
            aria-controls={panelId(idBase, tab)}
            aria-selected={isSelected}
            tabIndex={isSelected ? 0 : -1}
            onClick={() => onSelect(tab)}
            className="rounded border border-muted px-3 py-2 text-sm aria-selected:border-2 aria-selected:border-accent aria-selected:font-semibold aria-selected:underline aria-selected:underline-offset-4"
          >
            {WORKSPACE_TAB_LABELS[tab]}
            {unsaved.has(tab) ? <span> (unsaved)</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * One workspace region. Below 900 px it is a tab panel, hidden (never unmounted, so drafts, the
 * pending-save queue and unsaved-work guards survive switching tabs) unless selected. On wider
 * screens it is `display: contents`: no box, no role, the desktop layout unchanged.
 */
export function WorkspacePanel({
  idBase,
  tab,
  narrow,
  selected,
  children,
}: {
  idBase: string;
  tab: WorkspaceTab;
  narrow: boolean;
  selected: WorkspaceTab;
  children: ReactNode;
}) {
  if (!narrow) return <div className="contents">{children}</div>;
  return (
    <div
      role="tabpanel"
      id={panelId(idBase, tab)}
      aria-labelledby={tabId(idBase, tab)}
      hidden={tab !== selected}
      tabIndex={0}
      className="flex min-w-0 flex-col gap-6"
    >
      {children}
    </div>
  );
}

/**
 * Below 900 px a node's detail lives on the Notes tab (the Nodes list). When a selection asks for
 * that detail to take focus (List View's Open, a link), switch to Notes in the same update, so
 * the detail is visible before its heading is focused. Renders nothing.
 */
export function FollowNodeDetail({ enabled, onOpen }: { enabled: boolean; onOpen: () => void }) {
  const store = useGraphViewStore();
  const open = useRef(onOpen);
  useEffect(() => {
    open.current = onOpen;
  }, [onOpen]);
  useEffect(() => {
    if (!enabled) return;
    return store.subscribe((state, previous) => {
      if (state.focusDetail && !previous.focusDetail && state.selectedNodeIds.length > 0) {
        open.current();
      }
    });
  }, [store, enabled]);
  return null;
}
