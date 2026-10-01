import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, renderWithQuery } from '@/test/render';
import { SignInForm } from './sign-in-form';

const replace = vi.fn();
let search = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => search,
}));

const CHALLENGE = '6f1c2b9e-8a4d-4e3f-9b21-7c5d0e8a1f42';
const ME = {
  id: '0b7c0a8e-5d7b-4c1e-9a3f-2f7e1c9d4b60',
  email: 'reader@example.test',
  displayName: null,
  timezone: 'UTC',
};

function started(resendInMs = 60_000): Response {
  return jsonResponse(202, {
    challengeId: CHALLENGE,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    resendAvailableAt: new Date(Date.now() + resendInMs).toISOString(),
  });
}

function envelope(status: number, code: string, headers: Record<string, string> = {}): Response {
  return jsonResponse(
    status,
    { code, message: 'x', retryable: status === 429, correlationId: CHALLENGE },
    headers,
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  search = new URLSearchParams();
  replace.mockReset();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function submitEmail(email = 'reader@example.test'): Promise<void> {
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: email } });
  fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
  await screen.findByLabelText('Sign-in code');
}

describe('SignInForm', () => {
  it('signs in with email then code and returns to the requested route', async () => {
    search = new URLSearchParams({ next: '/studies/42?tab=thread' });
    fetchMock.mockResolvedValueOnce(started()).mockResolvedValueOnce(jsonResponse(200, ME));
    const { queryClient } = renderWithQuery(<SignInForm />);

    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy();
    const emailInput = screen.getByLabelText('Email address');
    expect(emailInput.getAttribute('type')).toBe('email');
    expect(emailInput.getAttribute('autocomplete')).toBe('email');
    await submitEmail();

    const codeInput = screen.getByLabelText('Sign-in code');
    expect(document.activeElement).toBe(codeInput);
    expect(codeInput.getAttribute('autocomplete')).toBe('one-time-code');
    expect(codeInput.getAttribute('inputmode')).toBe('numeric');
    expect(screen.getByText('Enter the 6-digit code sent to reader@example.test.')).toBeTruthy();

    fireEvent.change(codeInput, { target: { value: '123456' } });
    const codeForm = codeInput.closest('form');
    if (!codeForm) throw new Error('code input is not inside a form');
    fireEvent.submit(codeForm);

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/studies/42?tab=thread'));
    expect(queryClient.getQueryData(['me'])).toStrictEqual(ME);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/\/auth\/otp\/start$/),
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ email: 'reader@example.test' }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/\/auth\/otp\/verify$/),
      expect.objectContaining({
        body: JSON.stringify({ challengeId: CHALLENGE, code: '123456' }),
      }),
    );
  });

  it('falls back to home for an unsafe next parameter', async () => {
    search = new URLSearchParams({ next: '//evil.example/' });
    fetchMock.mockResolvedValueOnce(started()).mockResolvedValueOnce(jsonResponse(200, ME));
    renderWithQuery(<SignInForm />);
    await submitEmail();
    fireEvent.change(screen.getByLabelText('Sign-in code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
  });

  it.each([
    ['OTP_INVALID', "That code isn't right. Check the email and try again."],
    ['OTP_EXPIRED', 'That code has expired or was already used. Request a new code.'],
    ['OTP_ATTEMPTS_EXHAUSTED', 'Too many attempts for this code. Request a new code.'],
  ])('shows %s in a focused alert and keeps the typed code', async (code, message) => {
    fetchMock.mockResolvedValueOnce(started()).mockResolvedValueOnce(envelope(422, code));
    renderWithQuery(<SignInForm />);
    await submitEmail();
    fireEvent.change(screen.getByLabelText('Sign-in code'), { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(message);
    expect(document.activeElement).toBe(alert);
    expect(screen.getByLabelText<HTMLInputElement>('Sign-in code').value).toBe('654321');
    expect(replace).not.toHaveBeenCalled();
  });

  it('keeps "Send a new code" disabled with a countdown, then sends a new code', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock.mockResolvedValueOnce(started(3_000)).mockResolvedValueOnce(started(60_000));
    renderWithQuery(<SignInForm />);
    await submitEmail();

    const resend = screen.getByRole<HTMLButtonElement>('button', { name: 'Send a new code' });
    expect(resend.disabled).toBe(true);
    expect(screen.getByText(/You can request a new code in [1-3] s\./)).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(resend.disabled).toBe(false);
    fireEvent.click(resend);
    expect((await screen.findByRole('status')).textContent).toContain('A new code was sent.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Send a new code' }).disabled,
    ).toBe(true);
  });

  it('shows a countdown from Retry-After when sending is rate limited, keeping the email', async () => {
    fetchMock.mockResolvedValueOnce(envelope(429, 'RATE_LIMITED', { 'retry-after': '42' }));
    renderWithQuery(<SignInForm />);
    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'reader@example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Please wait before requesting another code.',
    );
    expect(screen.getByText(/You can request a new code in (41|42) s\./)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send code' }).disabled).toBe(
      true,
    );
    expect(screen.getByLabelText<HTMLInputElement>('Email address').value).toBe(
      'reader@example.test',
    );
  });

  it('shows a generic error when the network fails, keeping the email', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network down'));
    renderWithQuery(<SignInForm />);
    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'reader@example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Something went wrong. Try again.',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Email address').value).toBe(
      'reader@example.test',
    );
  });

  it('lets the user go back and change the email', async () => {
    fetchMock.mockResolvedValueOnce(started());
    renderWithQuery(<SignInForm />);
    await submitEmail();
    fireEvent.click(screen.getByRole('button', { name: 'Use a different email' }));
    expect(screen.getByLabelText<HTMLInputElement>('Email address').value).toBe(
      'reader@example.test',
    );
    // The 60 s resend window belongs to the previous email, so a different one can be sent now.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send code' }).disabled).toBe(
      false,
    );
    expect(screen.queryByText(/You can request a new code in/)).toBeNull();
  });

  it('moves focus back to the alert when the same error repeats', async () => {
    fetchMock
      .mockResolvedValueOnce(started())
      .mockResolvedValueOnce(envelope(422, 'OTP_INVALID'))
      .mockResolvedValueOnce(envelope(422, 'OTP_INVALID'));
    renderWithQuery(<SignInForm />);
    await submitEmail();
    const codeInput = screen.getByLabelText<HTMLInputElement>('Sign-in code');
    fireEvent.change(codeInput, { target: { value: '111111' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const alert = await screen.findByRole('alert');
    await waitFor(() => expect(document.activeElement).toBe(alert));

    codeInput.focus();
    fireEvent.change(codeInput, { target: { value: '222222' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('alert')));
  });
});
