'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {
  DEFAULT_TARGET_HOSTS,
  HARD_MAX_REQUESTS_PER_SECOND,
  modeNames,
  normalizeTargetBaseUrl,
  scenarios,
  targetNames,
  validateStartConfig,
} = require('../runner/config');

const PORT = Number(process.env.PORT || 4173);
const RUNNER_BASE_URL = process.env.RUNNER_BASE_URL || 'http://k6-runner:3000';
const RUNNER_SERVICE_TOKEN = process.env.RUNNER_SERVICE_TOKEN;
const MAX_REQUESTS_PER_SECOND = Number(process.env.RUNNER_MAX_REQUESTS_PER_SECOND || HARD_MAX_REQUESTS_PER_SECOND);
const ALLOWED_TARGET_HOSTS = new Set((process.env.RUNNER_ALLOWED_TARGET_HOSTS || DEFAULT_TARGET_HOSTS.join(','))
  .split(',').map((host) => host.trim().toLowerCase().replace(/^\[|\]$/g, '')).filter(Boolean));
const allowedTargetUrls = (process.env.DASHBOARD_ALLOWED_TARGET_URLS || 'http://sfm-backend:8080')
  .split(',')
  .map((value) => normalizeTargetBaseUrl(value.trim(), ALLOWED_TARGET_HOSTS))
  .filter(Boolean);
const DEFAULT_TARGET_URL = normalizeTargetBaseUrl(
  process.env.DASHBOARD_DEFAULT_TARGET_URL || allowedTargetUrls[0], ALLOWED_TARGET_HOSTS,
);
const TARGET_URLS = [...new Set(allowedTargetUrls)];
const DIST_DIR = path.join(__dirname, 'dist');
const MIME_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function validateEnvironment() {
  if (!RUNNER_SERVICE_TOKEN || RUNNER_SERVICE_TOKEN.length < 32) throw new Error('RUNNER_SERVICE_TOKEN must be configured with at least 32 characters.');
  if (!Number.isInteger(MAX_REQUESTS_PER_SECOND) || MAX_REQUESTS_PER_SECOND < 1 || MAX_REQUESTS_PER_SECOND > HARD_MAX_REQUESTS_PER_SECOND) {
    throw new Error(`RUNNER_MAX_REQUESTS_PER_SECOND must be an integer from 1 to ${HARD_MAX_REQUESTS_PER_SECOND}.`);
  }
  if (!TARGET_URLS.length || !DEFAULT_TARGET_URL || !TARGET_URLS.includes(DEFAULT_TARGET_URL)) {
    throw new Error('Dashboard target URLs must be origins on RUNNER_ALLOWED_TARGET_HOSTS, and the default must be in the allowlist.');
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

function validateStartRequest(body) {
  if (!body || Array.isArray(body) || typeof body !== 'object') {
    return { error: { status: 400, code: 'INVALID_REQUEST_BODY', message: 'Body must be a JSON object' } };
  }
  const baseUrl = body.baseUrl === undefined ? DEFAULT_TARGET_URL : body.baseUrl;
  if (typeof baseUrl !== 'string' || !TARGET_URLS.includes(baseUrl)) {
    return { error: { status: 400, code: 'TARGET_URL_NOT_ALLOWLISTED', message: 'Choose an allowed local or staging target API URL' } };
  }
  const validated = validateStartConfig({ ...body, baseUrl }, MAX_REQUESTS_PER_SECOND, ALLOWED_TARGET_HOSTS, DEFAULT_TARGET_URL);
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

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/config') {
    return sendJson(res, 200, {
      scenarios,
      targets: targetNames,
      modes: modeNames,
      targetUrls: TARGET_URLS,
      defaultTargetUrl: DEFAULT_TARGET_URL,
      maxVus: 1000,
      minDurationSeconds: 10,
      maxDurationSeconds: 3600,
      maxRequestsPerSecond: MAX_REQUESTS_PER_SECOND,
    });
  }
  if (req.method === 'GET' && pathname === '/api/status') {
    const response = await runnerRequest('GET', 'status');
    return sendJson(res, response.status, response.payload);
  }
  if (req.method === 'POST' && pathname === '/api/start') {
    let body;
    try { body = await readJson(req); }
    catch (error) { return sendJson(res, error.status || 400, { error: { code: 'INVALID_REQUEST_BODY', message: error.message } }); }
    const validated = validateStartRequest(body);
    if (validated.error) {
      const { status, code, message, details } = validated.error;
      return sendJson(res, status, { error: { code, message, ...(details ? { details } : {}) } });
    }
    const response = await runnerRequest('POST', 'start', { ...body, baseUrl: validated.value.baseUrl });
    return sendJson(res, response.status, response.payload);
  }
  if (req.method === 'POST' && pathname === '/api/stop') {
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
    try { return await handleApi(req, res, url.pathname); }
    catch {
      return sendJson(res, 502, { error: { code: 'RUNNER_UNAVAILABLE', message: 'The local k6 Runner could not be reached' } });
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
}

module.exports = { validateStartRequest, validateLocalRequest, validateEnvironment, server };
