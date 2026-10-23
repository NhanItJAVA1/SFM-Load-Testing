import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';

type Mode = 'concurrent_users' | 'request_rate';
type Scenario = { vus: number; durationSeconds: number };
type Metrics = {
  throughputRps: number | null;
  averageLatencyMs: number | null;
  p95LatencyMs: number | null;
  errorRatePercent: number | null;
  completedRequests: number | null;
};
type RunStatus = {
  status: 'idle' | 'running' | 'completed' | 'stopped' | 'failed';
  running: boolean;
  testId: string | null;
  scenario: string | null;
  target: string | null;
  targetApiUrl: string | null;
  mode: Mode | null;
  requestsPerSecond: number | null;
  vus: number | null;
  effectiveVUs: number | null;
  durationSeconds: number | null;
  droppedIterations: number | null;
  metrics: Metrics;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  stopping?: boolean;
  diagnostics?: { stdout: string; stderr: string };
};
type DashboardConfig = {
  scenarios: Record<string, Scenario>;
  targets: string[];
  modes: Mode[];
  targetUrls: string[];
  defaultTargetUrl: string;
  maxVus: number;
  minDurationSeconds: number;
  maxDurationSeconds: number;
  maxRequestsPerSecond: number;
};

const HISTORY_KEY = 'sfm-performance-lab-history-v1';
const EMPTY_METRICS: Metrics = { throughputRps: null, averageLatencyMs: null, p95LatencyMs: null, errorRatePercent: null, completedRequests: null };

async function api<T>(route: string, init?: RequestInit): Promise<T> {
  const response = await fetch(route, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || `Request failed (${response.status})`);
  return body as T;
}

function loadHistory(): RunStatus[] {
  try {
    const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(value) ? value.slice(0, 30) : [];
  } catch { return []; }
}

function saveHistory(history: RunStatus[]) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 30))); } catch { /* storage may be unavailable */ }
}

function upsertHistory(history: RunStatus[], run: RunStatus) {
  if (!run.testId || run.status === 'idle' || run.status === 'running') return history;
  return [run, ...history.filter((item) => item.testId !== run.testId)].slice(0, 30);
}

function formatValue(value: number | null | undefined, digits = 2) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: digits }) : '—';
}

function formatTime(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function safeFilePart(value: string) {
  return value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'run';
}

function download(name: string, type: string, content: string) {
  const href = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(href);
}

function escapeHtml(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}

function exportJson(run: RunStatus) {
  const label = safeFilePart(run.testId || 'run');
  download(`sfm-performance-${label}.json`, 'application/json', JSON.stringify(run, null, 2));
}

function exportHtml(run: RunStatus) {
  const metrics = run.metrics || EMPTY_METRICS;
  const rows = [
    ['Status', run.status], ['Test ID', run.testId], ['Scenario', run.scenario], ['Mode', run.mode],
    ['Target', run.target], ['Target API URL', run.targetApiUrl], ['Started', run.startedAt], ['Finished', run.finishedAt],
    ['Requested RPS', run.requestsPerSecond], ['Effective VUs', run.effectiveVUs], ['Duration (seconds)', run.durationSeconds],
    ['Throughput (requests/s)', metrics.throughputRps], ['Average latency (ms)', metrics.averageLatencyMs],
    ['P95 latency (ms)', metrics.p95LatencyMs], ['HTTP error rate (%)', metrics.errorRatePercent],
    ['Completed requests', metrics.completedRequests], ['Dropped iterations', run.droppedIterations], ['Exit code', run.exitCode],
  ];
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>SFM Performance Lab report</title><style>body{font:15px system-ui,sans-serif;max-width:900px;margin:40px auto;padding:0 20px;color:#172033}h1{color:#146e66}table{width:100%;border-collapse:collapse}td{padding:10px;border-bottom:1px solid #dbe2ea}td:first-child{font-weight:600;width:35%}pre{white-space:pre-wrap;background:#f3f6f8;padding:16px;border-radius:8px}</style><h1>SFM Performance Lab</h1><p>Generated ${escapeHtml(new Date().toISOString())}</p><table>${rows.map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value ?? '—')}</td></tr>`).join('')}</table><h2>k6 diagnostics</h2><pre>${escapeHtml(run.diagnostics?.stdout || '')}</pre></html>`;
  download(`sfm-performance-${safeFilePart(run.testId || 'run')}.html`, 'text/html', html);
}

type TrendDefinition = { title: string; unit: string; value: (run: RunStatus) => number | null };

const trendDefinitions: TrendDefinition[] = [
  { title: 'RPS · Requests per second', unit: 'req/s', value: (item) => item.metrics?.throughputRps ?? null },
  { title: 'P95 latency', unit: 'ms', value: (item) => item.metrics?.p95LatencyMs ?? null },
  { title: 'HTTP error rate', unit: '%', value: (item) => item.metrics?.errorRatePercent ?? null },
  { title: 'Effective VUs', unit: 'VUs', value: (item) => item.effectiveVUs ?? item.vus ?? null },
];

export function App() {
  const [config, setConfig] = useState<DashboardConfig | null>(null);
  const [run, setRun] = useState<RunStatus | null>(null);
  const [history, setHistory] = useState<RunStatus[]>(loadHistory);
  const [scenario, setScenario] = useState('smoke');
  const [mode, setMode] = useState<Mode>('concurrent_users');
  const [target, setTarget] = useState('ping');
  const [targetUrl, setTargetUrl] = useState('');
  const [vus, setVus] = useState('1');
  const [requestsPerSecond, setRequestsPerSecond] = useState('20');
  const [duration, setDuration] = useState('30');
  const [busy, setBusy] = useState<'start' | 'stop' | null>(null);
  const [message, setMessage] = useState('');

  const refresh = useCallback(async () => {
    try {
      const latest = await api<RunStatus>('/api/status');
      setRun(latest);
      setHistory((previous) => {
        const next = upsertHistory(previous, latest);
        if (next !== previous) saveHistory(next);
        return next;
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not reach the local Runner');
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    api<DashboardConfig>('/api/config').then((value) => {
      if (!mounted) return;
      setConfig(value);
      setTargetUrl(value.defaultTargetUrl);
      const preset = value.scenarios.smoke;
      if (preset) { setVus(String(preset.vus)); setDuration(String(preset.durationSeconds)); }
    }).catch((error: unknown) => setMessage(error instanceof Error ? error.message : 'Dashboard setup failed'));
    void refresh();
    return () => { mounted = false; };
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => { void refresh(); }, run?.running ? 1000 : 4000);
    return () => window.clearInterval(timer);
  }, [refresh, run?.running]);

  const selectedPreset = config?.scenarios[scenario];
  const isRunning = Boolean(run?.running);
  const metrics = run?.metrics || EMPTY_METRICS;
  const statusClass = useMemo(() => `status-pill status-${run?.status || 'idle'}`, [run?.status]);
  const progressStart = run?.startedAt ? Date.parse(run.startedAt) : NaN;
  const progressEnd = run?.running ? Date.now() : run?.finishedAt ? Date.parse(run.finishedAt) : NaN;
  const hasProgress = Number.isFinite(progressStart) && Number.isFinite(progressEnd)
    && Number.isInteger(run?.durationSeconds) && (run?.durationSeconds ?? 0) > 0;
  const elapsedSeconds = hasProgress ? Math.max(0, Math.floor((progressEnd - progressStart) / 1000)) : 0;
  const progressPercent = hasProgress
    ? Math.min(100, Math.max(0, (elapsedSeconds / (run!.durationSeconds!)) * 100))
    : 0;
  const chartRuns = useMemo(() => {
    const byId = new Map(history.filter((item) => item.testId).map((item) => [item.testId!, item]));
    if (run?.testId && run.status !== 'idle') byId.set(run.testId, run);
    return [...byId.values()].sort((left, right) => Date.parse(left.startedAt || '') - Date.parse(right.startedAt || ''));
  }, [history, run]);

  function changeScenario(value: string) {
    setScenario(value);
    const preset = config?.scenarios[value];
    if (preset) { setVus(String(preset.vus)); setDuration(String(preset.durationSeconds)); }
  }

  async function startTest(event: FormEvent) {
    event.preventDefault();
    if (!config || busy || isRunning) return;
    setBusy('start'); setMessage('');
    const body: Record<string, unknown> = {
      scenario, target, mode, durationSeconds: Number(duration), baseUrl: targetUrl.trim(),
    };
    if (mode === 'concurrent_users') body.vus = Number(vus);
    else body.requestsPerSecond = Number(requestsPerSecond);
    try {
      const started = await api<{ id: string }>('/api/start', { method: 'POST', body: JSON.stringify(body) });
      setMessage(`Started test ${started.id}`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not start the test');
    } finally { setBusy(null); }
  }

  async function stopTest() {
    if (busy || !isRunning) return;
    setBusy('stop'); setMessage('');
    try { await api('/api/stop', { method: 'POST', body: '{}' }); await refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not stop the test'); }
    finally { setBusy(null); }
  }

  if (!config) return <main className="loading"><span className="brand-mark">S</span><p>Connecting to the local k6 Runner…</p>{message && <p className="error-text">{message}</p>}</main>;

  return <main className="shell">
    <header className="topbar">
      <a className="brand" href="#top"><span className="brand-mark">S</span><span><b>SFM Performance Lab</b><small>Developer load testing</small></span></a>
      <div className="local-indicator"><span /> Local session</div>
    </header>

    <section className="hero" id="top">
      <div><div className="eyebrow">SFM · PERFORMANCE ENGINEERING</div><h1>Run a controlled load test.</h1><p>Start k6 locally, observe the actual run summary, and export a report for review.</p></div>
      <div className="hero-mark">k6<span>↗</span></div>
    </section>

    {message && <div className="notice" role="status">{message}<button onClick={() => setMessage('')} aria-label="Dismiss">×</button></div>}

    <section className="workspace">
      <form className="panel setup-panel" onSubmit={startTest}>
        <div className="panel-heading"><div><div className="eyebrow">TEST CONFIGURATION</div><h2>Configure a run</h2></div><span className="step-label">01 / SETUP</span></div>

        <label className="field-label" htmlFor="target-url">Target API base URL</label>
        <input id="target-url" className="text-input" list="allowed-target-urls" value={targetUrl} onChange={(event) => setTargetUrl(event.target.value)} placeholder="http://sfm-backend:8080" required />
        <datalist id="allowed-target-urls">{config.targetUrls.map((url) => <option value={url} key={url} />)}</datalist>
        <p className="field-help">Only configured local or staging origins are accepted. Target paths remain fixed to the selected API.</p>

        <div className="field-grid">
          <div><label className="field-label" htmlFor="scenario">Scenario</label><select id="scenario" className="text-input" value={scenario} onChange={(event) => changeScenario(event.target.value)}>{Object.keys(config.scenarios).map((name) => <option value={name} key={name}>{name}</option>)}</select></div>
          <div><label className="field-label" htmlFor="target">API target</label><select id="target" className="text-input" value={target} onChange={(event) => setTarget(event.target.value)}>{config.targets.map((name) => <option value={name} key={name}>{name}</option>)}</select></div>
        </div>

        <fieldset className="mode-switch"><legend className="field-label">Load model</legend><label className={mode === 'concurrent_users' ? 'mode-option selected' : 'mode-option'}><input type="radio" name="mode" checked={mode === 'concurrent_users'} onChange={() => setMode('concurrent_users')} /><span><b>Concurrent users</b><small>Fixed VUs over time</small></span></label><label className={mode === 'request_rate' ? 'mode-option selected' : 'mode-option'}><input type="radio" name="mode" checked={mode === 'request_rate'} onChange={() => setMode('request_rate')} /><span><b>Request rate</b><small>Arrival rate target</small></span></label></fieldset>

        <div className="field-grid">
          {mode === 'concurrent_users' ? <div><label className="field-label" htmlFor="vus">Virtual users</label><input id="vus" className="text-input" type="number" min="1" max={config.maxVus} step="1" value={vus} onChange={(event) => setVus(event.target.value)} required /></div> : <div><label className="field-label" htmlFor="rps">Requests per second</label><input id="rps" className="text-input" type="number" min="1" max={config.maxRequestsPerSecond} step="1" value={requestsPerSecond} onChange={(event) => setRequestsPerSecond(event.target.value)} required /><small className="field-help">Maximum configured: {config.maxRequestsPerSecond} RPS; achieved rate may be lower.</small></div>}
          <div><label className="field-label" htmlFor="duration">Duration (seconds)</label><input id="duration" className="text-input" type="number" min={config.minDurationSeconds} max={config.maxDurationSeconds} step="1" value={duration} onChange={(event) => setDuration(event.target.value)} required /></div>
        </div>
        {mode === 'concurrent_users' && selectedPreset && <p className="preset-note">Preset {scenario}: {selectedPreset.vus} VUs · {selectedPreset.durationSeconds}s. Adjust values for this run.</p>}

        <div className="form-actions"><button className="primary-button" type="submit" disabled={isRunning || busy !== null}>{busy === 'start' ? 'Starting…' : '▶  Start test'}</button><button className="secondary-button" type="button" onClick={stopTest} disabled={!isRunning || busy !== null}>{busy === 'stop' ? 'Stopping…' : '■  Stop'}</button></div>
        <p className="security-note"><span>●</span> Local-only dashboard · fixed k6 script · no command or Docker access</p>
      </form>

      <section className="panel results-panel">
        <div className="panel-heading"><div><div className="eyebrow">LIVE RESULT</div><h2>Run overview</h2></div><span className={statusClass}>{run?.status || 'idle'}</span></div>
        {run?.testId ? <><div className="run-meta"><div><span>Test ID</span><code>{run.testId}</code></div><div><span>Scenario · mode</span><b>{run.scenario} · {run.mode}</b></div><div><span>Started</span><b>{formatTime(run.startedAt)}</b></div></div>
          {hasProgress && run.durationSeconds ? <div className="execution-progress">
            <div className="progress-heading"><b>Test progress</b><span>{Math.round(progressPercent)}%</span></div>
            <div className="progress-track" role="progressbar" aria-label="Elapsed test duration" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progressPercent)}>
              <div className={`progress-fill${run.status === 'failed' ? ' progress-failed' : ''}`} style={{ width: `${progressPercent}%` }} />
            </div>
            <small>{elapsedSeconds} / {run.durationSeconds} seconds. {run.running
              ? (progressPercent >= 100 ? 'Configured duration reached; waiting for Runner to confirm the result.' : 'Progress shows elapsed time; Runner status confirms completion.')
              : `${run.status === 'completed' ? 'Completed' : run.status === 'stopped' ? 'Stopped' : run.status === 'failed' ? 'Failed' : 'Finished'} · ${formatTime(run.finishedAt)}`}</small>
          </div> : null}
          <div className="metric-grid">
            <Metric label="Throughput" value={formatValue(metrics.throughputRps, 3)} unit="req/s" accent />
            <Metric label="Average latency" value={formatValue(metrics.averageLatencyMs, 2)} unit="ms" />
            <Metric label="P95 latency" value={formatValue(metrics.p95LatencyMs, 2)} unit="ms" />
            <Metric label="HTTP error rate" value={formatValue(metrics.errorRatePercent, 2)} unit="%" />
            <Metric label="Completed requests" value={formatValue(metrics.completedRequests, 0)} unit="requests" />
            <Metric label="Dropped iterations" value={formatValue(run.droppedIterations, 0)} unit="iterations" />
          </div>
          <div className="result-footer"><span>{run.running ? (run.stopping ? 'Stopping k6 process…' : `Running ${run.effectiveVUs ?? run.vus ?? '—'} VUs for ${run.durationSeconds ?? '—'}s`) : `Finished ${formatTime(run.finishedAt)} · exit ${run.exitCode ?? '—'}`}</span><div className="export-actions"><button className="text-button" onClick={() => exportJson(run)}>Export JSON</button><button className="text-button" onClick={() => exportHtml(run)}>Export HTML</button></div></div>
          <details className="diagnostics"><summary>k6 summary and diagnostics</summary><pre>{run.diagnostics?.stdout || 'The k6 summary appears when the run completes.'}{run.diagnostics?.stderr ? `\n${run.diagnostics.stderr}` : ''}</pre></details>
        </> : <div className="empty-state"><div className="empty-icon">↗</div><h3>No test results yet</h3><p>Configure a local or staging target and start a run. Metrics will appear here from k6's actual summary.</p></div>}
      </section>
    </section>

    <section className="panel trends-panel" aria-labelledby="trends-title">
      <div className="panel-heading"><div><div className="eyebrow">SAVED RUN SUMMARIES</div><h2 id="trends-title">Performance trends</h2></div><span className="step-label">{chartRuns.length} RUNS</span></div>
      <p className="chart-caption">Each point is the final k6 summary for one run. Metrics appear after the run completes; this view does not show per-second samples.</p>
      <div className="trend-grid">{trendDefinitions.map((definition) => <RunTrendChart key={definition.title} definition={definition} runs={chartRuns} />)}</div>
    </section>

    <section className="panel history-panel">
      <div className="panel-heading"><div><div className="eyebrow">LOCAL BROWSER HISTORY</div><h2>Recent runs</h2></div><span className="step-label">{history.length} SAVED</span></div>
      {history.length ? <div className="history-list">{history.map((item) => <div className="history-row" key={item.testId}><div className="history-status"><span className={`status-dot dot-${item.status}`} /><div><b>{item.scenario} · {item.mode}</b><small>{formatTime(item.startedAt)} · {item.target} · {item.testId}</small></div></div><div className="history-metrics"><b>{formatValue(item.metrics?.throughputRps, 2)}<small> req/s</small></b><b>{formatValue(item.metrics?.p95LatencyMs, 2)}<small> ms P95</small></b><b>{formatValue(item.metrics?.errorRatePercent, 2)}<small> % errors</small></b></div><div className="export-actions"><button className="text-button" onClick={() => exportJson(item)}>JSON</button><button className="text-button" onClick={() => exportHtml(item)}>HTML</button></div></div>)}</div> : <p className="history-empty">Completed and stopped runs are saved in this browser only.</p>}
      {history.length > 0 && <button className="clear-history" onClick={() => { setHistory([]); saveHistory([]); }}>Clear browser history</button>}
    </section>
    <footer className="footer"><span>SFM Performance Lab</span><span>k6 test execution remains separate from SFM Admin, Prometheus, and Grafana.</span></footer>
  </main>;
}

function Metric({ label, value, unit, accent = false }: { label: string; value: string; unit: string; accent?: boolean }) {
  return <div className={accent ? 'metric-card metric-accent' : 'metric-card'}><span>{label}</span><div><b>{value}</b><small>{unit}</small></div></div>;
}

function RunTrendChart({ definition, runs }: { definition: TrendDefinition; runs: RunStatus[] }) {
  const points = runs.flatMap((item) => {
    const value = definition.value(item);
    const timestamp = Date.parse(item.startedAt || '');
    return value !== null && Number.isFinite(value) && Number.isFinite(timestamp) ? [{ item, value, timestamp }] : [];
  });
  const width = 640;
  const height = 210;
  const left = 48;
  const right = width - 18;
  const top = 18;
  const bottom = 158;
  const minValue = Math.min(0, ...points.map((point) => point.value));
  const maxValue = Math.max(1, ...points.map((point) => point.value)) * 1.12;
  const x = (index: number) => points.length < 2 ? (left + right) / 2 : left + index * (right - left) / (points.length - 1);
  const y = (value: number) => bottom - ((value - minValue) / (maxValue - minValue || 1)) * (bottom - top);
  const line = points.map((point, index) => `${index ? 'L' : 'M'} ${x(index)} ${y(point.value)}`).join(' ');
  const labelIndexes = points.length <= 4 ? points.map((_, index) => index) : [0, Math.round((points.length - 1) / 2), points.length - 1];

  return <article className="trend-card">
    <h3>{definition.title} <small>({definition.unit})</small></h3>
    {points.length ? <svg className="trend-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${definition.title} across saved test runs`}>
      {[0, 0.5, 1].map((ratio) => {
        const gridY = top + ratio * (bottom - top);
        const value = maxValue - ratio * (maxValue - minValue);
        return <g key={ratio}><line x1={left} x2={right} y1={gridY} y2={gridY} className="chart-gridline"/><text x={left - 8} y={gridY + 4} textAnchor="end" className="chart-axis-label">{formatValue(value, 3)}</text></g>;
      })}
      {points.length > 1 && <path d={line} className="chart-line" />}
      {points.map((point, index) => <circle key={point.item.testId} cx={x(index)} cy={y(point.value)} r="4" className="chart-point"><title>{`${formatTime(point.item.startedAt)} · ${formatValue(point.value, 3)} ${definition.unit} · ${point.item.scenario} · ${point.item.testId}`}</title></circle>)}
      {labelIndexes.map((index) => <text key={index} x={x(index)} y={bottom + 23} textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'} className="chart-axis-label">{new Date(points[index].timestamp).toLocaleDateString()}</text>)}
    </svg> : <div className="chart-empty">Run a test to add a data point.</div>}
    <div className="chart-footnote">{points.length} {points.length === 1 ? 'run' : 'runs'} · latest saved k6 summaries</div>
  </article>;
}
