import React, { useState, useMemo } from 'react';

/**
 * Leichtgewichtiger SVG-Zeitreihen-Graph (keine Library).
 * series: [{ key, label, color, data: [{date, value}] }]
 * Tooltip beim Überfahren zeigt alle Serien für den jeweiligen Tag.
 */
export default function TimeChart({ title, series, formatY = (v) => v, formatX = fmtDay, height = 220 }) {
  const [hover, setHover] = useState(null);

  const { dates, points, maxY, pad, w, h, plotW, plotH } = useMemo(() => {
    const dateSet = new Set();
    series.forEach((s) => s.data.forEach((d) => dateSet.add(d.date)));
    const dates = [...dateSet].sort();
    const byDate = series.map((s) => {
      const m = new Map(s.data.map((d) => [d.date, d.value]));
      return dates.map((dt) => m.get(dt) ?? 0);
    });
    const maxY = Math.max(1, ...byDate.flat());
    const w = 760;
    const h = height;
    const pad = { l: 52, r: 16, t: 14, b: 30 };
    const plotW = w - pad.l - pad.r;
    const plotH = h - pad.t - pad.b;
    const x = (i) => pad.l + (dates.length <= 1 ? plotW / 2 : (i / (dates.length - 1)) * plotW);
    const y = (v) => pad.t + plotH - (v / maxY) * plotH;
    const points = series.map((s, si) => byDate[si].map((v, i) => ({ x: x(i), y: y(v), v })));
    return { dates, points, maxY, pad, w, h, plotW, plotH, x, y };
  }, [series, height]);

  if (dates.length === 0) {
    return (
      <div className="chart-card">
        <div className="chart-title">{title}</div>
        <div className="chart-empty">Keine Daten für die aktuelle Auswahl.</div>
      </div>
    );
  }

  const xAt = (i) => pad.l + (dates.length <= 1 ? plotW / 2 : (i / (dates.length - 1)) * plotW);
  const yTicks = 4;
  const pick = (clientX, currentTarget) => {
    const rect = currentTarget.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * w;
    let best = 0;
    let bestD = Infinity;
    dates.forEach((_, i) => {
      const d = Math.abs(xAt(i) - px);
      if (d < bestD) { bestD = d; best = i; }
    });
    setHover(best);
  };
  const onMove = (e) => pick(e.clientX, e.currentTarget);
  const onTouch = (e) => {
    if (e.touches && e.touches[0]) { pick(e.touches[0].clientX, e.currentTarget); }
  };

  return (
    <div className="chart-card">
      <div className="chart-head">
        <div className="chart-title">{title}</div>
        <div className="chart-legend">
          {series.map((s) => (
            <span key={s.key} className="legend-item"><span className="legend-dot" style={{ background: s.color }} />{s.label}</span>
          ))}
        </div>
      </div>
      <div className="chart-wrap">
        <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="chart-svg" onMouseMove={onMove} onMouseLeave={() => setHover(null)} onTouchStart={onTouch} onTouchMove={onTouch} style={{ touchAction: 'pan-y' }}>
          {/* horizontale Gitterlinien + Y-Beschriftung */}
          {Array.from({ length: yTicks + 1 }).map((_, i) => {
            const val = (maxY / yTicks) * i;
            const yy = pad.t + plotH - (val / maxY) * plotH;
            return (
              <g key={i}>
                <line x1={pad.l} y1={yy} x2={w - pad.r} y2={yy} className="chart-grid" />
                <text x={pad.l - 8} y={yy + 4} className="chart-axis" textAnchor="end">{formatY(val)}</text>
              </g>
            );
          })}
          {/* Flächen + Linien */}
          {series.map((s, si) => {
            const pts = points[si];
            const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
            const area = `${line} L${pts[pts.length - 1].x},${pad.t + plotH} L${pts[0].x},${pad.t + plotH} Z`;
            return (
              <g key={s.key}>
                <path d={area} fill={s.color} opacity="0.12" />
                <path d={line} fill="none" stroke={s.color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
                {hover != null && <circle cx={pts[hover].x} cy={pts[hover].y} r="4" fill={s.color} stroke="#0b0b14" strokeWidth="1.5" />}
              </g>
            );
          })}
          {/* Hover-Linie */}
          {hover != null && <line x1={xAt(hover)} y1={pad.t} x2={xAt(hover)} y2={pad.t + plotH} className="chart-hover-line" />}
          {/* X-Beschriftung: erste, mittlere, letzte */}
          {Array.from({ length: 5 }, (_, k) => Math.round((k * (dates.length - 1)) / 4)).filter((v, i, a) => a.indexOf(v) === i).map((i) => (
            <text key={i} x={xAt(i)} y={h - 8} className="chart-axis" textAnchor="middle">{formatX(dates[i])}</text>
          ))}
        </svg>
        {hover != null && (() => {
          const frac = xAt(hover) / w;
          // Randabhängig ausrichten, damit der Tooltip nicht abgeschnitten wird
          const style = frac > 0.7
            ? { right: `${(1 - frac) * 100}%`, transform: 'translateX(0)' }
            : frac < 0.3
            ? { left: `${frac * 100}%`, transform: 'translateX(0)' }
            : { left: `${frac * 100}%`, transform: 'translateX(-50%)' };
          return (
          <div className="chart-tooltip" style={style}>
            <div className="tt-date">{formatX(dates[hover])}</div>
            {series.map((s, si) => (
              <div key={s.key} className="tt-row"><span className="legend-dot" style={{ background: s.color }} />{s.label}: <strong>{formatY(points[si][hover].v)}</strong></div>
            ))}
          </div>
          );
        })()}
      </div>
    </div>
  );
}

function fmtDay(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.`;
}
