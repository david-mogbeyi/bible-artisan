import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { EXPORT_LINK_TTL_SECONDS } from '@bible-artisan/contracts';

/**
 * Signed export download links (BIB-47; PRD section 24: "A private signed export URL expires after
 * 15 minutes"). The signature is HMAC-SHA256 over the export id, its owner and the link's expiry
 * (Unix seconds), keyed by a key derived with HKDF from the server's CURSOR_SECRET for this
 * purpose alone (no new secret to deploy). The owner is part of the signed message, so a link only
 * ever works for the session that owns the export: the download route still requires that
 * session, and another user's session fails the signature check (the same 404 as an absent
 * export).
 */
export function exportLinkKey(secret: Buffer): Buffer {
  return Buffer.from(
    hkdfSync('sha256', secret, Buffer.alloc(0), 'bible-artisan/export-link/v1', 32),
  );
}

export function signExportLink(
  key: Buffer,
  exportId: string,
  ownerId: string,
  expiresAtSeconds: number,
): string {
  return createHmac('sha256', key)
    .update(`${exportId}.${ownerId}.${expiresAtSeconds}`)
    .digest('base64url');
}

export function verifyExportLink(
  key: Buffer,
  exportId: string,
  ownerId: string,
  expiresAtSeconds: number,
  signature: string,
): boolean {
  const expected = Buffer.from(signExportLink(key, exportId, ownerId, expiresAtSeconds));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** A fresh link for the export, valid for 15 minutes from `now`. */
export function exportDownloadLink(
  key: Buffer,
  exportId: string,
  ownerId: string,
  now: Date = new Date(),
): { url: string; expiresAt: Date } {
  const expires = Math.floor(now.getTime() / 1000) + EXPORT_LINK_TTL_SECONDS;
  const signature = signExportLink(key, exportId, ownerId, expires);
  return {
    url: `/v1/exports/${exportId}/download?expires=${expires}&signature=${signature}`,
    expiresAt: new Date(expires * 1000),
  };
}
