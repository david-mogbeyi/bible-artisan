import { AI_CONSENT_VERSION } from '@bible-artisan/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '@/test/axe';
import { jsonResponse, renderWithQuery, textOf } from '@/test/render';
import {
  AI_CHANGED_ELSEWHERE,
  AI_UNAVAILABLE_TEXT,
  AiConsentSettings,
} from './ai-consent-settings';

const OFF = {
  enabled: false,
  consentVersion: null,
  consentedAt: null,
  currentConsentVersion: AI_CONSENT_VERSION,
  needsRenewal: false,
  revision: 1,
  providerAvailable: true,
  provider: 'Anthropic',
  modelId: 'claude-sonnet-5-5',
  remaining: { thisHour: 20, today: 50 },
};
const ON = {
  ...OFF,
  enabled: true,
  consentVersion: AI_CONSENT_VERSION,
  consentedAt: '2026-11-15T00:00:00.000Z',
  revision: 2,
};

type Reply = Response;
let reads: Reply[];
let writes: Reply[];
let sent: { body: unknown; key: string | undefined }[];

beforeEach(() => {
  reads = [];
  writes = [];
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((_input: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      if (method !== 'GET') {
        const headers = init.headers as Record<string, string>;
        sent.push({ body: JSON.parse(init.body as string), key: headers['Idempotency-Key'] });
      }
      const next = (method === 'GET' ? reads : writes).shift();
      if (!next) throw new Error(`unexpected ${method}`);
      return Promise.resolve(next);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const section = () => screen.getByRole('region', { name: 'AI features' });

describe('AI consent settings (BIB-40)', () => {
  it('explains what is sent and to whom, then turns AI on only after the server confirms', async () => {
    reads.push(jsonResponse(200, OFF), jsonResponse(200, ON));
    writes.push(
      jsonResponse(200, {
        enabled: true,
        consentVersion: AI_CONSENT_VERSION,
        revision: 2,
        cancelledJobCount: 0,
      }),
    );
    renderWithQuery(<AiConsentSettings />);
    await screen.findByText('AI features are off.');
    expect(within(section()).getByText('What is sent')).not.toBeNull();
    expect(within(section()).getByText(/Provider: Anthropic/)).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Agree and turn on AI features' }));
    await waitFor(() => expect(textOf(screen.getByRole('status'))).toBe('AI features are on.'));
    expect(sent).toStrictEqual([
      {
        body: { expectedRevision: 1, enabled: true, consentVersion: AI_CONSENT_VERSION },
        key: expect.any(String),
      },
    ]);
    expect(await screen.findByRole('button', { name: 'Turn off AI features' })).not.toBeNull();
    await expectNoA11yViolations(document.body);
  });

  it('turning AI off reports cancelled requests; a conflict asks the user to review', async () => {
    reads.push(jsonResponse(200, ON), jsonResponse(200, OFF));
    writes.push(
      jsonResponse(200, {
        enabled: false,
        consentVersion: AI_CONSENT_VERSION,
        revision: 3,
        cancelledJobCount: 2,
      }),
    );
    renderWithQuery(<AiConsentSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off AI features' }));
    await waitFor(() =>
      expect(textOf(screen.getByRole('status'))).toBe(
        'AI features are off. 2 waiting AI requests were cancelled.',
      ),
    );
    expect(sent[0]?.body).toStrictEqual({ expectedRevision: 2, enabled: false });

    reads.push(jsonResponse(200, OFF));
    writes.push(
      jsonResponse(409, {
        code: 'REVISION_CONFLICT',
        message: 'Revision conflict',
        retryable: false,
        correlationId: 'x',
        currentRevision: 4,
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Agree and turn on AI features' }));
    expect(await screen.findByText(AI_CHANGED_ELSEWHERE)).not.toBeNull();
  });

  it('without an approved provider, says AI is unavailable and offers no switch', async () => {
    reads.push(
      jsonResponse(200, { ...OFF, providerAvailable: false, provider: null, modelId: null }),
    );
    renderWithQuery(<AiConsentSettings />);
    expect(await screen.findByText(AI_UNAVAILABLE_TEXT)).not.toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
