'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateRateVUs, validateStartConfig } = require('./config');

test('legacy requests retain scenario defaults and use concurrent_users mode', () => {
  const expected = { smoke: [1, 30], load: [10, 300], stress: [25, 600], spike: [50, 120] };
  for (const [scenario, [vus, durationSeconds]] of Object.entries(expected)) {
    const result = validateStartConfig({ scenario, target: 'ping' });
    assert.deepEqual(result.value && [result.value.mode, result.value.vus, result.value.durationSeconds], ['concurrent_users', vus, durationSeconds]);
  }
});

test('explicit modes accept Backend payloads without scenario but legacy mode still requires it', () => {
  const concurrent = validateStartConfig({ mode: 'concurrent_users', target: 'ping', vus: 12, durationSeconds: 45 });
  assert.deepEqual([concurrent.value.scenario, concurrent.value.mode, concurrent.value.vus, concurrent.value.durationSeconds], ['custom', 'concurrent_users', 12, 45]);
  const rate = validateStartConfig({ mode: 'request_rate', target: 'database', requestsPerSecond: 40, durationSeconds: 60 });
  assert.deepEqual([rate.value.scenario, rate.value.mode, rate.value.requestsPerSecond, rate.value.durationSeconds], ['custom', 'request_rate', 40, 60]);
  assert.equal(validateStartConfig({ mode: 'concurrent_users', scenario: 'custom', target: 'ping', vus: 1 }).error.code, 'UNKNOWN_SCENARIO');
  assert.equal(validateStartConfig({ target: 'ping' }).error.reason, 'scenario_required_when_mode_omitted');
  assert.equal(validateStartConfig({ mode: 'request_rate', requestsPerSecond: 5 }).error.reason, 'target_is_required');
});

test('concurrent_users accepts VUs through the 1000 boundary and rejects values outside it', () => {
  assert.equal(validateStartConfig({ scenario: 'smoke', target: 'ping', vus: 1 }).value.vus, 1);
  assert.equal(validateStartConfig({ scenario: 'smoke', target: 'ping', vus: 1000 }).value.vus, 1000);
  for (const vus of [0, 1001, 1.5, '10']) {
    assert.equal(validateStartConfig({ scenario: 'smoke', target: 'ping', vus }).error.code, 'INVALID_VUS');
  }
});

test('request_rate requires RPS and rejects conflicting or out-of-range fields', () => {
  const missing = validateStartConfig({ scenario: 'spike', target: 'ping', mode: 'request_rate' });
  assert.equal(missing.error.code, 'INVALID_REQUESTS_PER_SECOND');
  const concurrentRps = validateStartConfig({ scenario: 'smoke', target: 'ping', requestsPerSecond: 5 });
  assert.equal(concurrentRps.error.code, 'CONFLICTING_PARAMETER');
  const rateVus = validateStartConfig({ scenario: 'smoke', target: 'ping', mode: 'request_rate', requestsPerSecond: 5, vus: 4 });
  assert.equal(rateVus.error.code, 'CONFLICTING_PARAMETER');
  for (const requestsPerSecond of [0, 1001, 2.5, '5']) {
    assert.equal(validateStartConfig({ scenario: 'smoke', target: 'ping', mode: 'request_rate', requestsPerSecond }).error.code, 'INVALID_REQUESTS_PER_SECOND');
  }
  assert.equal(validateStartConfig({ scenario: 'smoke', target: 'ping', mode: 'request_rate', requestsPerSecond: 5 }, 5).value.requestsPerSecond, 5);
  assert.equal(validateStartConfig({ scenario: 'smoke', target: 'ping', mode: 'request_rate', requestsPerSecond: 6 }, 5).error.details.maximum, 5);
});

test('request_rate VU allocation is bounded and scales conservatively', () => {
  assert.deepEqual(calculateRateVUs(1), { preAllocatedVUs: 1, maxVUs: 1 });
  assert.deepEqual(calculateRateVUs(1000), { preAllocatedVUs: 100, maxVUs: 250 });
  assert.ok(calculateRateVUs(1000).maxVUs <= 250);
});

test('request_rate defaults duration independently and rejects unknown mode or target', () => {
  const rate = validateStartConfig({ scenario: 'spike', target: 'ping', mode: 'request_rate', requestsPerSecond: 100 });
  assert.equal(rate.value.durationSeconds, 120);
  assert.equal(rate.value.preAllocatedVUs, 10);
  assert.equal(rate.value.maxVUs, 25);
  assert.equal(validateStartConfig({ scenario: 'smoke', target: 'ping', mode: 'other' }).error.code, 'UNKNOWN_MODE');
  assert.equal(validateStartConfig({ scenario: 'smoke', target: 'production', mode: 'request_rate', requestsPerSecond: 1 }).error.code, 'UNKNOWN_TARGET');
  assert.equal(validateStartConfig({ scenario: 'smoke', target: 'ping', mode: 'request_rate', requestsPerSecond: 1, url: 'http://example.com' }).error.code, 'UNKNOWN_PARAMETER');
});

test('duration range remains 10 to 3600 seconds', () => {
  assert.equal(validateStartConfig({ scenario: 'smoke', target: 'ping', durationSeconds: 10 }).value.durationSeconds, 10);
  assert.equal(validateStartConfig({ scenario: 'smoke', target: 'ping', durationSeconds: 3600 }).value.durationSeconds, 3600);
  assert.equal(validateStartConfig({ scenario: 'smoke', target: 'ping', durationSeconds: 9 }).error.code, 'INVALID_DURATION_SECONDS');
  assert.equal(validateStartConfig({ scenario: 'smoke', target: 'ping', durationSeconds: 3601 }).error.code, 'INVALID_DURATION_SECONDS');
});

test('target base URLs must be exact allowed local or staging origins', () => {
  const allowed = new Set(['sfm-backend', 'localhost', 'staging-sfm.test']);
  assert.equal(validateStartConfig({ scenario: 'smoke', target: 'ping', baseUrl: 'http://localhost:8080' }, 1000, allowed).value.baseUrl, 'http://localhost:8080');
  assert.equal(validateStartConfig({ scenario: 'smoke', target: 'ping', baseUrl: 'https://staging-sfm.test' }, 1000, allowed).value.baseUrl, 'https://staging-sfm.test');
  for (const baseUrl of ['https://api.example.com', 'http://localhost:8080/api', 'http://user@localhost:8080', 'http://localhost:8080?x=1']) {
    assert.equal(validateStartConfig({ scenario: 'smoke', target: 'ping', baseUrl }, 1000, allowed).error.code, 'INVALID_TARGET_URL');
  }
});
