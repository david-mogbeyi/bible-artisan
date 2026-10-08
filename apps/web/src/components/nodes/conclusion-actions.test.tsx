import type { StudyResponse } from '@bible-artisan/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { studyQueryKey } from '@/lib/studies';
import { jsonResponse, renderWithQuery, textOf } from '@/test/render';
import { CONCLUSION_COPY, ConclusionActions } from './conclusion-actions';
import { NodesSection } from './nodes-section';

const STUDY_ID = 'aaaaaaaa-2222-4333-8444-555555555555';
const CON = 'bbbbbbbb-2222-4333-8444-555555555555';
const OBS = 'cccccccc-2222-4333-8444-555555555555';
const QUE = 'dddddddd-2222-4333-8444-555555555555';
const EDGE = 'eeeeeeee-2222-4333-8444-555555555555';
const V1 = '11111111-2222-4333-8444-555555555555';
const V2 = '22222222-2222-4333-8444-555555555555';
const T = '2026-10-01T12:00:00.000Z';
const STUDY: StudyResponse = {
  id: STUDY_ID,
  title: 'Conscience',
  description: null,
  lifecycle: 'active',
  pinned: false,
  revision: 4,
  contentRevision: 3,
  startingReference: null,
  mainQuestion: null,
  originalQuestion: null,
  tags: [],
  branchId: null,
  purgeAt: null,
  createdAt: T,
};

const summary = (overrides: Record<string, unknown> = {}) => ({
  id: CON,
  type: 'conclusion',
  origin: 'user',
  label: 'Conscience is a moral witness',
  status: 'tentative',
  observationKind: null,
  referenceId: null,
  canonicalNodeId: null,
  established: false,
  evidenceIncomplete: false,
  revision: 1,
  createdAt: T,
  updatedAt: T,
  ...overrides,
});
const OBS_SUMMARY = summary({
  id: OBS,
  type: 'observation',
  label: 'Paul appeals to conscience',
  status: null,
  observationKind: 'textual_observation',
});
const QUE_SUMMARY = summary({
  id: QUE,
  type: 'question',
  label: 'What is conscience?',
  status: 'open',
});
const conclusion = (overrides: Record<string, unknown> = {}) => ({
  type: 'conclusion',
  id: CON,
  studyId: STUDY_ID,
  origin: 'user',
  canonicalNodeId: null,
  revision: 1,
  createdAt: T,
  updatedAt: T,
  text: 'Conscience is a moral witness',
  status: 'tentative',
  establishedAt: null,
  evidenceIncomplete: false,
  liveEvidenceCount: 0,
  version: { id: V1, number: 1 },
  ...overrides,
});
const question = (overrides: Record<string, unknown> = {}) => ({
  type: 'question',
  id: QUE,
  studyId: STUDY_ID,
  origin: 'user',
  canonicalNodeId: null,
  revision: 1,
  createdAt: T,
  updatedAt: T,
  text: 'What is conscience?',
  status: 'open',
  ...overrides,
});
const saved = (id: string, type: string, overrides: Record<string, unknown> = {}) => ({
  id,
  studyId: STUDY_ID,
  type,
  origin: 'user',
  revision: 2,
  referenceId: null,
  createdAt: T,
  updatedAt: T,
  lastEventSequence: '7',
  versionId: V2,
  previousVersionId: V1,
  warnings: [],
  ...overrides,
});
const envelope = (code: string, extra: Record<string, unknown> = {}) => ({
  code,
  message: 'server text, never shown',
  retryable: false,
  correlationId: 'x',
  ...extra,
});

type Reply = Response | Error | Promise<Response>;
let replies: Map<string, Reply[]>;
let requests: { method: string; path: string; body: unknown; key: string | undefined }[];

function reply(route: string, ...answers: Reply[]) {
  replies.set(route, [...(replies.get(route) ?? []), ...answers]);
}

beforeEach(() => {
  replies = new Map();
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit = {}) => {
      const url = new URL(input, 'http://api.test');
      const path = `${url.pathname.replace(/^\/v1/, '')}${url.search}`;
      const method = init.method ?? 'GET';
      const headers = (init.headers ?? {}) as Record<string, string>;
      requests.push({
        method,
        path,
        body: init.body ? JSON.parse(init.body as string) : undefined,
        key: headers['Idempotency-Key'],
      });
      const next = replies.get(`${method} ${path}`)?.shift();
      if (!next && method === 'GET' && path.startsWith(`/studies/${STUDY_ID}/edges?`)) {
        return Promise.resolve(jsonResponse(200, { items: [] }));
      }
      if (!next) throw new Error(`unexpected ${method} ${path}`);
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const NODES = `/studies/${STUDY_ID}/nodes`;
const patches = () => requests.filter((r) => r.method === 'PATCH');

function renderSection(study: StudyResponse = STUDY) {
  const rendered = renderWithQuery(
    <NodesSection study={study} onReload={() => Promise.resolve()} />,
  );
  rendered.queryClient.setQueryData(studyQueryKey(STUDY_ID), study);
  return rendered;
}

/** Lists the three nodes, serves the conclusion's detail, and opens it. */
async function openConclusion(detail = conclusion(), list = [summary()]) {
  reply(`GET ${NODES}`, jsonResponse(200, { items: [...list, OBS_SUMMARY] }));
  reply(`GET ${NODES}/${CON}`, jsonResponse(200, detail));
  renderSection();
  fireEvent.click(await screen.findByRole('button', { name: /^Conclusion · You/ }));
  return screen.findByRole('region', { name: 'Conclusion' });
}

describe('question status (BIB-30)', () => {
  it('changes only through Change status and Save by keyboard, and says Saved after the 200', async () => {
    reply(`GET ${NODES}`, jsonResponse(200, { items: [QUE_SUMMARY] }));
    reply(`GET ${NODES}/${QUE}`, jsonResponse(200, question()));
    reply(`PATCH ${NODES}/${QUE}`, jsonResponse(200, saved(QUE, 'question')));
    reply(`GET ${NODES}`, jsonResponse(200, { items: [{ ...QUE_SUMMARY, status: 'answered' }] }));
    reply(`GET ${NODES}/${QUE}`, jsonResponse(200, question({ status: 'answered', revision: 2 })));
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: /^Question · You · Open/ }));
    const region = await screen.findByRole('region', { name: 'Question' });
    expect(textOf(region)).toContain('StatusOpen');
    expect(patches()).toStrictEqual([]);

    fireEvent.click(within(region).getByRole('button', { name: 'Change status' }));
    const form = within(region).getByRole('form', { name: 'Change question status' });
    expect(
      within(within(form).getByRole('group', { name: 'Status' }))
        .getAllByRole('radio')
        .map((radio) => [radio.getAttribute('value'), (radio as HTMLInputElement).checked]),
    ).toStrictEqual([
      ['open', true],
      ['partially_answered', false],
      ['answered', false],
      ['deferred', false],
    ]);
    fireEvent.click(within(form).getByRole('radio', { name: 'Answered' }));
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved');
    expect(patches().map((r) => r.body)).toStrictEqual([
      { expectedRevision: 1, status: 'answered' },
    ]);
    await waitFor(() => expect(textOf(region)).toContain('StatusAnswered'));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(region).getByRole('button', { name: 'Change status' }),
      ),
    );
  });

  it('shows no Change status in a read-only study', async () => {
    reply(`GET ${NODES}`, jsonResponse(200, { items: [QUE_SUMMARY] }));
    reply(`GET ${NODES}/${QUE}`, jsonResponse(200, question()));
    renderSection({ ...STUDY, lifecycle: 'archived' });
    fireEvent.click(await screen.findByRole('button', { name: /^Question · You · Open/ }));
    const region = await screen.findByRole('region', { name: 'Question' });
    expect(textOf(region)).toContain('StatusOpen');
    expect(within(region).queryByRole('button', { name: 'Change status' })).toBeNull();
  });
});

describe('conclusion markers and warnings (BIB-30)', () => {
  it('says Version N, Established by me with its help text, and Evidence incomplete as text, in the detail and the list', async () => {
    const region = await openConclusion(
      conclusion({
        status: 'supported',
        establishedAt: T,
        evidenceIncomplete: true,
        version: { id: V2, number: 3 },
      }),
      [summary({ status: 'supported', established: true, evidenceIncomplete: true })],
    );
    expect(textOf(region)).toContain('Version 3');
    expect(textOf(region)).toContain(`Established by me ${CONCLUSION_COPY.establishedHelp}`);
    expect(textOf(region)).toContain(CONCLUSION_COPY.incomplete);
    expect(textOf(screen.getByRole('button', { name: /^Conclusion · You · Supported/ }))).toContain(
      'Supported · Established by me · Evidence incomplete',
    );
    expect(within(region).getByRole('button', { name: 'Connect evidence' })).toBeTruthy();
    expect(within(region).getByRole('button', { name: "Remove 'Established by me'" })).toBeTruthy();
  });

  it('offers Mark as established by me only for a supported conclusion with live evidence', async () => {
    const region = await openConclusion(conclusion({ status: 'supported', liveEvidenceCount: 2 }), [
      summary({ status: 'supported' }),
    ]);
    reply(`PATCH ${NODES}/${CON}`, jsonResponse(200, saved(CON, 'conclusion')));
    reply(
      `GET ${NODES}/${CON}`,
      jsonResponse(
        200,
        conclusion({ status: 'supported', establishedAt: T, liveEvidenceCount: 2, revision: 2 }),
      ),
    );
    reply(
      `GET ${NODES}`,
      jsonResponse(200, {
        items: [summary({ status: 'supported', established: true }), OBS_SUMMARY],
      }),
    );
    fireEvent.click(within(region).getByRole('button', { name: 'Mark as established by me' }));
    await screen.findByText('Saved');
    expect(patches().map((r) => r.body)).toStrictEqual([
      { expectedRevision: 1, establishment: 'set' },
    ]);
    await within(region).findByRole('button', { name: "Remove 'Established by me'" });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(region).getByRole('button', { name: "Remove 'Established by me'" }),
      ),
    );
  });

  it('hides the marker button without live evidence, and every action in a read-only study', async () => {
    const region = await openConclusion(
      conclusion({ status: 'supported', evidenceIncomplete: true }),
      [summary({ status: 'supported', evidenceIncomplete: true })],
    );
    expect(within(region).queryByRole('button', { name: /established by me/i })).toBeNull();
  });
});

describe('conclusion actions (BIB-30)', () => {
  it('asks for evidence before Supported (422): a fixed message next to Status, and Connect evidence opens the Connect dialog on this conclusion', async () => {
    const region = await openConclusion();
    fireEvent.click(within(region).getByRole('button', { name: 'Change status' }));
    const form = within(region).getByRole('form', { name: 'Change conclusion status' });
    const mark = within(form).getByRole('checkbox', { name: 'Mark as established by me' });
    expect((mark as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(within(form).getByRole('radio', { name: 'Supported' }));
    expect((mark as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(within(form).getByRole('radio', { name: 'Challenged' }));
    expect((mark as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(within(form).getByRole('radio', { name: 'Supported' }));

    reply(
      `PATCH ${NODES}/${CON}`,
      jsonResponse(422, envelope('CONCLUSION_EVIDENCE_REQUIRED', { message: 'server words' })),
    );
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    const alert = await within(form).findByRole('alert');
    expect(textOf(alert)).toContain(CONCLUSION_COPY.evidenceRequired);
    expect(textOf(alert)).not.toContain('server words');
    expect(patches().map((r) => r.body)).toStrictEqual([
      { expectedRevision: 1, status: 'supported' },
    ]);

    fireEvent.click(within(alert).getByRole('button', { name: 'Connect evidence' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect nodes' });
    expect(within(dialog).getByLabelText<HTMLSelectElement>('To').value).toBe(CON);
    expect(within(dialog).getByLabelText<HTMLSelectElement>('Relationship').value).toBe('');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Connect evidence' })),
    );
  });

  it('sends Supported with the marker in one request and warns before a status that clears it', async () => {
    const region = await openConclusion(
      conclusion({
        status: 'supported',
        establishedAt: T,
        liveEvidenceCount: 1,
        version: { id: V2, number: 2 },
      }),
      [summary({ status: 'supported', established: true })],
    );
    fireEvent.click(within(region).getByRole('button', { name: 'Change status' }));
    const form = within(region).getByRole('form', { name: 'Change conclusion status' });
    expect(within(form).queryByText(CONCLUSION_COPY.clearsMarker)).toBeNull();
    fireEvent.click(within(form).getByRole('radio', { name: 'Challenged' }));
    expect(within(form).getByText(CONCLUSION_COPY.clearsMarker)).toBeTruthy();

    reply(
      `PATCH ${NODES}/${CON}`,
      jsonResponse(200, saved(CON, 'conclusion', { warnings: ['establishment_cleared'] })),
    );
    fireEvent.change(within(form).getByLabelText(/Why are you changing the status/), {
      target: { value: '  Romans 2:15 pushes back  ' },
    });
    reply(
      `GET ${NODES}/${CON}`,
      jsonResponse(200, conclusion({ status: 'challenged', revision: 2 })),
    );
    reply(
      `GET ${NODES}`,
      jsonResponse(200, { items: [summary({ status: 'challenged' }), OBS_SUMMARY] }),
    );
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await screen.findByText(CONCLUSION_COPY.savedCleared);
    expect(patches().map((r) => r.body)).toStrictEqual([
      { expectedRevision: 1, status: 'challenged', changeReason: '  Romans 2:15 pushes back  ' },
    ]);
  });

  it('requires a reason to revise and to abandon, and sends the statement with it', async () => {
    const region = await openConclusion();
    fireEvent.click(within(region).getByRole('button', { name: 'Revise statement' }));
    const form = within(region).getByRole('form', { name: 'Revise conclusion' });
    expect(within(form).getByLabelText<HTMLTextAreaElement>('Statement').value).toBe(
      'Conscience is a moral witness',
    );
    expect(textOf(form)).toContain(CONCLUSION_COPY.reviseHelp);
    fireEvent.change(within(form).getByLabelText('Statement'), {
      target: { value: 'Conscience is a moral witness that can be wrong' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(textOf(form)).toContain('Say why you are revising this.');
    expect(patches()).toStrictEqual([]);

    reply(`PATCH ${NODES}/${CON}`, jsonResponse(200, saved(CON, 'conclusion')));
    reply(`GET ${NODES}/${CON}`, jsonResponse(200, conclusion({ status: 'revised', revision: 2 })));
    reply(
      `GET ${NODES}`,
      jsonResponse(200, { items: [summary({ status: 'revised' }), OBS_SUMMARY] }),
    );
    fireEvent.change(within(form).getByLabelText('Why are you revising this?'), {
      target: { value: '1 Cor 8:7' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved');
    expect(patches().map((r) => r.body)).toStrictEqual([
      {
        expectedRevision: 1,
        text: 'Conscience is a moral witness that can be wrong',
        changeReason: '1 Cor 8:7',
      },
    ]);

    await waitFor(() => expect(textOf(region)).toContain('StatusRevised'));
    fireEvent.click(within(region).getByRole('button', { name: 'Change status' }));
    const statusForm = within(region).getByRole('form', { name: 'Change conclusion status' });
    fireEvent.click(within(statusForm).getByRole('radio', { name: 'Abandoned' }));
    fireEvent.click(within(statusForm).getByRole('button', { name: 'Save' }));
    expect(textOf(statusForm)).toContain('Say why you are changing the status'.slice(0, 0));
    expect(patches()).toHaveLength(1);
    expect(textOf(statusForm)).toContain('required');
  });

  it('keeps the draft on a 409 until Reload is confirmed; Retry resends the same key and body', async () => {
    const region = await openConclusion();
    fireEvent.click(within(region).getByRole('button', { name: 'Change status' }));
    const form = within(region).getByRole('form', { name: 'Change conclusion status' });
    fireEvent.click(within(form).getByRole('radio', { name: 'Challenged' }));
    reply(
      `PATCH ${NODES}/${CON}`,
      new TypeError('offline'),
      jsonResponse(409, envelope('REVISION_CONFLICT', { currentRevision: 3 })),
    );
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await within(form).findByRole('button', { name: 'Retry' });
    expect(textOf(form)).toContain(CONCLUSION_COPY.unknown);
    fireEvent.click(within(form).getByRole('button', { name: 'Retry' }));
    await within(form).findByRole('button', { name: 'Reload' });
    expect(textOf(form)).toContain(CONCLUSION_COPY.conflict);
    const [first, second] = patches();
    expect([second?.body, second?.key]).toStrictEqual([first?.body, first?.key]);
    expect(within(form).getByRole<HTMLInputElement>('radio', { name: 'Challenged' }).checked).toBe(
      true,
    );

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    reply(
      `GET ${NODES}/${CON}`,
      jsonResponse(200, conclusion({ status: 'supported', revision: 3, liveEvidenceCount: 1 })),
    );
    fireEvent.click(within(form).getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(within(form).getByRole<HTMLInputElement>('radio', { name: 'Supported' }).checked).toBe(
        true,
      ),
    );
  });

  it('shows no actions in a read-only study, only the status, marker, warning and History', async () => {
    reply(
      `GET ${NODES}`,
      jsonResponse(200, {
        items: [summary({ status: 'supported', established: true }), OBS_SUMMARY],
      }),
    );
    reply(
      `GET ${NODES}/${CON}`,
      jsonResponse(
        200,
        conclusion({ status: 'supported', establishedAt: T, liveEvidenceCount: 1 }),
      ),
    );
    renderSection({ ...STUDY, lifecycle: 'archived' });
    fireEvent.click(await screen.findByRole('button', { name: /^Conclusion · You/ }));
    const region = await screen.findByRole('region', { name: 'Conclusion' });
    expect(textOf(region)).toContain('Established by me');
    expect(within(region).getByRole('button', { name: /^History/ })).toBeTruthy();
    for (const name of ['Revise statement', 'Change status', "Remove 'Established by me'"]) {
      expect(within(region).queryByRole('button', { name })).toBeNull();
    }
  });
});

describe('History (BIB-30)', () => {
  const version = (overrides: Record<string, unknown>) => ({
    id: V1,
    versionNumber: 1,
    action: 'created',
    statement: 'Conscience is a moral witness',
    status: 'tentative',
    established: false,
    changeReason: null,
    createdAt: T,
    evidence: [],
    ...overrides,
  });

  it('loads only when opened and lists versions with reasons, evidence sentences and tombstones', async () => {
    const region = await openConclusion(conclusion({ version: { id: V2, number: 3 } }));
    const button = within(region).getByRole('button', { name: 'History (3 versions)' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(requests.some((r) => r.path.endsWith('/versions'))).toBe(false);
    reply(
      `GET ${NODES}/${CON}/versions`,
      jsonResponse(200, {
        items: [
          version({
            id: '33333333-2222-4333-8444-555555555555',
            versionNumber: 3,
            action: 'evidence_removed',
            status: 'supported',
            statement: 'It is a moral witness that can be wrong',
          }),
          version({
            id: V2,
            versionNumber: 2,
            action: 'established',
            status: 'supported',
            established: true,
            changeReason: '1 Cor 8:7',
            evidence: [
              {
                edgeId: EDGE,
                edgeType: 'supports',
                role: 'supporting',
                nodeId: OBS,
                nodeType: 'observation',
                label: 'Paul appeals to conscience',
                nodeRevision: 1,
                nodeVersionId: null,
                edgeLive: false,
                nodeLive: true,
                nodeChangedSince: true,
              },
            ],
          }),
          version({}),
        ],
      }),
    );
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const items = await within(region).findAllByText(/^Version \d · /);
    expect(items).toHaveLength(3);
    const text = textOf(region);
    expect(text).toContain('Version 3 · Supported');
    expect(text).toContain(CONCLUSION_COPY.evidenceRemoved);
    expect(text).toContain('Reason: 1 Cor 8:7');
    expect(text).toContain(
      'Observation: Paul appeals to conscience supports this conclusion (relationship changed or removed since) (edited since this version)',
    );
    expect(text).toContain('Version 1 · Tentative');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('says it is loading, and offers Retry when the history cannot load', async () => {
    const region = await openConclusion();
    reply(
      `GET ${NODES}/${CON}/versions`,
      jsonResponse(503, envelope('DEPENDENCY_UNAVAILABLE', { retryable: true })),
    );
    fireEvent.click(within(region).getByRole('button', { name: 'History (1 version)' }));
    const alert = await within(region).findByText("Couldn't load the history.");
    expect(
      within(alert.closest('[role="alert"]') as HTMLElement).getByRole('button', { name: 'Retry' }),
    ).toBeTruthy();
  });
});

describe('unsaved drafts (BIB-30)', () => {
  it('reports an unsaved Revise draft so the node detail stays open', () => {
    const onUnsavedChange = vi.fn();
    renderWithQuery(
      <ConclusionActions
        studyId={STUDY_ID}
        node={conclusion() as never}
        editable
        onSaved={() => undefined}
        onLocked={() => undefined}
        refetch={() => Promise.resolve()}
        onUnsavedChange={onUnsavedChange}
        onConnectEvidence={() => undefined}
        connecting={false}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Revise statement' }));
    expect(onUnsavedChange).toHaveBeenLastCalledWith(false);
    fireEvent.change(screen.getByLabelText('Statement'), { target: { value: 'Edited' } });
    expect(onUnsavedChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onUnsavedChange).toHaveBeenLastCalledWith(false);
  });
});
