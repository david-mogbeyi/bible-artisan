import { describe, expect, it } from 'vitest';
import { latencySlot, MAX_PENDING_KEYS, RequestMetricsRecorder } from './request-metrics';

const MINUTE = Date.UTC(2026, 10, 15, 12, 0);

describe('latencySlot', () => {
  it('puts a duration in the first slot whose bound it does not exceed, or overflow', () => {
    expect(latencySlot(0)).toBe(0);
    expect(latencySlot(25)).toBe(0);
    expect(latencySlot(25.1)).toBe(1);
    expect(latencySlot(500)).toBe(4);
    expect(latencySlot(750)).toBe(5);
    expect(latencySlot(10_000)).toBe(9);
    expect(latencySlot(10_001)).toBe(10);
  });
});

describe('RequestMetricsRecorder', () => {
  it('counts requests per minute, method and route by status class and latency slot', () => {
    let now = MINUTE + 5_000;
    const recorder = new RequestMetricsRecorder(() => now);
    const save = { method: 'PATCH', route: '/v1/studies/:studyId', aborted: false };
    recorder.record({ ...save, status: 200, durationMs: 40 });
    recorder.record({ ...save, status: 409, durationMs: 600 });
    recorder.record({ ...save, status: 503, durationMs: 20_000 });
    recorder.record({ ...save, status: null, durationMs: 3, aborted: true });
    recorder.record({ method: 'GET', route: '/v1/me', status: 401, durationMs: 1, aborted: false });
    now = MINUTE + 60_000;
    recorder.record({ ...save, status: 404, durationMs: 1 });
    recorder.record({ ...save, status: 403, durationMs: 1 });

    const { rows, dropped } = recorder.drain();
    expect(dropped).toBe(0);
    expect(rows).toStrictEqual([
      {
        bucketStart: new Date(MINUTE),
        method: 'PATCH',
        route: '/v1/studies/:studyId',
        requestCount: 4,
        serverErrorCount: 1,
        conflictCount: 1,
        unauthorizedCount: 0,
        forbiddenCount: 0,
        notFoundCount: 0,
        abortedCount: 1,
        latencyHistogram: [1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      },
      {
        bucketStart: new Date(MINUTE),
        method: 'GET',
        route: '/v1/me',
        requestCount: 1,
        serverErrorCount: 0,
        conflictCount: 0,
        unauthorizedCount: 1,
        forbiddenCount: 0,
        notFoundCount: 0,
        abortedCount: 0,
        latencyHistogram: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      },
      {
        bucketStart: new Date(MINUTE + 60_000),
        method: 'PATCH',
        route: '/v1/studies/:studyId',
        requestCount: 2,
        serverErrorCount: 0,
        conflictCount: 0,
        unauthorizedCount: 0,
        forbiddenCount: 1,
        notFoundCount: 1,
        abortedCount: 0,
        latencyHistogram: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      },
    ]);
    expect(recorder.drain()).toStrictEqual({ rows: [], dropped: 0 });
  });

  it('merges restored rows back into pending counts after a failed flush', () => {
    const recorder = new RequestMetricsRecorder(() => MINUTE);
    const request = { method: 'GET', route: '/v1/me', status: 500, durationMs: 1, aborted: false };
    recorder.record(request);
    const { rows } = recorder.drain();
    recorder.record(request);
    recorder.restore(rows);
    const [row] = recorder.drain().rows;
    expect(row?.requestCount).toBe(2);
    expect(row?.serverErrorCount).toBe(2);
    expect(row?.latencyHistogram[0]).toBe(2);
  });

  it('stops adding keys at the bound and reports what it dropped', () => {
    const recorder = new RequestMetricsRecorder(() => MINUTE);
    for (let i = 0; i <= MAX_PENDING_KEYS; i += 1) {
      recorder.record({
        method: 'GET',
        route: `/v1/r${i}`,
        status: 200,
        durationMs: 1,
        aborted: false,
      });
    }
    const { rows, dropped } = recorder.drain();
    expect(rows).toHaveLength(MAX_PENDING_KEYS);
    expect(dropped).toBe(1);
  });
});
