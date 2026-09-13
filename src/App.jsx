import React, { useEffect, useMemo, useRef, useState } from 'react';

const API_URL = 'wss://ws.derivws.com/websockets/v3?app_id=1089';
const FALLBACK_SYMBOLS = [
  { symbol: '1HZ10V', displayName: 'Volatility 10 (1s) Index' },
  { symbol: '1HZ25V', displayName: 'Volatility 25 (1s) Index' },
  { symbol: '1HZ50V', displayName: 'Volatility 50 (1s) Index' },
  { symbol: '1HZ75V', displayName: 'Volatility 75 (1s) Index' },
  { symbol: '1HZ100V', displayName: 'Volatility 100 (1s) Index' }
];

function lastDigit(quote, pipSize) {
  if (quote == null) return null;
  const n = Number(quote);
  if (!Number.isFinite(n)) return null;
  if (Number.isInteger(pipSize) && pipSize >= 0 && pipSize <= 10) {
    const fixed = n.toFixed(pipSize);
    return Number(fixed.replace(/\D/g, '').at(-1));
  }
  const text = String(quote);
  const decimal = text.includes('.') ? text.split('.')[1] : '';
  return Number((decimal || text).at(-1));
}

function entropy(probabilities) {
  return -probabilities.reduce((sum, p) => sum + (p > 0 ? p * Math.log2(p) : 0), 0);
}

function analyze(digits) {
  const MIN = 100;
  if (digits.length < MIN) return { signal: false, digit: null, confidence: 0, probability: 0, scores: Array(10).fill(0), reason: `Collecting ${MIN - digits.length} more ticks` };

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
    const gap = digits.length - 1 - [...digits].reverse().indexOf(d);
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

  return {
    signal,
    digit: best,
    confidence,
    probability: probability * 100,
    scores,
    entropy: h,
    reason: signal ? 'Multiple statistical features agree' : 'No sufficiently strong edge'
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
  const ws = useRef(null);
  const pending = useRef(null);
  const requestId = useRef(10);

  useEffect(() => {
    setTicks([]);
    setPredictions([]);
    setError('');
    setServerPipSize(null);
    const socket = new WebSocket(API_URL);
    ws.current = socket;

    socket.onopen = () => {
      setConnected(true);
      setStatus('Live market data');
      socket.send(JSON.stringify({ active_symbols: 'brief', product_type: 'basic', req_id: 1 }));
    };

    socket.onmessage = (event) => {
      try {
        const m = JSON.parse(event.data);
        if (m.error) {
          setError(m.error.message || 'Deriv API error');
          return;
        }
        if (m.msg_type === 'active_symbols') {
          const discovered = (m.active_symbols || [])
            .filter(x => x.symbol && x.display_name)
            .filter(x => /volatility|crash|boom|jump|step|range break|drift|daily/i.test(`${x.display_name} ${x.market || ''} ${x.submarket || ''}`))
            .map(x => ({ symbol: x.symbol, displayName: x.display_name, pipSize: x.pip_size }));
          if (discovered.length) {
            setSymbols(discovered.sort((a, b) => a.displayName.localeCompare(b.displayName)));
            setSymbol(current => discovered.some(x => x.symbol === current) ? current : discovered[0].symbol);
          }
        }
        if (m.msg_type === 'tick' && m.tick?.quote != null) {
          const pip = Number.isInteger(m.tick.pip_size) ? m.tick.pip_size : null;
          setServerPipSize(pip);
          const d = lastDigit(m.tick.quote, pip);
          if (d == null) return;
          setTicks(prev => [...prev.slice(-999), d]);
        }
      } catch {
        setError('Invalid market response.');
      }
    };

    socket.onerror = () => {
      setConnected(false);
      setStatus('Connection error');
    };
    socket.onclose = () => {
      setConnected(false);
      setStatus('Disconnected');
    };
    return () => socket.close();
  }, [symbol]);

  useEffect(() => {
    if (!ws.current || ws.current.readyState !== WebSocket.OPEN) return;
    ws.current.send(JSON.stringify({ ticks: symbol, subscribe: 1, req_id: requestId.current++ }));
  }, [symbol, connected]);

  const analysis = useMemo(() => analyze(ticks), [ticks]);
  const counts = useMemo(() => Array(10).fill(0).map((_, d) => ticks.slice(-100).filter(x => x === d).length), [ticks]);
  const maxCount = Math.max(1, ...counts);

  useEffect(() => {
    if (ticks.length === 0) return;
    const current = pending.current;
    if (current && ticks.length > current.tickCount) {
      const outcome = ticks.at(-1) === current.digit ? 'WIN' : 'LOSS';
      setPredictions(prev => [{ ...current, result: outcome, at: new Date().toLocaleTimeString() }, ...prev].slice(0, 100));
      pending.current = null;
    }
    if (analysis.signal && analysis.digit != null) {
      pending.current = { tickCount: ticks.length, digit: analysis.digit, confidence: analysis.confidence, probability: analysis.probability };
    }
  }, [ticks, analysis]);

  const wins = predictions.filter(p => p.result === 'WIN').length;
  const losses = predictions.filter(p => p.result === 'LOSS').length;
  const settled = wins + losses;
  const hitRate = settled ? (wins / settled * 100).toFixed(1) : '—';
  const selectedName = symbols.find(x => x.symbol === symbol)?.displayName || symbol;

  return <div className="app">
    <header><div><span className="eyebrow">DERIV • MATCHES ANALYSIS</span><h1>Matches Analysis <b>PRO</b></h1><p>Dynamic last-digit analysis with live symbol discovery and a strict NO SIGNAL filter.</p></div><div className={connected ? 'status live' : 'status'}><i/> {connected ? 'LIVE' : 'OFFLINE'}</div></header>
    <main>
      <section className="controls card"><label>Market<select value={symbol} onChange={e => setSymbol(e.target.value)}>{symbols.map(x => <option key={x.symbol} value={x.symbol}>{x.displayName}</option>)}</select></label><div className="metric"><span>Ticks</span><strong>{ticks.length}</strong></div><div className="metric"><span>Hit rate</span><strong>{hitRate}{settled ? '%' : ''}</strong></div><div className="metric"><span>Feed</span><strong>{status}</strong></div></section>
      {error && <div className="card error">{error}</div>}
      <section className="hero card"><div><span className="eyebrow">NEXT MATCH CANDIDATE</span>{analysis.signal ? <div className="big-digit">{analysis.digit}</div> : <div className="no-signal">NO SIGNAL</div>}<p>{analysis.reason}. Estimated probability: <strong>{analysis.probability.toFixed(1)}%</strong> • Confidence: <strong>{analysis.confidence.toFixed(1)}%</strong></p><small>{selectedName} • baseline per digit ≈ 10%</small></div><div className="hero-side"><span>Model state</span><strong>{ticks.length < 100 ? 'WARMING UP' : analysis.signal ? 'QUALIFIED' : 'WAITING'}</strong><small>{Math.max(0, 100 - ticks.length)} observations until full warm-up</small></div></section>
      <section className="grid"><div className="card"><div className="section-title"><h2>Digit distribution</h2><span>Last {Math.min(100, ticks.length)}</span></div><div className="digits">{counts.map((c, d) => <div className="digit-row" key={d}><b>{d}</b><div className="bar"><i style={{ width: `${c / maxCount * 100}%` }}/></div><span>{c}</span></div>)}</div></div>
      <div className="card"><div className="section-title"><h2>Recent ticks</h2><span>{ticks.length}</span></div><div className="ticker">{ticks.slice(-80).reverse().map((d, i) => <span key={i} className={d === analysis.digit && analysis.signal ? 'candidate' : ''}>{d}</span>)}</div></div></section>
      <section className="card"><div className="section-title"><h2>Prediction audit</h2><span>Paper tracking only</span></div><div className="stats"><div><b>{wins}</b><span>Wins</span></div><div><b>{losses}</b><span>Losses</span></div><div><b>{settled}</b><span>Settled</span></div><div><b>{hitRate}{settled ? '%' : ''}</b><span>Hit rate</span></div></div><div className="history">{predictions.length === 0 ? <p className="muted">Qualified predictions appear here and are evaluated strictly against the next tick.</p> : predictions.slice(0, 15).map((p, i) => <div className="history-row" key={i}><span>Digit <b>{p.digit}</b></span><span>{p.probability.toFixed(1)}%</span><strong className={p.result === 'WIN' ? 'win' : 'loss'}>{p.result}</strong><time>{p.at}</time></div>)}</div></section>
      <p className="disclaimer">Statistical analysis only. No prediction system can guarantee a winning result. Use paper validation and walk-forward testing before considering any real-money use.</p>
    </main>
  </div>;
}
