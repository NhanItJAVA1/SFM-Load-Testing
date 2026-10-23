import http from 'k6/http';
import { check, sleep } from 'k6';

const scenarios = {
  custom: { vus: 1, durationSeconds: 30 },
  smoke: { vus: 1, durationSeconds: 30 },
  load: { vus: 10, durationSeconds: 300 },
  stress: { vus: 25, durationSeconds: 600 },
  spike: { vus: 50, durationSeconds: 120 },
};
const endpoints = {
  ping: '/api/v1/load-test/ping',
  database: '/api/v1/load-test/database',
  redis: '/api/v1/load-test/redis',
};
const scenarioName = __ENV.SCENARIO;
const targetName = __ENV.TARGET;
const mode = __ENV.MODE || 'concurrent_users';
const targetUrl = __ENV.TARGET_URL;
const baseUrl = __ENV.BASE_URL || 'http://sfm-be:8080';
const MAX_VUS = 1000;
const defaults = scenarios[scenarioName];
const vus = __ENV.VUS === undefined ? defaults?.vus : Number(__ENV.VUS);
const durationSeconds = __ENV.DURATION_SECONDS === undefined ? defaults?.durationSeconds : Number(__ENV.DURATION_SECONDS);
const requestsPerSecond = Number(__ENV.REQUESTS_PER_SECOND);
const preAllocatedVUs = Number(__ENV.PRE_ALLOCATED_VUS);
const maxRateVUs = Number(__ENV.MAX_VUS);
const configuredMaxRps = Number(__ENV.MAX_REQUESTS_PER_SECOND || 1000);
const allowedHosts = (__ENV.K6_TARGET_HOST_ALLOWLIST || 'sfm-backend,sfm-be,localhost,127.0.0.1,::1,host.docker.internal')
  .split(',').map((host) => host.trim().toLowerCase().replace(/^\[|\]$/g, '')).filter(Boolean);

if (!Object.hasOwn(scenarios, scenarioName) || (!targetUrl && !Object.hasOwn(endpoints, targetName))) {
  throw new Error('Runner supplied an invalid scenario or target');
}
if (!['concurrent_users', 'request_rate'].includes(mode)) {
  throw new Error('Runner supplied an invalid load mode');
}
if (!Number.isInteger(durationSeconds) || durationSeconds < 10 || durationSeconds > 3600) {
  throw new Error('Runner supplied invalid limits: VUS must be an integer from 1 to 1000 and DURATION_SECONDS from 10 to 3600');
}
if (mode === 'concurrent_users' && (!Number.isInteger(vus) || vus < 1 || vus > MAX_VUS)) {
  throw new Error('Runner supplied invalid limits: VUS must be an integer from 1 to 1000');
}
if (mode === 'request_rate' && (!Number.isInteger(requestsPerSecond) || requestsPerSecond < 1 || requestsPerSecond > configuredMaxRps || !Number.isInteger(preAllocatedVUs) || preAllocatedVUs < 1 || preAllocatedVUs > 100 || !Number.isInteger(maxRateVUs) || maxRateVUs < preAllocatedVUs || maxRateVUs > 250)) {
  throw new Error('Runner supplied invalid request-rate allocation settings');
}
if (targetUrl) {
  const match = /^(https?):\/\/(\[[^\]]+\]|[^/?#:]+)(?::\d+)?(?:[/?#]|$)/i.exec(targetUrl);
  const targetHost = match?.[2]?.replace(/^\[|\]$/g, '').toLowerCase();
  if (!match || !targetHost || !allowedHosts.includes(targetHost) || /[#\s]/.test(targetUrl)) {
    throw new Error('TARGET_URL must use an explicitly allowlisted local or staging host');
  }
} else {
  const match = /^https?:\/\/(\[[^\]]+\]|[^/?#:]+)(?::\d+)?\/?$/i.exec(baseUrl);
  const baseHost = match?.[1]?.replace(/^\[|\]$/g, '').toLowerCase();
  if (!match || !baseHost || !allowedHosts.includes(baseHost)) {
    throw new Error('BASE_URL must be an origin on the configured target host allowlist');
  }
}

const targetLabel = targetName || 'custom';

export const options = {
  scenarios: {
    selected: mode === 'request_rate'
      ? { executor: 'constant-arrival-rate', rate: requestsPerSecond, timeUnit: '1s', duration: `${durationSeconds}s`, preAllocatedVUs, maxVUs: maxRateVUs }
      : { executor: 'constant-vus', vus, duration: `${durationSeconds}s` },
  },
  thresholds: { checks: ['rate>0.99'], http_req_failed: ['rate<0.01'] },
};

export default function () {
  const response = http.get(targetUrl || `${baseUrl}${endpoints[targetName]}`, { tags: { target: targetLabel } });
  check(response, { 'response is successful': (r) => r.status >= 200 && r.status < 400 });
  if (mode === 'concurrent_users') sleep(1);
}
