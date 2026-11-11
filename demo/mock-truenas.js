'use strict';
// Simuliertes TrueNAS (JSON-RPC über WebSocket) – nur für die Demo-Ansicht.
const { WebSocketServer } = require('ws');

const port = Number(process.env.MOCK_PORT || 9999);
const GiB = 1024 ** 3, TiB = 1024 ** 4;
const now = () => Date.now();
const d = (ms) => ({ $date: ms });
const booted = now() - 12.4 * 86400e3;

const apps = [
  { name: 'jellyfin', metadata: { title: 'Jellyfin' }, state: 'RUNNING', human_version: '10.10.3', upgrade_available: false },
  { name: 'nextcloud', metadata: { title: 'Nextcloud' }, state: 'RUNNING', human_version: '30.0.2', upgrade_available: true },
  { name: 'immich', metadata: { title: 'Immich' }, state: 'RUNNING', human_version: '1.121.0', upgrade_available: false },
  { name: 'pihole', metadata: { title: 'Pi-hole' }, state: 'STOPPED', human_version: '2024.07', upgrade_available: false },
  { name: 'vaultwarden', metadata: { title: 'Vaultwarden' }, state: 'CRASHED', human_version: '1.32.5', upgrade_available: false },
];
const vms = [
  { id: 1, name: 'homeassistant', status: { state: 'RUNNING' }, vcpus: 2, memory: 4096 },
  { id: 2, name: 'win11-test', status: { state: 'STOPPED' }, vcpus: 4, memory: 8192 },
];

const methods = {
  'auth.login_with_api_key': () => true,
  'core.subscribe': () => 'sub-1',
  'system.info': () => ({
    hostname: 'truenas', version: '25.04.2.4', model: 'Intel(R) Core(TM) i5-12400', cores: 12,
    physmem: 64 * GiB, uptime_seconds: (now() - booted) / 1000, loadavg: [0.8, 0.9, 1.1],
  }),
  'pool.query': () => [
    { name: 'tank', status: 'ONLINE', healthy: true, size: 43.6 * TiB, allocated: 27.1 * TiB, free: 16.5 * TiB,
      scan: { function: 'SCRUB', state: 'FINISHED', percentage: 100, errors: 0, end_time: d(now() - 3 * 86400e3) } },
    { name: 'backup', status: 'DEGRADED', healthy: false, size: 14.5 * TiB, allocated: 12.4 * TiB, free: 2.1 * TiB,
      scan: { function: 'RESILVER', state: 'SCANNING', percentage: 41.3, errors: 0, end_time: null } },
    { name: 'apps', status: 'ONLINE', healthy: true, size: 928 * GiB, allocated: 312 * GiB, free: 616 * GiB,
      scan: { function: 'SCRUB', state: 'FINISHED', percentage: 100, errors: 0, end_time: d(now() - 9 * 86400e3) } },
  ],
  'disk.query': () => [
    ...['sda', 'sdb', 'sdc', 'sdd'].map((n, i) => ({ name: n, model: 'WDC WD120EFBX', serial: 'WD-9A' + (4410 + i), size: 12e12, type: 'HDD', pool: 'tank' })),
    ...['sde', 'sdf'].map((n, i) => ({ name: n, model: 'ST8000VN004', serial: 'ZR1' + (5520 + i), size: 8e12, type: 'HDD', pool: 'backup' })),
    { name: 'nvme0n1', model: 'Samsung SSD 980 PRO 1TB', serial: 'S5GX1', size: 1e12, type: 'SSD', pool: 'apps' },
    { name: 'nvme1n1', model: 'Samsung SSD 970 EVO 250GB', serial: 'S4EU2', size: 25e10, type: 'SSD', pool: 'boot-pool' },
  ],
  'disk.temperatures': () => ({ sda: 34, sdb: 35, sdc: 37, sdd: 36, sde: 47, sdf: 52, nvme0n1: 41, nvme1n1: 38 }),
  'alert.list': () => [
    { level: 'CRITICAL', klass: 'VolumeStatus', dismissed: false, datetime: d(now() - 2 * 3600e3),
      formatted: "Pool backup state is DEGRADED: One or more devices is currently being resilvered." },
    { level: 'WARNING', klass: 'ZpoolCapacityWarning', dismissed: false, datetime: d(now() - 26 * 3600e3),
      formatted: 'Space usage for pool "backup" is 85%. Optimal pool performance requires used space remain below 80%.' },
    { level: 'INFO', klass: 'AppUpdate', dismissed: false, datetime: d(now() - 5 * 3600e3),
      formatted: 'An update is available for "nextcloud" application.' },
  ],
  'app.query': () => apps,
  'app.start': ([n]) => { apps.find((a) => a.name === n).state = 'RUNNING'; return 1; },
  'app.stop': ([n]) => { apps.find((a) => a.name === n).state = 'STOPPED'; return 1; },
  'vm.query': () => vms,
  'vm.start': ([id]) => { vms.find((v) => v.id === id).status.state = 'RUNNING'; return null; },
  'vm.stop': ([id]) => { vms.find((v) => v.id === id).status.state = 'STOPPED'; return null; },
  'pool.snapshottask.query': () => [
    { dataset: 'tank/dokumente', enabled: true, state: { state: 'FINISHED', datetime: d(now() - 40 * 60e3) } },
    { dataset: 'tank/fotos', enabled: true, state: { state: 'FINISHED', datetime: d(now() - 40 * 60e3) } },
  ],
  'replication.query': () => [
    { name: 'tank → backup', enabled: true, state: { state: 'ERROR', datetime: d(now() - 7 * 3600e3) } },
  ],
  'cloudsync.query': () => [
    { description: 'Dokumente → Backblaze B2', enabled: true, job: { state: 'SUCCESS', time_finished: d(now() - 11 * 3600e3) } },
    { description: 'Fotos → Storj', enabled: false, job: null },
  ],
  'rsynctask.query': () => [],
};

let tick = 0;
function realtime() {
  tick++;
  const wave = Math.sin(tick / 9) * 12 + Math.sin(tick / 3.1) * 5;
  const burst = tick % 60 > 40 ? 35 : 0;
  const cpu = Math.max(2, 18 + wave + burst + Math.random() * 6);
  const net = Math.max(0, 9e6 + Math.sin(tick / 7) * 7e6 + (burst ? 60e6 : 0) + Math.random() * 3e6);
  return {
    cpu: { cpu: { usage: cpu, temp: 41 + cpu / 5 } },
    memory: { physical_memory_total: 64 * GiB, physical_memory_available: (21 - Math.sin(tick / 20) * 2) * GiB, arc_size: 28 * GiB },
    interfaces: { enp3s0: { received_bytes_rate: net, sent_bytes_rate: net * 0.22 + 1e5 } },
  };
}

// Beispieldaten für Kalender, Nachrichten und Wetter
const pad = (n) => String(n).padStart(2, '0');
const ymd = (dt) => `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}`;
const stamp = (dt) => dt.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
const at = (days, h, m = 0) => { const x = new Date(); x.setDate(x.getDate() + days); x.setHours(h, m, 0, 0); return x; };
const vevent = (uid, title, start, end, extra = '') =>
  `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:${stamp(new Date())}\r\nSUMMARY:${title}\r\nDTSTART:${stamp(start)}\r\nDTEND:${stamp(end)}\r\n${extra}END:VEVENT\r\n`;
const allDay = (uid, title, days) =>
  `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:${stamp(new Date())}\r\nSUMMARY:${title}\r\nDTSTART;VALUE=DATE:${ymd(at(days, 0))}\r\nDTEND;VALUE=DATE:${ymd(at(days + 1, 0))}\r\nEND:VEVENT\r\n`;
const cal = (body) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//demo//DE\r\n${body}END:VCALENDAR\r\n`;
const files = {
  '/privat.ics': () => cal(
    vevent('p1', 'Zahnarzt', at(0, 23, 0), at(0, 23, 45), 'LOCATION:Praxis Dr. Keller\r\n') +
    allDay('p2', 'Geburtstag Oma', 1) +
    vevent('p3', 'Sport', at(-14, 18, 30), at(-14, 20, 0), 'RRULE:FREQ=WEEKLY\r\nLOCATION:Turnhalle\r\n') +
    vevent('p4', 'Abendessen mit Anna', at(3, 19, 0), at(3, 21, 30), 'LOCATION:Trattoria Roma\r\n')),
  '/arbeit.ics': () => cal(
    vevent('a1', 'Team-Besprechung', at(1, 9, 30), at(1, 10, 15)) +
    vevent('a2', 'Quartalsplanung', at(2, 13, 0), at(2, 15, 0), 'LOCATION:Raum 2.14\r\n') +
    vevent('a3', 'Abgabe Bericht', at(5, 12, 0), at(5, 12, 30))),
  '/feed.xml': () => {
    const item = (t, h) => `<item><title>${t}</title><link>https://example.org/${h}</link><pubDate>${new Date(now() - h * 3600e3).toUTCString()}</pubDate></item>`;
    return `<?xml version="1.0"?><rss version="2.0"><channel><title>Beispiel-Nachrichten</title>` +
      item('Bundestag beschließt Haushalt für das kommende Jahr', 0.5) + item('Neue Bahnstrecke zwischen Hamburg und Hannover freigegeben', 1.6) +
      item('Forschende melden Durchbruch bei Feststoffbatterien', 3) + item('Erster Schnee in den Alpen: Skigebiete öffnen früher', 5.2) +
      item('Nationalmannschaft gewinnt Testspiel deutlich', 8) + item('Strompreise sinken zum Jahreswechsel leicht', 12) +
      `</channel></rss>`;
  },
  '/weather': () => JSON.stringify({
    current: { temperature_2m: 7.4, weather_code: 3 },
    daily: { time: [0, 1, 2, 3].map((i) => at(i, 12).toISOString().slice(0, 10)), weather_code: [3, 61, 2, 0],
      temperature_2m_max: [9.1, 8.2, 10.4, 11.0], temperature_2m_min: [3.9, 5.1, 2.2, 1.4] },
  }),
};
const httpServer = require('http').createServer((req, res) => {
  const f = files[req.url.split('?')[0]];
  if (!f) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(f());
}).listen(port);
const wss = new WebSocketServer({ server: httpServer, path: '/api/current' });
wss.on('connection', (ws) => {
  const timer = setInterval(() => {
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'collection_update',
      params: { msg: 'added', collection: 'reporting.realtime', fields: realtime() } }));
  }, Number(process.env.MOCK_INTERVAL || 2000));
  ws.on('close', () => clearInterval(timer));
  ws.on('message', (raw) => {
    const { id, method, params } = JSON.parse(raw);
    const fn = methods[method];
    if (!fn) return ws.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }));
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, result: fn(params || []) }));
  });
});
console.log(`Simuliertes TrueNAS auf ws://localhost:${port}/api/current`);
