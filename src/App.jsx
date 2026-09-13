import React, { useEffect, useMemo, useRef, useState } from 'react';

const SYMBOLS = [
  ['R_10','Volatility 10 Index'], ['R_25','Volatility 25 Index'], ['R_50','Volatility 50 Index'],
  ['R_75','Volatility 75 Index'], ['R_100','Volatility 100 Index']
];

function digitOf(quote) {
  const s = String(quote);
  const p = s.indexOf('.');
  return Number((p >= 0 ? s.slice(p + 1) : s).replace(/\D/g, '').slice(-1));
}

function analyze(digits) {
  if (digits.length < 80) return { signal:false, digit:null, confidence:0, scores:Array(10).fill(0), reason:'Collecting data' };
  const windows = [20, 50, 100].filter(n => digits.length >= n);
  const scores = Array(10).fill(0);
  for (let d=0; d<10; d++) {
    let score = 0;
    for (const n of windows) {
      const w = digits.slice(-n);
      const freq = w.filter(x => x === d).length / n;
      score += (freq - 0.1) * (n === 20 ? 0.55 : n === 50 ? 0.3 : 0.15);
    }
    const last = digits[digits.length - 1];
    const gap = digits.length - 1 - [...digits].reverse().indexOf(d);
    if (gap > 0 && gap < 25) score += 0.006;
    if (last === d) score -= 0.004;
    scores[d] = score;
  }
  const ranked = [...scores.keys()].sort((a,b)=>scores[b]-scores[a]);
  const best = ranked[0], second = ranked[1];
  const edge = scores[best] - scores[second];
  const confidence = Math.max(0, Math.min(99, 50 + edge * 900));
  return { signal: confidence >= 58, digit:best, confidence, scores, reason:confidence >= 58 ? 'Statistical edge detected' : 'Edge too weak' };
}

export default function App() {
  const [symbol,setSymbol] = useState('R_10');
  const [ticks,setTicks] = useState([]);
  const [connected,setConnected] = useState(false);
  const [error,setError] = useState('');
  const [predictions,setPredictions] = useState([]);
  const ws = useRef(null);
  const predictionRef = useRef(null);

  useEffect(()=>{
    setTicks([]); setPredictions([]); setError(''); setConnected(false);
    const appId = '1089';
    const url = `wss://ws.derivws.com/websockets/v3?app_id=${appId}`;
    const socket = new WebSocket(url); ws.current = socket;
    socket.onopen = () => { setConnected(true); socket.send(JSON.stringify({ticks:symbol,subscribe:1})); };
    socket.onmessage = e => {
      try {
        const m = JSON.parse(e.data);
        if (m.error) { setError(m.error.message || 'Deriv API error'); return; }
        if (m.tick?.quote != null) {
          const d = digitOf(m.tick.quote);
          setTicks(prev => [...prev.slice(-499), d]);
        }
      } catch { setError('Invalid market response'); }
    };
    socket.onerror = () => setError('WebSocket connection error');
    socket.onclose = () => setConnected(false);
    return () => socket.close();
  },[symbol]);

  const analysis = useMemo(()=>analyze(ticks),[ticks]);
  const counts = useMemo(()=>Array(10).fill(0).map((_,d)=>ticks.filter(x=>x===d).length),[ticks]);
  const maxCount = Math.max(1,...counts);

  useEffect(()=>{
    if (!analysis.signal || analysis.digit == null) { predictionRef.current = null; return; }
    if (predictionRef.current?.tickCount === ticks.length) return;
    const p = { tickCount:ticks.length, digit:analysis.digit, confidence:analysis.confidence, result:null };
    const previous = predictionRef.current;
    if (previous && ticks.length > previous.tickCount) {
      const result = ticks[ticks.length-1] === previous.digit ? 'WIN' : 'LOSS';
      setPredictions(x=>[{...previous,result,at:new Date().toLocaleTimeString()},...x].slice(0,50));
    }
    predictionRef.current = p;
  },[ticks,analysis]);

  const wins = predictions.filter(p=>p.result==='WIN').length;
  const losses = predictions.filter(p=>p.result==='LOSS').length;
  const settled = wins + losses;
  const hitRate = settled ? (wins/settled*100).toFixed(1) : '—';

  return <div className="app">
    <header><div><span className="eyebrow">DERIV • MATCHES ANALYSIS</span><h1>Matches Analysis <b>PRO</b></h1><p>Live last-digit intelligence with a strict NO SIGNAL filter.</p></div><div className={connected?'status live':'status'}><i/> {connected?'LIVE':'OFFLINE'}</div></header>
    <main>
      <section className="controls card"><label>Market<select value={symbol} onChange={e=>setSymbol(e.target.value)}>{SYMBOLS.map(([s,n])=><option key={s} value={s}>{n}</option>)}</select></label><div className="metric"><span>Ticks</span><strong>{ticks.length}</strong></div><div className="metric"><span>Hit rate</span><strong>{hitRate}{settled?'%':''}</strong></div></section>
      <section className="hero card"><div><span className="eyebrow">NEXT MATCH CANDIDATE</span>{analysis.signal?<div className="big-digit">{analysis.digit}</div>:<div className="no-signal">NO SIGNAL</div>}<p>{analysis.reason}. Confidence: <strong>{analysis.confidence.toFixed(1)}%</strong></p></div><div className="hero-side"><span>Model state</span><strong>{ticks.length<80?'WARMING UP':analysis.signal?'QUALIFIED':'WAITING'}</strong><small>Minimum 80 live observations</small></div></section>
      <section className="grid"><div className="card"><div className="section-title"><h2>Digit distribution</h2><span>Last {Math.min(100,ticks.length)}</span></div><div className="digits">{counts.map((c,d)=><div className="digit-row" key={d}><b>{d}</b><div className="bar"><i style={{width:`${c/maxCount*100}%`}}/></div><span>{c}</span></div>)}</div></div>
      <div className="card"><div className="section-title"><h2>Recent ticks</h2><span>{ticks.length}</span></div><div className="ticker">{ticks.slice(-60).reverse().map((d,i)=><span key={i} className={d===analysis.digit&&analysis.signal?'candidate':''}>{d}</span>)}</div></div></section>
      <section className="card"><div className="section-title"><h2>Prediction audit</h2><span>Paper tracking only</span></div><div className="stats"><div><b>{wins}</b><span>Wins</span></div><div><b>{losses}</b><span>Losses</span></div><div><b>{settled}</b><span>Settled</span></div><div><b>{hitRate}{settled?'%':''}</b><span>Hit rate</span></div></div><div className="history">{predictions.length===0?<p className="muted">Qualified predictions will appear here and be checked against the next tick.</p>:predictions.slice(0,12).map((p,i)=><div className="history-row" key={i}><span>Digit <b>{p.digit}</b></span><span>{p.confidence.toFixed(1)}%</span><strong className={p.result==='WIN'?'win':'loss'}>{p.result}</strong><time>{p.at}</time></div>)}</div></section>
      <p className="disclaimer">This is a statistical analysis and paper-tracking tool, not a guarantee of profit. A match digit has a baseline chance of roughly 1 in 10; the app intentionally refuses weak setups.</p>
    </main>
  </div>
}
