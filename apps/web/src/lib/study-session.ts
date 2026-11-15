'use client';

import { useEffect, useRef } from 'react';
import { endStudySession } from './thread';

/**
 * Whether the page now shown still belongs to `studyId`: its study page, or the reader opened in
 * it (`/bible?study=<id>`). Moving between those two continues the session.
 */
function stillInStudy(studyId: string): boolean {
  const { pathname, search } = window.location;
  if (pathname === `/studies/${studyId}`) return true;
  return pathname === '/bible' && new URLSearchParams(search).get('study') === studyId;
}

/**
 * Explicit exit (BIB-33, PRD section 8): ends this tab's session in the study when the tab leaves
 * it, so the session closes at once instead of after 30 idle minutes. Leaving is `pagehide` (the
 * tab closes, reloads or goes to another site) or this component unmounting on a route outside
 * the study (checked once the new route is in the address bar). Only while `active`: an archived
 * or trashed study takes no session. Best effort: a failure changes nothing for the user, and the
 * idle timeout still closes the session.
 */
export function useEndSessionOnLeave(studyId: string | null, active: boolean): void {
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);
  useEffect(() => {
    if (!studyId) return;
    const end = () => {
      if (!activeRef.current) return;
      void endStudySession(studyId, { keepalive: true }).catch(() => undefined);
    };
    const shownAt = window.location.href;
    window.addEventListener('pagehide', end);
    return () => {
      window.removeEventListener('pagehide', end);
      // Unmounted by a navigation (the address changed) to a page outside the study.
      setTimeout(() => {
        if (window.location.href !== shownAt && !stillInStudy(studyId)) end();
      }, 0);
    };
  }, [studyId]);
}
