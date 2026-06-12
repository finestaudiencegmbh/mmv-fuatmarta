import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { fetchAllSheets, isConfigured } from './sheets.js';
import { parseSheets } from './parser.js';
import { buildDataset } from './build.js';
import { loadScoringConfig } from './scoring.js';
import { getSampleParsed } from './sample-data.js';
import { isSupermetricsConfigured, fetchFbInsights, aggregateFb } from './supermetrics.js';
import { isMetaConfigured, fetchMetaAll } from './meta.js';
import { combineMetaWithLeads } from './combine.js';
import { isChatConfigured, buildContext, chat } from './chat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 3000;
// Standard 15 Min: Ansehen/Tab-Wechsel/erneutes Öffnen kommt aus dem Cache und
// kostet keine Meta-Calls (schont das API-Rate-Limit). Der „Aktualisieren"-
// Button (refresh=1) umgeht den Cache und holt immer frische Daten.
const CACHE_TTL = (Number(process.env.CACHE_TTL_SECONDS) || 900) * 1000;

const app = express();
app.use(express.json());

// --- Optionaler Basic-Auth-Schutz -------------------------------------------
const AUTH_USER = process.env.DASHBOARD_USER;
const AUTH_PASS = process.env.DASHBOARD_PASSWORD;
if (AUTH_USER && AUTH_PASS) {
  app.use((req, res, next) => {
    // Health-Check muss ohne Login erreichbar sein (Render/Hoster prüfen ihn
    // ohne Zugangsdaten – sonst schlägt das Deployment fehl).
    if (req.path === '/api/health') return next();
    const hdr = req.headers.authorization || '';
    const [scheme, encoded] = hdr.split(' ');
    if (scheme === 'Basic' && encoded) {
      const [u, p] = Buffer.from(encoded, 'base64').toString().split(':');
      if (u === AUTH_USER && p === AUTH_PASS) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="MMV Dashboard"');
    return res.status(401).send('Authentifizierung erforderlich.');
  });
}

// --- Daten-Cache (je Zeitraum) ---------------------------------------------
const cache = new Map(); // key -> { at, payload }

async function loadDataset({ refresh = false, from = '', to = '' } = {}) {
  const key = `${from}|${to}`;
  const hit = cache.get(key);
  if (!refresh && hit && Date.now() - hit.at < CACHE_TTL) {
    return hit.payload;
  }
  const cfg = loadScoringConfig();
  let parsed;
  let source;
  if (isConfigured()) {
    const sheets = await fetchAllSheets();
    parsed = parseSheets(sheets);
    source = 'google';
  } else {
    parsed = getSampleParsed();
    source = 'demo';
  }
  const dataset = buildDataset(parsed, cfg);

  // Facebook-Ads-Daten: bevorzugt direkt über die Meta Marketing API,
  // alternativ über Supermetrics. Fehler hier dürfen das Sheet-Dashboard
  // nicht blockieren. Der Zeitraum (from/to) wird an Meta durchgereicht.
  const range = from && to ? { since: from, until: to } : null;
  const metaOn = isMetaConfigured();
  const smOn = isSupermetricsConfigured();
  let fb = { configured: metaOn || smOn, provider: metaOn ? 'meta' : smOn ? 'supermetrics' : null, error: null, totals: null, byDim: null, rows: 0, hierarchy: null, daily: null };
  if (metaOn) {
    try {
      const all = await fetchMetaAll(range);
      const agg = aggregateFb(all.records);
      // Leads für denselben Zeitraum, damit FB-Hierarchie & Leads konsistent sind
      const leadsInRange = filterLeadsByRange(dataset.leads, from, to);
      // Stunden-Raster, wenn genau ein Tag gewählt ist
      const hourlyDay = from && to && from === to ? from : null;
      const combined = combineMetaWithLeads(all, leadsInRange, { hourlyDay });
      fb = { configured: true, provider: 'meta', error: null, fetchedAt: new Date().toISOString(), ...agg, hierarchy: combined.hierarchy, daily: combined.daily, totals: combined.totals, nonLeadCampaigns: combined.nonLeadCampaigns, uocByDim: combined.uocByDim, dimMeta: combined.dimMeta, dailyByEntity: combined.dailyByEntity, intradayByEntity: combined.intradayByEntity, intradayDay: combined.intradayDay, accounts: all.accounts, accountsRequested: all.accountsRequested, accountErrors: all.accountErrors };
    } catch (err) {
      console.error('Meta-Fehler:', err.message);
      fb.error = err.message;
    }
  } else if (smOn) {
    try {
      const records = await fetchFbInsights();
      const agg = aggregateFb(records);
      fb = { configured: true, provider: 'supermetrics', error: null, fetchedAt: new Date().toISOString(), ...agg };
    } catch (err) {
      console.error('Supermetrics-Fehler:', err.message);
      fb.error = err.message;
    }
  }

  const payload = {
    source,
    fetchedAt: new Date().toISOString(),
    range: range || null,
    scoring: { weights: cfg.weights, tiers: cfg.tiers },
    fb,
    ...dataset,
  };
  cache.set(key, { at: Date.now(), payload });
  return payload;
}

/** Begrenzt Leads auf [from,to] (YYYY-MM-DD, inklusive). Tagesdatum = UTC,
 *  passend zum im Sheet angezeigten +0000-Zeitstempel. */
function filterLeadsByRange(leads, from, to) {
  if (!from && !to) return leads;
  return leads.filter((l) => {
    const day = (l.wonAt || '').slice(0, 10);
    if (!day) return false;
    if (from && day < from) return false;
    if (to && day > to) return false;
    return true;
  });
}

// --- API --------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, configured: isConfigured(), mode: isConfigured() ? 'google' : 'demo' });
});

app.get('/api/data', async (req, res) => {
  try {
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
    const from = isYmd(req.query.from) ? req.query.from : '';
    const to = isYmd(req.query.to) ? req.query.to : '';
    const payload = await loadDataset({ refresh, from, to });
    res.json(payload);
  } catch (err) {
    console.error('Fehler beim Laden der Daten:', err);
    res.status(500).json({ error: err.message, hint: 'Prüfe Service-Account & Freigabe des Sheets (siehe README).' });
  }
});

// Diagnose: wo steckt ein Creative/eine Ad in jeder Datenquelle?
// Aufruf: /api/debug/find?q=Video Ad #4
app.get('/api/debug/find', async (req, res) => {
  try {
    const q = String(req.query.q || '').toLowerCase().trim();
    if (!q) return res.json({ error: 'Bitte ?q=... angeben, z. B. /api/debug/find?q=Video Ad #4' });
    const has = (s) => String(s ?? '').toLowerCase().includes(q);

    // Sheet-Leads (kompletter Datensatz, ohne Zeitraum-Filter)
    const payload = await loadDataset({});
    const leads = payload.leads || [];
    const leadGroups = {};
    let leadCount = 0;
    for (const l of leads) {
      if (!(has(l.creative) || has(l.mediumRaw) || has(l.adset) || has(l.sourceRaw))) continue;
      leadCount += 1;
      const key = `${l.sourceType} | kampagne="${l.campaign}" | anzeigengruppe="${l.adset}" | creative="${l.creative}"`;
      leadGroups[key] = (leadGroups[key] || 0) + 1;
    }

    // Meta: Insights (Auslieferung im Lookback) + komplette Ad-Liste
    let metaInsights = [];
    let metaAdliste = [];
    if (isMetaConfigured()) {
      const all = await fetchMetaAll();
      metaInsights = (all.entities || [])
        .filter((e) => has(e.creative) || has(e.adset) || has(e.campaign))
        .map((e) => ({ account: e.account, kampagne: e.campaign, anzeigengruppe: e.adset, creative: e.creative, spend: e.spend }));
      metaAdliste = (all.adList || [])
        .filter((a) => has(a.name) || has(a.adset) || has(a.campaign))
        .map((a) => ({ name: a.name, kampagne: a.campaign, anzeigengruppe: a.adset, aktiv: a.active, status: a.status }));
    }

    res.json({
      suchbegriff: q,
      sheet_leads: { treffer: leadCount, gruppen: leadGroups },
      meta_insights: metaInsights,
      meta_adliste: metaAdliste,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/chat/health', (req, res) => {
  res.json({ configured: isChatConfigured() });
});

app.post('/api/chat', async (req, res) => {
  try {
    if (!isChatConfigured()) {
      return res.status(503).json({ error: 'Chatbot nicht konfiguriert (ANTHROPIC_API_KEY fehlt).' });
    }
    const { messages, from = '', to = '' } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages fehlt.' });
    }
    const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
    const payload = await loadDataset({ from: isYmd(from) ? from : '', to: isYmd(to) ? to : '' });
    const leadsInRange = filterLeadsByRange(payload.leads, isYmd(from) ? from : '', isYmd(to) ? to : '');
    const context = buildContext(payload, leadsInRange);
    const answer = await chat({ messages: messages.slice(-12), context });
    res.json({ answer });
  } catch (err) {
    console.error('Chat-Fehler:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Statisches Frontend (Production-Build) ---------------------------------
const distDir = path.join(ROOT, 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req, res) => res.sendFile(path.join(distDir, 'index.html')));
} else {
  app.get('/', (req, res) =>
    res
      .type('html')
      .send('<h1>MMV Dashboard – API läuft</h1><p>Frontend noch nicht gebaut. Im Dev: <code>npm run dev</code> und <a href="http://localhost:5173">localhost:5173</a> öffnen. Für Production: <code>npm run serve</code>.</p>')
  );
}

app.listen(PORT, () => {
  const mode = isConfigured() ? 'Google Sheets (live)' : 'DEMO (synthetische Daten)';
  console.log(`\n  MMV Dashboard-Server läuft auf  http://localhost:${PORT}`);
  console.log(`  Datenquelle: ${mode}\n`);
});
