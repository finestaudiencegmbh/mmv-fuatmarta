/**
 * Führt die Facebook-Kennzahlen (pro Ad) mit der Lead-/Ticket-Attribution aus
 * dem Sheet (über die UTM-Namen) zu einer verschachtelten Hierarchie zusammen:
 *
 *   Kampagne → Anzeigengruppe → Creative (Ad)
 *
 * Jede Ebene enthält:
 *   - aus Facebook:  Spend, Impressionen, CPM, individuell ausgehende Klicks,
 *                    individuell ausgehende CTR, individueller ausg. Klickpreis
 *   - aus dem Sheet: Leads, Tickets (via UTM-Attribution)
 *   - kombiniert:    CPL, Kosten/Ticket, LP-Conversion (= Leads ÷ individuell
 *                    ausgehende Klicks)
 *
 * Zusätzlich werden zwei Tagesreihen gebaut:
 *   - spend  (aus Facebook)
 *   - leads/tickets (aus dem Sheet, nach Lead-Datum)
 */

import { loadCampaignConfig, isLeadCampaign } from './campaigns.js';

// Normalisiert Namen fürs Matching FB <-> Sheet: vereinheitlicht Bindestriche
// (– — −  ->  -), entfernt "Kopie"/"Copy"-Suffixe (Sheet hat oft "… – Kopie",
// FB nicht) und kollabiert Whitespace.
const normKey = (s) =>
  String(s ?? '')
    .replace(/[‐-―−]/g, '-')        // diverse Bindestriche -> "-"
    .replace(/[\s-]*\b(kopie|copy)\b\s*\d*$/i, '')  // "– Kopie", "- Copy 2" am Ende weg
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

function emptyMetrics() {
  return { spend: 0, impressions: 0, clicks: 0, uoc: 0, leads: 0, tickets: 0, scoreSum: 0, scored: 0, qualified: 0 };
}

/** Leitet die abgeleiteten Kennzahlen aus den Rohsummen ab. */
function derive(m) {
  const cpm = m.impressions ? m.spend / (m.impressions / 1000) : null;
  const outboundCtr = m.impressions ? m.uoc / m.impressions : null; // individuell ausgehende CTR
  const cpoc = m.uoc ? m.spend / m.uoc : null; // individueller ausgehender Klickpreis
  const cpl = m.leads ? m.spend / m.leads : null;
  const cpt = m.tickets ? m.spend / m.tickets : null;
  const lpConversion = m.uoc ? m.leads / m.uoc : null; // = CVR Start (Leads ÷ individuell ausg. Klicks)
  return {
    spend: round2(m.spend),
    impressions: m.impressions,
    outboundClicks: m.uoc,
    cpm: round2(cpm),
    outboundCtr,
    cpoc: round2(cpoc),
    leads: m.leads,
    tickets: m.tickets,
    cpl: round2(cpl),
    cpt: round2(cpt),
    lpConversion,
    cvrStart: lpConversion,
    cvrTicket: m.leads ? m.tickets / m.leads : null, // Lead -> Ticket
    avgQuality: m.scored ? Math.round(m.scoreSum / m.scored) : null,
    qualifiedRate: m.tickets ? m.qualified / m.tickets : null,
  };
}

const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

// Hierarchischer Attributions-Schlüssel, damit gleichnamige Anzeigengruppen/
// Creatives in verschiedenen Kampagnen NICHT zusammengeworfen werden.
//   campaign:  Kampagne
//   adset:     Kampagne ▸ Anzeigengruppe
//   creative:  Kampagne ▸ Anzeigengruppe ▸ Creative
const PATH_SEP = '';
function pathKey(dim, { campaign, adset, creative }) {
  const c = normKey(campaign);
  if (dim === 'campaign') return c;
  const a = normKey(adset);
  if (dim === 'adset') return `${c}${PATH_SEP}${a}`;
  return `${c}${PATH_SEP}${a}${PATH_SEP}${normKey(creative)}`;
}

/**
 * @param {object} meta   Ergebnis aus fetchMetaAll() (entities, daily, status)
 * @param {array}  leads  Lead-Records aus buildDataset (mit campaign/adset/creative, wonAt, hasTicket)
 */
export function combineMetaWithLeads(meta, leads, opts = {}) {
  const { entities = [], daily = [], dailyEntities = [], campaignStatus = {}, adsetStatus = {}, adStatus = {} } = meta || {};

  // Meta listet ARCHIVIERTE Kampagnen/Anzeigengruppen/Ads standardmäßig NICHT im
  // Status-Endpoint, sie tauchen aber in den Insights auf (hatten Spend). Ein
  // Eintrag, der in den Insights vorkommt, aber im (erfolgreich geladenen) Status
  // FEHLT, ist daher archiviert/gelöscht -> als inaktiv werten. Nur wenn der
  // Status komplett leer ist (Abruf fehlgeschlagen), bleibt der Status unbekannt
  // (null), damit nie versehentlich ALLES ausgeblendet wird.
  const haveCampaignStatus = Object.keys(campaignStatus).length > 0;
  const haveAdsetStatus = Object.keys(adsetStatus).length > 0;
  const haveAdStatus = Object.keys(adStatus).length > 0;
  const resolveActive = (map, have, name) => {
    const s = map[name];
    if (s) return s.active;
    return have ? false : null;
  };
  const campCfg = loadCampaignConfig();

  // Lead-/Ticket-/Qualitäts-Zähler je Dimension. WICHTIG: HIERARCHISCH
  // geschlüsselt, damit ein Creative-/Anzeigengruppen-Name, der in mehreren
  // Kampagnen/Anzeigengruppen vorkommt (z. B. "Static #22 – Neu" bei CBO),
  // nicht alle gleichnamigen Leads einsammelt. Schlüssel:
  //   campaign:  Kampagne
  //   adset:     Kampagne ▸ Anzeigengruppe
  //   creative:  Kampagne ▸ Anzeigengruppe ▸ Creative
  const leafName = (dim, parts) => (dim === 'campaign' ? parts.campaign : dim === 'adset' ? parts.adset : parts.creative);
  // Leads werden nach der LEAD-UTM gezählt, Tickets/Qualität nach der TICKET-
  // EIGENEN UTM (ticketCampaign/-Adset/-Creative). So zählt ein Ticket genau
  // dort, wo es entstand – nicht in jeder Kampagne, in der die Person Lead war.
  const leadBy = { campaign: new Map(), adset: new Map(), creative: new Map() };
  const ticketBy = { campaign: new Map(), adset: new Map(), creative: new Map() };
  // Ticket-Dimensionen; fehlen sie (ältere/direkte Daten), Fallback auf Lead-Dim
  const tView = (l) => ({
    campaign: l.ticketCampaign ?? l.campaign,
    adset: l.ticketAdset ?? l.adset,
    creative: l.ticketCreative ?? l.creative,
  });
  for (const l of leads || []) {
    if (l.sourceType === 'paid') {
      for (const dim of ['campaign', 'adset', 'creative']) {
        if (!normKey(leafName(dim, l))) continue;
        const k = pathKey(dim, l);
        if (!leadBy[dim].has(k)) leadBy[dim].set(k, { leads: 0 });
        leadBy[dim].get(k).leads += 1;
      }
    }
    if (l.hasTicket) {
      const tv = tView(l);
      for (const dim of ['campaign', 'adset', 'creative']) {
        if (!normKey(leafName(dim, tv))) continue;
        const k = pathKey(dim, tv);
        if (!ticketBy[dim].has(k)) ticketBy[dim].set(k, { tickets: 0, scoreSum: 0, scored: 0, qualified: 0 });
        const e = ticketBy[dim].get(k);
        e.tickets += 1;
        if (l.quality) {
          e.scoreSum += l.quality.score;
          e.scored += 1;
          if (['A', 'B'].includes(l.quality.tier)) e.qualified += 1;
        }
      }
    }
  }
  const lookupLeads = (dim, parts) => {
    const L = leadBy[dim].get(pathKey(dim, parts)) || { leads: 0 };
    const T = ticketBy[dim].get(pathKey(dim, parts)) || { tickets: 0, scoreSum: 0, scored: 0, qualified: 0 };
    return { leads: L.leads, tickets: T.tickets, scoreSum: T.scoreSum, scored: T.scored, qualified: T.qualified };
  };

  // Hierarchie aufbauen: Kampagne -> Anzeigengruppe -> Ad
  const campaigns = new Map();
  for (const e of entities) {
    const cKey = normKey(e.campaign);
    if (!campaigns.has(cKey)) {
      const objective = campaignStatus[e.campaign]?.objective ?? null;
      campaigns.set(cKey, {
        id: e.campaignId,
        name: e.campaign,
        account: e.account ?? null,
        level: 'campaign',
        active: resolveActive(campaignStatus, haveCampaignStatus, e.campaign),
        status: campaignStatus[e.campaign]?.status ?? (haveCampaignStatus ? 'ARCHIVED' : null),
        objective,
        leadCampaign: isLeadCampaign(e.campaign, objective, campCfg),
        _m: emptyMetrics(),
        adsets: new Map(),
      });
    }
    const c = campaigns.get(cKey);
    const aKey = normKey(e.adset);
    if (!c.adsets.has(aKey)) {
      c.adsets.set(aKey, {
        id: e.adsetId,
        name: e.adset,
        level: 'adset',
        active: resolveActive(adsetStatus, haveAdsetStatus, e.adset),
        status: adsetStatus[e.adset]?.status ?? (haveAdsetStatus ? 'ARCHIVED' : null),
        _m: emptyMetrics(),
        ads: [],
      });
    }
    const a = c.adsets.get(aKey);

    // Ad-Ebene: FB-Kennzahlen direkt, Leads/Tickets/Qualität über den vollen
    // Pfad (Kampagne ▸ Anzeigengruppe ▸ Creative), nicht nur den Creative-Namen
    const adLeads = lookupLeads('creative', { campaign: e.campaign, adset: e.adset, creative: e.creative });
    const adM = {
      spend: e.spend,
      impressions: e.impressions,
      clicks: e.clicks,
      uoc: e.uniqueOutboundClicks,
      leads: adLeads.leads,
      tickets: adLeads.tickets,
      scoreSum: adLeads.scoreSum,
      scored: adLeads.scored,
      qualified: adLeads.qualified,
    };
    const adActive = resolveActive(adStatus, haveAdStatus, e.creative);
    a.ads.push({ id: e.adId, name: e.creative, level: 'ad', active: adActive, ...derive(adM) });

    // FB-Summen nach oben aggregieren
    for (const node of [a._m, c._m]) {
      node.spend += e.spend;
      node.impressions += e.impressions;
      node.clicks += e.clicks;
      node.uoc += e.uniqueOutboundClicks;
    }
  }

  // Leads/Tickets je Ebene aus der Sheet-Attribution (nicht aus Ad-Summe,
  // damit auch Leads ohne exakten Creative-Match auf Anzeigengruppen-/
  // Kampagnenebene korrekt erscheinen)
  const applyLeadStats = (m, src) => {
    m.leads = src.leads;
    m.tickets = src.tickets;
    m.scoreSum = src.scoreSum;
    m.scored = src.scored;
    m.qualified = src.qualified;
  };
  const result = [];
  for (const c of campaigns.values()) {
    applyLeadStats(c._m, lookupLeads('campaign', { campaign: c.name }));
    const adsets = [];
    for (const a of c.adsets.values()) {
      applyLeadStats(a._m, lookupLeads('adset', { campaign: c.name, adset: a.name }));
      adsets.push({
        id: a.id, name: a.name, level: 'adset', active: a.active, status: a.status,
        ...derive(a._m),
        ads: a.ads.sort((x, y) => y.spend - x.spend),
      });
    }
    result.push({
      id: c.id, name: c.name, account: c.account, level: 'campaign', active: c.active, status: c.status,
      objective: c.objective, leadCampaign: c.leadCampaign,
      ...derive(c._m),
      adsets: adsets.sort((x, y) => y.spend - x.spend),
    });
  }
  result.sort((x, y) => y.spend - x.spend);

  // Summen: gesamt vs. nur Lead-Kampagnen (für CPL/€-Ticket ohne Traffic-Spend)
  const totals = { spend: 0, leadSpend: 0, impressions: 0, outboundClicks: 0, leads: 0, tickets: 0, nonLeadSpend: 0 };
  for (const c of result) {
    totals.spend += c.spend || 0;
    totals.impressions += c.impressions || 0;
    totals.outboundClicks += c.outboundClicks || 0;
    totals.leads += c.leads || 0;
    totals.tickets += c.tickets || 0;
    if (c.leadCampaign) totals.leadSpend += c.spend || 0;
    else totals.nonLeadSpend += c.spend || 0;
  }
  totals.spend = round2(totals.spend);
  totals.leadSpend = round2(totals.leadSpend);
  totals.nonLeadSpend = round2(totals.nonLeadSpend);

  // Welche Kampagnen sind Nicht-Lead (Traffic etc.)? -> für Tagesreihen-Abzug
  const nonLeadCampaignKeys = new Set(result.filter((c) => !c.leadCampaign).map((c) => normKey(c.name)));

  // Tagesreihen
  const spendByDay = daily.map((d) => ({ date: d.date, spend: round2(d.spend), impressions: d.impressions, clicks: d.clicks }));

  const leadDay = new Map();
  for (const l of leads || []) {
    const day = (l.wonAt || '').slice(0, 10);
    if (!day) continue;
    if (!leadDay.has(day)) leadDay.set(day, { date: day, leads: 0, tickets: 0 });
    const e = leadDay.get(day);
    e.leads += 1;
    if (l.hasTicket) e.tickets += 1;
  }
  const leadsByDay = [...leadDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1));

  // Individuell ausgehende Klicks je Dimension (für CTR/CPC/CVR-Start in der
  // "Performance nach Ebene"-Tabelle), Schlüssel normalisiert.
  const uocByDim = { campaign: {}, adset: {}, creative: {} };
  for (const e of entities) {
    const add = (bucket, name) => {
      const k = normKey(name);
      if (!k) return;
      bucket[k] = (bucket[k] || 0) + (e.uniqueOutboundClicks || 0);
    };
    add(uocByDim.campaign, e.campaign);
    add(uocByDim.adset, e.adset);
    add(uocByDim.creative, e.creative);
  }

  // Pro Dimension (campaign/adset/creative): FB-Kennzahlen + Status + Lead-Stats,
  // damit das Frontend AUCH pausierte Einträge ohne Leads anzeigen kann (grau).
  const dimMeta = { campaign: {}, adset: {}, creative: {} };
  const ensure = (dim, name, { active = null, parents = {} } = {}) => {
    const k = normKey(name);
    if (!k) return null;
    if (!dimMeta[dim][k]) {
      dimMeta[dim][k] = { name, spend: 0, impressions: 0, clicks: 0, uoc: 0, active, parents };
    }
    if (active != null) dimMeta[dim][k].active = active;
    return dimMeta[dim][k];
  };
  for (const e of entities) {
    const cActive = resolveActive(campaignStatus, haveCampaignStatus, e.campaign);
    const aActive = resolveActive(adsetStatus, haveAdsetStatus, e.adset);
    const adRaw = resolveActive(adStatus, haveAdStatus, e.creative);
    const adActive = adRaw == null ? aActive : adRaw; // echter Ad-Status, sonst von Anzeigengruppe
    const buckets = [
      ensure('campaign', e.campaign, { active: cActive }),
      ensure('adset', e.adset, { active: aActive, parents: { campaign: e.campaign } }),
      ensure('creative', e.creative, { active: adActive, parents: { campaign: e.campaign, adset: e.adset } }),
    ];
    for (const b of buckets) {
      if (!b) continue;
      b.spend += e.spend || 0;
      b.impressions += e.impressions || 0;
      b.clicks += e.clicks || 0;
      b.uoc += e.uniqueOutboundClicks || 0;
    }
  }

  // Tagesreihen JE Entität (Kampagne/Anzeigengruppe/Creative) für die
  // "Grafik"-Ansicht: FB-Tagesdaten + Plattform-Split + Sheet-Leads/Tickets/
  // Qualität, alles je Tag. Schlüssel = normalisierter Name.
  const dailyByEntity = buildDailyByEntity(dailyEntities, leads || []);

  // Minutengenaue Events je Entität (nur Sheet-KPIs: Leads/Tickets/Qualität),
  // wenn der Zeitraum genau EIN Tag ist. Meta-Spend ist hier (noch) nicht dabei.
  const intradayByEntity = opts.hourlyDay ? buildIntradayByEntity(leads || [], opts.hourlyDay) : null;

  return {
    hierarchy: result,
    totals,
    uocByDim,
    dimMeta,
    dailyByEntity,
    intradayByEntity,
    intradayDay: opts.hourlyDay || null,
    nonLeadCampaigns: result.filter((c) => !c.leadCampaign).map((c) => ({ name: c.name, objective: c.objective, spend: c.spend })),
    daily: { spend: spendByDay, leads: leadsByDay },
  };
}

/**
 * Baut je Dimension (campaign/adset/creative) und je normalisiertem Namen eine
 * sortierte Tagesreihe mit FB-Rohwerten (spend/impressions/clicks/uoc + Spend
 * pro Plattform) und Sheet-Werten (leads/tickets/quality). Das Frontend leitet
 * daraus die überlagerbaren KPIs ab (CPL, CPM, CTR, CPC, €/Ticket, Qualität …).
 */
function buildDailyByEntity(dailyEntities, leads) {
  const dims = ['campaign', 'adset', 'creative'];
  const fb = { campaign: new Map(), adset: new Map(), creative: new Map() };
  const ensureDay = (map, key, date) => {
    if (!map.has(key)) map.set(key, new Map());
    const days = map.get(key);
    if (!days.has(date)) days.set(date, { spend: 0, impressions: 0, clicks: 0, uoc: 0, platforms: {} });
    return days.get(date);
  };
  for (const r of dailyEntities) {
    if (!r.date) continue;
    for (const dim of dims) {
      if (!normKey(r[dim])) continue; // Blatt-Name vorhanden?
      const key = pathKey(dim, r);
      const d = ensureDay(fb[dim], key, r.date);
      d.spend += r.spend || 0;
      d.impressions += r.impressions || 0;
      d.clicks += r.clicks || 0;
      d.uoc += r.uoc || 0;
      if (r.platform) d.platforms[r.platform] = (d.platforms[r.platform] || 0) + (r.spend || 0);
    }
  }

  const sheet = { campaign: new Map(), adset: new Map(), creative: new Map() };
  const ensureLeadDay = (map, key, date) => {
    if (!map.has(key)) map.set(key, new Map());
    const days = map.get(key);
    if (!days.has(date)) days.set(date, { leads: 0, tickets: 0, scoreSum: 0, scored: 0, qualified: 0 });
    return days.get(date);
  };
  for (const l of leads) {
    // Leads nach Lead-Dimensionen (Lead-Datum)
    if (l.sourceType === 'paid') {
      const day = (l.wonAt || '').slice(0, 10);
      if (day) {
        for (const dim of dims) {
          if (!normKey(l[dim])) continue;
          ensureLeadDay(sheet[dim], pathKey(dim, l), day).leads += 1;
        }
      }
    }
    // Tickets/Qualität nach TICKET-Dimensionen (Ticket-Datum)
    if (l.hasTicket) {
      const tday = (l.ticketAt || l.wonAt || '').slice(0, 10);
      const tv = { campaign: l.ticketCampaign ?? l.campaign, adset: l.ticketAdset ?? l.adset, creative: l.ticketCreative ?? l.creative };
      if (tday) {
        for (const dim of dims) {
          const leaf = dim === 'campaign' ? tv.campaign : dim === 'adset' ? tv.adset : tv.creative;
          if (!normKey(leaf)) continue;
          const d = ensureLeadDay(sheet[dim], pathKey(dim, tv), tday);
          d.tickets += 1;
          if (l.quality) {
            d.scoreSum += l.quality.score;
            d.scored += 1;
            if (['A', 'B'].includes(l.quality.tier)) d.qualified += 1;
          }
        }
      }
    }
  }

  const out = { campaign: {}, adset: {}, creative: {} };
  for (const dim of dims) {
    const keys = new Set([...fb[dim].keys(), ...sheet[dim].keys()]);
    for (const key of keys) {
      const fbDays = fb[dim].get(key);
      const shDays = sheet[dim].get(key);
      const dates = new Set([...(fbDays?.keys() || []), ...(shDays?.keys() || [])]);
      out[dim][key] = [...dates].sort().map((date) => {
        const f = fbDays?.get(date) || { spend: 0, impressions: 0, clicks: 0, uoc: 0, platforms: {} };
        const s = shDays?.get(date) || { leads: 0, tickets: 0, scoreSum: 0, scored: 0, qualified: 0 };
        return {
          date,
          spend: round2(f.spend),
          impressions: f.impressions,
          uoc: f.uoc,
          platforms: f.platforms,
          leads: s.leads,
          tickets: s.tickets,
          quality: s.scored ? Math.round(s.scoreSum / s.scored) : null,
        };
      });
    }
  }
  return out;
}

/**
 * Minutengenaue Lead-Events je Entität für einen einzelnen Tag (Sheet-KPIs only).
 * Pro Entität eine SPARSE Liste echter Leads: [{ m, ticket, quality }] mit
 * m = Minute des Tages (0–1439). Das Frontend baut daraus die Ausschlag-Linie.
 * Die Minute wird 1:1 aus dem Zeitstempel genommen – die Sheet-Zeit ist bereits
 * deutsche Ortszeit (per Zapier gesetzt), daher KEINE Zeitzonen-Umrechnung.
 */
function buildIntradayByEntity(leads, day) {
  const dims = ['campaign', 'adset', 'creative'];
  const out = { campaign: {}, adset: {}, creative: {} };
  for (const l of leads) {
    if (l.sourceType !== 'paid') continue;
    if ((l.wonAt || '').slice(0, 10) !== day) continue;
    const h = Number(String(l.wonAt).slice(11, 13));
    const min = Number(String(l.wonAt).slice(14, 16));
    if (!Number.isFinite(h) || !Number.isFinite(min)) continue;
    const m = h * 60 + min;
    if (!(m >= 0 && m < 1440)) continue;
    const ev = { m, ticket: Boolean(l.hasTicket), quality: l.quality ? l.quality.score : null };
    for (const dim of dims) {
      if (!normKey(l[dim])) continue;
      const key = pathKey(dim, l);
      (out[dim][key] || (out[dim][key] = [])).push(ev);
    }
  }
  for (const dim of dims) for (const key of Object.keys(out[dim])) out[dim][key].sort((a, b) => a.m - b.m);
  return out;
}
