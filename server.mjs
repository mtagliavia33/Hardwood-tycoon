// Hardwood Tycoon sync server — deploy on Railway.
// Set the ADMIN_KEY variable to your owner passcode. Attach a volume at
// /data (or set DATA_DIR) so accounts survive redeploys.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : './data');
const DATA_FILE = path.join(DATA_DIR, 'tycoon.json');

// accounts: name -> { pin: sha256, save: <game state|null>, created, lastSeen }
let db = { accounts: {}, commands: {}, admins: [] };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) }; } catch {}

let saveTimer = null;
function persist(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(db));
    } catch (e) { console.error('persist failed:', e.message); }
  }, 250);
}

function send(res, code, body, type = 'application/json'){
  res.writeHead(code, {
    'content-type': type,
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type,x-admin-key',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}
const readBody = req => new Promise(resolve => {
  let b = '';
  req.on('data', c => { b += c; if (b.length > 2e6) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
});
const cleanName = v => (typeof v === 'string' ? v : '').trim().slice(0, 20);
const num = v => (typeof v === 'number' && isFinite(v)) ? v : 0;
const hash = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const isOwner = req => ADMIN_KEY && req.headers['x-admin-key'] === ADMIN_KEY;

function auth(b){ // -> account or null
  const name = cleanName(b && b.name);
  const a = name && db.accounts[name];
  return (a && typeof b.pin === 'string' && a.pin === hash(b.pin)) ? { name, a } : null;
}
function statsOf(save){
  if (!save || !Array.isArray(save.worlds)) return { cash: 10, all: 0, playtime: 0, peakRate: 0, rings: 0, prestiges: 0 };
  return {
    cash: save.worlds.reduce((t, w) => t + num(w && w.cash), 0),
    all: num(save.all), playtime: num(save.playtime), peakRate: num(save.peakRate),
    rings: num(save.rings), prestiges: num(save.prestiges),
  };
}
function takeCommands(name){
  const cmds = db.commands[name] || [];
  if (cmds.length){ db.commands[name] = []; persist(); }
  return cmds;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, '');
  const url = new URL(req.url, 'http://x');

  // the game itself, so the Railway URL is also playable
  if (url.pathname === '/' || url.pathname === '/index.html'){
    try { return send(res, 200, fs.readFileSync('./index.html'), 'text/html; charset=utf-8'); }
    catch { return send(res, 404, { error: 'index.html missing' }); }
  }
  if (url.pathname === '/api/ping') return send(res, 200, { ok: true, game: 'hardwood-tycoon', accounts: true });

  // create an account (optionally seeded with an existing local save)
  if (url.pathname === '/api/signup' && req.method === 'POST'){
    const b = await readBody(req);
    const name = cleanName(b && b.name);
    if (!name) return send(res, 400, { error: 'Pick a name first.' });
    if (typeof (b && b.pin) !== 'string' || b.pin.length < 4) return send(res, 400, { error: 'PIN must be at least 4 characters.' });
    if (db.accounts[name]) return send(res, 409, { error: 'That name is taken — log in instead, or pick another.' });
    const device = typeof (b && b.device) === 'string' ? b.device.slice(0, 64) : '';
    if (device && Object.values(db.accounts).filter(a => a.device === device).length >= 2)
      return send(res, 403, { error: 'This device already has 2 accounts — that\'s the max.' });
    db.accounts[name] = { pin: hash(b.pin), save: (b.save && typeof b.save === 'object') ? b.save : null,
      device, created: Date.now(), lastSeen: Date.now() };
    persist();
    return send(res, 200, { ok: true, save: db.accounts[name].save, admin: db.admins.includes(name) });
  }

  // log in from any device
  if (url.pathname === '/api/login' && req.method === 'POST'){
    const b = await readBody(req);
    const got = auth(b);
    if (!got) return send(res, 401, { error: 'Wrong name or PIN.' });
    got.a.lastSeen = Date.now(); persist();
    return send(res, 200, { ok: true, save: got.a.save, admin: db.admins.includes(got.name) });
  }

  // push the current save; response carries pending admin commands + admin flag
  if (url.pathname === '/api/save' && req.method === 'POST'){
    const b = await readBody(req);
    const got = auth(b);
    if (!got) return send(res, 401, { error: 'Wrong name or PIN.' });
    if (b.save && typeof b.save === 'object') got.a.save = b.save;
    got.a.lastSeen = Date.now(); persist();
    return send(res, 200, { ok: true, commands: takeCommands(got.name), admin: db.admins.includes(got.name) });
  }

  // rename an account (auth by pin)
  if (url.pathname === '/api/rename' && req.method === 'POST'){
    const b = await readBody(req);
    const got = auth(b);
    if (!got) return send(res, 401, { error: 'Wrong name or PIN.' });
    const to = cleanName(b.newName);
    if (!to) return send(res, 400, { error: 'Pick a new name.' });
    if (db.accounts[to]) return send(res, 409, { error: 'That name is taken.' });
    db.accounts[to] = got.a;
    delete db.accounts[got.name];
    if (db.commands[got.name]){ db.commands[to] = db.commands[got.name]; delete db.commands[got.name]; }
    db.admins = db.admins.map(x => x === got.name ? to : x);
    persist();
    return send(res, 200, { ok: true });
  }

  // public: global leaderboard data
  if (url.pathname === '/api/leaderboard' && req.method === 'GET'){
    const rows = Object.entries(db.accounts).map(([name, a]) => {
      const s = statsOf(a.save);
      return { name, all: s.all, playtime: s.playtime, peakRate: s.peakRate, rings: s.rings, lastSeen: a.lastSeen };
    });
    return send(res, 200, { rows });
  }

  // owner: every account in the game
  if (url.pathname === '/api/players' && req.method === 'GET'){
    if (!ADMIN_KEY) return send(res, 503, { error: 'Set the ADMIN_KEY variable on the server first.' });
    if (!isOwner(req)) return send(res, 401, { error: 'wrong passcode' });
    const players = {};
    for (const [name, a] of Object.entries(db.accounts)) players[name] = {
      ...statsOf(a.save), lastSeen: a.lastSeen,
      pending: (db.commands[name] || []).reduce((t, c) => t + num(c.give), 0), // queued gives not yet collected
    };
    return send(res, 200, { players, admins: db.admins });
  }

  // owner: give money / reset / grant admin
  if (url.pathname === '/api/command' && req.method === 'POST'){
    if (!ADMIN_KEY) return send(res, 503, { error: 'Set the ADMIN_KEY variable on the server first.' });
    if (!isOwner(req)) return send(res, 401, { error: 'wrong passcode' });
    const b = await readBody(req);
    const name = cleanName(b && b.name);
    if (!name || !db.accounts[name] || !b.cmd || typeof b.cmd !== 'object') return send(res, 400, { error: 'unknown account or empty cmd' });
    if (b.cmd.delete === true){ // remove the account entirely
      delete db.accounts[name];
      delete db.commands[name];
      db.admins = db.admins.filter(x => x !== name);
      persist();
      return send(res, 200, { ok: true, deleted: true });
    }
    const cmd = {};
    if (num(b.cmd.give) > 0) cmd.give = num(b.cmd.give);
    if (b.cmd.reset === true) cmd.reset = true;
    if (typeof b.cmd.admin === 'boolean') db.admins = b.cmd.admin
      ? [...new Set([...db.admins, name])] : db.admins.filter(x => x !== name);
    // reset is idempotent: wipe the stored save now AND queue it for a live session
    if (cmd.reset) db.accounts[name].save = null;
    if (Object.keys(cmd).length) (db.commands[name] = db.commands[name] || []).push(cmd);
    persist();
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: 'not found' });
});

server.listen(PORT, () => console.log(`Hardwood Tycoon server on :${PORT} (admin key ${ADMIN_KEY ? 'set' : 'NOT SET'})`));
