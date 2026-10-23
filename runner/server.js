'use strict';

const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.RUNNER_SERVICE_TOKEN;
const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'load-test.js');
const MAX_TEST_MS = 60 * 60 * 1000 + 30 * 1000;
const STOP_GRACE_MS = 5000;
const OUTPUT_LIMIT = 4096;
const scenarios = Object.freeze({
  smoke: { vus: 1, durationSeconds: 30 },
  load: { vus: 10, durationSeconds: 300 },
  stress: { vus: 25, durationSeconds: 600 },
  spike: { vus: 50, durationSeconds: 120 },
});
const targets = new Set(['ping', 'database', 'redis']);
let active = null;
let latest = null;

if (!TOKEN || TOKEN.length < 32) {
  console.error('RUNNER_SERVICE_TOKEN must be set to at least 32 characters.');
  process.exit(1);
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function reject(res, req, status, code, reason, message, details) {
  console.warn(JSON.stringify({
    event: 'request_rejected',
    method: req.method,
    route: ['/start', '/stop', '/status', '/health'].includes(new URL(req.url, 'http://runner.local').pathname) ? new URL(req.url, 'http://runner.local').pathname : 'unmatched_route',
    httpStatus: status,
    errorCode: code,
    reason,
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
  if (!run) return { status: 'idle', running: false, testId: null, scenario: null, target: null, vus: null, durationSeconds: null, startedAt: null, finishedAt: null, exitCode: null };
  return {
    status: active ? 'running' : run.status,
    running: Boolean(active),
    testId: run.id,
    scenario: run.scenario,
    target: run.target,
    vus: run.vus,
    durationSeconds: run.durationSeconds,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    exitCode: run.exitCode,
    ...(active ? { stopping: run.stopping } : {}),
    diagnostics: { stdout: run.stdout, stderr: run.stderr },
  };
}

function redactOutput(value) {
  let safe = value;
  for (const secret of [
    TOKEN,
    process.env.K6_PROMETHEUS_RW_PASSWORD,
    process.env.K6_PROMETHEUS_RW_USERNAME,
    process.env.K6_PROMETHEUS_RW_SERVER_URL,
    process.env.SFM_BE_URL,
  ]) {
    if (secret && secret.length > 0) safe = safe.split(secret).join('[REDACTED]');
  }
  return safe
    .replace(/(authorization\s*[:=]\s*bearer\s+)\S+/gi, '$1[REDACTED]')
    .replace(/((?:password|token|secret)\s*[:=]\s*)\S+/gi, '$1[REDACTED]');
}

function appendOutput(run, stream, chunk) {
  const combined = redactOutput(`${run[stream]}${chunk.toString()}`);
  run[stream] = combined.length > OUTPUT_LIMIT ? combined.slice(-OUTPUT_LIMIT) : combined;
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
    if (!body || Array.isArray(body) || typeof body !== 'object') return reject(res, req, 400, 'INVALID_REQUEST_BODY', 'body_must_be_json_object', 'Body must be a JSON object');
    const allowedKeys = ['scenario', 'target', 'vus', 'durationSeconds'];
    const unknown = Object.keys(body).filter((key) => !allowedKeys.includes(key));
    if (unknown.length) return reject(res, req, 400, 'UNKNOWN_PARAMETER', 'configuration_key_not_allowlisted', 'Request contains an unsupported configuration parameter', { allowed: allowedKeys });
    if (!Object.hasOwn(body, 'scenario') || !Object.hasOwn(body, 'target')) return reject(res, req, 400, 'MISSING_REQUIRED_FIELD', 'scenario_and_target_are_required', 'scenario and target are required', { required: ['scenario', 'target'] });
    if (!Object.hasOwn(scenarios, body.scenario)) return reject(res, req, 400, 'UNKNOWN_SCENARIO', 'scenario_not_allowlisted', 'Unknown scenario', { allowed: Object.keys(scenarios) });
    if (!targets.has(body.target)) return reject(res, req, 400, 'UNKNOWN_TARGET', 'target_not_allowlisted', 'Unknown target', { allowed: [...targets] });
    if (body.vus !== undefined && (!Number.isInteger(body.vus) || body.vus < 1 || body.vus > 100)) {
      return reject(res, req, 400, 'INVALID_VUS', 'vus_must_be_integer_in_range', 'vus must be an integer from 1 to 100', { field: 'vus', minimum: 1, maximum: 100 });
    }
    if (body.durationSeconds !== undefined && (!Number.isInteger(body.durationSeconds) || body.durationSeconds < 10 || body.durationSeconds > 3600)) {
      return reject(res, req, 400, 'INVALID_DURATION_SECONDS', 'duration_seconds_must_be_integer_in_range', 'durationSeconds must be an integer from 10 to 3600', { field: 'durationSeconds', minimum: 10, maximum: 3600 });
    }
    if (active) return reject(res, req, 409, 'TEST_ALREADY_RUNNING', 'single_active_test_limit_reached', 'A test is already running', { testId: active.id });

    const defaults = scenarios[body.scenario];
    const vus = body.vus === undefined ? defaults.vus : body.vus;
    const durationSeconds = body.durationSeconds === undefined ? defaults.durationSeconds : body.durationSeconds;

    const run = {
      id: crypto.randomUUID(), scenario: body.scenario, target: body.target, vus, durationSeconds,
      startedAt: new Date().toISOString(), finishedAt: null, exitCode: null,
      status: 'running', stopping: false, stopRequested: false,
      stdout: '', stderr: '', finished: false,
    };
    const args = [
      'run', '--quiet',
      '--tag', `testid=${run.id}`,
      '--tag', `scenario=${run.scenario}`,
      '--tag', `target=${run.target}`,
      '--env', `SCENARIO=${run.scenario}`,
      '--env', `TARGET=${run.target}`,
      '--env', `VUS=${run.vus}`,
      '--env', `DURATION_SECONDS=${run.durationSeconds}`,
    ];
    const env = { PATH: process.env.PATH, HOME: process.env.HOME || '/tmp', BASE_URL: process.env.SFM_BE_URL || 'http://sfm-backend:8080' };
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
    return json(res, 202, { started: true, id: run.id, scenario: run.scenario, target: run.target, vus: run.vus, durationSeconds: run.durationSeconds });
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
