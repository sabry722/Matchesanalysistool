export const ENGINE_CONFIG = Object.freeze({
  minTicks: 100,
  recentWindow: 120,
  shortWindow: 40,
  mediumWindow: 300,
  transitionWindow: 400,
  minTransitionSamples: 10,
  minCalibrationSamples: 20,
  maxProbability: 30,
  baselineProbability: 10,
  confidenceFloor: 26,
  marginFloor: 0.015,
  entropyCeiling: 0.992
});

export const CONFIDENCE_BUCKETS = Object.freeze([
  [0, 30], [30, 40], [40, 50], [50, 60], [60, 70], [70, 80], [80, 100]
]);

export function normalizeDigits(values) {
  return (Array.isArray(values) ? values : [])
    .filter(value => {
      if (typeof value === 'number') return Number.isFinite(value);
      return typeof value === 'string' && value.trim() !== '';
    })
    .map(Number)
    .filter(Number.isInteger)
    .filter(d => d >= 0 && d <= 9);
}

export function lastDigit(quote, pipSize) {
  if (quote == null) return null;
  const n = Number(quote);
  if (!Number.isFinite(n)) return null;

  if (Number.isInteger(pipSize) && pipSize >= 0 && pipSize <= 10) {
    const chars = n.toFixed(pipSize).replace(/\D/g, '');
    return chars ? Number(chars.at(-1)) : null;
  }

  const text = String(quote);
  const decimal = text.includes('.') ? text.split('.')[1] : '';
  const chars = decimal || text;
  const digit = chars ? Number(chars.at(-1)) : null;
  return Number.isInteger(digit) && digit >= 0 && digit <= 9 ? digit : null;
}

export function entropy(probabilities) {
  return -probabilities.reduce(
    (sum, p) => sum + (p > 0 ? p * Math.log2(p) : 0),
    0
  );
}

export function bucketIndex(confidence) {
  const i = CONFIDENCE_BUCKETS.findIndex(([lo, hi], index) =>
    confidence >= lo && (index === CONFIDENCE_BUCKETS.length - 1 ? confidence <= hi : confidence < hi)
  );
  return i < 0 ? CONFIDENCE_BUCKETS.length - 1 : i;
}

function smoothedProbability(count, total, prior = 1) {
  return (count + prior) / (total + prior * 10);
}

export function baseAnalyze(input, config = ENGINE_CONFIG) {
  const digits = normalizeDigits(input);
  if (digits.length < config.minTicks) {
    return {
      signal: false,
      digit: null,
      confidence: 0,
      probability: config.baselineProbability,
      scores: Array(10).fill(0),
      reason: `Collecting ${config.minTicks - digits.length} more ticks`,
      entropy: 1,
      margin: 0,
      modelAgreement: 0,
      componentVotes: 0
    };
  }

  const recent = digits.slice(-config.recentWindow);
  const short = digits.slice(-config.shortWindow);
  const medium = digits.slice(-config.mediumWindow);
  const transitionSource = digits.slice(-config.transitionWindow);
  const counts = Array(10).fill(0);
  const shortCounts = Array(10).fill(0);
  const mediumCounts = Array(10).fill(0);

  recent.forEach(d => counts[d]++);
  short.forEach(d => shortCounts[d]++);
  medium.forEach(d => mediumCounts[d]++);

  const probs = counts.map(c => smoothedProbability(c, recent.length));
  const normalizedEntropy = entropy(probs) / Math.log2(10);
  const scores = Array(10).fill(0);
  const last = digits.at(-1);
  const transitionCounts = Array.from({ length: 10 }, () => Array(10).fill(0));

  for (let i = 1; i < transitionSource.length; i++) {
    transitionCounts[transitionSource[i - 1]][transitionSource[i]]++;
  }

  const row = transitionCounts[last];
  const transitions = row.reduce((a, b) => a + b, 0);
  const mediumTotal = medium.length;
  const shortTotal = short.length;

  for (let d = 0; d < 10; d++) {
    const longEdge = probs[d] - 0.10;
    const mediumEdge = smoothedProbability(mediumCounts[d], mediumTotal) - 0.10;
    const shortEdge = smoothedProbability(shortCounts[d], shortTotal) - 0.10;
    const transitionProb = transitions >= config.minTransitionSamples
      ? smoothedProbability(row[d], transitions, 0.5)
      : 0.10;
    const transitionEdge = transitionProb - 0.10;

    // Do not use "overdue digit"/gambler's-fallacy boosts.
    scores[d] = longEdge * 0.25
      + mediumEdge * 0.20
      + shortEdge * 0.20
      + transitionEdge * 0.35;
  }

  const ranked = [...Array(10).keys()].sort((a, b) => scores[b] - scores[a]);
  const best = ranked[0];
  const second = ranked[1];
  const margin = scores[best] - scores[second];

  const longEdge = probs[best] - 0.10;
  const mediumEdge = smoothedProbability(mediumCounts[best], mediumTotal) - 0.10;
  const shortEdge = smoothedProbability(shortCounts[best], shortTotal) - 0.10;
  const transitionEdge = transitions >= config.minTransitionSamples
    ? smoothedProbability(row[best], transitions, 0.5) - 0.10
    : 0;
  const componentVotes = [longEdge, mediumEdge, shortEdge, transitionEdge].filter(edge => edge > 0).length;
  const modelAgreement = componentVotes / 4;
  const uncertaintyPenalty = Math.max(0, normalizedEntropy - 0.93);

  const rawProbability = 0.10 + Math.max(0, scores[best]);
  const probability = Math.max(
    0.10,
    Math.min(
      config.maxProbability / 100,
      rawProbability * (0.78 + 0.22 * modelAgreement) - uncertaintyPenalty * 0.04
    )
  );
  const confidence = Math.max(0, Math.min(99, 100 * ((probability - 0.10) / 0.14)));
  const signal = confidence >= config.confidenceFloor
    && margin >= config.marginFloor
    && modelAgreement >= 0.75
    && componentVotes >= 3
    && normalizedEntropy < config.entropyCeiling;

  return {
    signal,
    digit: best,
    confidence,
    probability: probability * 100,
    scores,
    entropy: normalizedEntropy,
    margin,
    modelAgreement,
    componentVotes,
    reason: signal ? 'Multi-window and transition models agree' : 'No sufficiently strong multi-model edge'
  };
}

export function calibrate(rawConfidence, calibration, config = ENGINE_CONFIG) {
  if (!calibration) {
    return {
      confidence: rawConfidence,
      probability: 10 + rawConfidence * 0.14,
      calibrated: false,
      sampleSize: 0
    };
  }

  const row = calibration.buckets[bucketIndex(rawConfidence)];
  if (!row || row.count < config.minCalibrationSamples) {
    return {
      confidence: rawConfidence,
      probability: 10 + rawConfidence * 0.14,
      calibrated: false,
      sampleSize: row?.count || 0
    };
  }

  const empirical = row.wins / row.count * 100;
  const shrink = Math.min(0.75, row.count / 100);
  const probability = 10 + (empirical - 10) * shrink;

  return {
    confidence: Math.max(0, Math.min(99, (probability - 10) / 0.14)),
    probability,
    calibrated: true,
    sampleSize: row.count
  };
}

export function buildCalibration(results) {
  const buckets = CONFIDENCE_BUCKETS.map(([lo, hi]) => ({ lo, hi, count: 0, wins: 0, hitRate: 0 }));
  results.forEach(result => {
    const row = buckets[bucketIndex(result.confidence)];
    row.count++;
    if (result.win) row.wins++;
  });
  buckets.forEach(row => { row.hitRate = row.count ? row.wins / row.count * 100 : 0; });
  return { buckets, total: results.length };
}

export function scoreValidation(results) {
  let wins = 0;
  let losses = 0;
  let maxLosingStreak = 0;
  let losingStreak = 0;
  let probabilitySum = 0;
  let brierSum = 0;

  results.forEach(result => {
    if (result.win) {
      wins++;
      losingStreak = 0;
    } else {
      losses++;
      losingStreak++;
      maxLosingStreak = Math.max(maxLosingStreak, losingStreak);
    }

    const p = result.probability / 100;
    probabilitySum += p;
    brierSum += (p - (result.win ? 1 : 0)) ** 2;
  });

  const signals = wins + losses;
  return {
    signals,
    wins,
    losses,
    hitRate: signals ? wins / signals * 100 : 0,
    edge: signals ? wins / signals * 100 - 10 : 0,
    maxLosingStreak,
    avgProbability: signals ? probabilitySum / signals * 100 : 0,
    brier: signals ? brierSum / signals : null
  };
}

export function walkForwardBacktest(input, config = ENGINE_CONFIG) {
  const digits = normalizeDigits(input);
  const all = [];

  for (let i = config.minTicks; i < digits.length; i++) {
    const prediction = baseAnalyze(digits.slice(0, i), config);
    if (prediction.signal && prediction.digit != null) {
      all.push({
        index: i,
        predicted: prediction.digit,
        actual: digits[i],
        win: prediction.digit === digits[i],
        confidence: prediction.confidence,
        probability: prediction.probability
      });
    }
  }

  const splitIndex = Math.max(1, Math.floor(all.length * 0.70));
  const training = all.slice(0, splitIndex);
  const validation = all.slice(splitIndex);
  const calibration = buildCalibration(training);
  const calibratedValidation = validation.map(result => {
    const c = calibrate(result.confidence, calibration, config);
    return { ...result, probability: c.probability, confidence: c.confidence };
  });

  return {
    observations: Math.max(0, digits.length - config.minTicks),
    candidates: all.length,
    trainingSignals: training.length,
    validationSignals: validation.length,
    noSignals: Math.max(0, digits.length - config.minTicks - all.length),
    calibration,
    raw: scoreValidation(validation),
    validated: scoreValidation(calibratedValidation),
    samples: calibratedValidation.slice(-30).reverse()
  };
}

export function analyze(input, calibration, config = ENGINE_CONFIG) {
  const raw = baseAnalyze(input, config);
  if (!raw.signal) return raw;

  const calibrated = calibrate(raw.confidence, calibration, config);
  const qualified = calibrated.calibrated
    ? calibrated.probability >= 12
    : raw.confidence >= config.confidenceFloor;

  return {
    ...raw,
    signal: qualified,
    probability: calibrated.probability,
    confidence: calibrated.confidence,
    calibrated: calibrated.calibrated,
    calibrationSamples: calibrated.sampleSize,
    reason: qualified ? raw.reason : 'Calibration does not confirm a sufficient edge'
  };
}

export function parseContractTypes(message) {
  if (!Array.isArray(message?.contracts_for)) return [];
  return message.contracts_for
    .map(contract => contract?.contract_type)
    .filter(Boolean);
}

export function supportsMatches(message) {
  return parseContractTypes(message).some(type =>
    ['DIGITMATCH', 'DIGITDIFF'].includes(type)
  );
}

export function benchmarkScore(result) {
  const validated = result?.validated || {};
  const edge = Number(validated.edge) || 0;
  const signals = Number(validated.signals) || 0;
  const brier = Number(validated.brier) || 0;
  const streak = Number(validated.maxLosingStreak) || 0;
  return edge * 2 + Math.min(signals, 100) * 0.05 - brier * 10 - streak * 0.12;
}

export function benchmarkRank(results) {
  return [...(Array.isArray(results) ? results : [])]
    .map(result => ({ ...result, rankScore: benchmarkScore(result) }))
    .sort((a, b) => b.rankScore - a.rankScore);
}
