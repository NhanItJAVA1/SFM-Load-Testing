'use strict';

const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateStartConfig, validateProductionStart, HARD_MAX_REQUESTS_PER_SECOND, DEFAULT_TARGET_HOSTS } = require('./config');
const { emptyMetrics, parseK6Summary } = require('./metrics');

const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.RUNNER_SERVICE_TOKEN;
const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'load-test.js');
const MAX_TEST_MS = 60 * 60 * 1000 + 30 * 1000;
const STOP_GRACE_MS = 5000;
const OUTPUT_LIMIT = 4096;
const MAX_REQUESTS_PER_SECOND = Number(process.env.RUNNER_MAX_REQUESTS_PER_SECOND || HARD_MAX_REQUESTS_PER_SECOND);
const TARGET_HOSTS = new Set((process.env.RUNNER_ALLOWED_TARGET_HOSTS || DEFAULT_TARGET_HOSTS.join(','))
  .split(',').map((host) => host.trim().toLowerCase().replace(/^\[|\]$/g, '')).filter(Boolean));
const PRODUCTION_TARGET_HOSTS = new Set((process.env.RUNNER_PRODUCTION_TARGET_HOSTS || 'sfmbe.duckdns.org')
  .split(',').map((host) => host.trim().toLowerCase().replace(/^\[|\]$/g, '')).filter(Boolean));
const PRODUCTION_BACKEND_URL = process.env.PRODUCTION_BACKEND_URL || 'https://sfmbe.duckdns.org';
const PRODUCTION_LIMITS = {
  vus: Number(process.env.RUNNER_PRODUCTION_MAX_VUS || 25),
  requestsPerSecond: Math.min(Number(process.env.RUNNER_PRODUCTION_MAX_REQUESTS_PER_SECOND || 25), MAX_REQUESTS_PER_SECOND),
  durationSeconds: Number(process.env.RUNNER_PRODUCTION_MAX_DURATION_SECONDS || 120),
};
const DEFAULT_TARGET_BASE_URL = process.env.SFM_BE_URL || 'http://sfm-backend:8080';
let active = null;
let latest = null;

if (!TOKEN || TOKEN.length < 32) {
  console.error('RUNNER_SERVICE_TOKEN must be set to at least 32 characters.');
  process.exit(1);
}
if (!Number.isInteger(MAX_REQUESTS_PER_SECOND) || MAX_REQUESTS_PER_SECOND < 1 || MAX_REQUESTS_PER_SECOND > HARD_MAX_REQUESTS_PER_SECOND) {
  console.error(`RUNNER_MAX_REQUESTS_PER_SECOND must be an integer from 1 to ${HARD_MAX_REQUESTS_PER_SECOND}.`);
  process.exit(1);
}
try {
  const productionUrl = new URL(PRODUCTION_BACKEND_URL);
  if (productionUrl.protocol !== 'https:' || productionUrl.username || productionUrl.password
    || productionUrl.pathname !== '/' || productionUrl.search || productionUrl.hash) throw new Error();
  PRODUCTION_TARGET_HOSTS.add(productionUrl.hostname.toLowerCase());
  if (!TARGET_HOSTS.has(productionUrl.hostname.toLowerCase())) throw new Error();
} catch {
  console.error('PRODUCTION_BACKEND_URL must be an HTTPS origin whose hostname is in RUNNER_ALLOWED_TARGET_HOSTS.');
  process.exit(1);
}
if (Object.values(PRODUCTION_LIMITS).some((limit) => !Number.isInteger(limit) || limit < 1)
  || PRODUCTION_LIMITS.vus > 1000 || PRODUCTION_LIMITS.requestsPerSecond > MAX_REQUESTS_PER_SECOND
  || PRODUCTION_LIMITS.durationSeconds > 3600) {
  console.error('Production limits must be positive integers within the Runner hard limits.');
  process.exit(1);
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function reject(res, req, status, code, reason, message, details, diagnostic = {}) {
  console.warn(JSON.stringify({
    event: 'request_rejected',
    method: req.method,
    route: ['/start', '/stop', '/status', '/health'].includes(new URL(req.url, 'http://runner.local').pathname) ? new URL(req.url, 'http://runner.local').pathname : 'unmatched_route',
    httpStatus: status,
    errorCode: code,
    reason,
    ...diagnostic,
  }));
  return json(res, status, { error: { code, message, ...(details ? { details } : {}) } });
}

function authorized(req) {
  const provided = req.headers.authorization || '';
  const expected = `Bearer ${TOKEN}`;
  return provided.length === expected.length && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 4096) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(Object.assign(new Error('Body must be valid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function publicStatus() {
  const run = active || latest;
  if (!run) return { status: 'idle', running: false, testId: null, scenario: null, target: null, targetApiUrl: null, mode: null, requestsPerSecond: null, vus: null, effectiveVUs: null, preAllocatedVUs: null, maxVUs: null, durationSeconds: null, droppedIterations: null, metrics: emptyMetrics(), startedAt: null, finishedAt: null, exitCode: null };
  return {
    status: active ? 'running' : run.status,
    running: Boolean(active),
    testId: run.id,
    scenario: run.scenario,
    target: run.target,
    targetApiUrl: run.baseUrl,
    mode: run.mode,
    requestsPerSecond: run.requestsPerSecond,
    vus: run.vus,
    effectiveVUs: run.effectiveVUs,
    preAllocatedVUs: run.preAllocatedVUs,
    maxVUs: run.maxVUs,
    durationSeconds: run.durationSeconds,
    droppedIterations: run.droppedIterations,
    metrics: run.metrics,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    exitCode: run.exitCode,
    ...(active ? { stopping: run.stopping } : {}),
    diagnostics: { stdout: run.stdout, stderr: run.stderr },
  };
}

function redactOutput(value, run) {
  let safe = value;
  for (const secret of [
    TOKEN,
    process.env.K6_PROMETHEUS_RW_PASSWORD,
    process.env.K6_PROMETHEUS_RW_USERNAME,
    process.env.K6_PROMETHEUS_RW_SERVER_URL,
    process.env.SFM_BE_URL,
    run.baseUrl,
  ]) {
    if (secret && secret.length > 0) safe = safe.split(secret).join('[REDACTED]');
  }
  return safe
    .replace(/(authorization\s*[:=]\s*bearer\s+)\S+/gi, '$1[REDACTED]')
    .replace(/((?:password|token|secret)\s*[:=]\s*)\S+/gi, '$1[REDACTED]');
}

function appendOutput(run, stream, chunk) {
  const combined = redactOutput(`${run[stream]}${chunk.toString()}`, run);
  run[stream] = combined.length > OUTPUT_LIMIT ? combined.slice(-OUTPUT_LIMIT) : combined;
  const output = `${run.stdout}\n${run.stderr}`;
  run.metrics = parseK6Summary(output);
  const match = /dropped_iterations(?:_total)?[^\n]*?:\s*([\d,]+)/i.exec(output);
  if (match) run.droppedIterations = Number(match[1].replaceAll(',', ''));
}

function finish(run) {
  if (run.finished) return;
  run.finished = true;
  clearTimeout(run.timeout);
  clearTimeout(run.killTimeout);
  if (active === run) active = null;
  run.finishedAt = new Date().toISOString();
  run.exitCode = run.exitCode ?? run.child.exitCode;
  const outputFailed = /level=error|failed to send the time series/i.test(run.stderr);
  run.status = run.spawnError || run.terminationReason === 'timeout'
    ? 'failed'
    : run.stopRequested ? 'stopped'
      : outputFailed || run.exitCode !== 0 || run.exitSignal ? 'failed' : 'completed';
  latest = run;
}

function stopActive(reason = 'requested') {
  const run = active;
  if (!run || run.stopping || run.finished) return false;
  if (run.child.exitCode !== null || run.child.signalCode !== null) return false;
  run.stopping = true;
  if (reason === 'requested') run.stopRequested = true;
  else run.terminationReason = reason;
  try {
    if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGTERM');
  } catch {
    run.terminationReason = run.terminationReason || 'termination_error';
  }
  run.killTimeout = setTimeout(() => {
    if (active === run && run.child.exitCode === null && run.child.signalCode === null) {
      try { run.child.kill('SIGKILL'); } catch { run.terminationReason = run.terminationReason || 'termination_error'; }
    }
  }, STOP_GRACE_MS);
  active.killTimeout.unref();
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://runner.local');
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { healthy: true });
  if (!['/start', '/stop', '/status'].includes(url.pathname) || !['POST', 'GET'].includes(req.method)) {
    return reject(res, req, 404, 'NOT_FOUND', 'route_or_method_not_supported', 'Route or method not found');
  }
  if (!authorized(req)) return reject(res, req, 401, 'UNAUTHORIZED', 'service_token_missing_or_invalid', 'A valid bearer token is required');

  if (req.method === 'GET' && url.pathname === '/status') return json(res, 200, publicStatus());
  if (req.method === 'POST' && url.pathname === '/stop') {
    const body = await readBody(req).catch((e) => e);
    if (body instanceof Error) return reject(res, req, body.status || 400, 'INVALID_REQUEST_BODY', 'body_must_be_empty_json', body.message);
    if (Object.keys(body).length) return reject(res, req, 400, 'UNKNOWN_PARAMETER', 'stop_does_not_accept_parameters', 'Stop accepts no parameters');
    if (!active) return json(res, 200, { stopped: false, message: 'No test is running', status: latest?.status || 'idle' });
    const run = active;
    const accepted = stopActive();
    return json(res, 202, { stopped: accepted || run.stopRequested, id: run.id, status: 'running', stopping: run.stopping });
  }
  if (req.method === 'POST' && url.pathname === '/start') {
    const body = await readBody(req).catch((e) => e);
    if (body instanceof Error) return reject(res, req, body.status || 400, 'INVALID_JSON', 'body_must_be_valid_json', body.message);
    if (body === null || Array.isArray(body) || typeof body !== 'object') return reject(res, req, 400, 'INVALID_REQUEST_BODY', 'body_must_be_json_object', 'Body must be a JSON object');
    const { confirmProduction, ...configuration } = body;
    const validated = validateStartConfig(configuration, MAX_REQUESTS_PER_SECOND, TARGET_HOSTS, DEFAULT_TARGET_BASE_URL);
    if (validated.error) {
      const { status, code, reason, message, details } = validated.error;
      return reject(res, req, status, code, reason, message, details, {
        payloadShape: {
          scenarioPresent: Object.hasOwn(body, 'scenario'),
          targetPresent: Object.hasOwn(body, 'target'),
          modePresent: Object.hasOwn(body, 'mode'),
          vusPresent: Object.hasOwn(body, 'vus'),
          requestsPerSecondPresent: Object.hasOwn(body, 'requestsPerSecond'),
          durationSecondsPresent: Object.hasOwn(body, 'durationSeconds'),
          baseUrlPresent: Object.hasOwn(body, 'baseUrl'),
          confirmProductionPresent: Object.hasOwn(body, 'confirmProduction'),
        },
      });
    }
    const productionValidation = validateProductionStart(
      validated.value,
      confirmProduction,
      Object.hasOwn(body, 'confirmProduction'),
      PRODUCTION_TARGET_HOSTS,
      PRODUCTION_LIMITS,
    );
    if (productionValidation) {
      const { status, code, reason, message, details } = productionValidation.error;
      return reject(res, req, status, code, reason, message, details, {
        payloadShape: { confirmProductionPresent: Object.hasOwn(body, 'confirmProduction') },
      });
    }
    if (active) return reject(res, req, 409, 'TEST_ALREADY_RUNNING', 'single_active_test_limit_reached', 'A test is already running', { testId: active.id });
    const config = validated.value;

    const run = {
      id: crypto.randomUUID(), ...config,
      startedAt: new Date().toISOString(), finishedAt: null, exitCode: null,
      status: 'running', stopping: false, stopRequested: false,
      stdout: '', stderr: '', finished: false, droppedIterations: null, metrics: emptyMetrics(),
    };
    const args = [
      'run', '--quiet',
      '--tag', `testid=${run.id}`,
      '--tag', `scenario=${run.scenario}`,
      '--tag', `target=${run.target}`,
      '--tag', `mode=${run.mode}`,
      '--env', `SCENARIO=${run.scenario}`,
      '--env', `TARGET=${run.target}`,
      '--env', `MODE=${run.mode}`,
      '--env', `VUS=${run.effectiveVUs}`,
      '--env', `DURATION_SECONDS=${run.durationSeconds}`,
      '--env', `MAX_REQUESTS_PER_SECOND=${MAX_REQUESTS_PER_SECOND}`,
    ];
    if (run.mode === 'request_rate') {
      args.push('--env', `REQUESTS_PER_SECOND=${run.requestsPerSecond}`);
      args.push('--env', `PRE_ALLOCATED_VUS=${run.preAllocatedVUs}`);
      args.push('--env', `MAX_VUS=${run.maxVUs}`);
    }
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME || '/tmp',
      BASE_URL: run.baseUrl,
      K6_TARGET_HOST_ALLOWLIST: [...TARGET_HOSTS].join(','),
    };
    if (process.env.K6_PROMETHEUS_RW_SERVER_URL) {
      args.push('--out', 'experimental-prometheus-rw');
      env.K6_PROMETHEUS_RW_SERVER_URL = process.env.K6_PROMETHEUS_RW_SERVER_URL;
      env.K6_PROMETHEUS_RW_TREND_STATS = process.env.K6_PROMETHEUS_RW_TREND_STATS || 'p(95)';
      for (const key of [
        'K6_PROMETHEUS_RW_USERNAME',
        'K6_PROMETHEUS_RW_PASSWORD',
        'K6_PROMETHEUS_RW_INSECURE_SKIP_TLS_VERIFY',
        'K6_PROMETHEUS_RW_PUSH_INTERVAL',
      ]) {
        if (process.env[key]) env[key] = process.env[key];
      }
    }
    args.push(SCRIPT);
    const child = spawn('k6', args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env });
    run.child = child;
    active = run;
    run.timeout = setTimeout(() => stopActive('timeout'), MAX_TEST_MS);
    run.timeout.unref();
    child.stdout.on('data', (chunk) => appendOutput(run, 'stdout', chunk));
    child.stderr.on('data', (chunk) => appendOutput(run, 'stderr', chunk));
    child.once('error', () => { run.spawnError = true; });
    child.once('close', (code, signal) => {
      run.exitCode = code;
      run.exitSignal = signal;
      finish(run);
    });
    return json(res, 202, { started: true, id: run.id, scenario: run.scenario, target: run.target, targetApiUrl: run.baseUrl, mode: run.mode, requestsPerSecond: run.requestsPerSecond, vus: run.vus, effectiveVUs: run.effectiveVUs, preAllocatedVUs: run.preAllocatedVUs, maxVUs: run.maxVUs, durationSeconds: run.durationSeconds });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`Runner listening on port ${PORT}`));
function shutdown() {
  const run = active;
  if (run) stopActive();
  server.close(() => {
    if (!run) process.exit(0);
    const forceExit = setTimeout(() => process.exit(1), 6000);
    forceExit.unref();
    run.child.once('exit', () => {
      clearTimeout(forceExit);
      process.exit(0);
    });
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
