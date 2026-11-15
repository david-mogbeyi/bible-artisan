import { vi } from 'vitest';

/**
 * Captures files the page hands to the browser as downloads (jsdom has no object URLs and can't
 * follow the link): returns the blobs, in order.
 */
export function captureDownloads(): Blob[] {
  const created: Blob[] = [];
  Object.assign(URL, {
    createObjectURL: (blob: Blob) => {
      created.push(blob);
      return 'blob:test-download';
    },
    revokeObjectURL: () => undefined,
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  return created;
}
