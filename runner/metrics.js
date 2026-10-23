'use strict';

function emptyMetrics() {
  return {
    throughputRps: null,
    averageLatencyMs: null,
    p95LatencyMs: null,
    errorRatePercent: null,
    completedRequests: null,
  };
}

function durationToMilliseconds(value, unit) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  switch (unit) {
    case 'ns': return number / 1_000_000;
    case 'us':
    case 'µs': return number / 1_000;
    case 'ms': return number;
    case 's': return number * 1000;
    default: return null;
  }
}

function metricLine(text, name) {
  return text.split(/\r?\n/).find((line) => new RegExp(`^\\s*${name}\\s*\\.+\\s*:`).test(line)) || '';
}

function parseK6Summary(output) {
  const text = String(output || '');
  const metrics = emptyMetrics();
  const requests = metricLine(text, 'http_reqs').match(/^\s*http_reqs\s*\.+\s*:\s*(\d+)\s+([\d.]+)\/s/);
  if (requests) {
    metrics.completedRequests = Number(requests[1]);
    metrics.throughputRps = Number(requests[2]);
  }

  const duration = metricLine(text, 'http_req_duration').match(/avg=([\d.]+)(ns|µs|us|ms|s).*?p\(95\)=([\d.]+)(ns|µs|us|ms|s)/);
  if (duration) {
    metrics.averageLatencyMs = durationToMilliseconds(duration[1], duration[2]);
    metrics.p95LatencyMs = durationToMilliseconds(duration[3], duration[4]);
  }

  const errors = metricLine(text, 'http_req_failed').match(/^\s*http_req_failed\s*\.+\s*:\s*([\d.]+)%/);
  if (errors) metrics.errorRatePercent = Number(errors[1]);
  return metrics;
}

module.exports = { emptyMetrics, parseK6Summary, durationToMilliseconds };
