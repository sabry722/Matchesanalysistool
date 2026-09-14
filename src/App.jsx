import React, { useEffect, useMemo, useRef, useState } from 'react';
import { analyze, lastDigit, normalizeDigits, walkForwardBacktest } from './engine/matchesEngine.js';

const API_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';
const MIN_TICKS = 100;
const WARMUP_TICKS = 400;
const BACKTEST_TICKS = 1500;
const BENCHMARK_TICKS = 1500;
const MAX_BENCHMARK_MARKETS = 12;
const MIN_CALIBRATION_SAMPLES = 20;
const TICK_STALE_MS = 12000;
const UI_TICK_FLUSH_MS = 25;

function normalizeActiveSymbol(item) {
  const symbol = item?.underlying_symbol ?? item?.symbol;
  const displayName = item?.underlying_symbol_name ?? item?.display_name ?? symbol;
  if (!symbol || !displayName) return null;
  const type = item?.underlying_symbol_type ?? item?.symbol_type ?? '';
  const market = item?.market ?? '';
  const submarket = item?.submarket ?? item?.subgroup ?? '';
  const synthetic = /synthetic|volatility|crash|boom|jump|step|range\s*break|drift|daily\s*reset/i.test(`${displayName} ${type} ${market} ${submarket}`);
  return { symbol, displayName, pipSize: item?.pip_size ?? item?.pip ?? null, market, submarket, type, synthetic };
}

function contractTypes(message) {
  const available = message?.contracts_for?.available;
  if (!Array.isArray(available)) return [];
  return available.map(item => String(item?.contract_type ?? '').toUpperCase()).filter(Boolean);
}

function supportsMatches(message) {
  return contractTypes(message).some(type => type === 'DIGITMATCH' || type === 'MATCHDIGIT' || type.includes('DIGITMATCH'));
}

function benchmarkRank(results) {
  return [...results].filter(row => !row.error && row.validated).sort((a, b) => {
    const score = row => row.validated.edge * 2 + Math.min(row.validated.signals, 100) * 0.05 - (row.validated.brier ?? 1) * 10 - row.validated.maxLosingStreak * 0.12;
    return score(b) - score(a);
  });
}

export default function App() {
  const [symbols, setSymbols] = useState([]);
  const [symbol, setSymbol] = useState('');
  const [ticks, setTicks] = useState([]);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState('Connecting to Deriv…');
  const [error, setError] = useState('');
  const [predictions, setPredictions] = useState([]);
  const [serverPipSize, setServerPipSize] = useState(null);
  const [eligible, setEligible] = useState(null);
  const [eligibilityText, setEligibilityText] = useState('Waiting for live symbol discovery…');
  const [backtestState, setBacktestState] = useState({ loading: false, result: null, error: '' });
  const [benchmark, setBenchmark] = useState({ loading: false, results: [], error: '', completed: 0, total: 0 });
  const [lastTickAt, setLastTickAt] = useState(null);
  const [streamSymbol, setStreamSymbol] = useState('');

  const ws = useRef(null);
  const requestId = useRef(100);
  const pending = useRef(null);
  const benchmarkRef = useRef(null);
  const activeSymbolReady = useRef(false);
  const reconnectTimer = useRef(null);
  const heartbeatTimer = useRef(null);
  const mounted = useRef(true);
  const selectedSymbolRef = useRef('');
  const marketMapRef = useRef(new Map());
  const tickBufferRef = useRef([]);
  const lastTickAtRef = useRef(null);
  const tickFlushTimer = useRef(null);
  const warmupReqIdRef = useRef(null);
  const backtestReqIdRef = useRef(null);
  const streamSymbolRef = useRef('');

  const calibration = backtestState.result?.calibration || null;
  const selectedMarket = symbols.find(item => item.symbol === symbol);

  useEffect(() => { selectedSymbolRef.current = symbol; }, [symbol]);

  const send = payload => {
    if (ws.current?.readyState !== WebSocket.OPEN) return false;
    try { ws.current.send(JSON.stringify(payload)); return true; } catch { return false; }
  };

  function flushTickBuffer() {
    tickFlushTimer.current = null;
    if (!mounted.current) return;
    setTicks([...tickBufferRef.current]);
    setLastTickAt(lastTickAtRef.current);
  }

  function scheduleTickFlush() {
    if (tickFlushTimer.current == null) tickFlushTimer.current = window.setTimeout(flushTickBuffer, UI_TICK_FLUSH_MS);
  }

  function resetTickBuffer() {
    tickBufferRef.current.length = 0;
    lastTickAtRef.current = null;
    if (tickFlushTimer.current != null) { clearTimeout(tickFlushTimer.current); tickFlushTimer.current = null; }
    setTicks([]);
    setLastTickAt(null);
  }

  function pushLiveTick(digit, incomingSymbol) {
    tickBufferRef.current.push(digit);
    if (tickBufferRef.current.length > 3000) tickBufferRef.current.splice(0, tickBufferRef.current.length - 3000);
    lastTickAtRef.current = Date.now();
    const nextStream = incomingSymbol || selectedSymbolRef.current;
    if (nextStream && nextStream !== streamSymbolRef.current) {
      streamSymbolRef.current = nextStream;
      setStreamSymbol(nextStream);
    }
    scheduleTickFlush();
  }

  function finishBenchmarkItem(payload) {
    const state = benchmarkRef.current;
    if (!state) return;
    const current = state.currentSymbol;
    const name = state.names[current] || current;
    const row = payload.result ? { symbol: current, name, ...payload.result } : { symbol: current, name, error: payload.error || 'Unknown benchmark error' };
    state.results = [...state.results, row];
    state.index += 1;
    setBenchmark({ loading: state.index < state.queue.length, results: benchmarkRank(state.results), error: '', completed: state.index, total: state.queue.length });
    if (state.index >= state.queue.length) { benchmarkRef.current = null; return; }
    const next = state.queue[state.index];
    state.currentSymbol = next;
    state.contractReqId = requestId.current++;
    send({ contracts_for: next, req_id: state.contractReqId });
  }

  function requestBenchmarkHistory(nextSymbol) {
    const state = benchmarkRef.current;
    if (!state || ws.current?.readyState !== WebSocket.OPEN) { finishBenchmarkItem({ error: 'Deriv WebSocket disconnected.' }); return; }
    const reqId = requestId.current++;
    state.reqId = reqId;
    state.currentSymbol = nextSymbol;
    send({ ticks_history: nextSymbol, end: 'latest', count: BENCHMARK_TICKS, style: 'ticks', subscribe: 0, req_id: reqId });
  }

  function processHistory(message) {
    const pip = Number.isFinite(Number(message?.pip_size)) ? Number(message.pip_size) : null;
    const prices = Array.isArray(message?.history?.prices) ? normalizeDigits(message.history.prices.map(quote => lastDigit(quote, pip))) : [];

    if (benchmarkRef.current?.reqId === message?.req_id) {
      if (prices.length >= MIN_TICKS + 1) finishBenchmarkItem({ result: walkForwardBacktest(prices) });
      else finishBenchmarkItem({ error: `Only ${prices.length} valid historical ticks returned.` });
      return;
    }

    if (backtestReqIdRef.current === message?.req_id) {
      backtestReqIdRef.current = null;
      if (prices.length >= MIN_TICKS + 1) setBacktestState({ loading: false, error: '', result: walkForwardBacktest(prices) });
      else setBacktestState({ loading: false, result: null, error: `Deriv returned only ${prices.length} usable historical ticks.` });
      return;
    }

    if (warmupReqIdRef.current !== message?.req_id) return;
    warmupReqIdRef.current = null;
    if (prices.length >= MIN_TICKS + 1) {
      const liveTail = tickBufferRef.current.slice(-25);
      tickBufferRef.current = [...prices.slice(-2999), ...liveTail].slice(-3000);
      setTicks([...tickBufferRef.current]);
      if (pip != null) setServerPipSize(pip);
      setBacktestState({ loading: false, result: null, error: '' });
      setStatus(`LIVE STREAM ACTIVE — ${prices.length} history ticks loaded`);
    } else {
      setBacktestState({ loading: false, result: null, error: `Deriv returned only ${prices.length} usable historical ticks.` });
      setStatus('LIVE STREAM ACTIVE — warming model');
    }
  }

  function handleMessage(message) {
    if (message?.error) {
      const text = message.error.message || 'Deriv API error.';
      if (benchmarkRef.current?.reqId === message.req_id || benchmarkRef.current?.contractReqId === message.req_id) finishBenchmarkItem({ error: text });
      else if (warmupReqIdRef.current === message.req_id) {
        warmupReqIdRef.current = null;
        setBacktestState({ loading: false, result: null, error: text });
        setStatus('LIVE STREAM ACTIVE — history preload unavailable');
      } else if (backtestReqIdRef.current === message.req_id) {
        backtestReqIdRef.current = null;
        setBacktestState({ loading: false, result: null, error: text });
      } else { setError(text); setStatus('Deriv feed error'); }
      return;
    }

    if (message?.msg_type === 'active_symbols') {
      const discovered = (message.active_symbols || []).map(normalizeActiveSymbol).filter(Boolean);
      const synthetic = discovered.filter(item => item.synthetic);
      const usable = (synthetic.length ? synthetic : discovered).sort((a, b) => a.displayName.localeCompare(b.displayName));
      marketMapRef.current = new Map(usable.map(item => [item.symbol, item]));
      activeSymbolReady.current = usable.length > 0;
      setSymbols(usable);
      setError('');
      setStatus(usable.length ? 'Live market data ready' : 'Connected, but Deriv returned no active markets');
      if (!usable.some(item => item.symbol === selectedSymbolRef.current)) setSymbol(usable[0]?.symbol || '');
      return;
    }

    if (message?.msg_type === 'contracts_for') {
      const match = supportsMatches(message);
      if (benchmarkRef.current?.contractReqId === message.req_id) {
        if (match) requestBenchmarkHistory(benchmarkRef.current.currentSymbol);
        else finishBenchmarkItem({ error: 'Matches contract not available for this market.' });
      } else {
        setEligible(match);
        setEligibilityText(match ? 'Matches contract available from Deriv' : 'Matches contract not offered for this market');
      }
      return;
    }

    if (message?.msg_type === 'tick' && message.tick?.quote != null) {
      const incomingSymbol = message.tick.symbol || message.echo_req?.ticks || '';
      const currentSymbol = selectedSymbolRef.current;
      if (!currentSymbol || (incomingSymbol && incomingSymbol !== currentSymbol)) return;
      const market = marketMapRef.current.get(currentSymbol);
      const rawPip = message.tick.pip_size ?? market?.pipSize ?? null;
      const pip = Number.isInteger(rawPip) ? rawPip : null;
      const digit = lastDigit(message.tick.quote, pip);
      if (digit == null) return;
      if (pip != null) setServerPipSize(previous => previous === pip ? previous : pip);
      pushLiveTick(digit, incomingSymbol || currentSymbol);
      return;
    }

    if (message?.msg_type === 'history') processHistory(message);
  }

  useEffect(() => {
    mounted.current = true;
    const connect = () => {
      if (!mounted.current || (ws.current && ws.current.readyState <= WebSocket.OPEN)) return;
      setStatus('Connecting to Deriv live feed…');
      const socket = new WebSocket(API_URL);
      ws.current = socket;
      socket.onopen = () => {
        if (!mounted.current) return;
        setConnected(true);
        setStatus('Connected to Deriv — requesting active markets…');
        setError('');
        activeSymbolReady.current = false;
        send({ active_symbols: 'brief', req_id: requestId.current++ });
      };
      socket.onmessage = event => { try { handleMessage(JSON.parse(event.data)); } catch { setError('Received an unreadable response from Deriv.'); } };
      socket.onerror = () => { if (mounted.current) { setConnected(false); setStatus('Deriv WebSocket error — retrying…'); } };
      socket.onclose = () => {
        if (!mounted.current) return;
        setConnected(false);
        activeSymbolReady.current = false;
        setStatus('Disconnected — reconnecting to Deriv…');
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = setTimeout(connect, 1500);
      };
    };
    connect();
    heartbeatTimer.current = setInterval(() => send({ ping: 1, req_id: requestId.current++ }), 25000);
    return () => {
      mounted.current = false;
      clearTimeout(reconnectTimer.current);
      clearInterval(heartbeatTimer.current);
      if (tickFlushTimer.current != null) clearTimeout(tickFlushTimer.current);
      if (ws.current) { try { ws.current.close(); } catch {} ws.current = null; }
    };
  }, []);

  useEffect(() => {
    if (!connected || !activeSymbolReady.current || !symbol) return;
    warmupReqIdRef.current = null;
    backtestReqIdRef.current = null;
    resetTickBuffer();
    setPredictions([]);
    streamSymbolRef.current = '';
    setStreamSymbol('');
    setServerPipSize(selectedMarket?.pipSize ?? null);
    setEligible(null);
    setEligibilityText('Checking Matches support…');
    setBacktestState({ loading: true, result: null, error: '' });
    pending.current = null;

    // Start the live stream BEFORE requesting history/contracts. The UI should never wait for warm-up.
    send({ forget_all: 'ticks', req_id: requestId.current++ });
    const tickReqId = requestId.current++;
    if (!send({ ticks: symbol, subscribe: 1, req_id: tickReqId })) {
      setError('Could not start the Deriv tick subscription.');
      return;
    }
    const warmupReqId = requestId.current++;
    warmupReqIdRef.current = warmupReqId;
    send({ ticks_history: symbol, end: 'latest', count: WARMUP_TICKS, style: 'ticks', subscribe: 0, req_id: warmupReqId });
    send({ contracts_for: symbol, req_id: requestId.current++ });
    setStatus('LIVE STREAM STARTING — receiving real Deriv ticks');
  }, [connected, symbol]);

  useEffect(() => {
    if (!lastTickAt) return;
    const timer = setInterval(() => {
      if (lastTickAtRef.current && Date.now() - lastTickAtRef.current > TICK_STALE_MS) setStatus('Connected, but tick stream is stale');
    }, 2000);
    return () => clearInterval(timer);
  }, [lastTickAt]);

  const analysis = useMemo(() => analyze(ticks, calibration), [ticks, calibration]);
  const counts = useMemo(() => { const recent = ticks.slice(-100); return Array.from({ length: 10 }, (_, digit) => recent.filter(value => value === digit).length); }, [ticks]);
  const maxCount = Math.max(1, ...counts);

  useEffect(() => {
    if (!ticks.length) return;
    if (pending.current && ticks.length > pending.current.tickCount) {
      const outcome = ticks.at(-1) === pending.current.digit ? 'WIN' : 'LOSS';
      setPredictions(previous => [{ ...pending.current, result: outcome, at: new Date().toLocaleTimeString() }, ...previous].slice(0, 100));
      pending.current = null;
    }
    if (analysis.signal && analysis.digit != null && !pending.current) pending.current = { tickCount: ticks.length, digit: analysis.digit, confidence: analysis.confidence, probability: analysis.probability, calibrated: analysis.calibrated };
  }, [ticks, analysis]);

  function runBacktest() {
    if (ws.current?.readyState !== WebSocket.OPEN || !symbol) { setBacktestState({ loading: false, result: null, error: 'Connect to Deriv and select a market first.' }); return; }
    setBacktestState({ loading: true, result: null, error: '' });
    const reqId = requestId.current++;
    backtestReqIdRef.current = reqId;
    send({ ticks_history: symbol, end: 'latest', count: BACKTEST_TICKS, style: 'ticks', subscribe: 0, req_id: reqId });
  }

  function runBenchmark() {
    if (ws.current?.readyState !== WebSocket.OPEN || !symbols.length) { setBenchmark(previous => ({ ...previous, error: 'Deriv live connection is not ready.' })); return; }
    const candidates = symbols.slice(0, MAX_BENCHMARK_MARKETS);
    const names = Object.fromEntries(candidates.map(item => [item.symbol, item.displayName]));
    const queue = candidates.map(item => item.symbol);
    benchmarkRef.current = { queue, names, index: 0, results: [], currentSymbol: queue[0], contractReqId: requestId.current++ };
    setBenchmark({ loading: true, results: [], error: '', completed: 0, total: queue.length });
    send({ contracts_for: queue[0], req_id: benchmarkRef.current.contractReqId });
  }

  const wins = predictions.filter(item => item.result === 'WIN').length;
  const losses = predictions.filter(item => item.result === 'LOSS').length;
  const settled = wins + losses;
  const liveHitRate = settled ? (wins / settled * 100).toFixed(1) : '—';
  const selectedName = selectedMarket?.displayName || (symbol ? symbol : 'Waiting for Deriv symbols…');
  const tickAge = lastTickAt ? Math.max(0, Math.round((Date.now() - lastTickAt) / 1000)) : null;
  const validated = backtestState.result?.validated;
  const validationReady = Boolean(validated && validated.signals >= 20 && validated.edge > 0);
  const best = benchmark.results[0];
  const bestReady = Boolean(best && best.validated?.signals >= 20 && best.validated?.edge > 0);

  return <div className="app">
    <header><div><span className="eyebrow">DERIV • MATCHES ANALYSIS</span><h1>Matches Analysis <b>PRO</b></h1><p>Live digit analysis using real Deriv ticks, instant historical warm-up, multi-window scoring, walk-forward validation and calibration.</p></div><div className={connected && lastTickAt && tickAge <= 12 ? 'status live' : 'status'}><i/> {connected && lastTickAt && tickAge <= 12 ? 'LIVE' : connected ? 'CONNECTED' : 'OFFLINE'}</div></header>
    <main>
      <section className="controls card"><label>Market<select value={symbol} onChange={event => setSymbol(event.target.value)} disabled={!symbols.length}>{!symbols.length && <option value="">Waiting for active Deriv markets…</option>}{symbols.map(item => <option key={item.symbol} value={item.symbol}>{item.displayName}</option>)}</select></label><div className={`metric ${eligible === true ? 'ok' : eligible === false ? 'bad' : ''}`}><span>Matches</span><strong>{eligible === true ? 'ELIGIBLE' : eligible === false ? 'NOT AVAILABLE' : '…'}</strong></div><div className="metric"><span>Ticks</span><strong>{ticks.length}</strong></div><div className="metric"><span>Live hit</span><strong>{liveHitRate}{settled ? '%' : ''}</strong></div></section>
      <section className="card eligibility"><div><b>{status}</b><small>{selectedName} • pip size {serverPipSize ?? 'auto'} • {streamSymbol ? `stream: ${streamSymbol}` : 'waiting for tick stream'}</small></div><span className={lastTickAt && tickAge <= 12 ? 'badge ok' : connected ? 'badge' : 'badge bad'}>{lastTickAt && tickAge <= 12 ? `REAL DERIV TICKS${tickAge === 0 ? '' : ` • ${tickAge}s ago`}` : connected ? 'WAITING FOR TICKS' : 'OFFLINE'}</span></section>
      {error && <div className="card error">{error}</div>}
      <section className="card eligibility"><div><b>{eligibilityText}</b><small>{symbols.length} active Deriv market{symbols.length === 1 ? '' : 's'} discovered dynamically • fast history warm-up {WARMUP_TICKS} ticks • no hard-coded synthetic symbol is assumed valid</small></div><span className={eligible === true ? 'badge ok' : eligible === false ? 'badge bad' : 'badge'}>{eligible === true ? 'CONTRACT READY' : eligible === false ? 'NOT OFFERED' : 'VERIFYING'}</span></section>
      <section className="hero card"><div><span className="eyebrow">NEXT MATCH CANDIDATE</span>{analysis.signal ? <div className="big-digit">{analysis.digit}</div> : <div className="no-signal">NO SIGNAL</div>}<p>{analysis.reason}. Estimated probability: <strong>{Number(analysis.probability || 10).toFixed(1)}%</strong> • Confidence: <strong>{Number(analysis.confidence || 0).toFixed(1)}%</strong></p><small>{analysis.calibrated ? `Calibrated from ${analysis.calibrationSamples} validation samples` : 'Calibration pending • model is statistical, not guaranteed'}</small></div><div className="hero-side"><span>Model state</span><strong>{ticks.length < MIN_TICKS ? 'WARMING UP' : analysis.signal ? 'QUALIFIED' : 'WAITING'}</strong><small>{Math.max(0, MIN_TICKS - ticks.length)} observations until full warm-up</small></div></section>
      <section className="grid"><div className="card"><div className="section-title"><h2>Digit distribution</h2><span>Last {Math.min(100, ticks.length)}</span></div><div className="digits">{counts.map((count, digit) => <div className="digit-row" key={digit}><b>{digit}</b><div className="bar"><i style={{ width: `${count / maxCount * 100}%` }}/></div><span>{count}</span></div>)}</div></div><div className="card"><div className="section-title"><h2>Live audit</h2><span>{predictions.length} settled</span></div><div className="audit">{predictions.length ? predictions.slice(0, 10).map((item, index) => <div className="audit-row" key={`${item.at}-${index}`}><b>{item.digit}</b><span>{item.confidence.toFixed(0)}%</span><span>{item.probability.toFixed(1)}%</span><strong className={item.result === 'WIN' ? 'win' : 'loss'}>{item.result}</strong></div>) : <p className="muted">No settled predictions yet.</p>}</div></div></section>
      <section className="card validation"><div className="section-title"><div><h2>Multi-market benchmark</h2><small>Ranks only markets actually returned by Deriv. No unavailable or hard-coded symbols are tested.</small></div><button onClick={runBenchmark} disabled={benchmark.loading || !symbols.length}>{benchmark.loading ? `SCANNING ${benchmark.completed}/${benchmark.total}` : 'SCAN BEST MARKET'}</button></div>{benchmark.error && <div className="error inline">{benchmark.error}</div>}{best && <div className={`validation-status ${bestReady ? 'ready' : 'hold'}`}><b>{bestReady ? 'BEST VALIDATED MARKET' : 'NO PROMOTED MARKET'}</b><span>{best.name} • {best.validated.hitRate.toFixed(1)}% hit • {best.validated.edge >= 0 ? '+' : ''}{best.validated.edge.toFixed(1)}% edge • {best.validated.signals} unseen signals</span></div>}<div className="calibration-table"><div className="cal-head"><span>Rank</span><span>Market</span><span>Hit</span><span>Edge</span></div>{benchmark.results.length ? benchmark.results.slice(0, 8).map((row, index) => <div className="cal-row" key={row.symbol}><span>#{index + 1}</span><span>{row.name}</span><span>{row.validated.hitRate.toFixed(1)}%</span><span>{row.validated.edge >= 0 ? '+' : ''}{row.validated.edge.toFixed(1)}%</span></div>) : <p className="muted">Run the benchmark to compare real active markets. A market is not promoted automatically without unseen validation.</p>}</div></section>
      <section className="card validation"><div className="section-title"><div><h2>Walk-forward validation</h2><small>Manual validation • next-tick causality • kept off the live tick path for maximum responsiveness</small></div><button onClick={runBacktest} disabled={backtestState.loading || !symbol}>{backtestState.loading ? 'RUNNING…' : 'RUN VALIDATION'}</button></div>{backtestState.error && <div className="error inline">{backtestState.error}</div>}{!backtestState.result && !backtestState.loading && <p className="muted">Run validation to measure whether the model has a real edge on the selected live Deriv market.</p>}{backtestState.result && validated && <><div className="validation-grid"><div><span>Validation hit</span><strong>{validated.hitRate.toFixed(1)}%</strong></div><div><span>Edge vs 10%</span><strong>{validated.edge >= 0 ? '+' : ''}{validated.edge.toFixed(1)}%</strong></div><div><span>Signals</span><strong>{validated.signals}</strong></div><div><span>Max loss streak</span><strong>{validated.maxLosingStreak}</strong></div><div><span>Avg predicted</span><strong>{validated.avgProbability.toFixed(1)}%</strong></div><div><span>Brier score</span><strong>{validated.brier == null ? '—' : validated.brier.toFixed(3)}</strong></div></div><div className={`validation-status ${validationReady ? 'ready' : 'hold'}`}><b>{validationReady ? 'CALIBRATION READY' : 'HOLD / MORE DATA'}</b><span>{validationReady ? 'Live signals may use empirical calibration.' : 'The app stays conservative until enough unseen samples confirm an edge.'}</span></div><div className="calibration-table"><div className="cal-head"><span>Confidence</span><span>Samples</span><span>Actual hit</span><span>Status</span></div>{backtestState.result.calibration.buckets.map((bucket, index) => <div className="cal-row" key={index}><span>{bucket.lo}–{bucket.hi}%</span><span>{bucket.count}</span><span>{bucket.count ? `${bucket.hitRate.toFixed(1)}%` : '—'}</span><span>{bucket.count >= MIN_CALIBRATION_SAMPLES ? 'VALID' : 'THIN'}</span></div>)}</div><p className="muted">Raw validation: {backtestState.result.raw.hitRate.toFixed(1)}% • Calibrated validation: {validated.hitRate.toFixed(1)}% • Statistical validation is not guaranteed profit.</p></>}</section>
    </main>
  </div>;
}
