import React, { useState, useMemo } from 'react';
import TimeChart from './TimeChart.jsx';
import { fmtClock } from '../lib.js';

const WINDOWS = [
  { label: 'Ganzer Tag', size: 0 },
  { label: '6 h', size: 360 },
  { label: '3 h', size: 180 },
  { label: '1 h', size: 60 },
];

const clock = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/**
 * Tagesverlauf-Chart mit Zeitfenster-Zoom (Ganzer Tag / 6h / 3h / 1h + Blättern).
 * series: [{ key, label, color, data: [{date, value}] }] mit minutengenauen
 * Bucket-Keys ("YYYY-MM-DDTHH:MM"). Filtert die Daten auf das gewählte Fenster.
 */
export default function IntradayChart({ title, series, formatY }) {
  const [winSize, setWinSize] = useState(0); // Minuten, 0 = ganzer Tag
  const [winStart, setWinStart] = useState(0);
  const winCount = winSize ? Math.ceil(1440 / winSize) : 1;
  const winIdx = winSize ? Math.floor(winStart / winSize) : 0;
  const step = (dir) => setWinStart((s) => Math.min(Math.max(0, s + dir * winSize), (winCount - 1) * winSize));
  const inWindow = (key) => {
    if (!winSize) return true;
    const m = Number(String(key).slice(11, 13)) * 60 + Number(String(key).slice(14, 16));
    return m >= winStart && m < winStart + winSize;
  };
  const view = useMemo(
    () => series.map((s) => ({ ...s, data: winSize ? s.data.filter((d) => inWindow(d.date)) : s.data })),
    [series, winSize, winStart]
  );

  return (
    <div>
      <div className="graph-window">
        <div className="win-sizes">
          {WINDOWS.map((w) => (
            <button key={w.size} className={`win-btn ${winSize === w.size ? 'on' : ''}`} onClick={() => { setWinSize(w.size); setWinStart(0); }}>{w.label}</button>
          ))}
        </div>
        {winSize > 0 && (
          <div className="win-nav">
            <button className="win-arrow" onClick={() => step(-1)} disabled={winIdx === 0} aria-label="Früher">◀</button>
            <span className="win-range">{clock(winStart)}–{clock(Math.min(1440, winStart + winSize))} Uhr</span>
            <button className="win-arrow" onClick={() => step(1)} disabled={winIdx >= winCount - 1} aria-label="Später">▶</button>
          </div>
        )}
      </div>
      <TimeChart title={title} series={view} formatY={formatY} formatX={fmtClock} />
    </div>
  );
}
