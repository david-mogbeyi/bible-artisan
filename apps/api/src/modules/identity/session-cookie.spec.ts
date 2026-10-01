import { describe, expect, it } from 'vitest';
import { clearSessionCookie, readSessionToken, serializeSessionCookie } from './session-cookie';

const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO_-';

describe('session cookie', () => {
  it('serializes a Secure, HttpOnly, SameSite=Lax cookie', () => {
    expect(serializeSessionCookie(TOKEN, { maxAgeSeconds: 2_592_000, secure: true })).toBe(
      `ba_session=${TOKEN}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`,
    );
  });

  it('omits Secure only when configured off (local http development)', () => {
    expect(serializeSessionCookie(TOKEN, { maxAgeSeconds: 60, secure: false })).toBe(
      `ba_session=${TOKEN}; Path=/; Max-Age=60; HttpOnly; SameSite=Lax`,
    );
  });

  it('clears with Max-Age=0', () => {
    expect(clearSessionCookie({ secure: true })).toBe(
      'ba_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
    );
  });

  it.each([
    ['the only cookie', `ba_session=${TOKEN}`, TOKEN],
    ['among others', `theme=dark; ba_session=${TOKEN}; other=1`, TOKEN],
    ['absent', 'theme=dark', undefined],
    ['missing header', undefined, undefined],
    ['repeated header array', [`ba_session=${TOKEN}`], undefined],
    ['malformed value', 'ba_session=abc', undefined],
    ['injection attempt', `ba_session=${TOKEN}'; DROP TABLE`, undefined],
    ['similar name', `xba_session=${TOKEN}`, undefined],
  ])('reads the token when %s', (_label, header, expected) => {
    expect(readSessionToken(header)).toBe(expected);
  });
});
