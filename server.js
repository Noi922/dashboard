'use strict';
// TrueNAS-Dashboard – Backend
// Hält die Verbindung zu TrueNAS (API-Key bleibt auf dem Server), sammelt die
// Daten und stellt sie dem Frontend unter /api/state bereit.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const widgets = require('./widgets');

const cfg = {
  host: process.env.TRUENAS_HOST || '',
  url: process.env.TRUENAS_URL || '', // optional: komplette WebSocket-URL
  apiKey: process.env.TRUENAS_API_KEY || '',
  scheme: process.env.TRUENAS_WS_SCHEME === 'ws' ? 'ws' : 'wss', // 'ws' nur für die Demo
  verifyTls: /^(1|true|yes)$/i.test(process.env.TRUENAS_VERIFY_TLS || ''),
  mode: (process.env.TRUENAS_API_MODE || 'auto').toLowerCase(), // auto | ws | rest
  port: Number(process.env.PORT || 8080),
  password: process.env.DASHBOARD_PASSWORD || '',
  actions: /^(1|true|yes)$/i.test(process.env.ENABLE_ACTIONS || ''),
};

if ((!cfg.host && !cfg.url) || !cfg.apiKey) {
  console.error('Fehler: TRUENAS_HOST und TRUENAS_API_KEY müssen gesetzt sein.');
  process.exit(1);
}

const HISTORY = 150; // Messpunkte (≈ 5 Minuten bei 2 s Takt)
const state = {
  connected: false,
  mode: null,
  error: null,
  updated: null,
  actionsEnabled: cfg.actions,
  system: null,
  live: null,
  history: { t: [], cpu: [], mem: [], rx: [], tx: [] },
  pools: null,
  disks: null,
  alerts: null,
  apps: null,
  vms: null,
  tasks: null,
  personal: widgets.state,
};

const log = (...a) => console.log(new Date().toISOString(), ...a);
const date = (v) => (v && typeof v === 'object' && '$date' in v ? v.$date : v ?? null);

// ---------------------------------------------------------------- WebSocket (JSON-RPC, ab 25.04)

class RpcClient {
  constructor() {
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
    this.onEvent = () => {};
    this.onClose = () => {};
    this.legacy = false; // true: älteres Protokoll unter /websocket (vor 25.04)
  }

  connect(legacy = false) {
    this.legacy = legacy;
    const url = cfg.url || `${cfg.scheme}://${cfg.host}${legacy ? '/websocket' : '/api/current'}`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { rejectUnauthorized: cfg.verifyTls, handshakeTimeout: 10000 });
      this.ws = ws;
      let opened = false;
      ws.on('open', () => {
        opened = true;
        if (!legacy) return resolve();
        this.onHello = resolve;
        ws.send(JSON.stringify({ msg: 'connect', version: '1', support: ['1'] }));
        setTimeout(() => reject(new Error('Keine Antwort auf Verbindungsaufbau')), 10000);
      });
      ws.on('unexpected-response', (_req, res) => {
        const e = new Error(`HTTP ${res.statusCode} beim WebSocket-Aufbau`);
        e.httpStatus = res.statusCode;
        reject(e);
        ws.terminate();
      });
      ws.on('error', (e) => { if (!opened) reject(e); });
      ws.on('close', () => {
        for (const p of this.pending.values()) p.reject(new Error('Verbindung getrennt'));
        this.pending.clear();
        if (opened) this.onClose();
      });
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (this.legacy) msg = this.fromLegacy(msg);
        if (!msg) return;
        if (msg.id != null && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) {
            const reason = msg.error.data?.reason || msg.error.message || 'RPC-Fehler';
            p.reject(new Error(reason));
          } else p.resolve(msg.result);
        } else if (msg.method === 'collection_update' && msg.params) {
          this.onEvent(msg.params);
        }
      });
    });
  }

  // Übersetzt Nachrichten des älteren Protokolls in die JSON-RPC-Form
  fromLegacy(m) {
    if (m.msg === 'connected') { this.onHello?.(); return null; }
    if (m.msg === 'ping') { this.ws.send(JSON.stringify({ msg: 'pong', id: m.id })); return null; }
    if (m.msg === 'result') return { id: Number(m.id), result: m.result, error: m.error && { message: m.error.reason || m.error.error || 'RPC-Fehler' } };
    if (m.msg === 'ready') return { id: Number(m.subs?.[0]), result: true };
    if (m.msg === 'nosub') return { id: Number(m.id), error: { message: m.error?.reason || m.error?.error || 'Abo abgelehnt' } };
    if ((m.msg === 'added' || m.msg === 'changed') && m.collection) return { method: 'collection_update', params: m };
    return null;
  }

  subscribe(name) {
    return this.legacy ? this.send((id) => ({ id: String(id), msg: 'sub', name })) : this.call('core.subscribe', [name]);
  }

  call(method, params = []) {
    return this.send((id) => (this.legacy ? { id: String(id), msg: 'method', method, params } : { jsonrpc: '2.0', id, method, params }), method);
  }

  send(build, label = 'Anfrage') {
    const method = label;
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error('Nicht verbunden'));
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Zeitüberschreitung bei ${method}`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(build(id)));
    });
  }

  close() { try { this.ws?.terminate(); } catch {} }
}

// ---------------------------------------------------------------- REST (v2.0, bis 25.10)

const REST_POST = { 'disk.temperatures': { names: [] } };

function restCall(method) {
  const post = method in REST_POST;
  const body = post ? JSON.stringify(REST_POST[method]) : null;
  const opts = {
    host: cfg.host,
    path: '/api/v2.0/' + method.replace(/\.query$/, '').replace(/\./g, '/'),
    method: post ? 'POST' : 'GET',
    rejectUnauthorized: cfg.verifyTls,
    timeout: 30000,
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
  };
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode} bei ${method}`));
        try { resolve(JSON.parse(data)); } catch { reject(new Error(`Ungültige Antwort bei ${method}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Zeitüberschreitung bei ${method}`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------- Datensammlung

let rpc = null;
const call = (method, params) => (state.mode === 'ws' ? rpc.call(method, params) : restCall(method));

async function section(key, fn) {
  try {
    state[key] = await fn();
  } catch (e) {
    if (state[key] == null) state[key] = { unavailable: e.message };
  }
}

async function pollSystem() {
  await section('system', async () => {
    const s = await call('system.info');
    return {
      hostname: s.hostname,
      version: s.version,
      model: s.model,
      cores: s.cores,
      physmem: s.physmem,
      uptime: s.uptime_seconds,
      loadavg: s.loadavg,
      fetched: Date.now(),
    };
  });
}

async function pollStorage() {
  await section('pools', async () => {
    const pools = await call('pool.query');
    return pools.map((p) => ({
      name: p.name,
      status: p.status,
      healthy: p.healthy,
      size: p.size,
      allocated: p.allocated,
      free: p.free,
      scan: p.scan && {
        function: p.scan.function,
        state: p.scan.state,
        percentage: p.scan.percentage,
        errors: p.scan.errors,
        end: date(p.scan.end_time),
      },
    }));
  });
  await section('disks', async () => {
    const disks = await call('disk.query', [[], { extra: { pools: true } }]);
    let temps = {};
    try { temps = await call('disk.temperatures', []); } catch {}
    return disks
      .map((d) => ({
        name: d.name,
        model: d.model,
        serial: d.serial,
        size: d.size,
        type: d.type,
        pool: d.pool ?? null,
        temp: temps?.[d.name] ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  });
}

async function pollAlerts() {
  await section('alerts', async () => {
    const alerts = await call('alert.list');
    return alerts
      .filter((a) => !a.dismissed)
      .map((a) => ({ level: a.level, text: a.formatted, klass: a.klass, time: date(a.datetime) }))
      .sort((a, b) => (b.time || 0) - (a.time || 0));
  });
}

async function pollWorkloads() {
  await section('apps', async () => {
    const apps = await call('app.query');
    return apps
      .map((a) => ({
        id: a.name,
        name: a.metadata?.title || a.name,
        state: a.state,
        version: a.human_version || a.version || null,
        update: !!a.upgrade_available,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });
  await section('vms', async () => {
    try {
      const vms = await call('vm.query');
      return vms.map((v) => ({
        id: v.id, name: v.name, state: v.status?.state || 'UNKNOWN', vcpus: v.vcpus, memory: v.memory, api: 'vm',
      }));
    } catch (e) {
      // 25.04 ("Fangtooth") verwaltet VMs über Incus
      const inst = await call('virt.instance.query');
      return inst.map((v) => ({
        id: v.id, name: v.name, state: v.status, vcpus: v.cpu, memory: v.memory ? v.memory / 1048576 : null, api: 'virt',
      }));
    }
  });
}

async function pollTasks() {
  await section('tasks', async () => {
    const out = [];
    const add = async (method, map) => {
      try { for (const t of await call(method)) out.push(map(t)); } catch {}
    };
    await add('pool.snapshottask.query', (t) => ({
      type: 'Snapshot', name: t.dataset, enabled: t.enabled, state: t.state?.state || null, time: date(t.state?.datetime),
    }));
    await add('replication.query', (t) => ({
      type: 'Replikation', name: t.name, enabled: t.enabled, state: t.state?.state || null, time: date(t.state?.datetime),
    }));
    await add('cloudsync.query', (t) => ({
      type: 'Cloud-Sync', name: t.description || t.path, enabled: t.enabled, state: t.job?.state || null, time: date(t.job?.time_finished),
    }));
    await add('rsynctask.query', (t) => ({
      type: 'Rsync', name: t.desc || t.path, enabled: t.enabled, state: t.job?.state || null, time: date(t.job?.time_finished),
    }));
    return out;
  });
}

function onRealtime(ev) {
  if (ev.collection !== 'reporting.realtime' || !ev.fields) return;
  const f = ev.fields;
  if (!onRealtime.logged) { // einmalig: Aufbau der Live-Daten fürs Fehlersuchen (enthält keine Zugangsdaten)
    onRealtime.logged = true;
    const keys = (o) => (o && typeof o === 'object' ? Object.keys(o).slice(0, 8).join(',') : typeof o);
    log('Live-Daten empfangen:', Object.keys(f).map((k) => `${k}[${keys(f[k])}]`).join(' '));
  }
  const cpuAll = f.cpu?.cpu || f.cpu?.average || {};
  let temp = cpuAll.temp ?? null;
  if (temp == null && f.cpu?.temperature_celsius) {
    const v = Object.values(f.cpu.temperature_celsius).filter((n) => typeof n === 'number');
    if (v.length) temp = Math.max(...v);
  }
  const m = f.memory || {};
  const vm = f.virtual_memory || {};
  const memTotal = m.physical_memory_total ?? vm.total ?? state.system?.physmem ?? null;
  const memAvail = m.physical_memory_available ?? vm.available ?? null;
  let rx = 0, tx = 0;
  for (const i of Object.values(f.interfaces || {})) {
    rx += i.received_bytes_rate || 0;
    tx += i.sent_bytes_rate || 0;
  }
  const live = {
    cpu: typeof cpuAll.usage === 'number' ? cpuAll.usage : null,
    temp,
    memTotal,
    memUsed: memTotal != null && memAvail != null ? memTotal - memAvail : null,
    arc: m.arc_size ?? f.zfs?.arc_size ?? null,
    rx,
    tx,
  };
  state.live = live;
  const h = state.history;
  h.t.push(Date.now());
  h.cpu.push(live.cpu);
  h.mem.push(live.memUsed != null ? (live.memUsed / live.memTotal) * 100 : null);
  h.rx.push(rx);
  h.tx.push(tx);
  for (const k of Object.keys(h)) if (h[k].length > HISTORY) h[k].shift();
  state.updated = Date.now();
}

// ---------------------------------------------------------------- Verbindungs-Lebenszyklus

let timers = [];
let generation = 0;

function schedule(fn, ms) {
  const gen = generation;
  const run = async () => {
    if (gen !== generation) return;
    try { await fn(); state.updated = Date.now(); } catch {}
    if (gen === generation) timers.push(setTimeout(run, ms));
  };
  run();
}

function stopPolling() {
  generation++;
  timers.forEach(clearTimeout);
  timers = [];
}

function startPolling() {
  schedule(pollSystem, 30000);
  schedule(pollStorage, 30000);
  schedule(pollAlerts, 15000);
  schedule(pollWorkloads, 10000);
  schedule(pollTasks, 60000);
}

async function connectWs(legacy = false) {
  rpc = new RpcClient();
  await rpc.connect(legacy);
  const ok = await rpc.call('auth.login_with_api_key', [cfg.apiKey]);
  if (!ok) throw new Error('Anmeldung abgelehnt – API-Key prüfen');
  rpc.onEvent = onRealtime;
  rpc.onClose = () => {
    log('Verbindung zu TrueNAS getrennt, neuer Versuch in 5 s');
    state.connected = false;
    state.error = 'Verbindung getrennt';
    stopPolling();
    setTimeout(start, 5000);
  };
  state.mode = 'ws';
  try { await rpc.subscribe('reporting.realtime'); } catch (e) {
    log('Live-Daten nicht verfügbar:', e.message);
  }
}

async function start() {
  try {
    if (cfg.mode === 'rest') {
      state.mode = 'rest';
      await restCall('system.info');
    } else {
      try {
        await connectWs();
      } catch (e) {
        rpc?.close();
        // Ältere Versionen kennen /api/current nicht -> älteres WebSocket-Protokoll, sonst REST
        if (cfg.mode === 'auto' && !cfg.url && e.httpStatus && e.httpStatus !== 401 && e.httpStatus !== 403) {
          log('Neue WebSocket-API nicht vorhanden (' + e.message + '), versuche ältere WebSocket-API');
          try {
            await connectWs(true);
          } catch (e2) {
            rpc?.close();
            log('Ältere WebSocket-API nicht nutzbar (' + e2.message + '), verwende REST-API');
            state.mode = 'rest';
            await restCall('system.info');
          }
        } else throw e;
      }
    }
    state.connected = true;
    state.error = null;
    log(`Verbunden mit TrueNAS (${state.mode === 'ws' ? (rpc.legacy ? 'ältere WebSocket-API' : 'WebSocket-API') : 'REST-API'})`);
    startPolling();
  } catch (e) {
    state.connected = false;
    state.error = e.message;
    log('Verbindung fehlgeschlagen:', e.message, '– neuer Versuch in 10 s');
    if (state.mode === 'rest' && cfg.mode !== 'rest') state.mode = null;
    setTimeout(start, 10000);
  }
}

// ---------------------------------------------------------------- Aktionen (optional)

async function runAction({ kind, id, action }) {
  if (!cfg.actions) throw new Error('Aktionen sind deaktiviert (ENABLE_ACTIONS=true setzen)');
  if (state.mode !== 'ws') throw new Error('Aktionen benötigen die WebSocket-API');
  if (!['start', 'stop'].includes(action)) throw new Error('Unbekannte Aktion');
  if (kind === 'app') {
    if (!state.apps?.some?.((a) => a.id === id)) throw new Error('Unbekannte App');
    await rpc.call(`app.${action}`, [id]);
  } else if (kind === 'vm') {
    const vm = state.vms?.find?.((v) => String(v.id) === String(id));
    if (!vm) throw new Error('Unbekannte VM');
    await rpc.call(vm.api === 'virt' ? `virt.instance.${action}` : `vm.${action}`, [vm.id]);
  } else throw new Error('Unbekannter Typ');
  setTimeout(() => pollWorkloads().catch(() => {}), 2000);
}

// ---------------------------------------------------------------- HTTP-Server

const INDEX = path.join(__dirname, 'public', 'index.html');

function authorized(req) {
  if (!cfg.password) return true;
  const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const pass = Buffer.from(m[1], 'base64').toString().split(':').slice(1).join(':');
  const a = crypto.createHash('sha256').update(pass).digest();
  const b = crypto.createHash('sha256').update(cfg.password).digest();
  return crypto.timingSafeEqual(a, b);
}

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

http
  .createServer((req, res) => {
    if (!authorized(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="TrueNAS-Dashboard"' });
      return res.end('Anmeldung erforderlich');
    }
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && url === '/api/state') return send(res, 200, state);
    if (req.method === 'POST' && url === '/api/action') {
      // Nur Anfragen von der eigenen Seite zulassen (Schutz vor Cross-Site-Requests)
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'Fremde Herkunft' });
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 10000) req.destroy(); });
      req.on('end', async () => {
        try {
          await runAction(JSON.parse(body));
          send(res, 200, { ok: true });
        } catch (e) {
          send(res, 400, { error: e.message });
        }
      });
      return;
    }
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      return fs.readFile(INDEX, (err, data) => (err ? send(res, 500, 'Fehler', 'text/plain') : send(res, 200, data, 'text/html')));
    }
    send(res, 404, { error: 'Nicht gefunden' });
  })
  .listen(cfg.port, () => {
    log(`Dashboard läuft auf Port ${cfg.port}`);
    start();
    widgets.start();
  });
