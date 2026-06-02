import { computeQuality } from './scoring.js';
import { loadCampaignConfig } from './campaigns.js';

const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Rein numerischer Wert (z. B. Meta-IDs wie 52540202640549) -> nicht zuordenbar. */
const isNumericId = (s) => /^\d{6,}$/.test(collapse(s));

const titleCase = (s) => collapse(s).replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Aussagekräftiges Label für eine ORGANISCHE Quelle:
 * - ManyChat (steht im utm_medium) -> "ManyChat · <Kampagnenname>"
 * - Bio (utm_source enthält "bio")  -> "<Plattform> Bio"  (fb-bio -> Facebook Bio)
 * - sonst -> die Quelle selbst (Title Case)
 * Liefert { campaign, adset } für die zweistufige Gruppierung.
 */
function organicLabels(utm) {
  const src = collapse(utm.source).toLowerCase();
  const med = collapse(utm.medium).toLowerCase();
  const camp = collapse(utm.campaign);

  if (/manychat/.test(med) || /manychat/.test(src) || /manychat/.test(camp.toLowerCase())) {
    const flow = camp || titleCase(collapse(utm.medium).replace(/manychat/i, '').replace(/[-_|]/g, ' ').trim()) || '(ohne Flow)';
    return { campaign: 'ManyChat', adset: flow };
  }
  if (/bio/.test(src)) {
    const platMap = { fb: 'Facebook', facebook: 'Facebook', ig: 'Instagram', insta: 'Instagram', instagram: 'Instagram', yt: 'YouTube', youtube: 'YouTube', tiktok: 'TikTok', tt: 'TikTok' };
    const token = src.replace(/[-_\s]*bio.*/, '').replace(/[-_\s]+/g, '');
    const plat = platMap[token] || titleCase(token) || 'Bio';
    return { campaign: 'Bio', adset: `${plat} Bio` };
  }
  const label = titleCase(src) || '(direkt)';
  return { campaign: label, adset: label };
}

/** Lesbares Label für ein Placement (utm_term). */
function placementLabel(term) {
  const t = collapse(term);
  if (!t) return '(kein Placement)';
  if (/^\d{6,}$/.test(t)) return `Placement-ID ${t}`;
  return t.replace(/_/g, ' ');
}

/** Quellen, die immer als organisch gelten – unabhängig vom UTM-Schema. */
function isOrganicSource(utm, patterns) {
  const hay = [utm.source, utm.medium, utm.campaign, utm.term]
    .map((v) => collapse(v).toLowerCase())
    .join(' | ');
  return patterns.some((p) => hay.includes(String(p).toLowerCase()));
}

/**
 * Entscheidet, ob ein Datensatz aus bezahlter Werbung stammt.
 * Bezahlte Anzeigengruppen folgen dem Schema "X | Y | Z | ..." und/oder
 * tauchen in der Adspend-Übersicht auf. Alles andere gilt als organisch.
 */
function isPaid(utm, paidAdsets, patterns) {
  // Harte Regel: ManyChat / Bio / moneymaker-workshop ist immer organisch.
  if (isOrganicSource(utm, patterns)) return false;
  const src = collapse(utm.source);
  if (!src) return false;
  if (paidAdsets.has(src.toLowerCase())) return true;
  // Bezahlte Anzeigen folgen dem Schema "X | Y | Z | ..." – das kann in der
  // Anzeigengruppe (utm_source), der Kampagne (utm_campaign) ODER dem Creative
  // (utm_medium) stehen. Manche Konten nutzen Pipes nur im Kampagnennamen.
  if (`${src} ${collapse(utm.campaign)} ${collapse(utm.medium)}`.includes('|')) return true;
  // Rein numerische Source = Meta-ID -> bezahlt (aber nicht eindeutig zuordenbar).
  if (isNumericId(src)) return true;
  return false;
}

/**
 * Führt Leads, VIP-Tickets und Adspend-Übersicht zu einem einheitlichen
 * Datensatz zusammen. Join über die E-Mail-Adresse.
 */
export function buildDataset({ leads, tickets, overview }, cfg) {
  const warnings = [];
  const paidAdsets = new Set(overview.map((o) => o.adset.toLowerCase()));
  const campCfg = loadCampaignConfig();
  const organicPatterns = campCfg.organicPatterns || ['manychat', 'bio'];
  const organicLabel = campCfg.organicLabel || '(organisch)';
  const unattribLabel = campCfg.unattributablePaidLabel || '(Paid · nicht zuordenbar)';

  // Leitet die Dimensions-Labels (Kampagne/Anzeigengruppe/Creative) aus einer
  // UTM-Kombination ab – einheitlich für Lead-UTM UND Ticket-UTM verwendbar.
  const dimsFor = (utm) => {
    const paid = isPaid(utm, paidAdsets, organicPatterns);
    const rawCampaign = collapse(utm.campaign);
    const rawAdset = collapse(utm.source);
    const rawCreative = collapse(utm.medium);
    if (!paid) return { paid: false, campaign: organicLabel, adset: organicLabel, creative: rawCreative || organicLabel };
    if (isNumericId(rawCampaign) || isNumericId(rawAdset) || !rawCampaign || !rawAdset) {
      return { paid: true, campaign: unattribLabel, adset: unattribLabel, creative: rawCreative || unattribLabel };
    }
    return { paid: true, campaign: rawCampaign, adset: rawAdset, creative: rawCreative || unattribLabel };
  };

  // Antworten/Qualität aus dem VIP-Tab nach E-Mail indizieren (zum Anreichern
  // der Lead-Zeilen; verändert NICHT die Lead-Anzahl).
  const ticketByEmail = new Map();
  for (const t of tickets) {
    for (const e of [t.email, t.emailTypeform]) {
      if (e && !ticketByEmail.has(e)) ticketByEmail.set(e, t);
    }
  }

  // 1) Jede Lead-Zeile = ein Datensatz (KEIN Dedup, auch ohne E-Mail). Damit
  //    entspricht die Lead-Anzahl exakt den Zeilen im Sheet.
  //    ABER: Ein Ticket wird nur EINMAL gewertet. Kommt dieselbe Person mehrfach
  //    als Lead rein (Re-Optin / Doppelzeile), beansprucht die ERSTE passende
  //    Zeile das Ticket; weitere Zeilen bleiben Leads, zählen aber nicht erneut
  //    als Ticket. Identität = Funnelcockpit-E-Mail (Fallback Typeform), exakt
  //    wie im Tickets-Tab.
  const recs = [];
  const seenLeadEmails = new Set();
  const claimedTickets = new Set();
  for (const l of leads) {
    const email = l.email || '';
    if (email) seenLeadEmails.add(email);
    const t = email ? ticketByEmail.get(email) : null;
    // Kanonische Ticket-Identität (für die Einmal-Wertung)
    const identity = t?.email || email;
    const isCandidate = Boolean(t) || Boolean(l.ticketAt);
    let isTicketRow = false;
    if (isCandidate) {
      if (!identity) {
        isTicketRow = true; // keine E-Mail -> nicht dedupierbar, einzeln werten
      } else if (!claimedTickets.has(identity)) {
        claimedTickets.add(identity);
        isTicketRow = true;
      }
    }
    recs.push({
      email,
      firstName: l.firstName || t?.firstName || '',
      lastName: l.lastName || t?.lastName || '',
      phone: t?.phone || '',
      wonAt: l.wonAt,
      // Ticket-Status aus dem Tickets-Tab (Typeform): jemand IST ein Ticket,
      // sobald eine zugehörige Antwortzeile existiert (E-Mail-Match über
      // Funnelcockpit- ODER Typeform-Adresse) – aber nur einmal je Person.
      ticketAt: isTicketRow ? (l.ticketAt || t?.at || null) : null,
      hasTicket: isTicketRow,
      utm: collapse(l.utm.source) ? { ...l.utm } : (t ? { ...t.utm } : { ...l.utm }),
      // UTM des TICKETS selbst (für ticket-eigene Attribution) – aus dem Tickets-
      // Tab, sonst (Spalte ohne Typeform-Match) die Lead-UTM.
      ticketUtm: isTicketRow ? (t && t.utm ? { ...t.utm } : { ...l.utm }) : null,
      answers: t?.answers || null,
    });
  }

  // 2) VIP-Tickets, deren E-Mail in KEINER Lead-Zeile vorkommt, als eigene
  //    Datensätze ergänzen (z. B. nur im VIP-Tab erfasste Personen).
  for (const t of tickets) {
    // mit einer Lead-Zeile verknüpft? (beide Mail-Varianten prüfen)
    if ((t.email && seenLeadEmails.has(t.email)) || (t.emailTypeform && seenLeadEmails.has(t.emailTypeform))) continue;
    const identity = t.email || t.emailTypeform || '';
    if (identity && claimedTickets.has(identity)) continue; // schon gewertet
    if (identity) claimedTickets.add(identity);
    const email = t.email || t.emailTypeform || '';
    recs.push({
      email,
      firstName: t.firstName || '',
      lastName: t.lastName || '',
      phone: t.phone || '',
      wonAt: t.at || null,
      ticketAt: t.at || null,
      hasTicket: true,
      utm: { ...t.utm },
      ticketUtm: { ...t.utm },
      answers: t.answers || null,
    });
  }

  // 3) Finalisieren: Dimensionen, Quelle, Qualität
  const records = [];
  for (const r of recs) {
    // Lead-Dimensionen aus der Lead-UTM
    const ld = dimsFor(r.utm);
    const paid = ld.paid;
    const { campaign, adset, creative } = ld;
    const quality = r.hasTicket ? computeQuality(r.answers, cfg) : null;

    // Ticket-Dimensionen aus der TICKET-EIGENEN UTM (damit ein Ticket dort zählt,
    // wo es wirklich entstand – nicht in jeder Kampagne, in der die Person Lead war)
    let ticketCampaign = null, ticketAdset = null, ticketCreative = null;
    if (r.hasTicket) {
      const td = dimsFor(r.ticketUtm || r.utm);
      ticketCampaign = td.campaign; ticketAdset = td.adset; ticketCreative = td.creative;
    }

    records.push({
      ticketCampaign,
      ticketAdset,
      ticketCreative,
      email: r.email,
      name: collapse(`${r.firstName} ${r.lastName}`) || '(ohne Name)',
      firstName: r.firstName,
      lastName: r.lastName,
      phone: r.phone,
      wonAt: r.wonAt,
      ticketAt: r.ticketAt,
      hasTicket: r.hasTicket,
      sourceType: paid ? 'paid' : 'organic',
      campaign,
      adset,
      creative,
      placement: placementLabel(r.utm.term),
      placementRaw: collapse(r.utm.term),
      // Rohe UTM-Werte für den Quellen-Tab (Donut/Top-Listen)
      sourceRaw: collapse(r.utm.source),
      campaignRaw: collapse(r.utm.campaign),
      mediumRaw: collapse(r.utm.medium),
      // Aussagekräftige Gruppierung für den Organisch-Container
      ...(paid ? {} : (() => { const o = organicLabels(r.utm); return { organicCampaign: o.campaign, organicAdset: o.adset }; })()),
      quality,
      answers: r.answers,
    });
  }

  // Spend-Übersicht: nach Anzeigengruppe verdichten (mehrere Kampagnen-Tabs)
  const overviewByAdset = new Map();
  for (const o of overview) {
    const k = o.adset.toLowerCase();
    if (!overviewByAdset.has(k)) overviewByAdset.set(k, o);
  }

  const matchedAdsets = new Set(records.filter((r) => r.sourceType === 'paid').map((r) => r.adset.toLowerCase()));
  for (const o of overview) {
    if (!matchedAdsets.has(o.adset.toLowerCase())) {
      // Übersicht kennt eine Anzeigengruppe, zu der (noch) keine Leads mit
      // exakt gleichem utm_source gefunden wurden – nur ein Hinweis.
    }
  }

  return {
    leads: records,
    overview,
    overviewByAdset: Object.fromEntries(overviewByAdset),
    warnings,
    counts: {
      leads: records.length,
      paidLeads: records.filter((r) => r.sourceType === 'paid').length,
      tickets: records.filter((r) => r.hasTicket).length,
      scored: records.filter((r) => r.quality).length,
    },
  };
}
