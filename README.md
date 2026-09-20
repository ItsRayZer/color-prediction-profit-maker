# Prediction Game Trading Chart

A professional, full-screen TradingView-style financial analytics dashboard and charting platform tailored for WinGo and color/size prediction games. Built with React 19, TypeScript, Vite, TradingView Lightweight Charts v5, and `lightweight-charts-drawing`.

---

## Features

### 1. Connected Trading Candlestick Math
- **Continuity**: The first candle opens at `0.0`. Every subsequent candle opens strictly at `previous.close`.
- **BIG Movements**: Bullish green candle (`close = open + 1`, `high = close`, `low = open`).
- **SMALL Movements**: Bearish red candle (`close = open - 1`, `high = open`, `low = close`).
- **Ball Color Markers**:
  - Red ball: `#ef5350` circle marker with ball number
  - Green ball: `#26a69a` circle marker with ball number
  - Violet ball: `#ab47bc` diamond marker with ball number

### 2. Multi-Chart Types
Seamless switching between 6 professional charting styles:
1. **Candlestick**: Classic high-contrast financial candles.
2. **Bar Chart**: OHLC directional bars.
3. **Line Chart**: Close-price connected line.
4. **Area Chart**: Gradient-shaded continuous price area.
5. **Baseline Chart**: Positive/negative zones relative to zero baseline.
6. **Hollow Candles**: Hollow bullish candles with filled bearish bars.

### 3. Floating Drawing Toolbar (68+ Professional Tools)
Integrated directly with `lightweight-charts-drawing`:
- **Trend Lines**: Trend Line, Ray, Info Line, Extended Line, Trend Angle, Horizontal Line, Horizontal Ray, Vertical Line, Cross Line.
- **Channels & Trends**: Parallel Channel, Regression Trend, Disjoint Channel, Flat Top/Bottom, Andrews' Pitchfork, Schiff Pitchfork, Modified Schiff, Inside Pitchfork, Pitchfan.
- **Fibonacci & Gann**: Fib Retracement, Fib Extension, Fib Channel, Fib Time Zone, Fib Circles, Fib Spiral, Fib Speed Fan, Gann Box, Gann Fan, Gann Square.
- **Geometric Shapes**: Rectangle, Rotated Rectangle, Circle, Ellipse, Triangle, Polyline, Bezier Curve, Double Curve, Arc.
- **Brushes & Markers**: Freehand Brush, Highlighter, Directional Arrows, Arrow Up (Bullish), Arrow Down (Bearish).
- **Annotations**: Text Annotation, Anchored Text, Note, Pin, Callout, Comment, Price Label, Price Note, Signpost.
- **Measurement & Risk**: Long Position, Short Position, Forecast Tool, Date & Price Range, Price Range, Date Range, Bars Pattern.
- **Interactive Controls**: Select, drag & edit anchors, delete selected, clear all, undo, redo, color picker, line width, JSON export & import.

### 4. Technical Indicators
Complete quantitative indicator suite:
1. **SMA** (Simple Moving Average)
2. **EMA** (Exponential Moving Average)
3. **WMA** (Weighted Moving Average)
4. **RSI** (Relative Strength Index)
5. **MACD** (Line, Signal line, Histogram)
6. **Bollinger Bands** (Upper, Middle, Lower bands)
7. **Moving Average Channel** (Upper & lower deviation offsets)
8. **Result Volume Histogram** (Bar representation of BIG vs SMALL)
9. **Streak Counter** (Visual trend streak length tracker)
10. **Big/Small Ratio Oscillator** (Rolling ratio oscillator)

### 5. Multi-Mode Data Feeds
- **Mock Data Generator**: Generates 1,000+ realistic rounds with accurate probabilities (~45% Red, ~45% Green, ~10% Violet, balls 0–9).
- **Manual Data Input**: Multi-line modal supporting formats like `red-big`, `green-small`, `violet-big` or `7 green big` with instantaneous chart plotting.
- **Real-Time Feed / Simulation**: WebSocket support with automatic fallback to 5-second simulated live rounds with auto-scroll.

### 6. Side Statistics Panel & Lower Histogram
- Live snapshot: Current round, continuous price, last result, ball color.
- Active streak badge (e.g. 5x BIG).
- Historical streak records (Max BIG, Max SMALL, Max RED, Max GREEN).
- Real-time distribution progress bar (BIG% vs SMALL%, Red/Green/Violet counts).
- Recent 20-round stream with color badges and ball numbers.
- Lower histogram panel with tooltip hover inspection.

---

## Tech Stack
- **Framework**: React 19, TypeScript
- **Bundler**: Vite
- **Chart Engine**: TradingView Lightweight Charts v5 (`lightweight-charts@^5.0.0`)
- **Drawing Tools**: `lightweight-charts-drawing`
- **State Management**: Zustand with `localStorage` persistence
- **Icons**: Lucide React
- **Styling**: Tailwind CSS & custom dark financial theme (`#131722`, `#1e222d`, `#2a2e39`)

---

## Installation & Setup

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Start Local Development Server**:
   ```bash
   npm run dev
   ```
   Open `http://localhost:5173` in your browser.

3. **Build for Production**:
   ```bash
   npm run build
   ```

4. **Run Automated Test Suite**:
   ```bash
   npx tsx scratch/test_trading_chart.js
   ```

---

## Navigation
- **TradingView Chart**: `http://localhost:5173/`
- **Dhaniwin Mobile Terminal**: `http://localhost:5173/terminal.html`
- A quick navigation button is located in the top header of both interfaces to switch seamlessly between them.
