'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  DEFAULT_TARGET_HOSTS,
  HARD_MAX_REQUESTS_PER_SECOND,
  modeNames,
  scenarios,
  targetNames,
  validateStartConfig,
} = require('../runner/config');
const { createEnvironmentConfig, validateEnvironmentConfig } = require('./environments');
const { EnvironmentManager } = require('./environment-manager');

const PORT = Number(process.env.PORT || 4173);
const RUNNER_BASE_URL = process.env.RUNNER_BASE_URL || 'http://k6-runner:3000';
const RUNNER_SERVICE_TOKEN = process.env.RUNNER_SERVICE_TOKEN;
const ENVIRONMENTS = validateEnvironmentConfig(createEnvironmentConfig());
const environmentManager = new EnvironmentManager(ENVIRONMENTS);
const CSRF_TOKEN = crypto.randomBytes(32).toString('hex');
let controlOperation = null;
const MAX_REQUESTS_PER_SECOND = Number(process.env.RUNNER_MAX_REQUESTS_PER_SECOND || HARD_MAX_REQUESTS_PER_SECOND);
const PRODUCTION_LIMITS = Object.freeze({
  ...ENVIRONMENTS.productionLimits,
  requestsPerSecond: Math.min(ENVIRONMENTS.productionLimits.requestsPerSecond, MAX_REQUESTS_PER_SECOND),
});
const ALLOWED_TARGET_HOSTS = new Set((process.env.RUNNER_ALLOWED_TARGET_HOSTS || DEFAULT_TARGET_HOSTS.join(','))
  .split(',').map((host) => host.trim().toLowerCase().replace(/^\[|\]$/g, '')).filter(Boolean));
const PRODUCTION_TARGET_HOSTS = new Set((process.env.RUNNER_PRODUCTION_TARGET_HOSTS || 'sfmbe.duckdns.org')
  .split(',').map((host) => host.trim().toLowerCase().replace(/^\[|\]$/g, '')).filter(Boolean));
const MONITORING_RANGES = Object.freeze({
  '15m': { seconds: 900, step: 15 },
  '1h': { seconds: 3600, step: 30 },
  '6h': { seconds: 21600, step: 120 },
  '24h': { seconds: 86400, step: 300 },
});
const DIST_DIR = path.join(__dirname, 'dist');
const MIME_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function validateEnvironment() {
  if (!RUNNER_SERVICE_TOKEN || RUNNER_SERVICE_TOKEN.length < 32) throw new Error('RUNNER_SERVICE_TOKEN must be configured with at least 32 characters.');
  if (!Number.isInteger(MAX_REQUESTS_PER_SECOND) || MAX_REQUESTS_PER_SECOND < 1 || MAX_REQUESTS_PER_SECOND > HARD_MAX_REQUESTS_PER_SECOND) {
    throw new Error(`RUNNER_MAX_REQUESTS_PER_SECOND must be an integer from 1 to ${HARD_MAX_REQUESTS_PER_SECOND}.`);
  }
  for (const name of ['local', 'production']) {
    const targetHost = new URL(ENVIRONMENTS[name].backendTarget).hostname.toLowerCase();
    if (!ALLOWED_TARGET_HOSTS.has(targetHost)) throw new Error(`RUNNER_ALLOWED_TARGET_HOSTS must include the ${name} backend host.`);
    if (name === 'production' && !PRODUCTION_TARGET_HOSTS.has(targetHost)) throw new Error('RUNNER_PRODUCTION_TARGET_HOSTS must include the configured Production backend host.');
  }
  try {
    const runnerUrl = new URL(RUNNER_BASE_URL);
    if (!['http:', 'https:'].includes(runnerUrl.protocol) || runnerUrl.username || runnerUrl.password) throw new Error();
  } catch {
    throw new Error('RUNNER_BASE_URL must be an absolute HTTP or HTTPS URL without credentials.');
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
  });
  res.end(JSON.stringify(body));
}

function validateLocalRequest(req) {
  const host = (req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) return false;
    } catch { return false; }
  }
  return req.headers['sec-fetch-site'] !== 'cross-site';
}

function validateCsrfRequest(req, expectedToken = CSRF_TOKEN) {
  const origin = req.headers.origin;
  const token = req.headers['x-sfm-lab-csrf'];
  if (typeof origin !== 'string' || typeof token !== 'string' || token.length !== expectedToken.length) return false;
  try { if (new URL(origin).host !== req.headers.host) return false; }
  catch { return false; }
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expectedToken));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let text = '';
    req.on('data', (chunk) => {
      text += chunk;
      if (text.length > 4096) reject(Object.assign(new Error('Request body too large'), { status: 413 }));
    });
    req.on('end', () => {
      try { resolve(text ? JSON.parse(text) : {}); }
      catch { reject(Object.assign(new Error('Body must be valid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function validateStartRequest(body, selectedEnvironment = environmentManager.currentEnvironment) {
  if (!body || Array.isArray(body) || typeof body !== 'object') {
    return { error: { status: 400, code: 'INVALID_REQUEST_BODY', message: 'Body must be a JSON object' } };
  }
  const environment = selectedEnvironment;
  if (body.environment !== environment) {
    return { error: { status: 409, code: 'ENVIRONMENT_CHANGED', message: 'The selected environment changed. Refresh the dashboard before starting a test.' } };
  }
  if (environment === 'production' && body.confirmProduction !== true) {
    return { error: { status: 400, code: 'PRODUCTION_CONFIRMATION_REQUIRED', message: 'Explicit confirmation is required before a Production load test.' } };
  }
  const baseUrl = ENVIRONMENTS[environment].backendTarget;
  if (body.baseUrl !== undefined && body.baseUrl !== baseUrl) {
    return { error: { status: 400, code: 'TARGET_URL_NOT_ALLOWED_FOR_ENVIRONMENT', message: 'The selected environment controls the test target.' } };
  }
  const runnerBody = { ...body, baseUrl };
  delete runnerBody.environment;
  delete runnerBody.confirmProduction;
  const validated = validateStartConfig(runnerBody, MAX_REQUESTS_PER_SECOND, ALLOWED_TARGET_HOSTS, baseUrl);
  if (!validated.error && environment === 'production') {
    const config = validated.value;
    if (config.durationSeconds > PRODUCTION_LIMITS.durationSeconds) {
      return { error: { status: 400, code: 'PRODUCTION_LIMIT_EXCEEDED', message: `Production duration cannot exceed ${PRODUCTION_LIMITS.durationSeconds} seconds.`, details: { field: 'durationSeconds', maximum: PRODUCTION_LIMITS.durationSeconds } } };
    }
    if (config.effectiveVUs > PRODUCTION_LIMITS.vus) {
      return { error: { status: 400, code: 'PRODUCTION_LIMIT_EXCEEDED', message: `Production load cannot exceed ${PRODUCTION_LIMITS.vus} effective VUs.`, details: { field: 'vus', maximum: PRODUCTION_LIMITS.vus } } };
    }
    if (config.mode === 'request_rate' && config.requestsPerSecond > PRODUCTION_LIMITS.requestsPerSecond) {
      return { error: { status: 400, code: 'PRODUCTION_LIMIT_EXCEEDED', message: `Production request rate cannot exceed ${PRODUCTION_LIMITS.requestsPerSecond} RPS.`, details: { field: 'requestsPerSecond', maximum: PRODUCTION_LIMITS.requestsPerSecond } } };
    }
  }
  return validated.error ? validated : { value: { ...validated.value, baseUrl } };
}

async function runnerRequest(method, route, body) {
  if (!RUNNER_SERVICE_TOKEN) throw new Error('Runner authentication is not configured');
  const response = await fetch(new URL(route, `${RUNNER_BASE_URL.replace(/\/$/, '')}/`), {
    method,
    headers: { authorization: `Bearer ${RUNNER_SERVICE_TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(35_000),
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; }
  catch { payload = { error: { code: 'INVALID_RUNNER_RESPONSE', message: 'Runner returned a non-JSON response' } }; }
  return { status: response.status, payload };
}

async function prometheusRequest(baseUrl, pathname, parameters) {
  const url = new URL(pathname, `${baseUrl.replace(/\/$/, '')}/`);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value));
  const response = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error('Prometheus returned an unsuccessful response');
  const body = await response.json();
  if (body?.status !== 'success' || !Array.isArray(body?.data?.result)) throw new Error('Prometheus returned an invalid query response');
  return body.data.result;
}

function vectorValue(result) {
  const raw = result?.[0]?.value?.[1];
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function healthState(value) {
  if (value === null) return 'unknown';
  return value >= 1 ? 'healthy' : 'unhealthy';
}

function monitoringQueries(job) {
  const selector = `{job="${job}"}`;
  const count = `http_server_request_duration_seconds_count${selector}`;
  const buckets = `http_server_request_duration_seconds_bucket${selector}`;
  return {
    requestsPerSecond: `sum(rate(${count}[5m]))`,
    p95LatencyMilliseconds: `histogram_quantile(0.95, sum by (le) (rate(${buckets}[5m]))) * 1000`,
    http5xxErrorRatePercent: `100 * sum(rate(http_server_request_duration_seconds_count${selector.replace('}', ',http_response_status_code=~"5.."}')}[5m])) / sum(rate(${count}[5m]))`,
    apiAvailabilityPercent: `100 * avg_over_time(up${selector}[5m])`,
    apiHealth: `up${selector}`,
    sqlServerHealth: `sfm_dependency_health{dependency="sqlserver",job="${job}"}`,
    redisHealth: `sfm_dependency_health{dependency="redis",job="${job}"}`,
  };
}

async function getEnvironmentMonitoring(rangeName, environmentName) {
  const range = MONITORING_RANGES[rangeName];
  const definition = ENVIRONMENTS[environmentName];
  const queryBaseUrl = definition.prometheusUrl;
  const queries = monitoringQueries(ENVIRONMENTS.metricsJob);
  const end = Date.now() / 1000;
  const start = end - range.seconds;
  const timeRange = { start, end, step: `${range.step}s` };
  const names = ['requestsPerSecond', 'p95LatencyMilliseconds', 'http5xxErrorRatePercent'];
  const [overviewResults, seriesResults] = await Promise.all([
    Promise.all(Object.entries(queries).map(async ([name, query]) => [name, vectorValue(await prometheusRequest(queryBaseUrl, '/api/v1/query', { query }))])),
    Promise.all(names.map(async (name) => [name, await prometheusRequest(queryBaseUrl, '/api/v1/query_range', { ...timeRange, query: queries[name] })])),
  ]);
  const overview = Object.fromEntries(overviewResults);
  const history = Object.fromEntries(seriesResults.map(([name, result]) => {
    const points = (result?.[0]?.values || []).flatMap((sample) => {
      const timestamp = Number(sample?.[0]);
      const parsed = Number(sample?.[1]);
      if (!Number.isFinite(timestamp)) return [];
      return [{ timestampUtc: new Date(timestamp * 1000).toISOString(), value: Number.isFinite(parsed) ? parsed : null }];
    });
    return [name, points];
  }));
  return {
    observedAtUtc: new Date().toISOString(),
    environment: environmentName,
    range: rangeName,
    stepSeconds: range.step,
    overview: {
      requestsPerSecond: overview.requestsPerSecond,
      p95LatencyMilliseconds: overview.p95LatencyMilliseconds,
      http5xxErrorRatePercent: overview.http5xxErrorRatePercent,
      apiAvailabilityPercent: overview.apiAvailabilityPercent,
      apiHealth: healthState(overview.apiHealth),
      sqlServerHealth: healthState(overview.sqlServerHealth),
      redisHealth: healthState(overview.redisHealth),
    },
    history,
  };
}

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/config') {
    return sendJson(res, 200, {
      scenarios,
      targets: targetNames,
      modes: modeNames,
      maxVus: 1000,
      minDurationSeconds: 10,
      maxDurationSeconds: 3600,
      maxRequestsPerSecond: MAX_REQUESTS_PER_SECOND,
      productionLimits: PRODUCTION_LIMITS,
      csrfToken: CSRF_TOKEN,
    });
  }
  if (req.method === 'GET' && pathname === '/api/environment') return sendJson(res, 200, await environmentManager.status());
  if (req.method === 'GET' && pathname === '/api/prometheus/status') {
    const environment = new URL(req.url, 'http://localhost').searchParams.get('environment') || environmentManager.currentEnvironment;
    return sendJson(res, 200, await environmentManager.check(environment));
  }
  if (req.method === 'GET' && pathname === '/api/status') {
    const response = await runnerRequest('GET', 'status');
    const payload = response.payload && typeof response.payload === 'object'
      ? { ...response.payload, environment: Object.keys(ENVIRONMENTS).find((name) => ENVIRONMENTS[name]?.backendTarget === response.payload.targetApiUrl) || null }
      : response.payload;
    return sendJson(res, response.status, payload);
  }
  if (req.method === 'GET' && pathname === '/api/monitoring') {
    const rangeName = new URL(req.url, 'http://localhost').searchParams.get('range') || '15m';
    if (!Object.hasOwn(MONITORING_RANGES, rangeName)) {
      return sendJson(res, 400, { error: { code: 'INVALID_MONITORING_RANGE', message: 'Choose one of the supported ranges: 15m, 1h, 6h, 24h.' } });
    }
    try { return sendJson(res, 200, await getEnvironmentMonitoring(rangeName, environmentManager.currentEnvironment)); }
    catch { return sendJson(res, 502, { error: { code: 'PROMETHEUS_UNAVAILABLE', message: 'Production monitoring data is temporarily unavailable.' } }); }
  }
  if (req.method === 'POST' && pathname === '/api/environment') {
    if (controlOperation) return sendJson(res, 409, { error: { code: 'CONTROL_OPERATION_IN_PROGRESS', message: 'Wait for the current control operation to finish.' } });
    controlOperation = 'environment';
    try {
      let body;
      try { body = await readJson(req); }
      catch (error) { return sendJson(res, error.status || 400, { error: { code: 'INVALID_REQUEST_BODY', message: error.message } }); }
      if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).some((key) => key !== 'environment')) {
        return sendJson(res, 400, { error: { code: 'INVALID_REQUEST_BODY', message: 'Provide only an environment field.' } });
      }
      const runner = await runnerRequest('GET', 'status');
      if (runner.status !== 200) return sendJson(res, 502, { error: { code: 'RUNNER_UNAVAILABLE', message: 'Runner status could not be checked.' } });
      if (runner.payload?.running) return sendJson(res, 409, { error: { code: 'TEST_RUNNING', message: 'Stop the active k6 test before switching environments.' } });
      const state = await environmentManager.switchTo(body.environment);
      return sendJson(res, 200, state);
    } catch (error) {
      return sendJson(res, error.status || 502, { error: { code: error.code || 'ENVIRONMENT_SWITCH_FAILED', message: error.message || 'Environment switch failed.' } });
    } finally { controlOperation = null; }
  }
  if (req.method === 'POST' && pathname === '/api/start') {
    if (controlOperation) return sendJson(res, 409, { error: { code: 'CONTROL_OPERATION_IN_PROGRESS', message: 'Wait for the current control operation to finish.' } });
    controlOperation = 'start';
    try {
      let body;
      try { body = await readJson(req); }
      catch (error) { return sendJson(res, error.status || 400, { error: { code: 'INVALID_REQUEST_BODY', message: error.message } }); }
      const validated = validateStartRequest(body);
      if (validated.error) {
        const { status, code, message, details } = validated.error;
        return sendJson(res, status, { error: { code, message, ...(details ? { details } : {}) } });
      }
      const runnerBody = { ...body, baseUrl: validated.value.baseUrl };
      delete runnerBody.environment;
      const response = await runnerRequest('POST', 'start', runnerBody);
      return sendJson(res, response.status, response.payload);
    } finally { controlOperation = null; }
  }
  if (req.method === 'POST' && pathname === '/api/stop') {
    if (controlOperation) return sendJson(res, 409, { error: { code: 'CONTROL_OPERATION_IN_PROGRESS', message: 'Wait for the current control operation to finish.' } });
    const response = await runnerRequest('POST', 'stop', {});
    return sendJson(res, response.status, response.payload);
  }
  return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Route not found' } });
}

const server = http.createServer(async (req, res) => {
  if (!validateLocalRequest(req)) return sendJson(res, 403, { error: { code: 'LOCAL_ACCESS_ONLY', message: 'SFM Performance Lab is available from this machine only' } });
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health' && req.method === 'GET') return sendJson(res, 200, { healthy: true });
  if (url.pathname.startsWith('/api/')) {
    if (req.method === 'POST' && !validateCsrfRequest(req)) return sendJson(res, 403, { error: { code: 'CSRF_REJECTED', message: 'A same-origin dashboard request is required.' } });
    try { return await handleApi(req, res, url.pathname); }
    catch (error) {
      return sendJson(res, error.status || 502, { error: { code: error.code || 'UPSTREAM_UNAVAILABLE', message: error.status ? error.message : 'The selected upstream service could not be reached.' } });
    }
  }

  const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const filePath = path.resolve(DIST_DIR, requested);
  if (!filePath.startsWith(`${DIST_DIR}${path.sep}`) && filePath !== path.join(DIST_DIR, 'index.html')) {
    return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'File not found' } });
  }
  const file = fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? filePath : path.join(DIST_DIR, 'index.html');
  if (!fs.existsSync(file)) return sendJson(res, 503, { error: { code: 'DASHBOARD_NOT_BUILT', message: 'Build the dashboard assets first' } });
  res.writeHead(200, {
    'content-type': MIME_TYPES[path.extname(file)] || 'application/octet-stream',
    'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
  });
  fs.createReadStream(file).pipe(res);
});

if (require.main === module) {
  try { validateEnvironment(); }
  catch (error) { console.error(error.message); process.exit(1); }
  server.listen(PORT, '0.0.0.0', () => console.log(`SFM Performance Lab listening on port ${PORT}`));
  const shutdown = () => {
    server.close(() => { void environmentManager.dispose().finally(() => process.exit(0)); });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

module.exports = { validateStartRequest, validateLocalRequest, validateCsrfRequest, validateEnvironment, server, environmentManager, getEnvironmentMonitoring, monitoringQueries };
