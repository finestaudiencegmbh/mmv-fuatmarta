import React, { useState, useMemo } from 'react';
import { fmtEur, fmtEur2, fmtInt, fmtPct, fmtScore } from '../lib.js';

/**
 * "Grafik"-Panel: Zeitreihe je Entität (Kampagne/Anzeigengruppe/Creative) mit
 * überlagerbaren KPIs. Jede KPI hat eine eigene Skala (Normalisierung auf das
 * eigene Maximum), damit z. B. Leads + CPL + CTR gemeinsam darstellbar sind.
 * series = [{ date, spend, impressions, uoc, leads, tickets, quality, platforms }]
 */

// KPI-Katalog: value() leitet den Tageswert aus einem Datenpunkt ab,
// total() den Periodenwert aus den Roh-Summen (für die Legende).
const KPIS = [
  { key: 'leads', label: 'Leads', color: '#d0bb5a', fmt: fmtInt, sheet: true,
    value: (p) => p.leads,
    total: (t) => t.leads },
  { key: 'tickets', label: 'Tickets', color: '#6fcf97', fmt: fmtInt, sheet: true,
    value: (p) => p.tickets,
    total: (t) => t.tickets },
  { key: 'quality', label: 'Lead-Qualität', color: '#6dd47e', fmt: fmtScore, sheet: true,
    value: (p) => p.quality,
    total: (t) => (t.qLeads ? Math.round(t.qSum / t.qLeads) : null) },
  { key: 'spend', label: 'Adspend', color: '#9db4e8', fmt: fmtEur,
    value: (p) => p.spend,
    total: (t) => t.spend },
  { key: 'cpl', label: 'CPL (€/Lead)', color: '#5ad0c0', fmt: fmtEur2,
    value: (p) => (p.leads ? p.spend / p.leads : null),
    total: (t) => (t.leads ? t.spend / t.leads : null) },
  { key: 'cpt', label: 'Kosten/Ticket', color: '#f2b705', fmt: fmtEur2,
    value: (p) => (p.tickets ? p.spend / p.tickets : null),
    total: (t) => (t.tickets ? t.spend / t.tickets : null) },
  { key: 'cpm', label: 'CPM', color: '#7c9cff', fmt: fmtEur2,
    value: (p) => (p.impressions ? p.spend / (p.impressions / 1000) : null),
    total: (t) => (t.impressions ? t.spend / (t.impressions / 1000) : null) },
  { key: 'ctr', label: 'CTR (ausg.)', color: '#e07a5f', fmt: fmtPct,
    value: (p) => (p.impressions ? p.uoc / p.impressions : null),
    total: (t) => (t.impressions ? t.uoc / t.impressions : null) },
  { key: 'cpc', label: 'CPC (ausg.)', color: '#c08adb', fmt: fmtEur2,
    value: (p) => (p.uoc ? p.spend / p.uoc : null),
    total: (t) => (t.uoc ? t.spend / t.uoc : null) },
];

const PLATFORM_COLORS = ['#4267B2', '#E1306C', '#0a84ff', '#25D366', '#ff7849', '#9b59b6'];
const platformLabel = (p) => ({ facebook: 'Facebook', instagram: 'Instagram', audience_network: 'Audience Network', messenger: 'Messenger', whatsapp: 'WhatsApp', unknown: 'Unbekannt' }[p] || (p ? p.charAt(0).toUpperCase() + p.slice(1) : 'Unbekannt'));

export default function GraphPanel({ title, levelLabel, series, hourly = false, onClose }) {
  // Im Stunden-Modus (1 Tag) nur Sheet-KPIs – Meta-Spend ist noch nicht stündlich.
  const kpiList = hourly ? KPIS.filter((k) => k.sheet) : KPIS;
  // Standard: Leads + CPL (Tag) bzw. Leads (Stunde)
  const [active, setActive] = useState(() => new Set(hourly ? ['leads'] : ['leads', 'cpl']));
  const [showPlatforms, setShowPlatforms] = useState(false);

  const toggle = (key) => setActive((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });

  // Plattformen, die in der Zeitreihe vorkommen
  const platforms = useMemo(() => {
    const set = new Set();
    (series || []).forEach((p) => Object.keys(p.platforms || {}).forEach((k) => { if ((p.platforms[k] || 0) > 0) set.add(k); }));
    return [...set].sort();
  }, [series]);

  // Periodensummen für die Legenden-Werte
  const totals = useMemo(() => {
    const t = { spend: 0, impressions: 0, uoc: 0, leads: 0, tickets: 0, qSum: 0, qLeads: 0, platforms: {} };
    (series || []).forEach((p) => {
      t.spend += p.spend || 0; t.impressions += p.impressions || 0; t.uoc += p.uoc || 0;
      t.leads += p.leads || 0; t.tickets += p.tickets || 0;
      if (p.quality != null && p.leads) { t.qSum += p.quality * p.leads; t.qLeads += p.leads; }
      Object.entries(p.platforms || {}).forEach(([k, v]) => { t.platforms[k] = (t.platforms[k] || 0) + (v || 0); });
    });
    return t;
  }, [series]);

  // Aktive Serien zusammenbauen (KPIs + ggf. Plattform-Spend)
  const chartSeries = useMemo(() => {
    const out = [];
    kpiList.forEach((k) => {
      if (!active.has(k.key)) return;
      out.push({
        key: k.key, label: k.label, color: k.color, fmt: k.fmt,
        agg: k.total(totals),
        data: (series || []).map((p) => ({ date: p.date, value: k.value(p) })),
      });
    });
    if (showPlatforms && !hourly) {
      platforms.forEach((pf, i) => {
        out.push({
          key: `pf_${pf}`, label: `Spend ${platformLabel(pf)}`, color: PLATFORM_COLORS[i % PLATFORM_COLORS.length], fmt: fmtEur,
          agg: totals.platforms[pf] || 0,
          data: (series || []).map((p) => ({ date: p.date, value: (p.platforms || {})[pf] ?? null })),
        });
      });
    }
    return out;
  }, [active, showPlatforms, platforms, series, totals, kpiList, hourly]);

  return (
    <div className="graph-overlay" onClick={onClose}>
      <div className="graph-modal" onClick={(e) => e.stopPropagation()}>
        <div className="graph-head">
          <div className="graph-titles">
            <span className="graph-level">{levelLabel}</span>
            <h3 className="graph-title" title={title}>{title}</h3>
          </div>
          <button className="graph-close" onClick={onClose} aria-label="Schließen">✕</button>
        </div>

        <div className="graph-kpis">
          {kpiList.map((k) => (
            <button key={k.key} className={`kpi-chip ${active.has(k.key) ? 'on' : ''}`} onClick={() => toggle(k.key)} style={active.has(k.key) ? { borderColor: k.color, color: k.color } : undefined}>
              <span className="kpi-dot" style={{ background: k.color }} />{k.label}
            </button>
          ))}
          {!hourly && platforms.length > 0 && (
            <button className={`kpi-chip ${showPlatforms ? 'on' : ''}`} onClick={() => setShowPlatforms((v) => !v)} style={showPlatforms ? { borderColor: '#4267B2', color: '#9db4e8' } : undefined}>
              <span className="kpi-dot" style={{ background: '#4267B2' }} />Spend pro Plattform
            </button>
          )}
        </div>

        {hourly && <div className="graph-hint">Tagesverlauf minutengenau (0–24 Uhr) · Linie schlägt bei jedem Lead aus. Ad-Spend-KPIs folgen – aktuell Leads, Tickets &amp; Lead-Qualität.</div>}
        <OverlayChart series={chartSeries} hourly={hourly} />
      </div>
    </div>
  );
}

/** SVG-Chart mit pro Serie eigener Skala (Normalisierung auf eigenes Max). */
function OverlayChart({ series, hourly = false }) {
  const [hover, setHover] = useState(null);
  const fmtX = hourly ? fmtHourLabel : fmtDay;

  const model = useMemo(() => {
    const dateSet = new Set();
    series.forEach((s) => s.data.forEach((d) => dateSet.add(d.date)));
    const dates = [...dateSet].sort();
    const w = 820, h = 300, pad = { l: 14, r: 14, t: 16, b: 28 };
    const plotW = w - pad.l - pad.r, plotH = h - pad.t - pad.b;
    const x = (i) => pad.l + (dates.length <= 1 ? plotW / 2 : (i / (dates.length - 1)) * plotW);
    const prepared = series.map((s) => {
      const m = new Map(s.data.map((d) => [d.date, d.value]));
      const vals = dates.map((dt) => { const v = m.get(dt); return v == null || Number.isNaN(v) ? null : v; });
      const max = Math.max(1e-9, ...vals.filter((v) => v != null));
      const y = (v) => pad.t + plotH - (v / max) * plotH;
      const pts = vals.map((v, i) => (v == null ? null : { x: x(i), y: y(v), v, i }));
      return { ...s, pts, max };
    });
    return { dates, prepared, w, h, pad, plotW, plotH, x };
  }, [series]);

  const { dates, prepared, w, h, pad, plotH, x } = model;

  if (series.length === 0) {
    return <div className="graph-chart"><div className="chart-empty">Wähle oben eine oder mehrere Kennzahlen aus.</div></div>;
  }
  if (dates.length === 0) {
    return <div className="graph-chart"><div className="chart-empty">Keine Daten für diesen Zeitraum.</div></div>;
  }

  const pick = (clientX, target) => {
    const rect = target.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * w;
    let best = 0, bestD = Infinity;
    dates.forEach((_, i) => { const d = Math.abs(x(i) - px); if (d < bestD) { bestD = d; best = i; } });
    setHover(best);
  };

  // Liniensegmente, die über null-Lücken hinweg unterbrochen werden
  const pathFor = (pts) => {
    let d = '', pen = false;
    pts.forEach((p) => {
      if (!p) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${p.x},${p.y} `;
      pen = true;
    });
    return d.trim();
  };

  return (
    <div className="graph-chart">
      <div className="chart-legend graph-legend">
        {prepared.map((s) => (
          <span key={s.key} className="legend-item">
            <span className="legend-dot" style={{ background: s.color }} />{s.label}
            <strong className="legend-agg" style={{ color: s.color }}>{s.fmt(s.agg)}</strong>
          </span>
        ))}
      </div>
      <div className="chart-wrap">
        <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="chart-svg"
          onMouseMove={(e) => pick(e.clientX, e.currentTarget)} onMouseLeave={() => setHover(null)}
          onTouchStart={(e) => e.touches[0] && pick(e.touches[0].clientX, e.currentTarget)}
          onTouchMove={(e) => e.touches[0] && pick(e.touches[0].clientX, e.currentTarget)}
          style={{ touchAction: 'pan-y' }}>
          {[0, 0.25, 0.5, 0.75, 1].map((f, i) => {
            const yy = pad.t + plotH - f * plotH;
            return <line key={i} x1={pad.l} y1={yy} x2={w - pad.r} y2={yy} className="chart-grid" />;
          })}
          {prepared.map((s) => (
            <path key={s.key} d={pathFor(s.pts)} fill="none" stroke={s.color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {hover != null && <line x1={x(hover)} y1={pad.t} x2={x(hover)} y2={pad.t + plotH} className="chart-hover-line" />}
          {hover != null && prepared.map((s) => s.pts[hover] && (
            <circle key={s.key} cx={s.pts[hover].x} cy={s.pts[hover].y} r="4" fill={s.color} stroke="#0b0b14" strokeWidth="1.5" />
          ))}
          {Array.from({ length: 5 }, (_, k) => Math.round((k * (dates.length - 1)) / 4)).filter((v, i, a) => a.indexOf(v) === i).map((i) => (
            <text key={i} x={x(i)} y={h - 8} className="chart-axis" textAnchor="middle">{fmtX(dates[i])}</text>
          ))}
        </svg>
        {hover != null && (() => {
          const frac = x(hover) / w;
          // Randabhängig ausrichten, damit der Tooltip nicht abgeschnitten wird
          const align = frac > 0.7 ? 'right' : frac < 0.3 ? 'left' : 'center';
          const left = align === 'right' ? 'auto' : align === 'left' ? `${frac * 100}%` : `${frac * 100}%`;
          const style = align === 'right'
            ? { right: `${(1 - frac) * 100}%`, transform: 'translateX(0)' }
            : align === 'left'
            ? { left, transform: 'translateX(0)' }
            : { left, transform: 'translateX(-50%)' };
          return (
          <div className="chart-tooltip" style={style}>
            <div className="tt-date">{fmtX(dates[hover])}</div>
            {prepared.map((s) => (
              <div key={s.key} className="tt-row"><span className="legend-dot" style={{ background: s.color }} />{s.label}: <strong>{s.pts[hover] ? s.fmt(s.pts[hover].v) : '–'}</strong></div>
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
  const [, m, d] = iso.split('-');
  return `${d}.${m}.`;
}

/** Minuten-Key "2026-06-01T16:36" -> "16:36". */
function fmtHourLabel(key) {
  return String(key ?? '').slice(11, 16);
}
