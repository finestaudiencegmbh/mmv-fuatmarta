// ---- Formatierung ----------------------------------------------------------
const eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const eur2 = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const intf = new Intl.NumberFormat('de-DE');

export const fmtEur = (n) => (n == null || Number.isNaN(n) ? '–' : eur.format(n));
export const fmtEur2 = (n) => (n == null || Number.isNaN(n) ? '–' : eur2.format(n));
export const fmtInt = (n) => (n == null ? '–' : intf.format(n));
export const fmtPct = (n) => (n == null || Number.isNaN(n) ? '–' : `${(n * 100).toFixed(1)} %`);
export const fmtScore = (n) => (n == null ? '–' : String(Math.round(n)));
export const fmtDate = (iso) => {
  if (!iso) return '–';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '–' : d.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
};

// Tagesschlüssel = UTC-Datum aus dem Zeitstempel. Das entspricht exakt dem im
// Sheet angezeigten Datum (+0000), sodass die Tageszahlen mit dem Sheet
// übereinstimmen.
export const dayKey = (iso) => (iso ? String(iso).slice(0, 10) : '');

// ---- Filterung -------------------------------------------------------------
export const DIMENSIONS = [
  { key: 'campaign', label: 'Kampagne' },
  { key: 'adset', label: 'Anzeigengruppe' },
  { key: 'creative', label: 'Creative' },
  { key: 'placement', label: 'Placement' },
];

export function uniqueValues(leads, key) {
  return [...new Set(leads.map((l) => l[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
}

export function answerValues(leads, answerKey) {
  return [
    ...new Set(
      leads
        .filter((l) => l.answers && l.answers[answerKey])
        .map((l) => l.answers[answerKey])
    ),
  ].sort((a, b) => a.localeCompare(b, 'de'));
}

export function applyFilters(leads, f) {
  return leads.filter((l) => {
    if (f.sourceType !== 'all' && l.sourceType !== f.sourceType) return false;
    if (f.campaign && l.campaign !== f.campaign) return false;
    if (f.adset && l.adset !== f.adset) return false;
    if (f.creative && l.creative !== f.creative) return false;
    if (f.placement && l.placement !== f.placement) return false;
    if (f.onlyTickets && !l.hasTicket) return false;
    if (f.employment && l.answers?.employment !== f.employment) return false;
    if (f.income && l.answers?.income !== f.income) return false;
    if (f.realEstate && l.answers?.realEstate !== f.realEstate) return false;
    if (f.tiers && f.tiers.length) {
      const tier = l.quality?.tier;
      const ok = (tier && f.tiers.includes(tier)) || (!tier && f.tiers.includes('none'));
      if (!ok) return false;
    }
    // Datumsbereich: konsistent mit dem Server. Bei gesetztem Zeitraum werden
    // Leads ohne gültiges Datum ausgeschlossen.
    if (f.from || f.to) {
      const day = dayKey(l.wonAt);
      if (!day) return false;
      if (f.from && day < f.from) return false;
      if (f.to && day > f.to) return false;
    }
    if (f.search) {
      const hay = `${l.name} ${l.email} ${l.creative} ${l.adset}`.toLowerCase();
      if (!hay.includes(f.search.toLowerCase())) return false;
    }
    return true;
  });
}

// ---- Aggregation -----------------------------------------------------------
// Matching FB <-> Sheet: Bindestrich-Varianten vereinheitlichen, "Kopie"/"Copy"-
// Suffix entfernen (Sheet hat oft "… – Kopie", FB nicht), Whitespace kollabieren.
export const normKey = (s) =>
  String(s ?? '')
    .replace(/[‐-―−]/g, '-')
    .replace(/[\s-]*\b(kopie|copy)\b\s*\d*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

// Hierarchischer Schlüssel (muss mit server/combine.js pathKey übereinstimmen):
// campaign / Kampagne▸Anzeigengruppe / Kampagne▸Anzeigengruppe▸Creative.
const PATH_SEP = '';
export function entityKey(dim, { campaign, adset, creative } = {}) {
  const c = normKey(campaign);
  if (dim === 'campaign') return c;
  const a = normKey(adset);
  if (dim === 'adset') return `${c}${PATH_SEP}${a}`;
  return `${c}${PATH_SEP}${a}${PATH_SEP}${normKey(creative)}`;
}

function spendForAdsets(adsetNames, overviewByAdset) {
  let sum = 0;
  let any = false;
  for (const name of adsetNames) {
    const o = overviewByAdset[name.toLowerCase()];
    if (o && o.adspend != null) {
      sum += o.adspend;
      any = true;
    }
  }
  return any ? sum : null;
}

/**
 * Verdichtet die (gefilterten) Leads nach einer Dimension.
 * Spend/Impressionen/Klicks kommen – sofern vorhanden – aus den Facebook-
 * Daten (Supermetrics) je Dimension. Fällt darauf zurück: Adspend je
 * Anzeigengruppe aus der Sheet-Übersicht (nur Kampagne/Anzeigengruppe).
 */
export function aggregate(leads, dimKey, overviewByAdset, fb, filters = {}, opts = {}) {
  const { addFbRows = true } = opts; // FB-only-Zeilen (pausierte/leere Kampagnen) ergänzen?
  const fbDim = addFbRows ? (fb?.byDim?.[dimKey] || null) : null;
  const groups = new Map();
  for (const l of leads) {
    const k = l[dimKey] || '(unbekannt)';
    if (!groups.has(k)) groups.set(k, { key: k, leads: [], adsets: new Set() });
    const g = groups.get(k);
    g.leads.push(l);
    if (l.adset) g.adsets.add(l.adset);
  }

  const rows = [];
  for (const g of groups.values()) {
    const total = g.leads.length;
    const ticketLeads = g.leads.filter((l) => l.hasTicket);
    const tickets = ticketLeads.length;
    const scored = ticketLeads.filter((l) => l.quality);
    const avgQuality = scored.length
      ? Math.round(scored.reduce((s, l) => s + l.quality.score, 0) / scored.length)
      : null;
    const qualified = ticketLeads.filter((l) => ['A', 'B'].includes(l.quality?.tier)).length;

    const dm = addFbRows ? (fb?.dimMeta?.[dimKey]?.[normKey(g.key)] || null) : null;
    const m = fbDim ? fbDim[normKey(g.key)] : null;
    let spend = m ? m.spend : (dm ? dm.spend : null);
    if (addFbRows && spend == null && (dimKey === 'adset' || dimKey === 'campaign')) {
      spend = spendForAdsets([...g.adsets], overviewByAdset);
    }
    const impressions = (m ? m.impressions : null) ?? (dm ? dm.impressions : null);
    const clicks = (m ? m.clicks : null) ?? (dm ? dm.clicks : null);
    const uoc = addFbRows ? (fb?.uocByDim?.[dimKey]?.[normKey(g.key)] ?? (dm ? dm.uoc : null)) : null;

    rows.push(makeRow({ key: g.key, total, tickets, avgQuality, qualified, spend, impressions, clicks, uoc, active: dm ? dm.active : null }));
  }

  // Pausierte/aktive FB-Einträge OHNE Leads im Zeitraum ergänzen, damit auch
  // ausgeschaltete Kampagnen/Anzeigengruppen sichtbar bleiben (grau).
  // Nur im Paid-Container (addFbRows). Respektiert die Drill-Down-Filterung.
  const dm = addFbRows ? (fb?.dimMeta?.[dimKey] || null) : null;
  if (dm) {
    const existing = new Set([...groups.keys()].map((g) => normKey(g)));
    for (const [k, meta] of Object.entries(dm)) {
      if (existing.has(k)) continue;
      // Parent-Filter prüfen (Kampagne/Anzeigengruppe), wenn gesetzt
      if (filters.campaign && meta.parents?.campaign && normKey(meta.parents.campaign) !== normKey(filters.campaign)) continue;
      if (filters.adset && meta.parents?.adset && normKey(meta.parents.adset) !== normKey(filters.adset)) continue;
      const uoc = fb?.uocByDim?.[dimKey]?.[k] ?? meta.uoc ?? null;
      rows.push(makeRow({ key: meta.name, total: 0, tickets: 0, avgQuality: null, qualified: 0, spend: meta.spend, impressions: meta.impressions, clicks: meta.clicks, uoc, active: meta.active }));
    }
  }
  return rows;
}

/** Baut eine Ergebniszeile inkl. abgeleiteter Kennzahlen. */
function makeRow({ key, total, tickets, avgQuality, qualified, spend, impressions, clicks, uoc, active }) {
  return {
    key,
    active,
    leads: total,
    tickets,
    ticketRate: total ? tickets / total : null,
    avgQuality,
    qualified,
    qualifiedRate: tickets ? qualified / tickets : null,
    spend,
    impressions,
    clicks,
    outboundClicks: uoc,
    cpm: impressions ? (spend ?? 0) / (impressions / 1000) : null,
    outboundCtr: impressions && uoc != null ? uoc / impressions : null,
    cpoc: uoc ? (spend ?? 0) / uoc : null,
    cvrStart: uoc ? total / uoc : null,
    cpl: spend != null && total ? spend / total : null,
    cpt: spend != null && tickets ? spend / tickets : null,
  };
}

export function computeKpis(leads, overviewByAdset, fb) {
  const total = leads.length;
  const paid = leads.filter((l) => l.sourceType === 'paid');
  const organic = leads.filter((l) => l.sourceType !== 'paid');

  // Tickets getrennt nach Quelle
  const paidTickets = paid.filter((l) => l.hasTicket);
  const organicTickets = organic.filter((l) => l.hasTicket);
  const ticketLeads = leads.filter((l) => l.hasTicket);

  // Qualität: über alle bewerteten Tickets (Antworten kommen aus dem Sheet,
  // unabhängig von der Quelle)
  const scored = ticketLeads.filter((l) => l.quality);
  const qualified = ticketLeads.filter((l) => ['A', 'B'].includes(l.quality?.tier)).length;

  let spend = fb?.totals?.spend ?? null;
  let impressions = fb?.totals?.impressions ?? null;
  if (spend == null) {
    const adsets = new Set(paid.map((l) => l.adset));
    spend = spendForAdsets([...adsets], overviewByAdset);
  }
  // CPL & Kosten/Ticket nur auf Lead-Kampagnen-Spend (ohne Traffic) UND nur
  // auf BEZAHLTE Leads/Tickets beziehen – Spend gibt es nur für Paid, daher
  // dürfen organische Leads den CPL nicht verwässern.
  const leadSpend = fb?.totals?.leadSpend ?? spend;
  const nonLeadSpend = fb?.totals?.nonLeadSpend ?? 0;
  return {
    total,
    paid: paid.length,
    organic: organic.length,
    paidTickets: paidTickets.length,
    organicTickets: organicTickets.length,
    paidTicketRate: paid.length ? paidTickets.length / paid.length : null,
    organicTicketRate: organic.length ? organicTickets.length / organic.length : null,
    tickets: ticketLeads.length,
    ticketRate: total ? ticketLeads.length / total : null,
    avgQuality: scored.length ? Math.round(scored.reduce((s, l) => s + l.quality.score, 0) / scored.length) : null,
    qualified,
    qualifiedRate: ticketLeads.length ? qualified / ticketLeads.length : null,
    spend,
    leadSpend,
    nonLeadSpend,
    impressions,
    // Denominator = bezahlte Leads/Tickets (nicht alle), da Spend nur Paid ist
    cpl: leadSpend != null && paid.length ? leadSpend / paid.length : null,
    cpt: leadSpend != null && paidTickets.length ? leadSpend / paidTickets.length : null,
  };
}

/** Tägliche Leads/Tickets aus (gefilterten) Leads – für den Verlaufs-Graphen. */
export function leadsByDay(leads) {
  const m = new Map();
  for (const l of leads) {
    const day = dayKey(l.wonAt);
    if (!day) continue;
    if (!m.has(day)) m.set(day, { date: day, leads: 0, tickets: 0 });
    const e = m.get(day);
    e.leads += 1;
    if (l.hasTicket) e.tickets += 1;
  }
  return [...m.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** Minute des Tages (0–1439) aus dem Zeitstempel. Die Zeit im Sheet ist bereits
 * deutsche Ortszeit (per Zapier +2h gesetzt), daher 1:1 übernommen – KEINE
 * Zeitzonen-Umrechnung. */
export const minuteOf = (iso) => {
  const s = String(iso ?? '');
  const h = Number(s.slice(11, 13));
  const m = Number(s.slice(14, 16));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  const mm = h * 60 + m;
  return mm >= 0 && mm < 1440 ? mm : null;
};

/** Bucket-Key für eine Minute des Tages: "2026-06-01T16:36". */
const minuteKey = (day, m) => `${day}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** 1440 Minuten-Buckets eines Tages (leere = 0), damit die Linie bei jedem Lead
 * ausschlägt und dazwischen auf 0 liegt. fill(events) bekommt je Eintrag einen
 * Bucket. */
function emptyMinuteBuckets(day) {
  return Array.from({ length: 1440 }, (_, m) => ({ date: minuteKey(day, m), leads: 0, tickets: 0, scoreSum: 0, scored: 0 }));
}
function finalizeMinuteBuckets(buckets) {
  return buckets.map((b) => ({ date: b.date, leads: b.leads, tickets: b.tickets, quality: b.scored ? Math.round(b.scoreSum / b.scored) : null }));
}

/**
 * Verlauf nach Zeit. Bei hourlyDay = 'YYYY-MM-DD' werden minutengenaue Buckets
 * dieses Tages gebildet (Ausschlag-Linie, 0 zwischen Leads). Sonst Tagesreihe.
 */
export function leadsByTime(leads, hourlyDay = null) {
  if (!hourlyDay) return leadsByDay(leads);
  const buckets = emptyMinuteBuckets(hourlyDay);
  for (const l of leads) {
    if (dayKey(l.wonAt) !== hourlyDay) continue;
    const m = minuteOf(l.wonAt);
    if (m == null) continue;
    buckets[m].leads += 1;
    if (l.hasTicket) buckets[m].tickets += 1;
    if (l.quality) { buckets[m].scoreSum += l.quality.score; buckets[m].scored += 1; }
  }
  return finalizeMinuteBuckets(buckets);
}

/** Baut minutengenaue Buckets aus serverseitigen Events [{ m, ticket, quality }]
 * (für das Grafik-Panel je Entität). */
export function minuteSeriesFromEvents(events, day) {
  const buckets = emptyMinuteBuckets(day);
  for (const e of events || []) {
    const b = buckets[e.m];
    if (!b) continue;
    b.leads += 1;
    if (e.ticket) b.tickets += 1;
    if (e.quality != null) { b.scoreSum += e.quality; b.scored += 1; }
  }
  return finalizeMinuteBuckets(buckets);
}

/** Formatiert einen Minuten-Bucket-Key ("2026-06-01T16:36") als "16:36". */
export const fmtClock = (key) => String(key ?? '').slice(11, 16);

/**
 * CPL pro Tag = Ad-Spend (FB) ÷ bezahlte Leads (Sheet) je Tag.
 * spendDaily: [{date, spend}] aus fb.daily.spend; leads: gefilterte Leads.
 */
export function cplByDay(spendDaily, leads) {
  const paidPerDay = new Map();
  for (const l of leads) {
    if (l.sourceType !== 'paid') continue;
    const day = dayKey(l.wonAt);
    if (!day) continue;
    paidPerDay.set(day, (paidPerDay.get(day) || 0) + 1);
  }
  return (spendDaily || [])
    .map((d) => {
      const n = paidPerDay.get(d.date) || 0;
      return { date: d.date, value: n ? d.spend / n : null };
    });
}

/**
 * Lead-Qualität pro Tag = Anteil qualifizierter Tickets (Tier A/B) an allen
 * Tickets des Tages. Nur Tage MIT Tickets, damit der Verlauf nicht künstlich
 * auf 0 fällt. value als Bruch (0..1).
 */
export function qualityByDay(leads) {
  const m = new Map();
  for (const l of leads) {
    if (!l.hasTicket) continue;
    const day = dayKey(l.wonAt);
    if (!day) continue;
    if (!m.has(day)) m.set(day, { date: day, tickets: 0, qualified: 0 });
    const e = m.get(day);
    e.tickets += 1;
    if (['A', 'B'].includes(l.quality?.tier)) e.qualified += 1;
  }
  return [...m.values()]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((e) => ({ date: e.date, value: e.tickets ? e.qualified / e.tickets : null }));
}

export function tierDistribution(leads, tiers) {
  const dist = {};
  for (const t of tiers) dist[t.key] = 0;
  dist.none = 0;
  for (const l of leads.filter((x) => x.hasTicket)) {
    const k = l.quality?.tier || 'none';
    dist[k] = (dist[k] || 0) + 1;
  }
  return dist;
}

/**
 * Zählt Leads je Rohwert eines UTM-Feldes (für den Quellen-Tab).
 * field: 'sourceRaw' | 'campaignRaw' | 'creativeRaw' (siehe unten).
 * Liefert sortierte Liste [{ key, count }] absteigend.
 */
export function groupCount(leads, getKey, { limit = 0, emptyLabel = '(direkt)' } = {}) {
  const m = new Map();
  for (const l of leads) {
    const raw = getKey(l);
    const key = raw && String(raw).trim() ? String(raw).trim() : emptyLabel;
    m.set(key, (m.get(key) || 0) + 1);
  }
  let arr = [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
  if (limit > 0) arr = arr.slice(0, limit);
  return arr;
}
