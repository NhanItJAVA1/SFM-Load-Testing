# SFM Performance Lab

Developer-only load-testing workspace for the SFM project. It includes a standalone React + TypeScript + Vite dashboard, an internal authenticated Node Runner, and the existing fixed k6 script/scenarios. Dashboard history is stored in the local browser; Runner state is in memory. No result database is used.

## Start the local dashboard

Prerequisites: Docker Desktop with the `sfm-network` Docker network already present, and a local or staging target API reachable by the Runner container. SFM-BE Admin APIs and Admin FE are not used to start tests. The default URL points at `http://sfm-backend:8080`; when no backend is running, choose a local target API URL that is reachable from Docker, such as `http://host.docker.internal:8080`, and configure its exact origin in `.env`.

Create `.env` from the sample and replace the service token with a private random value of at least 32 characters. Example PowerShell setup:

```powershell
if (-not (Test-Path .env)) {
  Copy-Item .env.example .env
  $token = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
  (Get-Content .env -Raw).Replace('replace-with-a-random-token-at-least-32-characters-long', $token) | Set-Content .env -NoNewline
}
```

If the shared Docker network does not exist, create the empty network once (this does not start or modify SFM-BE):

```powershell
docker network create sfm-network
```

Build and start only the local Runner and dashboard:

```powershell
docker compose up -d --build k6-runner performance-lab
docker compose ps
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173). The dashboard is published only on loopback. The Runner has no published host port and the dashboard can call only its fixed Start, Stop, and Status APIs using a server-side token. It has no Docker socket, command runner, or Prometheus dependency. SFM-BE does not need to be started unless it is the selected test target.

Target API URLs are full origins only: no path, query, fragment, or embedded credentials. They must appear in `DASHBOARD_ALLOWED_TARGET_URLS` and their exact hostnames must appear in `RUNNER_ALLOWED_TARGET_HOSTS`. The Runner script still maps `ping`, `database`, and `redis` to fixed paths. Configure only local or staging hosts; never add a production target. For example, if a local API is bound to the developer host, set both variables to include `host.docker.internal` and add `http://host.docker.internal:8080` to `DASHBOARD_ALLOWED_TARGET_URLS`.

Choose smoke, load, stress, or spike; select concurrent users or request rate; and set VUs/RPS and duration. The results panel displays throughput, average latency, P95 latency, HTTP error rate, completed requests, and dropped iterations from the k6 summary. Recent finished runs are kept in that browser's local storage. JSON and HTML exports contain the Runner status, parsed k6 metrics, and bounded k6 summary diagnostics; they do not claim to contain the full sample stream. Use the standalone k6 JSON output command below when raw samples are needed.

## API

All control endpoints require `Authorization: Bearer <RUNNER_SERVICE_TOKEN>`. `/health` is an unauthenticated liveness check intended for the private container network.

| Method | Path | Request | Purpose |
|---|---|---|---|
| POST | `/start` | `{"scenario":"smoke","target":"ping","vus":2,"durationSeconds":45}` | Start a predefined run with optional bounded overrides |
| POST | `/stop` | empty JSON body | Send SIGTERM to the active k6 process |
| GET | `/status` | — | Report active or most recent in-memory run |
| GET | `/health` | — | Liveness |

For fixed concurrent users, the legacy body above still works with `mode` omitted. Explicit-mode bodies may omit `scenario` to match the SFM-BE DTO: `{"mode":"concurrent_users","target":"ping","vus":20,"durationSeconds":60}` or `{"mode":"request_rate","target":"ping","requestsPerSecond":20,"durationSeconds":60}`. The Runner assigns these requests the fixed `custom` scenario label; omitted durations default to 30 seconds. Mode-omitted legacy requests still require an allowlisted scenario, and any supplied scenario must be allowlisted. `requestsPerSecond` is rejected unless mode is `request_rate`; `vus` is rejected in that mode because Runner computes bounded allocation values.

Scenarios are fixed: smoke (1 VU, 30s), load (10 VUs, 300s), stress (25 VUs, 600s), and spike (50 VUs, 120s). If `mode` is omitted, Runner preserves the existing `concurrent_users` behavior. `concurrent_users` accepts `vus` (1–1000); both `vus` and `durationSeconds` default independently from the selected scenario. `durationSeconds` is 10–3600 for either mode. `request_rate` requires integer `requestsPerSecond` and accepts no `vus` field. Its configurable safety ceiling defaults to 1000 RPS via `RUNNER_MAX_REQUESTS_PER_SECOND` (valid 1–1000); this is a requested arrival rate, not a guarantee of achieved throughput.\n\nFor request-rate allocation, Runner uses `preAllocatedVUs = min(100, max(1, ceil(requestsPerSecond / 10)))` and `maxVUs = min(250, max(preAllocatedVUs, ceil(requestsPerSecond / 4)))`. This bounds k6 rate-mode VUs to 100 preallocated and 250 maximum. Each iteration makes exactly one request to the chosen allowlisted target. If k6 drops iterations, actual RPS can be lower than requested. A hard 60 minute, 30 second Runner timeout allows the maximum requested duration to finish and stops any remaining run. The default base URL is `http://sfm-backend:8080`; `SFM_BE_URL` can override it with an allowlisted local host. Unknown request fields, scenarios, modes, targets, and mode-specific parameters are rejected.

`GET /status` returns `status` (`idle`, `running`, `completed`, `stopped`, or `failed`), test ID, scenario, target, target API base URL, mode, requested RPS, effective VUs (plus preallocated/max VUs), duration, actual k6 summary metrics, droppedIterations when available, start/finish times, exit code, and the latest bounded stdout/stderr diagnostics. Only the most recent finished run is retained in Runner memory. Each output stream is capped at 4 KiB and known credentials are redacted. A nonzero k6 exit, spawn error, remote-write output error, or runner timeout is reported as `failed`; a successful exit is `completed`; a user stop is `stopped`.

The Runner has no API for arbitrary URLs, scripts, commands, or file paths. The optional `baseUrl` must be a credential-free HTTP(S) origin whose exact hostname is configured in `RUNNER_ALLOWED_TARGET_HOSTS`; the k6 script still uses only its fixed target paths. VUs and duration can only be set within the stated integer bounds. Its k6 process is spawned with a fixed executable, fixed script, selected enum values, and `shell: false`. Rejected requests produce structured error codes; safe JSON logs include the route, HTTP status, error code, and fixed validation reason without logging request values or tokens. Process output is available only through the authenticated status endpoint, is bounded to 4 KiB per stream, and redacts the service token, target base URL, and Prometheus credentials/URL. The service token must be at least 32 characters. Keep it in deployment secrets and never commit `.env`.

## Build and run with Docker

This optional Docker service provides authenticated internal HTTP control. It is not required for the standalone developer workflow below.

The Runner attaches to the external Docker network `sfm-network` by default so it can reach existing local targets and Prometheus. If your local SFM stack uses another network name, set `SFM_DOCKER_NETWORK` in `.env` to that existing network:

```powershell
docker network create sfm-network
```

Then build/start as described in **Start the local dashboard**. Existing SFM-BE services need only be running when selected as a target.

```powershell
docker compose up -d --build k6-runner performance-lab
```

After changing Runner or dashboard code, rebuild and recreate the local services with `docker compose up -d --build k6-runner performance-lab`. Optionally set `RUNNER_MAX_REQUESTS_PER_SECOND=500` in `.env` to lower the accepted RPS ceiling; the hard maximum is 1000.

The Runner attaches to an `internal: true` control network and the shared upstream network; Compose does not publish its port. The dashboard reaches Runner over that internal control network and uses a separate bridge network for its loopback-only host port. Do not bind the dashboard to a public interface or route it through an Internet-facing proxy. Only attach trusted internal services to the shared network.

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

## Standalone local k6 runs

Install Grafana k6 `1.8.2` on the developer machine and run `scripts/load-test.js` directly. These commands do not call the Runner or Admin APIs. `TARGET_URL` is the complete request URL; it can point to a local test service or an explicitly allowlisted non-production host. By default, only `localhost`, `127.0.0.1`, `::1`, `host.docker.internal`, `sfm-backend`, and `sfm-be` are allowed. For a staging host, add its exact hostname with `K6_TARGET_HOST_ALLOWLIST`; never add a production host. The Runner does not pass `TARGET_URL` or this allowlist to child k6 processes, so its API remains restricted to the fixed target enum.

PowerShell example for fixed concurrent users, saving the raw k6 samples and console summary:

```powershell
New-Item -ItemType Directory -Force results | Out-Null
k6 run `
  --out json=results/local-smoke.ndjson `
  -e SCENARIO=smoke `
  -e MODE=concurrent_users `
  -e VUS=1 `
  -e DURATION_SECONDS=30 `
  -e TARGET_URL=http://localhost:8080/api/v1/load-test/ping `
  -e K6_TARGET_HOST_ALLOWLIST=localhost `
  scripts/load-test.js *> results/local-smoke.log
```

For requested arrival rate, pass k6's bounded VU allocation explicitly. For example, 20 requested iterations/second uses 2 preallocated and at most 5 VUs under the Runner's documented strategy:

```powershell
k6 run `
  --out json=results/local-rate-20rps.ndjson `
  -e SCENARIO=smoke `
  -e MODE=request_rate `
  -e REQUESTS_PER_SECOND=20 `
  -e PRE_ALLOCATED_VUS=2 `
  -e MAX_VUS=5 `
  -e MAX_REQUESTS_PER_SECOND=1000 `
  -e DURATION_SECONDS=60 `
  -e TARGET_URL=http://localhost:8080/api/v1/load-test/ping `
  -e K6_TARGET_HOST_ALLOWLIST=localhost `
  scripts/load-test.js *> results/local-rate-20rps.log
```

To send metrics to the existing Prometheus instance as well, set `K6_PROMETHEUS_RW_SERVER_URL` to a host-reachable Remote Write Receiver URL and add `--out experimental-prometheus-rw`. Confirm the existing Prometheus receiver is enabled and reachable from the developer machine; no second Prometheus is needed. The JSON output and `.log` summary remain available for analysis even when remote write is not configured.

For thesis collection, keep each run's `.ndjson` and `.log` together with a short manifest recording the test label, UTC start time, target environment/build, scenario, mode, requested VUs or RPS, duration, k6 version, and any relevant machine/container CPU and memory limits. Repeat comparable runs under the same conditions, retain failed and dropped-iteration results, and calculate reported statistics from the saved samples or Prometheus series. Do not include credentials in manifests or check raw results into a public repository.

## Production separation and Admin dependencies

SFM-BE's `/api/v1/admin/load-tests/{start,stop,status,metrics,metrics/history}` endpoints are consumed by `SFM-FE/src/api/adminApi.ts` and the Admin load-testing workspace/hook. They are protected by the `AdminOnly` policy. Backend controller discovery enables these endpoints only in Development, Testing, and Staging; Production does not register the controller or Runner/Prometheus load-test clients. The separate anonymous `/api/v1/load-test/{ping,database,redis}` target endpoints are enabled only in Development/Testing. The Admin FE hides the load-testing tab and routes in production builds while retaining it in development builds. Other Admin APIs remain registered and unaffected.

Prometheus and Grafana continue to collect/visualize metrics from their existing configuration. k6 is a developer-operated load generator; production administrators cannot start tests through the Admin UI or the production Backend API. Do not deploy the Runner or expose its control port in Production.
