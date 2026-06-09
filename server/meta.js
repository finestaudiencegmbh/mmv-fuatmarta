/**
 * Facebook/Meta Marketing API – holt Ad-Insights direkt über den Graph-API-
 * Access-Token. Liefert:
 *   - records:  Placement-Ebene (Ad × publisher_platform × platform_position)
 *               für die bestehende Dimensions-Aggregation (aggregateFb)
 *   - entities: Kennzahlen je Ad inkl. IDs + Hierarchie + INDIVIDUELL
 *               ausgehende Klicks/CTR/Klickpreis (unique_outbound_*)
 *   - daily:    täglicher Ad-Spend/Impressionen/Klicks (für den Zeitgraphen)
 *   - status:   effective_status je Kampagne und Anzeigengruppe (aktiv?)
 *
 * Benötigte .env:
 *   META_ACCESS_TOKEN   – Access-Token mit ads_read
 *   META_AD_ACCOUNT_ID  – Werbekonto, z. B. act_367913946654819
 * Optional:
 *   META_API_VERSION    – Graph-API-Version (Default v21.0)
 *   META_LOOKBACK_DAYS  – Zeitfenster in Tagen (Default 90)
 */

const GRAPH = 'https://graph.facebook.com';

export function isMetaConfigured() {
  return Boolean(process.env.META_ACCESS_TOKEN && process.env.META_AD_ACCOUNT_ID);
}

const ymd = (d) => d.toISOString().slice(0, 10);

function normAccount(id) {
  const s = String(id || '').trim();
  return s.startsWith('act_') ? s : `act_${s}`;
}

/** Position lesbar machen (z. B. "feed", "instagram_stories" -> "instagram stories"). */
function positionLabel(position) {
  return String(position || '').trim().replace(/_/g, ' ');
}

/** Meta liefert action-basierte Felder als Array [{action_type, value}]. Summe der Werte. */
function actionSum(field, type = 'outbound_click') {
  if (!Array.isArray(field)) return 0;
  let sum = 0;
  for (const a of field) {
    if (!type || a.action_type === type) sum += Number(a.value) || 0;
  }
  return sum;
}

function cfg() {
  return {
    token: process.env.META_ACCESS_TOKEN,
    account: normAccount(accountIds()[0] || ''),
    version: process.env.META_API_VERSION || 'v21.0',
    lookback: Number(process.env.META_LOOKBACK_DAYS) || 90,
  };
}

/** Liest ein ODER mehrere Werbekonten aus META_AD_ACCOUNT_ID (kommagetrennt). */
function accountIds() {
  return String(process.env.META_AD_ACCOUNT_ID || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normAccount);
}

function dateRange(lookback) {
  const end = new Date();
  const start = new Date(end.getTime() - lookback * 86400000);
  return { since: ymd(start), until: ymd(end) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Rate-Limit-Codes von Meta (4 = App-Limit, 17 = User-Limit, 613 = Custom-Limit)
const RATE_LIMIT_CODES = new Set([4, 17, 613, 80000, 80004]);

/** Generischer paginierter GET gegen die Graph API, mit Retry bei Rate-Limit
 * UND bei Netzwerkfehlern ("fetch failed", Verbindungsabbruch, Timeout). */
async function graphGet(url) {
  const out = [];
  let next = url;
  let guard = 0;
  while (next && guard < 60) {
    guard += 1;
    let json = null;
    // bis zu 4 Versuche – bei Rate-Limit (Code 4 etc.) UND bei Netzwerkfehlern,
    // mit ansteigender Wartezeit. So überstehen wir transiente Abbrüche.
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(next);
        json = await res.json().catch(() => null);
        if (!json) throw new Error(`Meta: unerwartete Antwort (HTTP ${res.status})`);
        if (json.error && RATE_LIMIT_CODES.has(json.error.code)) {
          if (attempt < 3) { await sleep(2000 * (attempt + 1)); continue; }
        }
        break; // Erfolg oder nicht-retrybarer Meta-Fehler
      } catch (err) {
        // Netzwerk-/Parsing-Fehler -> erneut versuchen, sonst durchreichen
        if (attempt < 3) { await sleep(1500 * (attempt + 1)); json = null; continue; }
        throw err;
      }
    }
    if (json.error) {
      const e = json.error;
      throw new Error(`Meta-Fehler: ${e.message}${e.code ? ` (Code ${e.code})` : ''}`);
    }
    for (const row of json.data || []) out.push(row);
    next = json.paging?.next || null;
  }
  return out;
}

function insightsUrl({ account, version, token }, extra) {
  const params = new URLSearchParams({ access_token: token, limit: '500', ...extra });
  return `${GRAPH}/${version}/${account}/insights?${params.toString()}`;
}

/** Placement-Ebene (für die Dimensions-Tabellen Kampagne/Anzeigengruppe/Creative/Placement). */
async function fetchPlacementRecords(c, range) {
  const rows = await graphGet(
    insightsUrl(c, {
      level: 'ad',
      fields: 'campaign_name,adset_name,ad_name,spend,impressions,clicks,reach',
      breakdowns: 'publisher_platform,platform_position',
      time_range: JSON.stringify(range),
    })
  );
  return rows.map((r) => ({
    campaign: String(r.campaign_name ?? '').trim(),
    adset: String(r.adset_name ?? '').trim(),
    creative: String(r.ad_name ?? '').trim(),
    platform: String(r.publisher_platform ?? '').trim(),
    placement: positionLabel(r.platform_position),
    spend: Number(r.spend) || 0,
    impressions: Number(r.impressions) || 0,
    clicks: Number(r.clicks) || 0,
    reach: Number(r.reach) || 0,
  }));
}

/** Kennzahlen je Ad inkl. IDs und individuell ausgehender Metriken. */
async function fetchEntities(c, range) {
  const rows = await graphGet(
    insightsUrl(c, {
      level: 'ad',
      fields:
        'campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,clicks,cpm,unique_outbound_clicks,unique_outbound_clicks_ctr,cost_per_unique_outbound_click',
      time_range: JSON.stringify(range),
      time_increment: 'all_days',
    })
  );
  return rows.map((r) => ({
    campaignId: r.campaign_id,
    campaign: String(r.campaign_name ?? '').trim(),
    adsetId: r.adset_id,
    adset: String(r.adset_name ?? '').trim(),
    adId: r.ad_id,
    creative: String(r.ad_name ?? '').trim(),
    spend: Number(r.spend) || 0,
    impressions: Number(r.impressions) || 0,
    clicks: Number(r.clicks) || 0,
    cpm: Number(r.cpm) || 0,
    // INDIVIDUELL ausgehende Klicks (unique_outbound_clicks)
    uniqueOutboundClicks: actionSum(r.unique_outbound_clicks),
    uniqueOutboundCtr: actionSum(r.unique_outbound_clicks_ctr), // in % (action-Wert)
    costPerUniqueOutboundClick: actionSum(r.cost_per_unique_outbound_click),
  }));
}

/** Täglicher Spend/Impressionen/Klicks (Konto-Ebene) für den Zeitgraphen. */
async function fetchDaily(c, range) {
  const rows = await graphGet(
    insightsUrl(c, {
      level: 'account',
      fields: 'spend,impressions,clicks',
      time_range: JSON.stringify(range),
      time_increment: '1',
    })
  );
  return rows
    .map((r) => ({
      date: r.date_start,
      spend: Number(r.spend) || 0,
      impressions: Number(r.impressions) || 0,
      clicks: Number(r.clicks) || 0,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * Tägliche Kennzahlen JE WERBEANZEIGE inkl. Plattform-Split – Basis für die
 * "Grafik"-Ansicht (Zeitreihen je Kampagne/Anzeigengruppe/Creative mit
 * überlagerbaren KPIs). time_increment '1' = pro Tag, breakdowns =
 * publisher_platform (Facebook/Instagram/…) für den Ad-Spend pro Plattform.
 */
async function fetchDailyEntities(c, range) {
  const rows = await graphGet(
    insightsUrl(c, {
      level: 'ad',
      fields: 'campaign_name,adset_name,ad_name,spend,impressions,clicks,unique_outbound_clicks',
      breakdowns: 'publisher_platform',
      time_range: JSON.stringify(range),
      time_increment: '1',
    })
  );
  return rows.map((r) => ({
    date: r.date_start,
    campaign: String(r.campaign_name ?? '').trim(),
    adset: String(r.adset_name ?? '').trim(),
    creative: String(r.ad_name ?? '').trim(),
    platform: String(r.publisher_platform ?? '').trim(),
    spend: Number(r.spend) || 0,
    impressions: Number(r.impressions) || 0,
    clicks: Number(r.clicks) || 0,
    uoc: actionSum(r.unique_outbound_clicks),
  }));
}

/** Anzeigename des Werbekontos (für die optische Trennung mehrerer Accounts). */
async function fetchAccountName(c) {
  const url = `${GRAPH}/${c.version}/${c.account}?fields=name&access_token=${c.token}`;
  const res = await fetch(url);
  const json = await res.json().catch(() => null);
  return (json && json.name) ? String(json.name).trim() : c.account;
}

/** effective_status je Kampagne (+objective), Anzeigengruppe und Werbeanzeige. */
async function fetchStatus(c) {
  const camps = await graphGet(
    `${GRAPH}/${c.version}/${c.account}/campaigns?fields=name,effective_status,objective&limit=500&access_token=${c.token}`
  );
  const adsets = await graphGet(
    `${GRAPH}/${c.version}/${c.account}/adsets?fields=name,effective_status,campaign_id&limit=500&access_token=${c.token}`
  );
  const ads = await graphGet(
    `${GRAPH}/${c.version}/${c.account}/ads?fields=id,name,effective_status,adset_id&limit=500&access_token=${c.token}`
  );
  const isActive = (s) => s === 'ACTIVE';
  const campaignStatus = {};
  for (const x of camps) {
    campaignStatus[String(x.name).trim()] = {
      status: x.effective_status,
      active: isActive(x.effective_status),
      objective: x.objective || null,
    };
  }
  const adsetStatus = {};
  for (const x of adsets) adsetStatus[String(x.name).trim()] = { status: x.effective_status, active: isActive(x.effective_status) };
  const adStatus = {};
  // Zusätzlich: alle Ads je Anzeigengruppe (adset_id) – damit auch Anzeigen OHNE
  // Auslieferung im Zeitraum (keine Insights-Zeile) im Dashboard auftauchen.
  const adsByAdset = {};
  for (const x of ads) {
    const name = String(x.name).trim();
    adStatus[name] = { status: x.effective_status, active: isActive(x.effective_status) };
    if (x.adset_id) (adsByAdset[x.adset_id] || (adsByAdset[x.adset_id] = [])).push({ id: x.id, name, status: x.effective_status, active: isActive(x.effective_status) });
  }
  return { campaignStatus, adsetStatus, adStatus, adsByAdset };
}

/** Holt alle Meta-Daten in einem Rutsch – über EIN oder MEHRERE Werbekonten
 * (META_AD_ACCOUNT_ID kommagetrennt). Die Ergebnisse werden zusammengeführt:
 * Records/Entities/Tages-Entitäten aneinandergehängt, Konto-Tagesspend je Datum
 * summiert, Status-Maps gemerged. Optional mit explizitem Zeitraum. */
export async function fetchMetaAll(customRange) {
  if (!isMetaConfigured()) return null;
  const base = cfg();
  const range = customRange?.since && customRange?.until ? customRange : dateRange(base.lookback);
  const ids = accountIds();

  // Pro Konto alles parallel holen. Schlägt EIN Konto fehl, wird es übersprungen
  // (Warnung im Log), damit die übrigen Konten trotzdem angezeigt werden.
  const perAccount = (await Promise.all(
    ids.map(async (account) => {
      try {
        const c = { ...base, account };
        const [records, entities, daily, dailyEntities, status, name] = await Promise.all([
          fetchPlacementRecords(c, range),
          fetchEntities(c, range),
          fetchDaily(c, range),
          fetchDailyEntities(c, range).catch(() => []),
          fetchStatus(c).catch(() => ({ campaignStatus: {}, adsetStatus: {}, adStatus: {} })),
          fetchAccountName(c).catch(() => account),
        ]);
        // Entities mit ihrem Werbekonto markieren (für die optische Trennung)
        return { account, name, records, entities: entities.map((e) => ({ ...e, account })), daily, dailyEntities, status };
      } catch (err) {
        console.error(`Meta-Konto ${account} konnte nicht geladen werden:`, err.message);
        return null;
      }
    })
  )).filter(Boolean);

  if (perAccount.length === 0) throw new Error('Meta: kein Werbekonto konnte geladen werden (Netzwerk/Token prüfen)');

  // Zusammenführen
  const records = perAccount.flatMap((a) => a.records);
  const entities = perAccount.flatMap((a) => a.entities);
  const dailyEntities = perAccount.flatMap((a) => a.dailyEntities);

  // Konto-Tagesspend je Datum summieren (über alle Konten)
  const dailyMap = new Map();
  for (const a of perAccount) {
    for (const d of a.daily) {
      const e = dailyMap.get(d.date) || { date: d.date, spend: 0, impressions: 0, clicks: 0 };
      e.spend += d.spend || 0;
      e.impressions += d.impressions || 0;
      e.clicks += d.clicks || 0;
      dailyMap.set(d.date, e);
    }
  }
  const daily = [...dailyMap.values()].sort((a, b) => (a.date < b.date ? -1 : 1));

  // Status-Maps mergen
  const campaignStatus = {}, adsetStatus = {}, adStatus = {}, adsByAdset = {};
  for (const a of perAccount) {
    Object.assign(campaignStatus, a.status.campaignStatus || {});
    Object.assign(adsetStatus, a.status.adsetStatus || {});
    Object.assign(adStatus, a.status.adStatus || {});
    Object.assign(adsByAdset, a.status.adsByAdset || {});
  }

  const accounts = perAccount.map((a) => ({ id: a.account, name: a.name }));
  return { records, entities, daily, dailyEntities, campaignStatus, adsetStatus, adStatus, adsByAdset, range, accounts };
}

/** Rückwärtskompatibel: nur die Placement-Records (für aggregateFb). */
export async function fetchMetaInsights() {
  const all = await fetchMetaAll();
  return all ? all.records : null;
}

export const _internal = { normAccount, positionLabel, actionSum };
