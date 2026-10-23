# SFM k6 Load Testing Runner (Phase 1)

An internal-only HTTP service that starts one of four fixed k6 profiles against a fixed SFM-BE health endpoint. Test state exists only in runner memory; this phase adds no persistence, frontend, or SFM-BE/Admin FE changes.

## API

All control endpoints require `Authorization: Bearer <RUNNER_SERVICE_TOKEN>`. `/health` is an unauthenticated liveness check intended for the private container network.

| Method | Path | Request | Purpose |
|---|---|---|---|
| POST | `/start` | `{"scenario":"smoke","target":"ping","vus":2,"durationSeconds":45}` | Start a predefined run with optional bounded overrides |
| POST | `/stop` | empty JSON body | Send SIGTERM to the active k6 process |
| GET | `/status` | — | Report active or most recent in-memory run |
| GET | `/health` | — | Liveness |

For fixed concurrent users, the legacy body above still works with `mode` omitted. To request an arrival rate, send `{"scenario":"smoke","target":"ping","mode":"request_rate","requestsPerSecond":20,"durationSeconds":60}`. `requestsPerSecond` is rejected unless mode is `request_rate`; `vus` is rejected in that mode because Runner computes bounded allocation values.

Scenarios are fixed: smoke (1 VU, 30s), load (10 VUs, 300s), stress (25 VUs, 600s), and spike (50 VUs, 120s). If `mode` is omitted, Runner preserves the existing `concurrent_users` behavior. `concurrent_users` accepts `vus` (1–1000); both `vus` and `durationSeconds` default independently from the selected scenario. `durationSeconds` is 10–3600 for either mode. `request_rate` requires integer `requestsPerSecond` and accepts no `vus` field. Its configurable safety ceiling defaults to 1000 RPS via `RUNNER_MAX_REQUESTS_PER_SECOND` (valid 1–1000); this is a requested arrival rate, not a guarantee of achieved throughput.\n\nFor request-rate allocation, Runner uses `preAllocatedVUs = min(100, max(1, ceil(requestsPerSecond / 10)))` and `maxVUs = min(250, max(preAllocatedVUs, ceil(requestsPerSecond / 4)))`. This bounds k6 rate-mode VUs to 100 preallocated and 250 maximum. Each iteration makes exactly one request to the chosen allowlisted target. If k6 drops iterations, actual RPS can be lower than requested. A hard 60 minute, 30 second Runner timeout allows the maximum requested duration to finish and stops any remaining run. The default base URL is `http://sfm-backend:8080`; `SFM_BE_URL` can override it with an allowlisted local host. Unknown request fields, scenarios, modes, targets, and mode-specific parameters are rejected.

`GET /status` returns `status` (`idle`, `running`, `completed`, `stopped`, or `failed`), test ID, scenario, target, mode, requested RPS, effective VUs (plus preallocated/max VUs), duration, droppedIterations when available, start/finish times, exit code, and the latest bounded stdout/stderr diagnostics. Only the most recent finished run is retained in memory. Each output stream is capped at 4 KiB and known credentials are redacted. A nonzero k6 exit, spawn error, remote-write output error, or runner timeout is reported as `failed`; a successful exit is `completed`; a user stop is `stopped`.

The runner has no API for URLs, scripts, commands, or file paths. VUs and duration can only be set within the stated integer bounds. Its k6 process is spawned with a fixed executable, fixed script, selected enum values, and `shell: false`. Rejected requests produce structured error codes; safe JSON logs include the route, HTTP status, error code, and fixed validation reason without logging request values or tokens. Process output is available only through the authenticated status endpoint, is bounded to 4 KiB per stream, and redacts the service token, backend URL, and Prometheus credentials/URL. The service token must be at least 32 characters. Keep it in deployment secrets and never commit `.env`.

## Build and run with Docker

Create a Docker network shared with the SFM-BE service. Use the network name that SFM-BE is attached to (the default below assumes a Compose project named `sfm`):

```powershell
docker network create sfm_default
```

If Docker Compose already created that network, use it instead. Create a local `.env` file (do not commit it):

```powershell
@"
RUNNER_SERVICE_TOKEN=$( [guid]::NewGuid().ToString() + [guid]::NewGuid().ToString() )
SFM_DOCKER_NETWORK=sfm_default
SFM_BE_URL=http://sfm-be:8080
"@ | Set-Content .env
```

The token generated above is 64 characters. Ensure the SFM-BE container is reachable by the Docker DNS name `sfm-be` on this network. Then:

```powershell
docker compose build
docker compose up -d
```

After changing Runner code, rebuild and recreate it with `docker compose up -d --build k6-runner`. Optionally set `RUNNER_MAX_REQUESTS_PER_SECOND=500` in `.env` to lower the accepted RPS ceiling; the hard maximum is 1000.

The runner attaches to an `internal: true` control network and the shared upstream network. Compose does not publish a host port. For local operator access only, use `docker compose exec` with an HTTP client in an operator container, or add a temporary loopback-only port mapping in a local override file. Do not bind the service to a public interface or route it through an Internet-facing proxy. Only attach trusted internal services to the shared network.

SFM-BE reachability uses Docker DNS and the shared network: `http://sfm-backend:8080`. Configure `SFM_BE_URL` only as one of the runner's allowlisted local host forms (`sfm-backend`, `sfm-be`, `localhost`, or `host.docker.internal`), with an optional port. No production hostname is allowed by the k6 script. For an existing staging Compose stack, set `SFM_DOCKER_NETWORK` to its network and keep the base URL on that private network.

## PowerShell API example

For a local smoke run, publish only on loopback by creating a temporary override file:

```powershell
@'
services:
  k6-runner:
    ports:
      - "127.0.0.1:3000:3000"
'@ | Set-Content docker-compose.override.yml
docker compose up -d
$token = (Get-Content .env | Where-Object { $_ -match '^RUNNER_SERVICE_TOKEN=' }) -replace '^RUNNER_SERVICE_TOKEN=', ''
$headers = @{ Authorization = "Bearer $token" }
$body = @{ scenario = 'smoke'; target = 'ping' } | ConvertTo-Json
$started = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/start -Headers $headers -ContentType 'application/json' -Body $body
Invoke-RestMethod -Method Get -Uri http://127.0.0.1:3000/status -Headers $headers
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/stop -Headers $headers -ContentType 'application/json' -Body '{}'
Start-Sleep -Seconds 2
Invoke-RestMethod -Method Get -Uri http://127.0.0.1:3000/status -Headers $headers
```

The final status should show `status: stopped` and `running: false`; the k6 child exits after SIGTERM. Remove the local override when finished. To run with explicit values, send:

```powershell
$body = @{ scenario = 'spike'; target = 'ping'; vus = 50; durationSeconds = 120 } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/start -Headers $headers -ContentType 'application/json' -Body $body
```

For backward compatibility, omit both optional values; a smoke run reports 1 VU and 30 seconds. To verify a full smoke test, run:

```powershell
$body = @{ scenario = 'smoke'; target = 'ping' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/start -Headers $headers -ContentType 'application/json' -Body $body
do {
  Start-Sleep -Seconds 2
  $status = Invoke-RestMethod -Method Get -Uri http://127.0.0.1:3000/status -Headers $headers
} while ($status.status -eq 'running')
$status | Format-List status, testId, scenario, target, vus, durationSeconds, startedAt, finishedAt, exitCode
```

This should finish with `status: completed` and `exitCode: 0`. The API returns HTTP 409 if another test is active. Invalid input is rejected with HTTP 400; for example:

```powershell
$bad = @{ scenario = 'production'; target = 'ping'; url = 'https://example.com' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/start -Headers $headers -ContentType 'application/json' -Body $bad
```

This returns an error because both `production` and the `url` parameter are disallowed.

## Prometheus Remote Write

The image pins Grafana k6 `1.8.2`. Compose defaults `K6_PROMETHEUS_RW_SERVER_URL` to `http://sfm-prometheus:9090/api/v1/write` and `K6_PROMETHEUS_RW_TREND_STATS` to `p(95)`. Set either variable in `.env` to override it. With the URL set, every run uses `experimental-prometheus-rw`; wide tags `testid`, `scenario`, and `target` distinguish each run. Percentile trend stats are exported as gauges so P95 can be queried without requiring native histogram ingestion. The runner passes only the required Prometheus variables to k6, and diagnostics redact the configured URL and credentials.

### Existing Prometheus receiver check

The existing `sfm-prometheus` container is Prometheus `v3.5.0` on `sfm-network`. Its `/api/v1/status/flags` currently reports `web.enable-remote-write-receiver: true`. This Runner sends metrics to that existing instance; this repository does not configure or modify Prometheus.

A smoke run with test ID `1ddec318-0a96-41ed-9f50-905ac1651a2d` produced these observed series:

| Prometheus metric | Observed sample | Meaning |
|---|---:|---|
| `k6_http_reqs_total` | 10 | Request counter |
| `k6_http_req_duration_p95` | 0.00718 | P95 request duration, seconds |
| `k6_http_req_failed_rate` | 0 | Failed request rate |
| `k6_vus` | 1 | Active VUs |

A custom `spike` run with 2 VUs for 10 seconds completed with exit code 0 and returned `k6_http_reqs_total=20`, `k6_http_req_duration_p95=0.00341` seconds, `k6_http_req_failed_rate=0`, and `k6_vus=2`. Query these series by test ID:

```promql
sum(rate(k6_http_reqs_total{testid="<test-id>"}[1m]))
last_over_time(k6_http_req_duration_p95{testid="<test-id>"}[5m]) * 1000
100 * avg_over_time(k6_http_req_failed_rate{testid="<test-id>"}[5m])
k6_vus{testid="<test-id>"}
```

The P95 gauge is exported per k6 remote-write aggregation interval; the query above shows its most recent sample in milliseconds. Leave Prometheus' existing TSDB retention and storage configuration unchanged; the Runner adds no persistence layer.

The request-rate mode was also run against `ping` at a requested 5 RPS for 10 seconds. It completed successfully (exit code 0), and Prometheus observed `k6_http_reqs_total=51`, `k6_http_req_duration_p95=0.0032819409999999996` seconds, `k6_http_req_failed_rate=0`, and `k6_vus=1`; those series included `mode="request_rate"` and the run's `testid`. Query the selected run using, for example:

```promql
sum(rate(k6_http_reqs_total{testid="<test-id>",mode="request_rate"}[1m]))
k6_http_req_duration_p95{testid="<test-id>",mode="request_rate"} * 1000
k6_http_req_failed_rate{testid="<test-id>",mode="request_rate"}
k6_vus{testid="<test-id>",mode="request_rate"}
```

`dropped_iterations` is a built-in k6 metric and will be reported in Runner status if it appears in captured k6 output. With this short successful run, Prometheus had no dropped-iteration series because no drops were observed.

## Limits and operations

The runner permits one active test at a time. It uses bounded VU/duration profiles, a maximum execution timeout just over 60 minutes, SIGTERM on stop, and SIGKILL escalation after five seconds. It runs as a non-root user with dropped capabilities, a read-only root filesystem, no Docker socket, and 1 CPU / 512 MiB memory limits. The k6 1.8.2 binary is copied from the official Grafana k6 container image at build time.
