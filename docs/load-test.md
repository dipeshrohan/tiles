# Load test (T5.15)

The target was 10,000 signals sending one reading a second each, with 50 people using Tiles at the same time. Tiles meets it. Running the test found a stall under overload; it is fixed.

## The tool

`tiles-loadtest`, in the API package (`api/src/tiles_api/loadtest.py`), works in two steps:

1. `tiles-loadtest prepare --agents 10 --out tokens.txt` (needs `TILES_DATABASE_URL`, like `tiles-seed`) registers the agents the test sends as, `load-0` … `load-9`. It revokes the agents of an earlier run and writes the new tokens to a file, mode 0600.
2. `tiles-loadtest run --api <url> --tokens tokens.txt --signals 10000 --users 50` drives the API through its public endpoints. It needs no database access.

The run has two kinds of virtual clients:

- **Edge agents.** Each agent owns a share of the signals (`load.a<agent>.s<n>`). Every `--interval` seconds (default 5), it sends the readings of that interval in one `POST /agent/samples` batch, split at the API's 10,000-reading limit. With 10 agents, each batch holds 5,000 readings.
- **People.** Each one repeats a step chosen at random, then pauses for half a second to a second and a half. The steps are:
  - search the signals;
  - page through the signals;
  - one signal's last ten minutes (raw readings);
  - one signal's last day (bucketed);
  - the warnings;
  - the ontology graph.

A warm-up comes first (`--warmup`), then the measurement (`--duration`). The report is Markdown (`--report`). The run fails, with exit code 1, when any of these happens:

- fewer than 99% of the target readings a second are stored;
- the agents' batches fall behind their schedule by more than one interval;
- a step's 95th percentile is over `--p95-ms` (default 1,000 ms);
- any request fails.

Throughput counts the readings stored against the time those readings cover, so the edges of the measuring window don't skew it.

`api/tests/test_loadtest.py` tests the arithmetic and the report. It also runs a short load test against a real server and database.

## Results

The environment was one 4-core machine running everything:

- the API (`TILES_WORKERS=2`, 10 connections per worker);
- PostgreSQL 17 with TimescaleDB 2.30;
- the load generator itself.

Measured over 120 seconds after a 20-second warm-up:

**Passed** over 120 s measured.

- Readings stored: 10,000/s (target 10,000/s); 1,200,000 sent, 1,200,000 stored.
- Batches late: median 0 ms, 95th percentile 1 ms, worst 2 ms.

| Request | Count | Per second | Median ms | 95th ms | 99th ms | Worst ms | Failed |
|---|---:|---:|---:|---:|---:|---:|---|
| ingest | 240 | 2.0 | 723 | 976 | 1,098 | 1,183 | - |
| ontology.graph | 926 | 7.7 | 26 | 126 | 192 | 239 | - |
| series.10min | 876 | 7.3 | 29 | 135 | 195 | 350 | - |
| series.day | 953 | 7.9 | 30 | 127 | 192 | 234 | - |
| signals.page | 933 | 7.8 | 150 | 306 | 406 | 462 | - |
| signals.search | 966 | 8.0 | 113 | 256 | 335 | 453 | - |
| warnings | 925 | 7.7 | 27 | 120 | 181 | 237 | - |

All 1,200,000 readings were stored on schedule: no batch was late by more than a few milliseconds. Every browsing step's 95th percentile was at most about 300 ms. Storing a 5,000-reading batch takes about 0.7 s, mostly in the database. Writing the rows into the hypertable takes about half of that, and checking that each reading's signal exists takes the other half. The check stays: it keeps readings tied to their signal, and it is what removes a site's readings when the site is deleted.

## What the test found

**A stall when requests outnumber database connections (fixed).** At twice the target (20,000 signals and 100 people, one API process), every request stopped and failed after 30 seconds with `PoolTimeout`.

- **The cause:**
  - the API's handlers run on worker threads (40), and each takes a database connection (10);
  - the threads blocked waiting for a connection left none for the requests that held one, so those could never finish and give their connection back.
- **The fix** (`store.db_slot`):
  - a request now waits for a free connection on the event loop, before it takes a thread;
  - after `TILES_DB_WAIT_SECONDS` (10) it gets a `503` with `Retry-After: 2`, which edge agents retry;
  - `api/tests/test_store.py` runs 240 requests through 2 connections, which stalled before the fix and are now all answered.
  - Work that takes connections outside a request (the copilot's answer as it streams, sweeps running after their request) uses a small pool of its own (`TILES_DB_SIDE_POOL_MAX`, 4). Otherwise it could take a connection that a queued request was promised.

With the fix, the same overload is answered in full. Every reading is stored, and the browsing steps slow to about 2 seconds instead of failing.

**One process uses one core.** Decoding and validating batches, and building answers, all run in one Python process. The new `TILES_WORKERS` setting runs several processes; the Helm chart's `api.workers` sets it, and its default is 2.

Each process has its own pools, so an upgrade to this chart doubles the API's database connections: replicas × 2 × (10 + 4). Each process also runs up to two sweeps at a time.

## Sizing

| Load | API | Database |
|---|---|---|
| Up to 10,000 readings/s and 50 people (one site's plant) | 2 pods × 2 workers, 0.5 to 1 CPU and up to 1.5 GB each | 4 CPUs, 16 GB, SSD storage (see storage below) |
| More | Add API pods; each opens up to `workers × (TILES_DB_POOL_MAX + TILES_DB_SIDE_POOL_MAX)` connections | Keep `max_connections` above the total of all pods, plus the jobs. Readings are compressed after 7 days (migration 0004) |

**Storage** at the full rate, measured on the test's readings:

- **Uncompressed:** 140 bytes a reading, about 120 GB a day. Readings stay uncompressed for their first 7 days (migration 0004), so plan about 850 GB for that window.
- **Compressed:** 9.4 bytes a reading (15 times smaller), about 8 GB a day, or about 3 TB a year.
- **High-volume sites:** compress sooner to shrink the uncompressed window. For example: `SELECT remove_compression_policy('samples'); SELECT add_compression_policy('samples', INTERVAL '1 day');`. The cost is that readings arriving more than a day late land in compressed chunks, which TimescaleDB writes more slowly.

Above the target, run the test on the deployment itself, with the load generator on a machine of its own. On one shared 4-core machine, the generator competes with the API and the database, so runs at twice the target there measure the machine rather than Tiles.

## Running it

```sh
# Against a local API. The dev identity browses; elsewhere, put a user's token in TILES_LOADTEST_TOKEN
# or a file named by --token-file (never on the command line, where `ps` shows it).
cd api
TILES_DATABASE_URL=postgresql://tiles:…@localhost:5432/tiles uv run tiles-loadtest prepare --agents 10 --out /tmp/tokens.txt
uv run tiles-loadtest run --api http://localhost:8000 --tokens /tmp/tokens.txt --signals 10000 --users 50 \
  --duration 120 --report load-test.md
```

The test writes real readings into the load signals of the site, 864 million a day at the full rate. Run it against a test site, or a test database, never a plant's.
