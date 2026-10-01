import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scheduleTrashPurge } from './trash-purge-schedule';

describe('scheduleTrashPurge (BIB-22)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('purges at once and then every interval, and keeps going after a failed run, logging only its class', async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const purgeExpired = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new TypeError('private detail'))
      .mockResolvedValue(0);
    const stop = scheduleTrashPurge({ purgeExpired }, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(purgeExpired).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls).toStrictEqual([['trash_purge_failed', { errorType: 'TypeError' }]]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(purgeExpired).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(purgeExpired).toHaveBeenCalledTimes(3);
  });

  it('never overlaps runs: a tick while a purge is still running is skipped', async () => {
    vi.useFakeTimers();
    let finish: () => void = () => undefined;
    const purgeExpired = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          finish = () => resolve(0);
        }),
    );
    const stop = scheduleTrashPurge({ purgeExpired }, 1000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(purgeExpired).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(1000);
    expect(purgeExpired).toHaveBeenCalledTimes(2);
    stop();
  });
});
