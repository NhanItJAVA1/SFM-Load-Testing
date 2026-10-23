'use strict';

const scenarios = Object.freeze({
  smoke: { vus: 1, durationSeconds: 30 },
  load: { vus: 10, durationSeconds: 300 },
  stress: { vus: 25, durationSeconds: 600 },
  spike: { vus: 50, durationSeconds: 120 },
});
const targets = new Set(['ping', 'database', 'redis']);
const modes = new Set(['concurrent_users', 'request_rate']);
const MAX_VUS = 1000;
const MAX_DURATION_SECONDS = 3600;
const HARD_MAX_REQUESTS_PER_SECOND = 1000;
const MAX_PREALLOCATED_RATE_VUS = 100;
const MAX_RATE_VUS = 250;
const DEFAULT_TARGET_HOSTS = Object.freeze(['sfm-backend', 'sfm-be', 'localhost', '127.0.0.1', '::1', 'host.docker.internal']);

function error(status, code, reason, message, details) {
  return { error: { status, code, reason, message, details } };
}

function calculateRateVUs(requestsPerSecond) {
  const preAllocatedVUs = Math.min(MAX_PREALLOCATED_RATE_VUS, Math.max(1, Math.ceil(requestsPerSecond / 10)));
  const maxVUs = Math.min(MAX_RATE_VUS, Math.max(preAllocatedVUs, Math.ceil(requestsPerSecond / 4)));
  return { preAllocatedVUs, maxVUs };
}

function normalizeTargetBaseUrl(value, allowedHosts) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash || !allowedHosts.has(hostname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function validateStartConfig(body, maxRequestsPerSecond = HARD_MAX_REQUESTS_PER_SECOND,
  allowedHosts = new Set(DEFAULT_TARGET_HOSTS), defaultBaseUrl = 'http://sfm-backend:8080') {
  if (!body || Array.isArray(body) || typeof body !== 'object') {
    return error(400, 'INVALID_REQUEST_BODY', 'body_must_be_json_object', 'Body must be a JSON object');
  }

  const allowed = ['scenario', 'target', 'mode', 'vus', 'durationSeconds', 'requestsPerSecond', 'baseUrl'];
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    return error(400, 'UNKNOWN_PARAMETER', 'configuration_key_not_allowlisted', 'Request contains an unsupported configuration parameter', { allowed });
  }
  const mode = body.mode === undefined ? 'concurrent_users' : body.mode;
  if (!modes.has(mode)) {
    return error(400, 'UNKNOWN_MODE', 'mode_not_allowlisted', 'mode must be concurrent_users or request_rate', { allowed: [...modes] });
  }
  if (!Object.hasOwn(body, 'target')) {
    return error(400, 'MISSING_REQUIRED_FIELD', 'target_is_required', 'target is always required', { required: ['target'] });
  }
  if (!Object.hasOwn(body, 'scenario') && body.mode === undefined) {
    return error(400, 'MISSING_REQUIRED_FIELD', 'scenario_required_when_mode_omitted', 'scenario is required when mode is omitted', { required: ['scenario', 'target'] });
  }
  if (Object.hasOwn(body, 'scenario') && !Object.hasOwn(scenarios, body.scenario)) {
    return error(400, 'UNKNOWN_SCENARIO', 'scenario_not_allowlisted', 'Unknown scenario', { allowed: Object.keys(scenarios) });
  }
  if (!targets.has(body.target)) {
    return error(400, 'UNKNOWN_TARGET', 'target_not_allowlisted', 'Unknown target', { allowed: [...targets] });
  }
  const baseUrl = normalizeTargetBaseUrl(body.baseUrl === undefined ? defaultBaseUrl : body.baseUrl, allowedHosts);
  if (!baseUrl) {
    return error(400, 'INVALID_TARGET_URL', 'target_base_url_not_allowlisted', 'baseUrl must be an HTTP or HTTPS origin on the configured target host allowlist', { field: 'baseUrl' });
  }

  // The Backend's explicit-mode DTO intentionally omits scenario. Use one fixed
  // internal label/default for those requests; clients still cannot submit it.
  const scenario = Object.hasOwn(body, 'scenario') ? body.scenario : 'custom';
  const scenarioDefaults = scenarios[scenario] || { vus: 1, durationSeconds: 30 };
  if (body.durationSeconds !== undefined && (!Number.isInteger(body.durationSeconds) || body.durationSeconds < 10 || body.durationSeconds > MAX_DURATION_SECONDS)) {
    return error(400, 'INVALID_DURATION_SECONDS', 'duration_seconds_must_be_integer_in_range', 'durationSeconds must be an integer from 10 to 3600', { field: 'durationSeconds', minimum: 10, maximum: MAX_DURATION_SECONDS });
  }

  const durationSeconds = body.durationSeconds === undefined ? scenarioDefaults.durationSeconds : body.durationSeconds;
  if (mode === 'concurrent_users') {
    if (body.requestsPerSecond !== undefined) {
      return error(400, 'CONFLICTING_PARAMETER', 'requests_per_second_requires_request_rate_mode', 'requestsPerSecond is only valid in request_rate mode', { field: 'requestsPerSecond', requiredMode: 'request_rate' });
    }
    const vus = body.vus === undefined ? scenarioDefaults.vus : body.vus;
    if (!Number.isInteger(vus) || vus < 1 || vus > MAX_VUS) {
      return error(400, 'INVALID_VUS', 'vus_must_be_integer_in_range', `vus must be an integer from 1 to ${MAX_VUS}`, { field: 'vus', minimum: 1, maximum: MAX_VUS });
    }
    return { value: { scenario, target: body.target, mode, baseUrl, vus, effectiveVUs: vus, preAllocatedVUs: vus, maxVUs: vus, durationSeconds, requestsPerSecond: null } };
  }

  if (body.vus !== undefined) {
    return error(400, 'CONFLICTING_PARAMETER', 'vus_is_not_valid_in_request_rate_mode', 'vus is controlled by the request_rate VU allocation strategy', { field: 'vus', allowedMode: 'concurrent_users' });
  }
  const requestsPerSecond = body.requestsPerSecond;
  if (!Number.isInteger(requestsPerSecond) || requestsPerSecond < 1 || requestsPerSecond > maxRequestsPerSecond) {
    return error(400, 'INVALID_REQUESTS_PER_SECOND', 'requests_per_second_must_be_integer_in_range', `requestsPerSecond must be an integer from 1 to ${maxRequestsPerSecond}`, { field: 'requestsPerSecond', minimum: 1, maximum: maxRequestsPerSecond });
  }
  const { preAllocatedVUs, maxVUs } = calculateRateVUs(requestsPerSecond);
  return {
    value: {
      scenario, target: body.target, mode, baseUrl, requestsPerSecond,
      vus: maxVUs, effectiveVUs: maxVUs, preAllocatedVUs, maxVUs, durationSeconds,
    },
  };
}

module.exports = {
  calculateRateVUs,
  validateStartConfig,
  HARD_MAX_REQUESTS_PER_SECOND,
  MAX_DURATION_SECONDS,
  DEFAULT_TARGET_HOSTS,
  scenarios,
  targetNames: [...targets],
  modeNames: [...modes],
  normalizeTargetBaseUrl,
};
