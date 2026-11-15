# Study-size benchmarks (BIB-52)

Release evidence for NFR-PERF-001…005 and NFR-SCALE-001/002 (PRD sections 22 and 31). These are
measured numbers, not targets. Re-run them after changes to graph, thread, search or the mutation
pipeline, and replace the tables below.

## How to run

```sh
# From the repo root. Uses .env DATABASE_URL as it is: migrated, with the WEB corpus imported.
pnpm --filter @bible-artisan/api bench:sizes
# Optional: BENCH_OUT=/path/report.json to keep the JSON report; BENCH_ITERATIONS=50 (default).
```

The script (`apps/api/scripts/bench-study-sizes.run.ts`) boots the real AppModule on a loopback
port, signs in a throwaway user and seeds through the public API, so every write goes through the
normal mutation pipeline (revision check, StudyEvent, idempotency receipt):

| Fixture          | Contents                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| 20-node study    | 20 nodes (question / thought / observation, text 60 to 6,000 characters), 20 edges              |
| 100-node study   | 100 nodes, 200 edges                                                                            |
| 500-node study   | 500 nodes, 1,500 edges, Study Thread topped up to 10,000 events (copies of its own events, SQL) |
| 2,000-node study | 2,000 nodes: the node cap. The 2,001st node is attempted                                        |
| Account          | 100 studies in all (the four above plus 96 blank ones)                                          |

Each read is warmed up three times, then timed 50 times in sequence (p50 / p95 / max). Three reads
are also fired as one burst of 100 concurrent requests. The "workspace bundle" is the set of reads
the study page makes in parallel before it shows content (study, graph, nodes, notes, first thread
page, limits), timed until the last one answers. The user and all its rows are deleted at the end.

## Environment

| Item      | Value                                                                         |
| --------- | ----------------------------------------------------------------------------- |
| Measured  | 2026-11-15T12:18Z                                                             |
| Machine   | Apple M4 Max, 16 cores, 48 GiB RAM, macOS 26.6.2 (Darwin 25.6.0)              |
| Runtime   | Node v24.18.0, one API process (NestJS), default pool settings                |
| Database  | PostgreSQL 16.14 (Homebrew), local, shared_buffers 128MB, max_connections 100 |
| Transport | Loopback HTTP; the client runs in the same process as the API                 |
| Corpus    | WEB, 31,103 verses                                                            |

This is a developer laptop with the database on the same machine, not the PRD's production
environment (section 22 "at 100 concurrent active users"). Treat the numbers as a lower bound on
server latency: network, TLS, a remote database and real concurrency all add to them.

## Results (milliseconds)

| Measurement                                               | n    | p50    | p95    | max    |
| --------------------------------------------------------- | ---- | ------ | ------ | ------ |
| Workspace bundle, 20 nodes                                | 50   | 8.2    | 9.6    | 11.3   |
| GET /graph, 20 nodes                                      | 50   | 4.9    | 5.4    | 5.5    |
| GET /nodes, 20 nodes                                      | 50   | 3.2    | 4.4    | 5.4    |
| GET /limits, 20 nodes                                     | 50   | 2.6    | 3.0    | 3.0    |
| Workspace bundle, 100 nodes                               | 50   | 13.1   | 15.9   | 16.7   |
| GET /graph, 100 nodes                                     | 50   | 7.3    | 8.1    | 8.5    |
| GET /nodes, 100 nodes                                     | 50   | 5.4    | 6.4    | 7.5    |
| GET /limits, 100 nodes                                    | 50   | 2.7    | 3.3    | 3.9    |
| Workspace bundle, 500 nodes / 1,500 edges / 10,000 events | 50   | 38.2   | 40.8   | 42.5   |
| GET /graph, 500 nodes / 1,500 edges                       | 50   | 24.8   | 31.3   | 31.9   |
| GET /nodes, 500 nodes                                     | 50   | 17.1   | 19.8   | 21.2   |
| GET /limits, 500 nodes                                    | 50   | 3.6    | 4.9    | 5.2    |
| Workspace bundle, 2,000 nodes (cap)                       | 50   | 111.7  | 117.5  | 119.5  |
| GET /graph, 2,000 nodes (cap)                             | 50   | 57.9   | 67.1   | 69.3   |
| GET /nodes, 2,000 nodes (cap)                             | 50   | 60.2   | 74.4   | 82.3   |
| GET /limits, 2,000 nodes (cap)                            | 50   | 3.8    | 5.3    | 6.2    |
| GET /studies/:id, 500 nodes                               | 50   | 2.8    | 3.3    | 3.5    |
| GET /events first page (50), 10,000 events                | 50   | 5.3    | 6.9    | 7.3    |
| GET /events every page (200 pages of 50), 10,000 events   | 200  | 5.0    | 7.8    | 9.9    |
| GET /studies library (50), 100 studies                    | 50   | 4.4    | 5.4    | 5.6    |
| GET /resume, 500 nodes                                    | 50   | 8.8    | 10.8   | 11.5   |
| GET /bible/passages (Romans 9)                            | 50   | 2.9    | 4.8    | 5.0    |
| GET /bible/search, terms                                  | 50   | 3.7    | 4.7    | 5.2    |
| GET /bible/search, phrase                                 | 50   | 3.6    | 4.6    | 4.6    |
| GET /events first page, 10,000 events, 100 concurrent     | 100  | 102.1  | 191.3  | 200.7  |
| GET /graph, 500 nodes, 100 concurrent                     | 100  | 1174.4 | 2119.2 | 2132.9 |
| GET /bible/search terms, 100 concurrent                   | 100  | 49.2   | 65.8   | 66.0   |
| Account storage measurement, 100 studies (8.6 MB)         | 10   | 11.9   | 17.7   | 17.7   |
| POST /studies (during seeding)                            | 100  | 5.2    | 7.0    | 50.0   |
| POST /nodes (during seeding)                              | 2620 | 6.1    | 10.2   | 19.2   |
| POST /edges (during seeding)                              | 1720 | 6.9    | 12.0   | 21.4   |

Cap boundary: with 2,000 live nodes the 2,001st `POST /nodes` answered 422 `NODE_LIMIT_EXCEEDED`,
and `GET /limits` reported `nodes: { used: 2000, limit: 2000, state: "reached" }`; every read above
still answered at the cap.

## Against the requirements

| Requirement                                                               | Server-side evidence                                                                                  | Status                                                 |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| NFR-PERF-001 reader and ordinary mutations p95 ≤ 500 ms                   | Passage read p95 4.8 ms; node / edge / study creation p95 ≤ 12 ms (sequential)                        | Met sequentially; not measured at 100 concurrent users |
| NFR-PERF-002 keyword search p95 ≤ 750 ms, bounded pages                   | Terms / phrase p95 4.7 / 4.6 ms; 100 concurrent p95 65.8 ms; 25 results per page                      | Met (single process, local)                            |
| NFR-PERF-003 usable content ≤ 2 s (20), ≤ 3 s (100), ≤ 5 s (500 nodes)    | Server part p95 9.6 / 15.9 / 40.8 ms; headless browser, open to usable p95 182 ms (100), 279 ms (500) | Met for 100 and 500 on this machine; 20 not measured   |
| NFR-PERF-004 ≥ 30 FPS at 100 nodes; no main-thread freeze > 200 ms at 500 | Headless: 60 FPS pan/drag at 100 nodes; longest task 143 ms unthrottled, 267 ms at 2x CPU throttle    | Met on this machine; margin thin on slower CPUs        |
| NFR-PERF-005 10,000 events, 50 per page, p95 ≤ 500 ms                     | Every one of the 200 pages p95 7.8 ms; first page under 100 concurrent requests p95 191 ms            | Met                                                    |
| NFR-SCALE-001 500 nodes / 1,500 edges / 10,000 events / 100 studies       | All seeded and read above                                                                             | Met (server)                                           |
| NFR-SCALE-002 caps, 80% warnings, read/export/delete at cap               | 2,000-node boundary above; event and storage caps and warnings covered by `safety-limits.int-spec.ts` | Met (server and UI notice)                             |

Observations:

- `GET /graph` is unpaginated by design (bounded by the node and edge caps). One process answering
  100 simultaneous 500-node graph reads takes up to 2.1 s for the last one; that is a burst well
  beyond one user's use, but it is the first read to watch if real concurrency grows.
- The account storage measurement scans the owner's rows: 17.7 ms p95 at 8.6 MB. It grows with
  the account, so it is cached per owner for 60 seconds and the mutation pipeline reads the cached
  figure; near the 500 MB cap a fresh measurement may take on the order of a second, once a minute.

## Browser measurements (headless Chromium, 2026-11-15)

Measured with Playwright against a production build of `main` (web and API on the same machine,
worker and PostgreSQL local), on the machine in the Environment table: Apple M4 Max, 16 cores,
48 GiB RAM (51,539,607,552 bytes), macOS 26.6.2. Browser: headless Chromium 156.0.8078.4
(Playwright build chromium-1248), viewport 1440x900. Other browser test runs may have shared the
machine. The fixtures were seeded through the public API (2,302 writes in 8.5 s, p50 3 ms, p95
5 ms): one study with 500 nodes / 1,500 edges / 2,001 events and one with 100 nodes / 200 edges.

Headless FPS is indicative only: headless Chromium has no real display vsync and may composite
differently from a GPU-backed browser, so "60 FPS" means no requestAnimationFrame tick was
dropped, not a measured display frame rate. CPU throttling (DevTools `setCPUThrottlingRate`) is
only a rough stand-in for a slower machine.

| Measurement (5 cold runs each unless stated)                 | Result                                                                                               |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Open to usable, 500 nodes / 1,500 edges / 2,001 events       | median 246.5 ms, p95 279 ms (2x throttle: 473 / 478 ms; 4x: 928 / 953 ms)                            |
| Open to usable, 100 nodes / 200 edges                        | median 167.3 ms, p95 182.4 ms                                                                        |
| Long tasks over 200 ms, 500 nodes, unthrottled               | 0 in all runs; max 57 ms while opening, 143 ms navigating (switch to List)                           |
| Long tasks over 200 ms, 500 nodes, 2x throttle               | 2: switch to List 267 ms, Exit focus 265 ms; none before usable                                      |
| Long tasks over 200 ms, 500 nodes, 4x throttle               | 219-256 ms once per open; List 528 ms, Exit focus 523 ms, Graph 254 ms                               |
| Long tasks, 100 nodes                                        | none of any length, including navigation                                                             |
| Pan / drag / pan at 200% zoom, 100 visible nodes             | 59.8-60 / 60 / 60 FPS; p95 frame 16.8 ms, worst 33.3 ms (same at 4x and 6x)                          |
| Pan / drag / zoomed pan, 500-node study (95-100 nodes drawn) | 60 / 60 / 60 FPS (4x throttle: 59.4 / 59.8 / 60)                                                     |
| GET /graph from the page, 50 sequential reads                | p95 19.7 ms (500 nodes, 511 KB), 4.4 ms (100 nodes, 84 KB)                                           |
| GET /events first page, 50 sequential reads                  | p95 2.8 ms (500-node study), 2.6 ms (100-node study); 20 cursor pages 2.4 ms                         |
| App requests during cold opens (reads in parallel, n=5)      | /graph p95 39.3 / 17.9 ms, /events p95 34.3 / 15.2 ms (500 / 100 nodes)                              |
| Initial DOM                                                  | about 6,818 elements (500 nodes, 100 nodes and 312 edges drawn at 25% zoom); about 3,634 (100 nodes) |

Notes:

- These runs predate the fix that opens a study of exactly 500 nodes focused (PRD section 12, "At
  500 nodes"): the 500-node study opened with every node, which is the heavier case.
- The slowest steps are switching to List View (all 500 rows with about 3,000 relationship rows
  render in one commit) and leaving focus (all 500 canvas nodes mount at once). They stay under
  200 ms unthrottled on this machine with about 1.4x margin; on a CPU half as fast they pass it.
  Chunked or virtualized rendering of the list and canvas would be needed to keep that margin;
  it is not a cheap change, so it waits for a measurement on real mid-range hardware.

## Outstanding (needs a real browser or device)

- NFR-PERF-003 for the 20-node study, and all sizes on a mid-range desktop rather than this
  laptop (the headless runs above cover 100 and 500 nodes here).
- NFR-PERF-004 on a mid-range desktop in a headful, GPU-backed browser: frame rate at 100 visible
  nodes, and the longest main-thread task when switching the 500-node study to List View or
  leaving focus (above 200 ms here at 2x CPU throttle).
- The 500-node study with 10,000 events in the browser (the headless fixture had 2,001), and the
  focused view above 500 nodes and at the 2,000-node cap in the browser.
- The same reads under 100 concurrent active users against a staging deployment (remote
  PostgreSQL, TLS), for NFR-PERF-001/002 as written.
