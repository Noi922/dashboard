'use strict';
// Persönliche Bereiche: E-Mail (IMAP), Kalender (ICS-Links), Nachrichten (RSS), Wetter (Open-Meteo).
// Jeder Bereich ist optional und erscheint nur, wenn er konfiguriert ist.

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

const cfg = {
  imap: {
    host: process.env.IMAP_HOST || '',
    port: Number(process.env.IMAP_PORT || 993),
    user: process.env.IMAP_USER || '',
    pass: process.env.IMAP_PASSWORD || '',
    mailbox: process.env.IMAP_MAILBOX || 'INBOX',
  },
  calendars: list(process.env.CALENDAR_URLS).map((entry, i) => {
    const cut = entry.includes('|') ? entry.indexOf('|') : -1;
    return {
      name: cut > 0 ? entry.slice(0, cut).trim() : `Kalender ${i + 1}`,
      url: (cut > 0 ? entry.slice(cut + 1) : entry).trim().replace(/^webcal:/i, 'https:'),
    };
  }),
  feeds: list(process.env.NEWS_FEEDS),
  weather: {
    lat: process.env.WEATHER_LAT || '',
    lon: process.env.WEATHER_LON || '',
    name: process.env.WEATHER_NAME || '',
    url: process.env.WEATHER_URL || 'https://api.open-meteo.com/v1/forecast',
  },
  demoMail: process.env.DEMO_MAIL === '1',
};

const state = { mail: null, calendar: null, news: null, weather: null };
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function guard(key, fn) {
  try {
    state[key] = await fn();
  } catch (e) {
    log(`Bereich "${key}" fehlgeschlagen:`, e.message);
    state[key] = { ...(state[key] || {}), error: e.message };
  }
}

// ---------------------------------------------------------------- E-Mail (nur lesend)

async function fetchMail() {
  if (cfg.demoMail) return demoMail();
  const { ImapFlow } = require('imapflow');
  const client = new ImapFlow({
    host: cfg.imap.host, port: cfg.imap.port, secure: cfg.imap.port === 993,
    auth: { user: cfg.imap.user, pass: cfg.imap.pass }, logger: false,
  });
  client.on('error', () => {});
  await client.connect();
  try {
    const status = await client.status(cfg.imap.mailbox, { messages: true, unseen: true });
    const box = await client.mailboxOpen(cfg.imap.mailbox, { readOnly: true }); // nichts wird als gelesen markiert
    const messages = [];
    if (box.exists > 0) {
      const from = Math.max(1, box.exists - 7);
      for await (const m of client.fetch(`${from}:*`, { envelope: true, flags: true })) {
        const sender = m.envelope?.from?.[0] || {};
        messages.push({
          from: sender.name || sender.address || 'Unbekannt',
          subject: m.envelope?.subject || '(kein Betreff)',
          date: m.envelope?.date ? new Date(m.envelope.date).getTime() : null,
          unread: !m.flags?.has('\\Seen'),
        });
      }
    }
    messages.sort((a, b) => (b.date || 0) - (a.date || 0));
    return { account: cfg.imap.user, unread: status.unseen, total: status.messages, messages, updated: Date.now() };
  } finally {
    await client.logout().catch(() => {});
  }
}

function demoMail() {
  const h = 3600e3, now = Date.now();
  return {
    account: 'ich@example.org', unread: 3, total: 1284, updated: now,
    messages: [
      { from: 'Stadtwerke', subject: 'Ihre Abrechnung für Oktober liegt bereit', date: now - 0.4 * h, unread: true },
      { from: 'Anna Berger', subject: 'Fotos vom Wochenende', date: now - 2.1 * h, unread: true },
      { from: 'TrueNAS', subject: 'Scrub of pool "tank" finished', date: now - 5 * h, unread: false },
      { from: 'Deutsche Bahn', subject: 'Ihre Buchungsbestätigung', date: now - 9 * h, unread: true },
      { from: 'Jonas', subject: 'Re: Umzug am Samstag', date: now - 26 * h, unread: false },
      { from: 'Bibliothek', subject: 'Erinnerung: Rückgabe in 3 Tagen', date: now - 31 * h, unread: false },
    ],
  };
}

// ---------------------------------------------------------------- Kalender (ICS)

async function fetchCalendar() {
  const ical = require('node-ical');
  const from = new Date(); from.setHours(0, 0, 0, 0);
  const to = new Date(from.getTime() + 14 * 86400e3);
  const events = [];
  const errors = [];
  await Promise.all(cfg.calendars.map(async (cal, index) => {
    let data;
    try { data = await ical.async.fromURL(cal.url); } catch (e) { errors.push(`${cal.name}: ${e.message}`); return; }
    for (const ev of Object.values(data)) {
      if (ev.type !== 'VEVENT' || !ev.start) continue;
      const allDay = ev.datetype === 'date';
      const dur = (ev.end ? new Date(ev.end).getTime() : new Date(ev.start).getTime()) - new Date(ev.start).getTime();
      const push = (start, src = ev) => events.push({
        title: String(src.summary?.val ?? src.summary ?? '(ohne Titel)'),
        location: src.location ? String(src.location.val ?? src.location) : null,
        start: start.getTime(), end: start.getTime() + dur, allDay, calendar: cal.name, cal: index,
      });
      if (ev.rrule) {
        const skip = new Set(Object.values(ev.exdate || {}).map((d) => new Date(d).toDateString()));
        for (const d of ev.rrule.between(new Date(from.getTime() - dur), to, true)) {
          if (skip.has(d.toDateString())) continue;
          const moved = ev.recurrences && Object.values(ev.recurrences).find((r) => new Date(r.recurrenceid).toDateString() === d.toDateString());
          if (moved) push(new Date(moved.start), moved); else push(d);
        }
      } else if (new Date(ev.start).getTime() + dur > from.getTime() && new Date(ev.start) < to) {
        push(new Date(ev.start));
      }
    }
  }));
  if (errors.length === cfg.calendars.length) throw new Error(errors.join('; '));
  events.sort((a, b) => a.start - b.start);
  return { events: events.filter((e) => e.end > Date.now() || e.allDay).slice(0, 10), calendars: cfg.calendars.map((c) => c.name), warning: errors.join('; ') || null, updated: Date.now() };
}

// ---------------------------------------------------------------- Nachrichten (RSS/Atom)

async function fetchNews() {
  const Parser = require('rss-parser');
  const parser = new Parser({ timeout: 15000 });
  const items = [];
  const errors = [];
  await Promise.all(cfg.feeds.map(async (url) => {
    try {
      const feed = await parser.parseURL(url);
      for (const it of (feed.items || []).slice(0, 15)) {
        items.push({
          title: (it.title || '').trim(),
          link: /^https?:\/\//i.test(it.link || '') ? it.link : null,
          source: feed.title || new URL(url).hostname,
          date: it.isoDate ? new Date(it.isoDate).getTime() : null,
        });
      }
    } catch (e) { errors.push(`${url}: ${e.message}`); }
  }));
  if (errors.length === cfg.feeds.length) throw new Error(errors.join('; '));
  items.sort((a, b) => (b.date || 0) - (a.date || 0));
  return { items: items.filter((i) => i.title).slice(0, 12), updated: Date.now() };
}

// ---------------------------------------------------------------- Wetter (Open-Meteo, ohne Konto)

async function fetchWeather() {
  const q = new URLSearchParams({
    latitude: cfg.weather.lat, longitude: cfg.weather.lon, timezone: 'auto', forecast_days: '4',
    current: 'temperature_2m,weather_code', daily: 'weather_code,temperature_2m_max,temperature_2m_min',
  });
  const res = await fetch(`${cfg.weather.url}?${q}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const w = await res.json();
  return {
    name: cfg.weather.name,
    temp: w.current.temperature_2m,
    code: w.current.weather_code,
    days: w.daily.time.map((day, i) => ({
      day, code: w.daily.weather_code[i], max: w.daily.temperature_2m_max[i], min: w.daily.temperature_2m_min[i],
    })),
    updated: Date.now(),
  };
}

// ----------------------------------------------------------------

function every(ms, key, fn) {
  const run = () => guard(key, fn).finally(() => setTimeout(run, ms));
  run();
}

function start() {
  const on = [];
  if (cfg.demoMail || (cfg.imap.host && cfg.imap.user && cfg.imap.pass)) { every(2 * 60e3, 'mail', fetchMail); on.push('E-Mail'); }
  if (cfg.calendars.length) { every(10 * 60e3, 'calendar', fetchCalendar); on.push('Kalender'); }
  if (cfg.feeds.length) { every(10 * 60e3, 'news', fetchNews); on.push('Nachrichten'); }
  if (cfg.weather.lat && cfg.weather.lon) { every(20 * 60e3, 'weather', fetchWeather); on.push('Wetter'); }
  log('Persönliche Bereiche:', on.length ? on.join(', ') : 'keine konfiguriert');
}

module.exports = { state, start };
