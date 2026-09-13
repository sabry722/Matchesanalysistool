# Matches Analysis Pro

A mobile-first Deriv Matches analysis dashboard built with React + Vite.

## Current features

- Live Deriv WebSocket tick stream
- Dynamic last-digit analysis across 0–9
- Rolling 20/50/100 tick statistical scoring
- Confidence filter with explicit **NO SIGNAL** state
- Recent digit distribution and live tick stream
- Paper prediction audit with automatic next-tick WIN/LOSS tracking
- Hit-rate statistics
- Responsive mobile-first interface

## Important

This application is an analysis and paper-tracking system. It does **not** guarantee winning trades or profit. The baseline probability of a specific last digit in a ten-digit match is approximately 10%, so weak signals are deliberately filtered out.

## Run locally

```bash
npm install
npm run dev
```

For production validation:

```bash
npm run build
```

The next development stage is a dedicated walk-forward backtesting engine, model calibration, and safer market-symbol discovery instead of relying on hard-coded symbols.
