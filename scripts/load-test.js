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
const baseUrl = __ENV.BASE_URL || 'http://sfm-be:8080';
const defaults = scenarios[scenarioName];
const vus = __ENV.VUS === undefined ? defaults?.vus : Number(__ENV.VUS);
const durationSeconds = __ENV.DURATION_SECONDS === undefined ? defaults?.durationSeconds : Number(__ENV.DURATION_SECONDS);

if (!Object.hasOwn(scenarios, scenarioName) || !Object.hasOwn(endpoints, targetName)) {
  throw new Error('Runner supplied an invalid scenario or target');
}
if (!Number.isInteger(vus) || vus < 1 || vus > 100 || !Number.isInteger(durationSeconds) || durationSeconds < 10 || durationSeconds > 3600) {
  throw new Error('Runner supplied invalid VU or duration limits');
}
if (!/^http:\/\/(sfm-backend|sfm-be|localhost|host\.docker\.internal)(:\d+)?$/.test(baseUrl)) {
  throw new Error('BASE_URL must use an allowlisted local SFM-BE host');
}

export const options = {
  scenarios: { selected: { executor: 'constant-vus', vus, duration: `${durationSeconds}s` } },
  thresholds: { checks: ['rate>0.99'], http_req_failed: ['rate<0.01'] },
};

export default function () {
  const response = http.get(`${baseUrl}${endpoints[targetName]}`, { tags: { target: targetName } });
  check(response, { 'response is successful': (r) => r.status >= 200 && r.status < 400 });
  sleep(1);
}
