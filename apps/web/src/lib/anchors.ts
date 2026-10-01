import {
  type AnchorSelection,
  type CaptureAnchorResponse,
  captureAnchorResponseSchema,
} from '@bible-artisan/contracts';
import { apiFetch } from './api-client';

/**
 * Durable Scripture anchors (BIB-18). The selection and its quote travel only in request bodies,
 * which are never logged; nothing here touches the URL or browser storage (NFR-PRIV-001).
 */

/** Builds an anchor from a reader selection; the server checks it against the stored text. */
export function captureAnchor(selection: AnchorSelection): Promise<CaptureAnchorResponse> {
  return apiFetch('/bible/anchors', captureAnchorResponseSchema, {
    method: 'POST',
    body: JSON.stringify(selection),
  });
}
