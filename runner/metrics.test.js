'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseK6Summary } = require('./metrics');

test('parses actual k6 summary metrics into dashboard fields', () => {
  const summary = `
    http_req_duration..............: avg=3.02ms min=788.44µs med=1.55ms max=67.24ms p(90)=2.67ms p(95)=3.28ms
    http_req_failed................: 0.98%  1 out of 102
    http_reqs......................: 102    5.099435/s
  `;
  assert.deepEqual(parseK6Summary(summary), {
    throughputRps: 5.099435,
    averageLatencyMs: 3.02,
    p95LatencyMs: 3.28,
    errorRatePercent: 0.98,
    completedRequests: 102,
  });
});

test('returns null until k6 has emitted the corresponding summary row', () => {
  assert.deepEqual(parseK6Summary(''), {
    throughputRps: null,
    averageLatencyMs: null,
    p95LatencyMs: null,
    errorRatePercent: null,
    completedRequests: null,
  });
});
