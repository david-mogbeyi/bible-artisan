import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, EDITION_ID, TRANSLATION } from '@/test/bible-fixtures';
import { libraryQueryKey } from '@/lib/studies';
import { jsonResponse, renderWithQuery } from '@/test/render';
import {
  BLANK_RULE,
  NewStudyForm,
  OFFLINE,
  QUESTION_BAD_CHARACTERS,
  START_RULE,
  TITLE_BAD_CHARACTERS,
} from './new-study-form';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));

const STUDY_ID = 'aaaaaaaa-2222-4333-8444-555555555555';
const ROMANS = {
  id: 'bbbbbbbb-2222-4333-8444-555555555555',
  editionId: EDITION_ID,
  bookCode: 'ROM',
  startChapter: 9,
  startVerse: 1,
  endChapter: 9,
  endVerse: 1,
  label: 'Romans 9:1',
};
const JUDGES_1 = {
  ...ROMANS,
  id: 'cccccccc-2222-4333-8444-555555555555',
  bookCode: 'JDG',
  startChapter: 1,
  endChapter: 1,
  label: 'Judges 1:1',
};
const CREATED = {
  studyId: STUDY_ID,
  revision: 1,
  contentRevision: 1,
  rootNodeId: null,
  questionNodeId: 'dddddddd-2222-4333-8444-555555555555',
  branchId: 'eeeeeeee-2222-4333-8444-555555555555',
  lastEventSequence: '1',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Reply = Response | Error | Promise<Response>;
let resolveReplies: Map<string, Reply>;
let createReplies: Reply[];
let fetchMock: ReturnType<typeof vi.fn>;

function reply(next: Reply | undefined, what: string): Promise<Response> {
  if (next === undefined) throw new Error(`unexpected ${what}`);
  return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
}

beforeEach(() => {
  push.mockReset();
  resolveReplies = new Map();
  createReplies = [];
  fetchMock = vi.fn((input: string, init?: RequestInit) => {
    if (input.endsWith('/bible/translations')) {
      return Promise.resolve(jsonResponse(200, { translations: [TRANSLATION] }));
    }
    if (input.endsWith('/bible/resolve')) {
      const { input: text } = JSON.parse(init?.body as string) as { input: string };
      return reply(resolveReplies.get(text), `resolve of ${text}`);
    }
    if (input.endsWith('/studies') && init?.method === 'POST') {
      return reply(createReplies.shift(), 'create');
    }
    throw new Error(`unexpected fetch ${input}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** How many POST /bible/resolve requests were sent. */
function resolveCount(): number {
  return (fetchMock.mock.calls as [string][]).filter(([input]) => input.endsWith('/bible/resolve'))
    .length;
}

/** Every POST /studies sent: its body and Idempotency-Key. */
function createCalls(): { body: unknown; key: string | undefined }[] {
  return (fetchMock.mock.calls as [string, RequestInit | undefined][])
    .filter(([input, init]) => input.endsWith('/studies') && init?.method === 'POST')
    .map(([, init]) => ({
      body: JSON.parse(init?.body as string) as unknown,
      key: (init?.headers as Record<string, string>)['Idempotency-Key'],
    }));
}

async function renderForm() {
  const rendered = renderWithQuery(<NewStudyForm />);
  // The translation selector is loaded before a passage can be checked.
  await screen.findByRole('option', { name: TRANSLATION.name });
  return rendered;
}

const field = (name: RegExp) => screen.getByLabelText(name);
const type = (name: RegExp, value: string) => fireEvent.change(field(name), { target: { value } });
const createButton = () => screen.getByRole('button', { name: 'Create study' });

describe('NewStudyForm', () => {
  it('resolves the passage inline, creates the study with one key, and opens it', async () => {
    resolveReplies.set('Rom 9:1', jsonResponse(200, { outcome: 'resolved', reference: ROMANS }));
    createReplies.push(jsonResponse(201, CREATED));
    await renderForm();

    type(/^Question/, '  What is conscience?  ');
    type(/^Passage$/, 'Rom 9:1');
    fireEvent.blur(field(/^Passage$/));
    expect(await screen.findByText('Starting passage: Romans 9:1')).toBeTruthy();

    fireEvent.click(createButton());
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/studies/${STUDY_ID}`));
    const calls = createCalls();
    expect(calls).toStrictEqual([
      {
        body: { question: 'What is conscience?', startingReferenceId: ROMANS.id },
        key: expect.stringMatching(UUID),
      },
    ]);
  });

  it('marks every cached library listing stale once the study is created, and only then', async () => {
    const recent = libraryQueryKey({ sort: 'recent', pinnedFirst: false, limit: 3 });
    const searched = libraryQueryKey({ sort: 'title', q: 'conscience' });
    const { queryClient } = await renderForm();
    for (const key of [recent, searched]) {
      queryClient.setQueryData(key, { items: [], nextCursor: null });
    }
    const stale = () =>
      [recent, searched].map((key) => queryClient.getQueryState(key)?.isInvalidated);

    // A refused create wrote nothing: the listings stay as they are.
    createReplies.push(
      jsonResponse(503, {
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'x',
        retryable: true,
        correlationId: 'x',
      }),
    );
    type(/^Question/, 'What is conscience?');
    fireEvent.click(createButton());
    await screen.findByRole('alert');
    expect(stale()).toStrictEqual([false, false]);

    createReplies.push(jsonResponse(201, CREATED));
    fireEvent.click(createButton());
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/studies/${STUDY_ID}`));
    expect(stale()).toStrictEqual([true, true]);
  });

  it('explains the start rule inline and sends nothing when there is no question or passage', async () => {
    await renderForm();
    type(/^Title/, 'Only a title');
    fireEvent.click(createButton());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(START_RULE);
    await waitFor(() => expect(document.activeElement).toBe(alert.parentElement));
    expect((field(/^Title/) as HTMLInputElement).value).toBe('Only a title');
    expect(createCalls()).toStrictEqual([]);
  });

  it('offers the candidate books for an ambiguous passage and resolves the one picked', async () => {
    resolveReplies.set(
      'Jud 1:1',
      jsonResponse(200, {
        outcome: 'ambiguous',
        candidates: [
          { bookCode: 'JDG', bookName: 'Judges', input: 'Judges 1:1' },
          { bookCode: 'JUD', bookName: 'Jude', input: 'Jude 1:1' },
        ],
      }),
    );
    resolveReplies.set(
      'Judges 1:1',
      jsonResponse(200, { outcome: 'resolved', reference: JUDGES_1 }),
    );
    await renderForm();
    type(/^Passage$/, 'Jud 1:1');
    fireEvent.blur(field(/^Passage$/));

    const group = await screen.findByRole('group', { name: 'Which book did you mean?' });
    fireEvent.click(within(group).getByRole('button', { name: 'Judges' }));
    expect(await screen.findByText('Starting passage: Judges 1:1')).toBeTruthy();
    expect((field(/^Passage$/) as HTMLInputElement).value).toBe('Judges 1:1');
  });

  it('shows a reference correction at the passage field and creates nothing', async () => {
    resolveReplies.set(
      'Rom 99:1',
      jsonResponse(422, {
        code: 'REFERENCE_CHAPTER_OUT_OF_RANGE',
        message: 'server text, never shown',
        retryable: false,
        correlationId: 'x',
      }),
    );
    await renderForm();
    type(/^Question/, 'Why?');
    type(/^Passage$/, 'Rom 99:1');
    fireEvent.click(createButton());

    expect(await screen.findByText('That chapter does not exist in this book.')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(field(/^Passage$/)));
    expect(field(/^Passage$/).getAttribute('aria-invalid')).toBe('true');
    expect(screen.queryByText('server text, never shown')).toBeNull();
    expect(createCalls()).toStrictEqual([]);
  });

  it('keeps the draft after a network failure and Retry of the unchanged draft resends the same body with the same key', async () => {
    createReplies.push(new TypeError('Failed to fetch'), jsonResponse(201, CREATED));
    await renderForm();
    type(/^Question/, 'What is conscience?');
    fireEvent.click(createButton());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      "Couldn't confirm the study was created. Your draft is still here, and Retry won't create a duplicate.",
    );
    expect((field(/^Question/) as HTMLInputElement).value).toBe('What is conscience?');
    expect(push).not.toHaveBeenCalled();

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/studies/${STUDY_ID}`));
    const [first, retried] = createCalls();
    expect(first).toStrictEqual({
      body: { question: 'What is conscience?' },
      key: expect.stringMatching(UUID),
    });
    expect(retried).toStrictEqual(first);
  });

  it('Retry after an edit sends the current draft with a new key, never the old key with a new body', async () => {
    createReplies.push(new TypeError('Failed to fetch'), jsonResponse(201, CREATED));
    await renderForm();
    type(/^Question/, 'What is conscience?');
    fireEvent.click(createButton());
    const alert = await screen.findByRole('alert');

    type(/^Question/, 'What is a good conscience?');
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/studies/${STUDY_ID}`));
    const [first, retried] = createCalls();
    expect(retried?.body).toStrictEqual({ question: 'What is a good conscience?' });
    expect(retried?.key).toMatch(UUID);
    expect(retried?.key).not.toBe(first?.key);
  });

  it('never pairs one key with two bodies across failures, retries, edits and resubmits', async () => {
    createReplies.push(
      new TypeError('Failed to fetch'),
      new TypeError('Failed to fetch'),
      new TypeError('Failed to fetch'),
      new TypeError('Failed to fetch'),
      jsonResponse(201, CREATED),
    );
    await renderForm();
    const retry = async () =>
      fireEvent.click(
        within(await screen.findByRole('alert')).getByRole('button', { name: 'Retry' }),
      );
    type(/^Question/, 'One');
    fireEvent.click(createButton());
    await retry();
    await waitFor(() => expect(createCalls()).toHaveLength(2));
    type(/^Question/, 'Two');
    await retry();
    await waitFor(() => expect(createCalls()).toHaveLength(3));
    type(/^Question/, 'One');
    fireEvent.click(createButton());
    await waitFor(() => expect(createCalls()).toHaveLength(4));
    type(/^Title/, 'Titled');
    await retry();
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));

    const bodiesByKey = new Map<string | undefined, Set<string>>();
    for (const call of createCalls()) {
      const bodies = bodiesByKey.get(call.key) ?? new Set<string>();
      bodies.add(JSON.stringify(call.body));
      bodiesByKey.set(call.key, bodies);
    }
    expect([...bodiesByKey.values()].map((bodies) => bodies.size)).toStrictEqual([1, 1, 1, 1]);
  });

  it('resolves a typed passage once when the field is left and Create pressed while the check runs', async () => {
    const check = deferred<Response>();
    resolveReplies.set('Rom 9:1', check.promise);
    createReplies.push(jsonResponse(201, CREATED));
    await renderForm();
    type(/^Passage$/, 'Rom 9:1');
    fireEvent.blur(field(/^Passage$/));
    fireEvent.click(createButton());
    check.resolve(jsonResponse(200, { outcome: 'resolved', reference: ROMANS }));
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(resolveCount()).toBe(1);
    expect(createCalls().map((c) => c.body)).toStrictEqual([{ startingReferenceId: ROMANS.id }]);
  });

  it('checks the passage again after it is edited, and after a failed check', async () => {
    resolveReplies.set('Rom 9:1', new TypeError('Failed to fetch'));
    await renderForm();
    type(/^Passage$/, 'Rom 9:1');
    fireEvent.blur(field(/^Passage$/));
    await screen.findByText("Couldn't check the passage.");
    resolveReplies.set('Rom 9:1', jsonResponse(200, { outcome: 'resolved', reference: ROMANS }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Starting passage: Romans 9:1')).toBeTruthy();
    expect(resolveCount()).toBe(2);
  });

  it.each([
    ['title', /^Title/, 'Con\u0000science', TITLE_BAD_CHARACTERS],
    ['question', /^Question/, 'Why\u0007?', QUESTION_BAD_CHARACTERS],
  ])('refuses control characters in the %s before sending', async (_, name, value, message) => {
    await renderForm();
    type(/^Question/, 'Why?');
    type(name, value);
    fireEvent.click(createButton());
    expect(await screen.findByText(message)).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(field(name)));
    expect(createCalls()).toStrictEqual([]);
  });

  it('blocks creation while offline and keeps the draft', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await renderForm();
    type(/^Question/, 'What is conscience?');
    fireEvent.click(createButton());
    expect((await screen.findByRole('alert')).textContent).toContain(OFFLINE);
    expect((field(/^Question/) as HTMLInputElement).value).toBe('What is conscience?');
    expect(createCalls()).toStrictEqual([]);
  });

  it('sends one request however often Create is pressed while it is pending, keeping focus on it', async () => {
    const pending = deferred<Response>();
    createReplies.push(pending.promise);
    await renderForm();
    type(/^Question/, 'Why?');
    createButton().focus();
    fireEvent.click(createButton());
    expect(await screen.findByText('Creating study…')).toBeTruthy();
    expect(createButton().getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(createButton());
    fireEvent.click(screen.getByRole('button', { name: 'Start a blank study' }));
    expect(document.activeElement).toBe(createButton());
    pending.resolve(jsonResponse(201, CREATED));
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(createCalls()).toHaveLength(1);
  });

  it('sends one request when Create is pressed again while the passage is still being checked', async () => {
    const check = deferred<Response>();
    resolveReplies.set('Rom 9:1', check.promise);
    createReplies.push(jsonResponse(201, CREATED));
    await renderForm();
    type(/^Passage$/, 'Rom 9:1');
    fireEvent.click(createButton());
    fireEvent.click(createButton());
    check.resolve(jsonResponse(200, { outcome: 'resolved', reference: ROMANS }));
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(createCalls().map((c) => c.body)).toStrictEqual([{ startingReferenceId: ROMANS.id }]);
  });

  it('points a REFERENCE_NOT_FOUND refusal at the passage field', async () => {
    resolveReplies.set('Rom 9:1', jsonResponse(200, { outcome: 'resolved', reference: ROMANS }));
    createReplies.push(
      jsonResponse(422, {
        code: 'REFERENCE_NOT_FOUND',
        message: 'server text',
        retryable: false,
        correlationId: 'x',
      }),
    );
    await renderForm();
    type(/^Passage$/, 'Rom 9:1');
    fireEvent.click(createButton());
    expect(
      await screen.findByText(
        "That passage isn't available in an active translation. Look it up again.",
      ),
    ).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(field(/^Passage$/)));
    expect(push).not.toHaveBeenCalled();
  });

  it('starts a blank study with only its title, and refuses one that has a question', async () => {
    createReplies.push(jsonResponse(201, { ...CREATED, questionNodeId: null, branchId: null }));
    await renderForm();
    type(/^Question/, 'Why?');
    fireEvent.click(screen.getByRole('button', { name: 'Start a blank study' }));
    expect((await screen.findByRole('alert')).textContent).toContain(BLANK_RULE);
    expect(createCalls()).toStrictEqual([]);

    type(/^Question/, '');
    type(/^Title/, 'Later');
    fireEvent.click(screen.getByRole('button', { name: 'Start a blank study' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/studies/${STUDY_ID}`));
    expect(createCalls().map((c) => c.body)).toStrictEqual([{ blank: true, title: 'Later' }]);
  });

  it('shows the limits and refuses an over-long question before sending it', async () => {
    await renderForm();
    type(/^Question/, 'q'.repeat(4001));
    expect(screen.getByText('4,001/4,000 characters')).toBeTruthy();
    fireEvent.click(createButton());
    expect(await screen.findByText('Use at most 4,000 characters for the question.')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(field(/^Question/)));
    expect(createCalls()).toStrictEqual([]);
  });
});
