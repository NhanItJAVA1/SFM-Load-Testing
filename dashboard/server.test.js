'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateStartRequest } = require('./server');

test('accepts only configured target API origins and retains Runner scenario validation', () => {
  const valid = validateStartRequest({
    scenario: 'smoke', target: 'ping', mode: 'concurrent_users', vus: 2,
    durationSeconds: 30, baseUrl: 'http://sfm-backend:8080',
  });
  assert.equal(valid.value.baseUrl, 'http://sfm-backend:8080');
  assert.equal(valid.value.vus, 2);
  assert.equal(validateStartRequest({ scenario: 'production', target: 'ping', baseUrl: 'http://sfm-backend:8080' }).error.code, 'UNKNOWN_SCENARIO');
});

test('rejects external or non-origin target URLs and unknown request fields', () => {
  for (const baseUrl of ['https://example.com', 'http://sfm-backend:8080/api', 'http://user@sfm-backend:8080']) {
    assert.equal(validateStartRequest({ scenario: 'smoke', target: 'ping', baseUrl }).error.code, 'TARGET_URL_NOT_ALLOWLISTED');
  }
  assert.equal(validateStartRequest({ scenario: 'smoke', target: 'ping', command: 'k6 run something' }).error.code, 'UNKNOWN_PARAMETER');
});
