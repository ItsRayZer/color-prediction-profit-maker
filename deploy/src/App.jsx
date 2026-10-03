import React, { useState, useEffect } from 'react';
import { 
  ShieldCheck, 
  TrendingUp, 
  AlertTriangle, 
  RefreshCw, 
  Upload, 
  Download, 
  Play, 
  Pause, 
  CheckCircle2, 
  XCircle, 
  Zap, 
  PieChart as PieChartIcon, 
  Activity, 
  Sliders,
  DollarSign
} from 'lucide-react';
import { analyzePrediction, mapColor } from './utils/predictionEngine';
import { calculateNextBet } from './utils/stakingEngine';

// Initial Mock Dataset for instant demo
const INITIAL_MOCK_HISTORY = [
  { period: '20260829001', number: '3', color: 'green', size: 'small', timestamp: '20:00:00' },
  { period: '20260829002', number: '7', color: 'green', size: 'big', timestamp: '20:00:30' },
  { period: '20260829003', number: '1', color: 'green', size: 'small', timestamp: '20:01:00' },
  { period: '20260829004', number: '9', color: 'green', size: 'big', timestamp: '20:01:30' },
  { period: '20260829005', number: '5', color: 'green-violet', size: 'big', timestamp: '20:02:00' },
  { period: '20260829006', number: '2', color: 'red', size: 'small', timestamp: '20:02:30' },
  { period: '20260829007', number: '8', color: 'red', size: 'big', timestamp: '20:03:00' },
  { period: '20260829008', number: '4', color: 'red', size: 'small', timestamp: '20:03:30' },
  { period: '20260829009', number: '7', color: 'green', size: 'big', timestamp: '20:04:00' },
  { period: '20260829010', number: '6', color: 'red', size: 'big', timestamp: '20:04:30' },
];

export default function App() {
  // Game History State
  const [history, setHistory] = useState(INITIAL_MOCK_HISTORY);
  const [manualNumber, setManualNumber] = useState('');

  // Capital & Bankroll State
  const [bankroll, setBankroll] = useState(1000);
  const [baseBet, setBaseBet] = useState(10);
  const [currentBet, setCurrentBet] = useState(10);
  const [consecutiveLosses, setConsecutiveLosses] = useState(0);
  const [stakingStrategy, setStakingStrategy] = useState('3_LOSS_SAFETY');
  const [stopLossLimit, setStopLossLimit] = useState(300);
  const [takeProfitLimit, setTakeProfitLimit] = useState(500);

  // Simulation State
  const [isSimulating, setIsSimulating] = useState(false);
  const [activeTab, setActiveTab] = useState('dashboard'); // 'dashboard', 'risk', 'import'

  // Dynamic Prediction Calculations
  const prediction = analyzePrediction(history);

  // Real-time IST Clock & Countdown Timer
  const [secondsLeft, setSecondsLeft] = useState(30);
  const [currentPeriod, setCurrentPeriod] = useState('');
  const [clockStr, setClockStr] = useState('');

  useEffect(() => {
    const timer = setInterval(() => {
      const now = new Date();
      const istMs = now.getTime() + (5.5 * 3600 * 1000);
      const ist = new Date(istMs);

      const h = ist.getUTCHours(), m = ist.getUTCMinutes(), se = ist.getUTCSeconds();
      const totalSec = h * 3600 + m * 60 + se;
      const dur = 30; // 30s period
      const periodIdx = Math.floor(totalSec / dur) + 1;
      const elapsed = totalSec % dur;
      const secsLeft = dur - elapsed;

      const y = ist.getUTCFullYear();
      const mo = String(ist.getUTCMonth() + 1).padStart(2, '0');
      const d = String(ist.getUTCDate()).padStart(2, '0');
      const periodStr = `${y}${mo}${d}10005${String(periodIdx).padStart(5, '0')}`;

      const hh = String(h).padStart(2, '0');
      const mm = String(m).padStart(2, '0');
      const ss = String(se).padStart(2, '0');

      setSecondsLeft(secsLeft);
      setCurrentPeriod(periodStr);
      setClockStr(`${hh}:${mm}:${ss} IST`);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Auto Simulator Effect
  useEffect(() => {
    let interval = null;
    if (isSimulating) {
      interval = setInterval(() => {
        const num = Math.floor(Math.random() * 10);
        let color = 'red';
        if (num === 0) color = 'red-violet';
        else if (num === 5) color = 'green-violet';
        else if ([1, 3, 7, 9].includes(num)) color = 'green';

        const size = num >= 5 ? 'big' : 'small';
        const newPeriod = String(Date.now()).slice(-9);

        const newRound = {
          period: newPeriod,
          number: String(num),
          color,
          size,
          timestamp: new Date().toLocaleTimeString()
        };

        const actualColor = mapColor(color);
        const isWin = (actualColor === prediction.color);

        setBankroll(prevBank => {
          const betResult = calculateNextBet({
            bankroll: prevBank,
            baseBet,
            currentBet,
            consecutiveLosses,
            lastOutcome: isWin ? 'WIN' : 'LOSS',
            stakingStrategy,
            maxRecoveryLevel: 3,
            stopLossLimit,
            takeProfitLimit,
            initialBankroll: 1000
          });
          const payout = isWin ? currentBet * 0.96 : -currentBet;
          setCurrentBet(betResult.nextBet);
          setConsecutiveLosses(betResult.consecutiveLosses);
          return Math.max(0, Math.round(prevBank + payout));
        });

        setHistory(prev => [...prev, newRound]);
      }, 3000);
    }
    return () => clearInterval(interval);
  }, [isSimulating, baseBet, currentBet, consecutiveLosses, stakingStrategy, stopLossLimit, takeProfitLimit, prediction.color]);

  // Add Manual Entry Result
  const handleAddManualResult = (numberInput) => {
    const num = parseInt(numberInput, 10);
    if (isNaN(num) || num < 0 || num > 9) return;

    let color = 'red';
    if (num === 0) color = 'red-violet';
    else if (num === 5) color = 'green-violet';
    else if ([1, 3, 7, 9].includes(num)) color = 'green';

    const size = num >= 5 ? 'big' : 'small';
    const newPeriod = String(Date.now()).slice(-9);

    const newRound = {
      period: newPeriod,
      number: String(num),
      color,
      size,
      timestamp: new Date().toLocaleTimeString()
    };

    setHistory(prev => [...prev, newRound]);
    setManualNumber('');
  };

  // Import JSON / CSV History File
  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target.result;
        if (file.name.endsWith('.json')) {
          const parsed = JSON.parse(text);
          if (Array.isArray(parsed)) setHistory(parsed);
        } else if (file.name.endsWith('.csv')) {
          const lines = text.split('\n');
          const rounds = [];
          for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',');
            if (cols.length >= 3) {
              rounds.push({
                period: cols[0]?.trim(),
                number: cols[1]?.trim(),
                color: cols[2]?.trim(),
                size: cols[3]?.trim() || 'big',
                timestamp: cols[4]?.trim() || ''
              });
            }
          }
          if (rounds.length > 0) setHistory(rounds);
        }
      } catch (err) {
        alert('Error parsing file: ' + err.message);
      }
    };
    reader.readAsText(file);
  };

  const formattedMins = String(Math.floor(secondsLeft / 60)).padStart(2, '0');
  const formattedSecs = String(secondsLeft % 60).padStart(2, '0');

  return (
    <div style={{ padding: '24px', maxWidth: '1400px', margin: '0 auto' }}>
      
      {/* Header Bar */}
      <header className="glass-panel" style={{ padding: '20px 28px', marginBottom: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ background: 'linear-gradient(135deg, #10b981, #8b5cf6)', padding: '10px', borderRadius: '12px' }}>
            <Activity size={28} color="#fff" />
          </div>
          <div>
            <h1 style={{ fontSize: '24px', fontWeight: '800', letterSpacing: '-0.5px' }}>
              Color Analytics <span style={{ color: '#10b981' }}>& Risk Guard</span>
            </h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>
              Pattern Predictor • Markov Matrix • 3-Loss Circuit Breaker
            </p>
          </div>
        </div>

        {/* Time Remaining Widget & Bankroll Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
          <div style={{ textAlign: 'center', background: 'rgba(255,255,255,0.05)', padding: '8px 16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.1)' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: '600' }}>
              TIME LEFT ({currentPeriod ? currentPeriod.slice(-5) : '—'})
            </div>
            <div style={{ fontSize: '20px', fontWeight: '900', fontFamily: 'var(--font-mono)', color: secondsLeft <= 5 ? '#ef4444' : '#f59e0b' }}>
              {formattedMins}:{formattedSecs}
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{clockStr}</div>
          </div>

          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Current Bankroll</div>
            <div style={{ fontSize: '22px', fontWeight: '700', fontFamily: 'var(--font-mono)', color: bankroll >= 1000 ? '#10b981' : '#ef4444' }}>
              ${bankroll.toLocaleString()}
            </div>
          </div>

          <button 
            onClick={() => setIsSimulating(!isSimulating)}
            className="glass-panel"
            style={{ 
              padding: '12px 20px', 
              borderRadius: '10px', 
              background: isSimulating ? 'rgba(239, 68, 68, 0.2)' : 'rgba(16, 185, 129, 0.2)',
              borderColor: isSimulating ? '#ef4444' : '#10b981',
              color: '#fff',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              fontWeight: '600'
            }}
          >
            {isSimulating ? <Pause size={18} color="#ef4444" /> : <Play size={18} color="#10b981" />}
            {isSimulating ? 'Pause Live Simulator' : 'Start Live Simulator'}
          </button>
        </div>
      </header>

      {/* Main Grid Layout */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: '24px' }}>
        
        {/* Left Column: Prediction Signal & Pattern Dashboard */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          
          {/* Signal Header Card */}
          <div className="glass-panel animate-pulse-glow" style={{ padding: '24px', position: 'relative', overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
              <div>
                <span style={{ fontSize: '12px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '1px', color: 'var(--text-secondary)' }}>
                  RECOMMENDED NEXT OUTCOME
                </span>
                <h2 style={{ fontSize: '36px', fontWeight: '800', marginTop: '4px', textTransform: 'uppercase', color: prediction.color === 'green' ? '#10b981' : '#ef4444' }}>
                  PREDICT {prediction.color}
                </h2>
              </div>
              <div className={`badge-${prediction.color}`} style={{ padding: '10px 20px', borderRadius: '30px', fontWeight: '700', fontSize: '16px' }}>
                {prediction.confidence}% Confidence
              </div>
            </div>

            {/* Pattern Reason Alert */}
            <div style={{ background: 'rgba(255,255,255,0.04)', padding: '14px', borderRadius: '10px', fontSize: '14px', color: '#e5e7eb', marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <Zap size={18} color="#f59e0b" />
              <span>{prediction.reasoning}</span>
            </div>

            {/* Probability Progress Meters */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '6px' }}>
                  <span>Green Probability</span>
                  <span style={{ fontWeight: '700', color: '#10b981' }}>{prediction.greenProb}%</span>
                </div>
                <div style={{ background: 'rgba(255,255,255,0.1)', height: '8px', borderRadius: '4px', overflow: 'hidden' }}>
                  <div style={{ width: `${prediction.greenProb}%`, height: '100%', background: '#10b981', transition: 'width 0.3s' }}></div>
                </div>
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '6px' }}>
                  <span>Red Probability</span>
                  <span style={{ fontWeight: '700', color: '#ef4444' }}>{prediction.redProb}%</span>
                </div>
                <div style={{ background: 'rgba(255,255,255,0.1)', height: '8px', borderRadius: '4px', overflow: 'hidden' }}>
                  <div style={{ width: `${prediction.redProb}%`, height: '100%', background: '#ef4444', transition: 'width 0.3s' }}></div>
                </div>
              </div>
            </div>
          </div>

          {/* History Feed & Fast Input Bar */}
          <div className="glass-panel" style={{ padding: '24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3 style={{ fontSize: '18px', fontWeight: '700' }}>Recent Draw History ({history.length} Rounds)</h3>
              
              {/* Quick Draw Input */}
              <div style={{ display: 'flex', gap: '6px' }}>
                {[0,1,2,3,4,5,6,7,8,9].map(num => (
                  <button
                    key={num}
                    onClick={() => handleAddManualResult(num)}
                    style={{
                      width: '32px',
                      height: '32px',
                      borderRadius: '6px',
                      border: 'none',
                      background: num === 0 ? '#7c3aed' : num === 5 ? '#059669' : num % 2 === 0 ? '#dc2626' : '#059669',
                      color: '#fff',
                      fontWeight: '700',
                      cursor: 'pointer'
                    }}
                  >
                    {num}
                  </button>
                ))}
              </div>
            </div>

            {/* History Table */}
            <div style={{ maxHeight: '340px', overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '14px' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-card)', color: 'var(--text-secondary)' }}>
                    <th style={{ padding: '10px' }}>Period</th>
                    <th style={{ padding: '10px' }}>Number</th>
                    <th style={{ padding: '10px' }}>Color</th>
                    <th style={{ padding: '10px' }}>Size</th>
                    <th style={{ padding: '10px' }}>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {history.slice(-12).reverse().map((round, idx) => (
                    <tr key={idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                      <td style={{ padding: '10px', fontFamily: 'var(--font-mono)', fontSize: '13px' }}>{round.period}</td>
                      <td style={{ padding: '10px', fontWeight: '700' }}>{round.number}</td>
                      <td style={{ padding: '10px' }}>
                        <span style={{
                          padding: '4px 10px',
                          borderRadius: '12px',
                          fontSize: '12px',
                          fontWeight: '600',
                          background: round.color.includes('green') ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)',
                          color: round.color.includes('green') ? '#10b981' : '#ef4444'
                        }}>
                          {round.color.toUpperCase()}
                        </span>
                      </td>
                      <td style={{ padding: '10px', textTransform: 'uppercase', fontSize: '12px', color: 'var(--text-secondary)' }}>{round.size}</td>
                      <td style={{ padding: '10px', color: 'var(--text-muted)', fontSize: '12px' }}>{round.timestamp}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Right Column: Capital Protection & 3-Loss Circuit Breaker */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          
          {/* 3-Loss Circuit Breaker Card */}
          <div className="glass-panel" style={{ padding: '24px', borderColor: consecutiveLosses >= 2 ? '#ef4444' : 'var(--border-card)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
              <ShieldCheck size={24} color="#10b981" />
              <h3 style={{ fontSize: '18px', fontWeight: '700' }}>3-Loss Circuit Breaker</h3>
            </div>

            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
              Prevents exponential loss collapse (1-3-9-27 ruin). Automatically resets bet size to base after 3 losses.
            </p>

            {/* Consecutive Losses Indicator */}
            <div style={{ display: 'flex', gap: '8px', marginBottom: '20px' }}>
              {[1, 2, 3].map(lvl => (
                <div 
                  key={lvl} 
                  style={{
                    flex: 1,
                    padding: '12px',
                    borderRadius: '8px',
                    textAlign: 'center',
                    background: consecutiveLosses >= lvl ? 'rgba(239, 68, 68, 0.25)' : 'rgba(255, 255, 255, 0.05)',
                    border: `1px solid ${consecutiveLosses >= lvl ? '#ef4444' : 'transparent'}`,
                    fontWeight: '700',
                    fontSize: '14px',
                    color: consecutiveLosses >= lvl ? '#ef4444' : 'var(--text-muted)'
                  }}
                >
                  Loss #{lvl}
                </div>
              ))}
            </div>

            {/* Next Recommended Bet Size */}
            <div style={{ background: 'rgba(16, 185, 129, 0.08)', border: '1px dashed #10b981', padding: '16px', borderRadius: '12px', marginBottom: '20px' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>RECOMMENDED NEXT BET</div>
              <div style={{ fontSize: '28px', fontWeight: '800', fontFamily: 'var(--font-mono)', color: '#10b981' }}>
                ${currentBet} <span style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>({stakingStrategy.replace(/_/g, ' ')})</span>
              </div>
            </div>

            {/* Controls & Parameters */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div>
                <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Base Bet Amount ($)</label>
                <input 
                  type="number" 
                  value={baseBet} 
                  onChange={(e) => setBaseBet(Number(e.target.value))}
                  style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid var(--border-card)', background: 'rgba(0,0,0,0.3)', color: '#fff', marginTop: '4px' }}
                />
              </div>

              <div>
                <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Staking Strategy</label>
                <select 
                  value={stakingStrategy} 
                  onChange={(e) => setStakingStrategy(e.target.value)}
                  style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid var(--border-card)', background: 'rgba(0,0,0,0.3)', color: '#fff', marginTop: '4px' }}
                >
                  <option value="3_LOSS_SAFETY">3-Loss Safety Reset (Recommended)</option>
                  <option value="FLAT">Flat Staking (Lowest Risk)</option>
                  <option value="PAROLI">Paroli Progression (Win Streak)</option>
                </select>
              </div>
            </div>
          </div>

          {/* CSV / History Data Import Card */}
          <div className="glass-panel" style={{ padding: '24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
              <Upload size={20} color="#8b5cf6" />
              <h3 style={{ fontSize: '16px', fontWeight: '700' }}>Import History Log</h3>
            </div>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '14px' }}>
              Upload recorded `history.csv` or JSON datasets to analyze patterns offline.
            </p>
            <input 
              type="file" 
              accept=".csv,.json" 
              onChange={handleFileUpload} 
              style={{ fontSize: '13px', color: 'var(--text-secondary)' }}
            />
          </div>

        </div>
      </div>
    </div>
  );
}
