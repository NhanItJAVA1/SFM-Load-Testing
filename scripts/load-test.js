import http from 'k6/http';
import { check, sleep } from 'k6';

const scenarios = {
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
const baseUrl = __ENV.BASE_URL || 'http://sfm-be:8080';
const MAX_VUS = 1000;
const defaults = scenarios[scenarioName];
const vus = __ENV.VUS === undefined ? defaults?.vus : Number(__ENV.VUS);
const durationSeconds = __ENV.DURATION_SECONDS === undefined ? defaults?.durationSeconds : Number(__ENV.DURATION_SECONDS);
const requestsPerSecond = Number(__ENV.REQUESTS_PER_SECOND);
const preAllocatedVUs = Number(__ENV.PRE_ALLOCATED_VUS);
const maxRateVUs = Number(__ENV.MAX_VUS);
const configuredMaxRps = Number(__ENV.MAX_REQUESTS_PER_SECOND || 1000);

if (!Object.hasOwn(scenarios, scenarioName) || !Object.hasOwn(endpoints, targetName)) {
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
if (!/^http:\/\/(sfm-backend|sfm-be|localhost|host\.docker\.internal)(:\d+)?$/.test(baseUrl)) {
  throw new Error('BASE_URL must use an allowlisted local SFM-BE host');
}

export const options = {
  scenarios: {
    selected: mode === 'request_rate'
      ? { executor: 'constant-arrival-rate', rate: requestsPerSecond, timeUnit: '1s', duration: `${durationSeconds}s`, preAllocatedVUs, maxVUs: maxRateVUs }
      : { executor: 'constant-vus', vus, duration: `${durationSeconds}s` },
  },
  thresholds: { checks: ['rate>0.99'], http_req_failed: ['rate<0.01'] },
};

export default function () {
  const response = http.get(`${baseUrl}${endpoints[targetName]}`, { tags: { target: targetName } });
  check(response, { 'response is successful': (r) => r.status >= 200 && r.status < 400 });
  if (mode === 'concurrent_users') sleep(1);
}
