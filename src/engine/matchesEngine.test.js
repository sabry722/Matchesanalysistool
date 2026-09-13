import test from 'node:test';
import assert from 'node:assert/strict';
import {
  baseAnalyze,
  benchmarkRank,
  buildCalibration,
  calibrate,
  lastDigit,
  normalizeDigits,
  parseContractTypes,
  scoreValidation,
  supportsMatches,
  walkForwardBacktest
} from './matchesEngine.js';

test('normalizes only valid digit observations', () => {
  assert.deepEqual(normalizeDigits([0, 9, '4', 10, -1, 2.5, null, 3]), [0, 9, 4, 3]);
});

test('extracts the last displayed decimal digit using pip size', () => {
  assert.equal(lastDigit(123.45, 2), 5);
  assert.equal(lastDigit(123.4, 3), 0);
  assert.equal(lastDigit('123.45', null), 5);
});

test('does not emit a signal before the minimum history window', () => {
  const result = baseAnalyze(Array.from({ length: 99 }, (_, i) => i % 10));
  assert.equal(result.signal, false);
  assert.equal(result.digit, null);
  assert.match(result.reason, /Collecting 1 more ticks/);
});

test('calibration requires a minimum sample count', () => {
  const small = buildCalibration(Array.from({ length: 10 }, (_, i) => ({ confidence: 50, win: i < 7 })));
  const result = calibrate(50, small);
  assert.equal(result.calibrated, false);
  assert.equal(result.sampleSize, 10);
});

test('calibration uses only the selected confidence bucket', () => {
  const samples = Array.from({ length: 20 }, () => ({ confidence: 50, win: true }));
  const calibration = buildCalibration(samples);
  const result = calibrate(50, calibration);
  assert.equal(result.calibrated, true);
  assert.equal(result.sampleSize, 20);
  assert.ok(result.probability > 10);
});

test('validation metrics stay bounded and calculate a 10 percent baseline edge', () => {
  const metrics = scoreValidation([
    { win: true, probability: 20 },
    { win: false, probability: 20 },
    { win: true, probability: 20 }
  ]);
  assert.equal(metrics.signals, 3);
  assert.equal(metrics.hitRate, 66.66666666666666);
  assert.equal(metrics.edge, 56.66666666666666);
  assert.equal(metrics.maxLosingStreak, 1);
  assert.ok(metrics.brier >= 0 && metrics.brier <= 1);
});

test('walk-forward result has separate training and validation observations', () => {
  const digits = Array.from({ length: 500 }, (_, i) => (i * 7 + Math.floor(i / 13)) % 10);
  const result = walkForwardBacktest(digits);
  assert.equal(result.observations, 400);
  assert.equal(result.trainingSignals + result.validationSignals, result.candidates);
  assert.equal(result.calibration.total, result.trainingSignals);
  assert.ok(result.validated.signals <= result.validationSignals);
});

test('Matches contract detection parses structured contract responses', () => {
  const message = {
    contracts_for: [
      { contract_type: 'DIGITDIFF' },
      { contract_type: 'DIGITMATCH' },
      { contract_type: 'CALL' }
    ]
  };
  assert.deepEqual(parseContractTypes(message), ['DIGITDIFF', 'DIGITMATCH', 'CALL']);
  assert.equal(supportsMatches(message), true);
  assert.equal(supportsMatches({ contracts_for: [{ contract_type: 'CALL' }] }), false);
});

test('benchmark ranking prefers the stronger validated edge', () => {
  const ranked = benchmarkRank([
    { symbol: 'A', validated: { edge: 2, signals: 40, brier: 0.10, maxLosingStreak: 3 } },
    { symbol: 'B', validated: { edge: 8, signals: 40, brier: 0.10, maxLosingStreak: 2 } }
  ]);
  assert.equal(ranked[0].symbol, 'B');
});
