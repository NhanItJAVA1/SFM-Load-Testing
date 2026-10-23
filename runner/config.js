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

function error(status, code, reason, message, details) {
  return { error: { status, code, reason, message, details } };
}

function calculateRateVUs(requestsPerSecond) {
  const preAllocatedVUs = Math.min(MAX_PREALLOCATED_RATE_VUS, Math.max(1, Math.ceil(requestsPerSecond / 10)));
  const maxVUs = Math.min(MAX_RATE_VUS, Math.max(preAllocatedVUs, Math.ceil(requestsPerSecond / 4)));
  return { preAllocatedVUs, maxVUs };
}

function validateStartConfig(body, maxRequestsPerSecond = HARD_MAX_REQUESTS_PER_SECOND) {
  if (!body || Array.isArray(body) || typeof body !== 'object') {
    return error(400, 'INVALID_REQUEST_BODY', 'body_must_be_json_object', 'Body must be a JSON object');
  }

  const allowed = ['scenario', 'target', 'mode', 'vus', 'durationSeconds', 'requestsPerSecond'];
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    return error(400, 'UNKNOWN_PARAMETER', 'configuration_key_not_allowlisted', 'Request contains an unsupported configuration parameter', { allowed });
  }
  if (!Object.hasOwn(body, 'scenario') || !Object.hasOwn(body, 'target')) {
    return error(400, 'MISSING_REQUIRED_FIELD', 'scenario_and_target_are_required', 'scenario and target are required', { required: ['scenario', 'target'] });
  }
  if (!Object.hasOwn(scenarios, body.scenario)) {
    return error(400, 'UNKNOWN_SCENARIO', 'scenario_not_allowlisted', 'Unknown scenario', { allowed: Object.keys(scenarios) });
  }
  if (!targets.has(body.target)) {
    return error(400, 'UNKNOWN_TARGET', 'target_not_allowlisted', 'Unknown target', { allowed: [...targets] });
  }

  const mode = body.mode === undefined ? 'concurrent_users' : body.mode;
  if (!modes.has(mode)) {
    return error(400, 'UNKNOWN_MODE', 'mode_not_allowlisted', 'mode must be concurrent_users or request_rate', { allowed: [...modes] });
  }
  if (body.durationSeconds !== undefined && (!Number.isInteger(body.durationSeconds) || body.durationSeconds < 10 || body.durationSeconds > MAX_DURATION_SECONDS)) {
    return error(400, 'INVALID_DURATION_SECONDS', 'duration_seconds_must_be_integer_in_range', 'durationSeconds must be an integer from 10 to 3600', { field: 'durationSeconds', minimum: 10, maximum: MAX_DURATION_SECONDS });
  }

  const durationSeconds = body.durationSeconds === undefined ? scenarios[body.scenario].durationSeconds : body.durationSeconds;
  if (mode === 'concurrent_users') {
    if (body.requestsPerSecond !== undefined) {
      return error(400, 'CONFLICTING_PARAMETER', 'requests_per_second_requires_request_rate_mode', 'requestsPerSecond is only valid in request_rate mode', { field: 'requestsPerSecond', requiredMode: 'request_rate' });
    }
    const vus = body.vus === undefined ? scenarios[body.scenario].vus : body.vus;
    if (!Number.isInteger(vus) || vus < 1 || vus > MAX_VUS) {
      return error(400, 'INVALID_VUS', 'vus_must_be_integer_in_range', `vus must be an integer from 1 to ${MAX_VUS}`, { field: 'vus', minimum: 1, maximum: MAX_VUS });
    }
    return { value: { scenario: body.scenario, target: body.target, mode, vus, effectiveVUs: vus, preAllocatedVUs: vus, maxVUs: vus, durationSeconds, requestsPerSecond: null } };
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
      scenario: body.scenario, target: body.target, mode, requestsPerSecond,
      vus: maxVUs, effectiveVUs: maxVUs, preAllocatedVUs, maxVUs, durationSeconds,
    },
  };
}

module.exports = {
  calculateRateVUs,
  validateStartConfig,
  HARD_MAX_REQUESTS_PER_SECOND,
  MAX_DURATION_SECONDS,
};
