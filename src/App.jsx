import React, { useEffect, useMemo, useRef, useState } from 'react';

const API_URL = 'wss://ws.derivws.com/websockets/v3?app_id=1089';
const FALLBACK_SYMBOLS = [
  { symbol: '1HZ10V', displayName: 'Volatility 10 (1s) Index' },
  { symbol: '1HZ25V', displayName: 'Volatility 25 (1s) Index' },
  { symbol: '1HZ50V', displayName: 'Volatility 50 (1s) Index' },
  { symbol: '1HZ75V', displayName: 'Volatility 75 (1s) Index' },
  { symbol: '1HZ100V', displayName: 'Volatility 100 (1s) Index' }
];
const MIN_TICKS = 100;
const BACKTEST_TICKS = 1500;
const MIN_CALIBRATION_SAMPLES = 20;
const BUCKETS = [
  [0, 30], [30, 40], [40, 50], [50, 60], [60, 70], [70, 80], [80, 100]
];

function lastDigit(quote, pipSize) {
  if (quote == null) return null;
  const n = Number(quote);
  if (!Number.isFinite(n)) return null;
  if (Number.isInteger(pipSize) && pipSize >= 0 && pipSize <= 10) {
    const fixed = n.toFixed(pipSize);
    const chars = fixed.replace(/\D/g, '');
    return chars ? Number(chars.at(-1)) : null;
  }
  const text = String(quote);
  const decimal = text.includes('.') ? text.split('.')[1] : '';
  const chars = decimal || text;
  return chars ? Number(chars.at(-1)) : null;
}

function entropy(probabilities) {
  return -probabilities.reduce((sum, p) => sum + (p > 0 ? p * Math.log2(p) : 0), 0);
}

function bucketIndex(confidence) {
  const i = BUCKETS.findIndex(([lo, hi], index) => confidence >= lo && (index === BUCKETS.length - 1 ? confidence <= hi : confidence < hi));
  return i < 0 ? BUCKETS.length - 1 : i;
}

function baseAnalyze(digits) {
  if (digits.length < MIN_TICKS) {
    return { signal: false, digit: null, confidence: 0, probability: 10, scores: Array(10).fill(0), reason: `Collecting ${MIN_TICKS - digits.length} more ticks`, entropy: 1, margin: 0 };
  }
  const recent = digits.slice(-100);
  const short = digits.slice(-30);
  const counts = Array(10).fill(0);
  const shortCounts = Array(10).fill(0);
  recent.forEach(d => counts[d]++);
  short.forEach(d => shortCounts[d]++);
  const probs = counts.map(c => c / recent.length);
  const h = entropy(probs) / Math.log2(10);
  const scores = Array(10).fill(0);
  const last = digits.at(-1);

  for (let d = 0; d < 10; d++) {
    const longEdge = probs[d] - 0.10;
    const shortEdge = shortCounts[d] / short.length - 0.10;
    let transition = 0;
    let transitions = 0;
    for (let i = 1; i < digits.length; i++) {
      if (digits[i - 1] === last) {
        transitions++;
        if (digits[i] === d) transition++;
      }
    }
    const transitionProb = transitions >= 8 ? transition / transitions : 0.10;
    const transitionEdge = transitionProb - 0.10;
    const reversed = [...digits].reverse();
    const gap = reversed.indexOf(d);
    const gapSignal = gap >= 8 && gap <= 35 ? 0.012 : 0;
    const repeatPenalty = d === last ? -0.006 : 0;
    scores[d] = longEdge * 0.40 + shortEdge * 0.25 + transitionEdge * 0.30 + gapSignal + repeatPenalty;
  }

  const ranked = [...Array(10).keys()].sort((a, b) => scores[b] - scores[a]);
  const best = ranked[0];
  const second = ranked[1];
  const margin = scores[best] - scores[second];
  const rawProbability = 0.10 + Math.max(0, scores[best]);
  const modelAgreement = Math.max(0, Math.min(1, 0.5 + margin * 8));
  const uncertaintyPenalty = Math.max(0, h - 0.93);
  const probability = Math.max(0.10, Math.min(0.40, rawProbability * (0.75 + 0.25 * modelAgreement) - uncertaintyPenalty * 0.05));
  const confidence = Math.max(0, Math.min(99, 100 * ((probability - 0.10) / 0.20)));
  const signal = confidence >= 24 && margin >= 0.012 && modelAgreement >= 0.55 && h < 0.995;
  return { signal, digit: best, confidence, probability: probability * 100, scores, entropy: h, margin, reason: signal ? 'Multiple statistical features agree' : 'No sufficiently strong edge' };
}

function calibrate(rawConfidence, calibration) {
  if (!calibration) return { confidence: rawConfidence, probability: 10 + (rawConfidence * 0.20), calibrated: false, sampleSize: 0 };
  const idx = bucketIndex(rawConfidence);
  const row = calibration.buckets[idx];
  if (!row || row.count < MIN_CALIBRATION_SAMPLES) return { confidence: rawConfidence, probability: 10 + rawConfidence * 0.20, calibrated: false, sampleSize: row?.count || 0 };
  const empirical = row.wins / row.count * 100;
  const shrink = Math.min(0.75, row.count / 100);
  const probability = 10 + (empirical - 10) * shrink;
  const confidence = Math.max(0, Math.min(99, (probability - 10) / 0.20));
  return { confidence, probability, calibrated: true, sampleSize: row.count };
}

function analyze(digits, calibration) {
  const raw = baseAnalyze(digits);
  if (!raw.signal) return raw;
  const calibrated = calibrate(raw.confidence, calibration);
  const qualified = calibrated.calibrated ? calibrated.probability >= 12 : raw.confidence >= 24;
  return {
    ...raw,
    confidence: calibrated.confidence,
    probability: calibrated.probability,
    calibrated: calibrated.calibrated,
    calibrationSamples: calibrated.sampleSize,
    signal: qualified,
    reason: qualified ? (calibrated.calibrated ? 'Validated by walk-forward calibration' : raw.reason) : 'Calibration did not confirm enough edge'
  };
}

function buildCalibration(results) {
  const buckets = BUCKETS.map(([lo, hi]) => ({ lo, hi, count: 0, wins: 0, hitRate: 0 }));
  results.forEach(r => {
    const row = buckets[bucketIndex(r.confidence)];
    row.count++;
    if (r.win) row.wins++;
  });
  buckets.forEach(row => { row.hitRate = row.count ? row.wins / row.count * 100 : 0; });
  return { buckets, total: results.length };
}

function scoreValidation(results) {
  let wins = 0;
  let losses = 0;
  let maxLosingStreak = 0;
  let losingStreak = 0;
  let probabilitySum = 0;
  let brierSum = 0;
  results.forEach(r => {
    if (r.win) { wins++; losingStreak = 0; } else { losses++; losingStreak++; maxLosingStreak = Math.max(maxLosingStreak, losingStreak); }
    probabilitySum += r.probability / 100;
    brierSum += (r.probability / 100 - (r.win ? 1 : 0)) ** 2;
  });
  const signals = wins + losses;
  return {
    signals, wins, losses,
    hitRate: signals ? wins / signals * 100 : 0,
    edge: signals ? wins / signals * 100 - 10 : 0,
    maxLosingStreak,
    avgProbability: signals ? probabilitySum / signals * 100 : 0,
    brier: signals ? brierSum / signals : null
  };
}

function walkForwardBacktest(digits) {
  const all = [];
  for (let i = MIN_TICKS; i < digits.length; i++) {
    const prediction = baseAnalyze(digits.slice(0, i));
    if (!prediction.signal || prediction.digit == null) continue;
    all.push({ index: i, predicted: prediction.digit, actual: digits[i], win: prediction.digit === digits[i], confidence: prediction.confidence, probability: prediction.probability });
  }

  const splitIndex = Math.max(1, Math.floor(all.length * 0.70));
  const training = all.slice(0, splitIndex);
  const validation = all.slice(splitIndex);
  const calibration = buildCalibration(training);
  const calibratedValidation = validation.map(r => {
    const c = calibrate(r.confidence, calibration);
    return { ...r, probability: c.probability, confidence: c.confidence };
  });
  const rawScore = scoreValidation(validation);
  const calibratedScore = scoreValidation(calibratedValidation);
  return {
    observations: Math.max(0, digits.length - MIN_TICKS),
    candidates: all.length,
    trainingSignals: training.length,
    validationSignals: validation.length,
    noSignals: Math.max(0, digits.length - MIN_TICKS - all.length),
    calibration,
    raw: rawScore,
    validated: calibratedScore,
    samples: calibratedValidation.slice(-30).reverse()
  };
}

export default function App() {
  const [symbols, setSymbols] = useState(FALLBACK_SYMBOLS);
  const [symbol, setSymbol] = useState(FALLBACK_SYMBOLS[0].symbol);
  const [ticks, setTicks] = useState([]);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState('Connecting…');
  const [error, setError] = useState('');
  const [predictions, setPredictions] = useState([]);
  const [serverPipSize, setServerPipSize] = useState(null);
  const [eligible, setEligible] = useState(null);
  const [eligibilityText, setEligibilityText] = useState('Checking Matches support…');
  const [backtestState, setBacktestState] = useState({ loading: false, result: null, error: '' });
  const ws = useRef(null);
  const pending = useRef(null);
  const requestId = useRef(10);
  const calibrationRef = useRef(null);

  const calibration = backtestState.result?.calibration || null;
  calibrationRef.current = calibration;

  useEffect(() => {
    const socket = new WebSocket(API_URL);
    ws.current = socket;
    socket.onopen = () => {
      setConnected(true); setStatus('Live market data'); setError('');
      socket.send(JSON.stringify({ active_symbols: 'brief', product_type: 'basic', req_id: 1 }));
    };
    socket.onmessage = event => {
      try {
        const m = JSON.parse(event.data);
        if (m.error) { setError(m.error.message || 'Deriv API error'); return; }
        if (m.msg_type === 'active_symbols') {
          const discovered = (m.active_symbols || [])
            .filter(x => x.symbol && x.display_name)
            .filter(x => /volatility|crash|boom|jump|step|range break|drift|daily/i.test(`${x.display_name} ${x.market || ''} ${x.submarket || ''}`))
            .map(x => ({ symbol: x.symbol, displayName: x.display_name, pipSize: x.pip_size }));
          if (discovered.length) {
            const sorted = discovered.sort((a, b) => a.displayName.localeCompare(b.displayName));
            setSymbols(sorted);
            setSymbol(current => sorted.some(x => x.symbol === current) ? current : sorted[0].symbol);
          }
        }
        if (m.msg_type === 'contracts_for') {
          const available = JSON.stringify(m.contracts_for || m).toUpperCase();
          const supportsMatch = available.includes('DIGITMATCH') || available.includes('MATCHDIGIT') || available.includes('DIGIT MATCH');
          setEligible(supportsMatch);
          setEligibilityText(supportsMatch ? 'Matches contract available' : 'Matches contract not confirmed');
        }
        if (m.msg_type === 'tick' && m.tick?.quote != null) {
          const pip = Number.isInteger(m.tick.pip_size) ? m.tick.pip_size : null;
          setServerPipSize(pip);
          const d = lastDigit(m.tick.quote, pip);
          if (d != null) setTicks(prev => [...prev.slice(-2999), d]);
        }
        if (m.msg_type === 'history' && m.history?.prices) {
          const prices = m.history.prices.map(q => lastDigit(q, m.pip_size)).filter(Number.isInteger);
          if (prices.length >= MIN_TICKS + 1) setBacktestState({ loading: false, error: '', result: walkForwardBacktest(prices) });
          else setBacktestState({ loading: false, error: `Only ${prices.length} valid ticks were returned.`, result: null });
        }
      } catch { setError('Invalid market response.'); }
    };
    socket.onerror = () => { setConnected(false); setStatus('Connection error'); };
    socket.onclose = () => { setConnected(false); setStatus('Disconnected'); };
    return () => { socket.close(); if (ws.current === socket) ws.current = null; };
  }, []);

  useEffect(() => {
    if (!ws.current || ws.current.readyState !== WebSocket.OPEN || !symbol) return;
    ws.current.send(JSON.stringify({ forget_all: 'ticks' }));
    ws.current.send(JSON.stringify({ contracts_for: symbol, req_id: requestId.current++ }));
    ws.current.send(JSON.stringify({ ticks: symbol, subscribe: 1, req_id: requestId.current++ }));
    setTicks([]); setPredictions([]); pending.current = null; setEligible(null);
    setEligibilityText('Checking Matches support…'); setBacktestState({ loading: false, result: null, error: '' });
  }, [symbol, connected]);

  const analysis = useMemo(() => analyze(ticks, calibration), [ticks, calibration]);
  const counts = useMemo(() => Array.from({ length: 10 }, (_, d) => ticks.slice(-100).filter(x => x === d).length), [ticks]);
  const maxCount = Math.max(1, ...counts);

  useEffect(() => {
    if (!ticks.length) return;
    if (pending.current && ticks.length > pending.current.tickCount) {
      const outcome = ticks.at(-1) === pending.current.digit ? 'WIN' : 'LOSS';
      setPredictions(prev => [{ ...pending.current, result: outcome, at: new Date().toLocaleTimeString() }, ...prev].slice(0, 100));
      pending.current = null;
    }
    if (analysis.signal && analysis.digit != null && !pending.current) {
      pending.current = { tickCount: ticks.length, digit: analysis.digit, confidence: analysis.confidence, probability: analysis.probability, calibrated: analysis.calibrated };
    }
  }, [ticks, analysis]);

  function runBacktest() {
    if (!ws.current || ws.current.readyState !== WebSocket.OPEN) { setBacktestState({ loading: false, result: null, error: 'Connect to Deriv before running validation.' }); return; }
    setBacktestState({ loading: true, result: null, error: '' });
    ws.current.send(JSON.stringify({ ticks_history: symbol, end: 'latest', count: BACKTEST_TICKS, style: 'ticks', req_id: requestId.current++ }));
  }

  const wins = predictions.filter(p => p.result === 'WIN').length;
  const losses = predictions.filter(p => p.result === 'LOSS').length;
  const settled = wins + losses;
  const liveHitRate = settled ? (wins / settled * 100).toFixed(1) : '—';
  const selectedName = symbols.find(x => x.symbol === symbol)?.displayName || symbol;
  const validated = backtestState.result?.validated;
  const validationReady = validated && validated.signals >= 20 && validated.edge > 0;

  return <div className="app">
    <header>
      <div><span className="eyebrow">DERIV • MATCHES ANALYSIS</span><h1>Matches Analysis <b>PRO</b></h1><p>Live digit analysis with walk-forward validation and confidence calibration.</p></div>
      <div className={connected ? 'status live' : 'status'}><i/> {connected ? 'LIVE' : 'OFFLINE'}</div>
    </header>
    <main>
      <section className="controls card">
        <label>Market<select value={symbol} onChange={e => setSymbol(e.target.value)}>{symbols.map(x => <option key={x.symbol} value={x.symbol}>{x.displayName}</option>)}</select></label>
        <div className={`metric ${eligible === true ? 'ok' : eligible === false ? 'bad' : ''}`}><span>Matches</span><strong>{eligible === true ? 'ELIGIBLE' : eligible === false ? 'CHECK' : '…'}</strong></div>
        <div className="metric"><span>Ticks</span><strong>{ticks.length}</strong></div>
        <div className="metric"><span>Live hit</span><strong>{liveHitRate}{settled ? '%' : ''}</strong></div>
      </section>
      {error && <div className="card error">{error}</div>}
      <section className="card eligibility"><div><b>{eligibilityText}</b><small>{selectedName} • pip size {serverPipSize ?? 'auto'} • baseline per digit ≈ 10%</small></div><span className={eligible === true ? 'badge ok' : eligible === false ? 'badge bad' : 'badge'}>{eligible === true ? 'CONTRACT READY' : eligible === false ? 'NOT VERIFIED' : 'VERIFYING'}</span></section>

      <section className="hero card">
        <div><span className="eyebrow">NEXT MATCH CANDIDATE</span>{analysis.signal ? <div className="big-digit">{analysis.digit}</div> : <div className="no-signal">NO SIGNAL</div>}
          <p>{analysis.reason}. Estimated probability: <strong>{analysis.probability.toFixed(1)}%</strong> • Confidence: <strong>{analysis.confidence.toFixed(1)}%</strong></p>
          <small>{analysis.calibrated ? `Calibrated from ${analysis.calibrationSamples} validation samples` : 'Calibration pending • model is statistical, not guaranteed'}</small>
        </div>
        <div className="hero-side"><span>Model state</span><strong>{ticks.length < MIN_TICKS ? 'WARMING UP' : analysis.signal ? 'QUALIFIED' : 'WAITING'}</strong><small>{Math.max(0, MIN_TICKS - ticks.length)} observations until full warm-up</small></div>
      </section>

      <section className="grid">
        <div className="card"><div className="section-title"><h2>Digit distribution</h2><span>Last {Math.min(100, ticks.length)}</span></div><div className="digits">{counts.map((c, d) => <div className="digit-row" key={d}><b>{d}</b><div className="bar"><i style={{ width: `${c / maxCount * 100}%` }}/></div><span>{c}</span></div>)}</div></div>
        <div className="card"><div className="section-title"><h2>Live audit</h2><span>{predictions.length} settled</span></div><div className="audit">{predictions.length ? predictions.slice(0, 10).map((p, i) => <div className="audit-row" key={`${p.at}-${i}`}><b>{p.digit}</b><span>{p.confidence.toFixed(0)}%</span><span>{p.probability.toFixed(1)}%</span><strong className={p.result === 'WIN' ? 'win' : 'loss'}>{p.result}</strong></div>) : <p className="muted">No settled predictions yet.</p>}</div></div>
      </section>

      <section className="card validation">
        <div className="section-title"><div><h2>Walk-forward validation</h2><small>70% calibration / 30% unseen validation • next-tick causality</small></div><button onClick={runBacktest} disabled={backtestState.loading}>{backtestState.loading ? 'RUNNING…' : 'RUN VALIDATION'}</button></div>
        {backtestState.error && <div className="error inline">{backtestState.error}</div>}
        {!backtestState.result && !backtestState.loading && <p className="muted">Run validation to measure whether the model has a real edge on the selected market.</p>}
        {backtestState.result && <>
          <div className="validation-grid">
            <div><span>Validation hit</span><strong>{validated.hitRate.toFixed(1)}%</strong></div>
            <div><span>Edge vs 10%</span><strong>{validated.edge >= 0 ? '+' : ''}{validated.edge.toFixed(1)}%</strong></div>
            <div><span>Signals</span><strong>{validated.signals}</strong></div>
            <div><span>Max loss streak</span><strong>{validated.maxLosingStreak}</strong></div>
            <div><span>Avg predicted</span><strong>{validated.avgProbability.toFixed(1)}%</strong></div>
            <div><span>Brier score</span><strong>{validated.brier == null ? '—' : validated.brier.toFixed(3)}</strong></div>
          </div>
          <div className={`validation-status ${validationReady ? 'ready' : 'hold'}`}><b>{validationReady ? 'CALIBRATION READY' : 'HOLD / MORE DATA'}</b><span>{validationReady ? 'Live signals may use empirical calibration.' : 'The app will stay conservative until enough unseen samples confirm an edge.'}</span></div>
          <div className="calibration-table"><div className="cal-head"><span>Confidence</span><span>Samples</span><span>Actual hit</span><span>Status</span></div>{backtestState.result.calibration.buckets.map((b, i) => <div className="cal-row" key={i}><span>{b.lo}–{b.hi}%</span><span>{b.count}</span><span>{b.count ? `${b.hitRate.toFixed(1)}%` : '—'}</span><span>{b.count >= MIN_CALIBRATION_SAMPLES ? 'VALID' : 'THIN'}</span></div>)}</div>
          <p className="muted">Raw validation: {backtestState.result.raw.hitRate.toFixed(1)}% • Calibrated validation: {validated.hitRate.toFixed(1)}% • This is statistical validation, not guaranteed profit.</p>
        </>}
      </section>
    </main>
  </div>;
}
