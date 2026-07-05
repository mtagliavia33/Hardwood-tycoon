// Hardwood Tycoon sync server — deploy on Railway.
// Set the ADMIN_KEY variable to your owner passcode. Attach a volume at
// /data (or set DATA_DIR) so player data survives redeploys.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : './data');
const DATA_FILE = path.join(DATA_DIR, 'tycoon.json');

let db = { players: {}, commands: {}, admins: [] };
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
  req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
});
const cleanName = v => (typeof v === 'string' ? v : '').trim().slice(0, 20);
const num = v => (typeof v === 'number' && isFinite(v)) ? v : 0;
const isOwner = req => ADMIN_KEY && req.headers['x-admin-key'] === ADMIN_KEY;

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, '');
  const url = new URL(req.url, 'http://x');

  // the game itself, so the Railway URL is also playable
  if (url.pathname === '/' || url.pathname === '/index.html'){
    try { return send(res, 200, fs.readFileSync('./index.html'), 'text/html; charset=utf-8'); }
    catch { return send(res, 404, { error: 'index.html missing' }); }
  }
  if (url.pathname === '/api/ping') return send(res, 200, { ok: true, game: 'hardwood-tycoon' });

  // devices report their accounts' stats
  if (url.pathname === '/api/report' && req.method === 'POST'){
    const b = await readBody(req);
    const name = cleanName(b && b.name);
    if (!name) return send(res, 400, { error: 'name required' });
    db.players[name] = {
      cash: num(b.cash), all: num(b.all), playtime: num(b.playtime), peakRate: num(b.peakRate),
      rings: num(b.rings), prestiges: num(b.prestiges), lastSeen: Date.now(),
    };
    persist();
    return send(res, 200, { ok: true });
  }

  // devices poll for admin commands aimed at their player
  if (url.pathname === '/api/commands' && req.method === 'GET'){
    const name = cleanName(url.searchParams.get('name'));
    const cmds = db.commands[name] || [];
    if (cmds.length){ db.commands[name] = []; persist(); }
    return send(res, 200, { commands: cmds, admin: db.admins.includes(name) });
  }

  // owner: full player list
  if (url.pathname === '/api/players' && req.method === 'GET'){
    if (!ADMIN_KEY) return send(res, 503, { error: 'Set the ADMIN_KEY variable on the server first.' });
    if (!isOwner(req)) return send(res, 401, { error: 'wrong passcode' });
    return send(res, 200, { players: db.players, admins: db.admins });
  }

  // owner: queue a command for a player (give money / reset / admin)
  if (url.pathname === '/api/command' && req.method === 'POST'){
    if (!ADMIN_KEY) return send(res, 503, { error: 'Set the ADMIN_KEY variable on the server first.' });
    if (!isOwner(req)) return send(res, 401, { error: 'wrong passcode' });
    const b = await readBody(req);
    const name = cleanName(b && b.name);
    if (!name || !b.cmd || typeof b.cmd !== 'object') return send(res, 400, { error: 'name and cmd required' });
    const cmd = {};
    if (num(b.cmd.give) > 0) cmd.give = num(b.cmd.give);
    if (b.cmd.reset === true) cmd.reset = true;
    if (typeof b.cmd.admin === 'boolean') cmd.admin = b.cmd.admin;
    if (!Object.keys(cmd).length) return send(res, 400, { error: 'empty cmd' });
    if ('admin' in cmd) db.admins = cmd.admin ? [...new Set([...db.admins, name])] : db.admins.filter(x => x !== name);
    // mirror the effect on the server record so the owner list updates immediately
    const p = db.players[name];
    if (p){
      if (cmd.give) p.cash += cmd.give;
      if (cmd.reset){ p.cash = 10; p.all = 0; p.playtime = 0; p.peakRate = 0; p.rings = 0; p.prestiges = 0; }
    }
    (db.commands[name] = db.commands[name] || []).push(cmd);
    persist();
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: 'not found' });
});

server.listen(PORT, () => console.log(`Hardwood Tycoon server on :${PORT} (admin key ${ADMIN_KEY ? 'set' : 'NOT SET'})`));
