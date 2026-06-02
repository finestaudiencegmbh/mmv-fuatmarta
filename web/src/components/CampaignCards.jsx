import React, { useState } from 'react';
import { fmtEur, fmtInt, fmtPct, entityKey, minuteSeriesFromEvents } from '../lib.js';
import GraphPanel from './GraphPanel.jsx';

/** Kleiner "Grafik"-Button (öffnet die Zeitreihen-Ansicht). */
function GraphBtn({ onClick, compact }) {
  return (
    <button className={`graph-btn ${compact ? 'compact' : ''}`} onClick={(e) => { e.stopPropagation(); onClick(); }} title="Grafik anzeigen">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 3v18h18" />
        <path d="M7 14l4-4 3 3 5-6" />
      </svg>
      {!compact && <span>Grafik</span>}
    </button>
  );
}

const fmtEur2 = (n) => (n == null ? '–' : new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(n));
const fmtScore = (n) => (n == null ? '–' : String(Math.round(n)));

/** Kennzahlen in drei Sektionen – ohne horizontales Scrollen, alles umbruchfähig. */
function Metrics({ n, leadHidden }) {
  const lead = (v) => (leadHidden ? '–' : v);
  const groups = [
    {
      title: 'Ergebnis', cls: 'g-result',
      items: [
        ['Adspend', fmtEur(n.spend)],
        ['Leads', lead(fmtInt(n.leads))],
        ['Tickets', lead(fmtInt(n.tickets))],
        ['€/Lead', lead(fmtEur(n.cpl))],
        ['€/Ticket', lead(fmtEur(n.cpt))],
      ],
    },
    {
      title: 'Qualität & Funnel', cls: 'g-quality',
      items: [
        ['Quali-Rate', lead(fmtPct(n.qualifiedRate))],
        ['Ø Quali', lead(fmtScore(n.avgQuality))],
        ['CVR Start', lead(fmtPct(n.cvrStart))],
        ['CVR Ticket', lead(fmtPct(n.cvrTicket))],
      ],
    },
    {
      title: 'Facebook', cls: 'g-fb',
      items: [
        ['CPM', fmtEur2(n.cpm)],
        ['CTR ausg.', fmtPct(n.outboundCtr)],
        ['CPC ausg.', fmtEur2(n.cpoc)],
        ['Ausg. Klicks', fmtInt(n.outboundClicks)],
      ],
    },
  ];
  return (
    <div className="cc-metrics">
      {groups.map((g) => (
        <div key={g.title} className={`cc-group ${g.cls}`}>
          <div className="cc-group-title">{g.title}</div>
          <div className="cc-tiles">
            {g.items.map(([label, val]) => (
              <div key={label} className="cc-tile">
                <span className="cc-tile-val">{val}</span>
                <span className="cc-tile-label">{label}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function StatusDot({ active }) {
  if (active == null) return null;
  return <span className={`status-dot ${active ? 'on' : 'off'}`} title={active ? 'Aktiv' : 'Pausiert'} />;
}

const LEVEL_LABEL = { campaign: 'Kampagne', adset: 'Anzeigengruppe', creative: 'Creative' };

export default function CampaignCards({ hierarchy, dailyByEntity, intradayByEntity, intradayDay, accounts }) {
  const [open, setOpen] = useState(() => new Set());
  const [onlyActive, setOnlyActive] = useState(true);
  const [graph, setGraph] = useState(null);
  const toggle = (id) => setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // Bei 1-Tages-Zeitraum liefert der Server minutengenaue Events je Entität.
  const intraday = Boolean(intradayByEntity && intradayDay);
  // Liefert die fertige Punktreihe (Tagesreihe oder minutengenaue Ausschlag-Linie)
  const seriesFor = (dim, parts) => {
    const key = entityKey(dim, parts);
    if (intraday) {
      const ev = intradayByEntity?.[dim]?.[key];
      return ev ? minuteSeriesFromEvents(ev, intradayDay) : null;
    }
    return dailyByEntity?.[dim]?.[key];
  };
  const hasData = (dim, parts) => {
    const key = entityKey(dim, parts);
    return intraday ? Boolean(intradayByEntity?.[dim]?.[key]?.length) : Boolean(dailyByEntity?.[dim]?.[key]?.length);
  };
  const openGraph = (dim, parts, title) => {
    setGraph({ title, levelLabel: LEVEL_LABEL[dim], series: seriesFor(dim, parts) || [] });
  };
  const hasGraph = (dim, parts) => hasData(dim, parts);

  const campaigns = (hierarchy || []).filter((c) => !onlyActive || c.active !== false);

  // Eine einzelne Kampagnen-Karte rendern (für flache Liste ODER Account-Gruppen)
  const renderCampaign = (c) => {
          const cOpen = open.has(c.id);
          const leadHidden = c.leadCampaign === false;
          const adsets = c.adsets.filter((a) => !onlyActive || a.active !== false);
          return (
            <div key={c.id} className={`cc-card ${leadHidden ? 'is-traffic' : ''}`}>
              <div className="cc-head" onClick={() => toggle(c.id)} role="button">
                <span className={`caret ${cOpen ? 'open' : ''}`}>▶</span>
                <StatusDot active={c.active} />
                <span className="cc-name" title={c.name}>{c.name}</span>
                {leadHidden && <span className="traffic-tag">Traffic</span>}
                <span className="cc-head-spend">{fmtEur(c.spend)}</span>
                {hasGraph('campaign', { campaign: c.name }) && <GraphBtn onClick={() => openGraph('campaign', { campaign: c.name }, c.name)} />}
              </div>
              <Metrics n={c} leadHidden={leadHidden} />

              {cOpen && (
                <div className="cc-children">
                  {adsets.map((a) => {
                    const aId = `${c.id}/${a.id}`;
                    const aOpen = open.has(aId);
                    const ads = (a.ads || []).filter((ad) => !onlyActive || ad.active !== false);
                    return (
                      <div key={aId} className="cc-sub">
                        <div className="cc-subhead" onClick={() => toggle(aId)} role="button">
                          <span className={`caret ${aOpen ? 'open' : ''}`}>▶</span>
                          <StatusDot active={a.active} />
                          <span className="cc-subname" title={a.name}>{a.name}</span>
                          <span className="cc-sub-meta">
                            <span className="cc-sm-item"><b>{fmtEur(a.spend)}</b> Adspend</span>
                            <span className="cc-sm-item"><b>{leadHidden ? '–' : fmtInt(a.leads)}</b> Leads</span>
                            <span className="cc-sm-item"><b>{leadHidden ? '–' : fmtEur(a.cpl)}</b> CPL</span>
                            <span className="cc-sm-item"><b>{leadHidden ? '–' : fmtPct(a.qualifiedRate)}</b> Quali</span>
                          </span>
                          {hasGraph('adset', { campaign: c.name, adset: a.name }) && <GraphBtn onClick={() => openGraph('adset', { campaign: c.name, adset: a.name }, a.name)} />}
                        </div>
                        {aOpen && (
                          <div className="cc-sub-body">
                            <Metrics n={a} leadHidden={leadHidden} />
                            {ads.length > 0 && (
                              <div className="cc-ads">
                                <div className="cc-ad cc-ad-headrow">
                                  <span className="cc-ad-name">Werbeanzeige</span>
                                  <span>Adspend</span>
                                  <span>Leads</span>
                                  <span>CPL</span>
                                  <span>Tickets</span>
                                  <span>Quali-Rate</span>
                                  <span>CVR Start</span>
                                  <span>CTR ausg.</span>
                                </div>
                                {ads.map((ad) => (
                                  <div key={ad.id} className={`cc-ad ${ad.active === false ? 'is-paused' : ''}`}>
                                    <span className="cc-ad-name" title={ad.name}>
                                      {ad.active != null && <span className={`status-dot ${ad.active ? 'on' : 'off'}`} />}
                                      <span className="cc-ad-label">{ad.name}</span>
                                      {ad.active === false && <span className="paused-tag">aus</span>}
                                      {hasGraph('creative', { campaign: c.name, adset: a.name, creative: ad.name }) && <GraphBtn compact onClick={() => openGraph('creative', { campaign: c.name, adset: a.name, creative: ad.name }, ad.name)} />}
                                    </span>
                                    <span>{fmtEur(ad.spend)}</span>
                                    <span>{leadHidden ? '–' : fmtInt(ad.leads)}</span>
                                    <span>{leadHidden ? '–' : fmtEur(ad.cpl)}</span>
                                    <span>{leadHidden ? '–' : fmtInt(ad.tickets)}</span>
                                    <span>{leadHidden ? '–' : fmtPct(ad.qualifiedRate)}</span>
                                    <span>{leadHidden ? '–' : fmtPct(ad.cvrStart)}</span>
                                    <span>{fmtPct(ad.outboundCtr)}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                            {ads.length === 0 && <div className="muted" style={{ padding: '8px 2px' }}>keine Werbeanzeigen</div>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
  };

  // Mehrere Werbekonten -> nach Account gruppieren (mit Überschrift); sonst flach
  const accountList = accounts && accounts.length > 1 ? accounts : null;
  let body;
  if (accountList) {
    const known = new Set(accountList.map((a) => a.id));
    const groups = accountList
      .map((acc) => ({ acc, items: campaigns.filter((c) => c.account === acc.id) }))
      .filter((g) => g.items.length > 0);
    const rest = campaigns.filter((c) => !known.has(c.account));
    if (rest.length) groups.push({ acc: { id: '_rest', name: 'Weitere Konten' }, items: rest });
    body = groups.map((g) => (
      <div key={g.acc.id} className="cc-account-group">
        <div className="cc-account-head">
          <span className="cc-account-name">{g.acc.name}</span>
          <span className="cc-account-count">{g.items.length} Kampagnen</span>
        </div>
        <div className="cc-list">{g.items.map(renderCampaign)}</div>
      </div>
    ));
  } else {
    body = <div className="cc-list">{campaigns.map(renderCampaign)}</div>;
  }

  return (
    <div>
      <div className="table-toolbar">
        <label className="switch">
          <input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} />
          <span className="switch-track"><span className="switch-thumb" /></span>
          <span className="switch-label">Nur aktive anzeigen</span>
        </label>
        <span className="muted">{campaigns.length} Kampagnen{accountList ? ` · ${accountList.length} Konten` : ''}</span>
      </div>

      {body}
      {campaigns.length === 0 && <div className="empty">Keine {onlyActive ? 'aktiven ' : ''}Kampagnen gefunden.</div>}

      {graph && (
        <GraphPanel title={graph.title} levelLabel={graph.levelLabel} series={graph.series} hourly={intraday} onClose={() => setGraph(null)} />
      )}
    </div>
  );
}
