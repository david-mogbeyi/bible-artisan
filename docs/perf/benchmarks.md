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
| NFR-PERF-003 usable content ≤ 2 s (20), ≤ 3 s (100), ≤ 5 s (500 nodes)    | Server part of the page's data: p95 9.6 / 15.9 / 40.8 ms                                              | Server part met; browser render not measured           |
| NFR-PERF-004 ≥ 30 FPS at 100 nodes; no main-thread freeze > 200 ms at 500 | Not measurable without a browser                                                                      | Outstanding                                            |
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

## Outstanding (needs a real browser or device)

- NFR-PERF-003 end to end: time from navigation to usable focused/list content for 20, 100 and
  500 nodes in a production build, including rendering (DevTools Performance panel or Lighthouse
  user timing).
- NFR-PERF-004: canvas pan/drag frame rate at 100 visible nodes (target ≥ 30 FPS), and the longest
  main-thread task when opening and navigating the 500-node study (target ≤ 200 ms), on a
  mid-range desktop.
- The same reads under 100 concurrent active users against a staging deployment (remote
  PostgreSQL, TLS), for NFR-PERF-001/002 as written.
