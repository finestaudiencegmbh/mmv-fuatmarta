import React, { useState, useRef, useEffect } from 'react';

// ---- Datums-Helfer (lokale Zeit, ohne Bibliothek) --------------------------
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const startOfWeek = (d) => { const x = new Date(d); const wd = (x.getDay() + 6) % 7; return addDays(x, -wd); }; // Mo
const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const endOfMonth = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0);

const fmtDE = (s) => { if (!s) return ''; const [y, m, d] = s.split('-'); return `${d}.${m}.${y}`; };

/** Liefert {from,to} für ein Preset relativ zu heute. */
function presetRange(key) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const y = addDays(today, -1);
  switch (key) {
    case 'today': return [today, today];
    case 'yesterday': return [y, y];
    case 'last7': return [addDays(today, -6), today];
    case 'last14': return [addDays(today, -13), today];
    case 'last28': return [addDays(today, -27), today];
    case 'last30': return [addDays(today, -29), today];
    case 'thisWeek': return [startOfWeek(today), today];
    case 'lastWeek': { const s = addDays(startOfWeek(today), -7); return [s, addDays(s, 6)]; }
    case 'thisMonth': return [startOfMonth(today), today];
    case 'lastMonth': { const s = startOfMonth(addDays(startOfMonth(today), -1)); return [s, endOfMonth(s)]; }
    case 'maximum': return [null, null];
    default: return [null, null];
  }
}

const PRESETS = [
  { key: 'maximum', label: 'Maximum' },
  { key: 'today', label: 'Heute' },
  { key: 'yesterday', label: 'Gestern' },
  { key: 'last7', label: 'Letzte 7 Tage' },
  { key: 'last14', label: 'Letzte 14 Tage' },
  { key: 'last28', label: 'Letzte 28 Tage' },
  { key: 'last30', label: 'Letzte 30 Tage' },
  { key: 'thisWeek', label: 'Diese Woche' },
  { key: 'lastWeek', label: 'Letzte Woche' },
  { key: 'thisMonth', label: 'Dieser Monat' },
  { key: 'lastMonth', label: 'Letzter Monat' },
];

const WD = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

function MonthGrid({ view, from, to, onPick }) {
  const first = startOfMonth(view);
  const lead = (first.getDay() + 6) % 7; // Mo=0
  const days = endOfMonth(view).getDate();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(new Date(view.getFullYear(), view.getMonth(), d));

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const inRange = (d) => from && to && ymd(d) >= from && ymd(d) <= to;
  const isEnd = (d) => (from && ymd(d) === from) || (to && ymd(d) === to);
  const isFuture = (d) => d > today;

  return (
    <div className="dp-month">
      <div className="dp-month-title">{MONTHS[view.getMonth()]} {view.getFullYear()}</div>
      <div className="dp-grid">
        {WD.map((w) => <div key={w} className="dp-wd">{w}</div>)}
        {cells.map((d, i) => d ? (
          <button
            key={i}
            className={`dp-day ${inRange(d) ? 'in' : ''} ${isEnd(d) ? 'end' : ''} ${isFuture(d) ? 'future' : ''}`}
            disabled={isFuture(d)}
            onClick={() => !isFuture(d) && onPick(d)}
          >{d.getDate()}</button>
        ) : <span key={i} className="dp-empty" />)}
      </div>
    </div>
  );
}

export default function DateRangePicker({ from, to, onApply }) {
  const [open, setOpen] = useState(false);
  const [tmpFrom, setTmpFrom] = useState(from || '');
  const [tmpTo, setTmpTo] = useState(to || '');
  const [view, setView] = useState(() => (to ? startOfMonth(parse(to)) : startOfMonth(new Date())));
  const ref = useRef(null);

  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  useEffect(() => { if (open) { setTmpFrom(from || ''); setTmpTo(to || ''); } }, [open, from, to]);

  const pick = (d) => {
    const s = ymd(d);
    if (!tmpFrom || (tmpFrom && tmpTo)) { setTmpFrom(s); setTmpTo(''); return; }
    if (s < tmpFrom) { setTmpTo(tmpFrom); setTmpFrom(s); } else { setTmpTo(s); }
  };

  const applyPreset = (key) => {
    const [a, b] = presetRange(key);
    if (!a) { setTmpFrom(''); setTmpTo(''); onApply({ from: '', to: '' }); setOpen(false); return; }
    setTmpFrom(ymd(a)); setTmpTo(ymd(b));
    setView(startOfMonth(b));
  };

  const apply = () => { const to = tmpTo || tmpFrom; onApply({ from: tmpFrom, to }); setOpen(false); };

  const label = from && to ? `${fmtDE(from)} – ${fmtDE(to)}` : 'Maximum (gesamter Zeitraum)';
  const prevView = startOfMonth(addDays(startOfMonth(view), -1));
  // Nicht in die Zukunft blättern: 'view' (rechter Monat) zeigt nie über den aktuellen Monat hinaus
  const thisMonth = startOfMonth(new Date());
  const atCurrentMonth = view.getFullYear() === thisMonth.getFullYear() && view.getMonth() === thisMonth.getMonth();

  return (
    <div className="dp" ref={ref}>
      <button className="dp-trigger" onClick={() => setOpen((v) => !v)}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" />
        </svg>
        {label}
        <svg className="dp-chev" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>

      {open && (
        <div className="dp-pop">
          <div className="dp-body">
            <div className="dp-presets">
              {PRESETS.map((p) => {
                const [a, b] = presetRange(p.key);
                const active = (!a && !tmpFrom && !tmpTo) || (a && tmpFrom === ymd(a) && tmpTo === ymd(b));
                return (
                  <button key={p.key} className={`dp-preset ${active ? 'active' : ''}`} onClick={() => applyPreset(p.key)}>
                    <span className="dp-radio" />{p.label}
                  </button>
                );
              })}
            </div>
            <div className="dp-cal">
              <div className="dp-cal-head">
                <button className="dp-nav" onClick={() => setView(prevView)} aria-label="zurück">‹</button>
                <button className="dp-nav" disabled={atCurrentMonth} onClick={() => !atCurrentMonth && setView(startOfMonth(addDays(endOfMonth(view), 1)))} aria-label="vor">›</button>
              </div>
              <div className="dp-months">
                <MonthGrid view={prevView} from={tmpFrom} to={tmpTo} onPick={pick} />
                <MonthGrid view={view} from={tmpFrom} to={tmpTo} onPick={pick} />
              </div>
            </div>
          </div>
          <div className="dp-footer">
            <span className="dp-range-label">{tmpFrom ? `${fmtDE(tmpFrom)} – ${tmpTo ? fmtDE(tmpTo) : fmtDE(tmpFrom)}` : 'Maximum'}</span>
            <div className="dp-actions">
              <button className="ghost-btn" onClick={() => setOpen(false)}>Abbrechen</button>
              <button className="refresh-btn" onClick={apply}>Aktualisieren</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
