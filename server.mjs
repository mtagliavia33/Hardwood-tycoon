// Galaxy Tycoon sync server — deploy on Railway.
// Set the ADMIN_KEY variable to your owner passcode. Attach a volume at
// /data (or set DATA_DIR) so accounts survive redeploys.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
// Only these accounts may ever open the admin panel — even with the right
// passcode. They are also exempt from being blocked. Matched exactly.
const OWNER_ACCOUNTS = ['owner', 'owners alt'];
const VERSION = 13;  // bump on every deploy — clients that loaded an older version are forced to reload
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : './data');
// galaxy.json, not tycoon.json: the switch to Galaxy Tycoon starts a fresh
// database. The old Hardwood Tycoon data stays untouched on the volume.
const DATA_FILE = path.join(DATA_DIR, 'galaxy.json');

// accounts: name -> { pin: sha256, save: <game state|null>, created, lastSeen }
let db = { accounts: {}, commands: {}, admins: [], messages: [], announcement: { text: '', id: 0, at: 0, until: 0 }, blocked: [], dms: {}, dmSeq: 0, chatMuted: [], market: null, goal: null, goalHistory: {} };
// active announcement: blanks out the text once its 'until' time has passed
function activeAnnouncement(){
  const a = db.announcement || { text: '', id: 0, at: 0, until: 0 };
  if (a.text && a.until && Date.now() > a.until) return { text: '', id: a.id, at: a.at, until: a.until };
  return a;
}
try { db = { ...db, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) }; } catch {}
db.blocked = (db.blocked || []).filter(n => !OWNER_ACCOUNTS.includes(n)); // owner accounts are never blocked
db.chatMuted = (db.chatMuted || []).filter(n => !OWNER_ACCOUNTS.includes(n)); // ...or muted

// Username filter: family game — no swears or inappropriate names, including
// leetspeak (sh1t) and hidden fragments (xX_badword_Xx). FRAGS match anywhere
// in the letters-only name; WORDS only as whole tokens (so "assist" is fine).
const LEET = { '0':'o','1':'i','3':'e','4':'a','5':'s','7':'t','8':'b','@':'a','$':'s','!':'i','+':'t' };
const BAD_FRAGS = ['fuck','shit','bitch','cunt','nigg','fag','whore','slut','penis','vagina','porn','boner','dildo','rape','nazi','hitler','pussy','asshole','dick','sexy','tits','boobs','hentai','blowjob','handjob','wank','molest','pedo','retard','dumbass','jackass','fatass','bigass','badass','smartass','kickass'];
const BAD_WORDS = ['ass','sex','hoe','cum','tit','cock','anal','nude','nudes','bastard','damn','arse','prick','twat','wtf','stfu','kys'];
function nameOk(name){
  const norm = [...String(name).toLowerCase()].map(c => LEET[c] || c).join('');
  const letters = norm.replace(/[^a-z]/g, '');
  if (BAD_FRAGS.some(f => letters.includes(f))) return false;
  return !norm.split(/[^a-z]+/).some(t => BAD_WORDS.includes(t));
}
// sweep accounts that existed before the filter — delete them outright
{
  let swept = false;
  for (const name of Object.keys(db.accounts)){
    if (OWNER_ACCOUNTS.includes(name) || nameOk(name)) continue;
    delete db.accounts[name]; delete db.commands[name];
    db.admins = db.admins.filter(x => x !== name);
    db.blocked = db.blocked.filter(x => x !== name);
    db.chatMuted = db.chatMuted.filter(x => x !== name);
    for (const k of Object.keys(db.dms || {})){ try { if (JSON.parse(k).includes(name)) delete db.dms[k]; } catch {} }
    console.log('removed inappropriate account name:', name);
    swept = true;
  }
  if (swept) setTimeout(() => persist(), 0); // persist is defined below
}

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
// effective owner passcode = in-game override if set, else the ADMIN_KEY env.
// The original ADMIN_KEY always works too, as a recovery key you can't be locked out of.
function currentAdminKey(){ return db.adminKey || ADMIN_KEY; }
function ver(){ return VERSION + (db.verBump || 0); }   // deploy version + runtime bumps (e.g. passcode changes)
const isOwner = req => { const h = req.headers['x-admin-key']; return !!h && (h === currentAdminKey() || (ADMIN_KEY && h === ADMIN_KEY)); };
// The admin panel also requires the caller to be signed in as one of the
// OWNER_ACCOUNTS, proven by that account's PIN — so knowing the passcode is
// not enough. Credentials come in as headers (URI-encoded to stay ASCII-safe).
function ownerAcct(req){
  let name = req.headers['x-acct'] || '', pin = req.headers['x-acct-pin'] || '';
  try { name = decodeURIComponent(name); pin = decodeURIComponent(pin); } catch { return null; }
  name = cleanName(name);
  if (!OWNER_ACCOUNTS.includes(name)) return null;
  const a = db.accounts[name];
  return (a && typeof pin === 'string' && a.pin === hash(pin)) ? name : null;
}

function auth(b){ // -> account or null
  const name = cleanName(b && b.name);
  const a = name && db.accounts[name];
  return (a && typeof b.pin === 'string' && a.pin === hash(b.pin)) ? { name, a } : null;
}
// DM thread key: names may contain any interior character, so a JSON array of
// the sorted pair is the only collision-proof key (JSON.parse recovers both).
const dmKey = (a, b) => JSON.stringify([a, b].sort());
const lastChatAt = new Map(); // name -> ms of last send; in-memory flood guard
function removeAccount(name){ // full cleanup, used by owner deletes and self-deletes
  delete db.accounts[name];
  delete db.commands[name];
  db.admins = db.admins.filter(x => x !== name);
  db.blocked = (db.blocked || []).filter(x => x !== name);
  db.chatMuted = (db.chatMuted || []).filter(x => x !== name);
  for (const k of Object.keys(db.dms || {})){ // drop their DM threads
    try { if (JSON.parse(k).includes(name)) delete db.dms[k]; } catch {}
  }
}
function statsOf(save){
  if (!save || typeof save !== 'object') return { credits: 0, lifetime: 0, dm: 0, planets: 0, bestStreak: 0, collection: 0 };
  return {
    credits: num(save.credits),
    lifetime: num(save.lifetime),
    dm: num(save.dmEarned),
    planets: (save.colonies && typeof save.colonies === 'object') ? Object.keys(save.colonies).length : 0,
    bestStreak: num(save.bestStreak),
    collection: (Array.isArray(save.crew) ? save.crew.length : 0) + (Array.isArray(save.artifacts) ? save.artifacts.length : 0),
  };
}
/* ---- galactic market: server-authoritative Ore/Ice prices ---- */
const MARKET_BASE = { ore: 1, ice: 2 };
const MARKET_TICK = 5 * 60 * 1000;   // re-price at most every 5 minutes, lazily
function market(){
  if (!db.market) db.market = {
    seed: { ore: Math.random() * Math.PI * 2, ice: Math.random() * Math.PI * 2 },
    ore: { price: 1, hist: [] }, ice: { price: 2, hist: [] },
    pressure: { ore: 0, ice: 0 }, lastTick: 0,
  };
  const m = db.market, now = Date.now();
  if (now - m.lastTick >= MARKET_TICK){
    for (const r of ['ore', 'ice']){
      const base = MARKET_BASE[r];
      const wave = 0.35 * Math.sin((2 * Math.PI * now) / 21600000 + m.seed[r]); // 6h cycle
      const noise = (Math.random() - 0.5) * 0.16;
      m[r].price = Math.max(0.5 * base, Math.min(2 * base, base * (1 + wave + noise - (m.pressure[r] || 0))));
      m[r].price = Math.round(m[r].price * 100) / 100;
      m[r].hist.push(m[r].price);
      if (m[r].hist.length > 24) m[r].hist = m[r].hist.slice(-24);
      m.pressure[r] = (m.pressure[r] || 0) * 0.5;   // selling pressure decays each tick
    }
    m.lastTick = now;
    persist();
  }
  return m;
}
/* ---- weekly galaxy goal: one co-op donation target for the whole server ---- */
const GOALS = [
  { text: 'Build the Star Gate 🏗️', res: 'ore',     target: 5e6 },
  { text: 'Fuel the Beacon 🗼',     res: 'fuel',    target: 2e5 },
  { text: 'Fund the Space Zoo 🦁',  res: 'credits', target: 2e7 },
];
function weekIdx(t = Date.now()){ return Math.floor(t / (7 * 24 * 3600 * 1000)); } // whole weeks since epoch
function goal(){
  const w = weekIdx();
  if (!db.goal || db.goal.week !== w){
    if (db.goal && db.goal.week === w - 1) // record whether last week's goal was met
      db.goalHistory[db.goal.week] = totalDonated(db.goal) >= db.goal.target;
    const g = GOALS[w % GOALS.length];
    db.goal = { week: w, text: g.text, res: g.res, target: g.target, contributed: {} };
    persist();
  }
  return db.goal;
}
const totalDonated = g => Object.values(g.contributed || {}).reduce((t, v) => t + num(v), 0);
function goalBoost(){ return db.goalHistory[weekIdx() - 1] === true; } // met last week -> boost this week
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
  if (url.pathname === '/api/ping') return send(res, 200, { ok: true, game: 'space-tycoon', accounts: true, version: ver() });

  // create an account (optionally seeded with an existing local save)
  if (url.pathname === '/api/signup' && req.method === 'POST'){
    const b = await readBody(req);
    const name = cleanName(b && b.name);
    if (!name) return send(res, 400, { error: 'Pick a name first.' });
    if (!nameOk(name)) return send(res, 400, { error: "That name isn't allowed — keep it clean and pick another." });
    // the owner account names are reserved: creating them needs the passcode
    if (OWNER_ACCOUNTS.includes(name) && req.headers['x-admin-key'] !== ADMIN_KEY)
      return send(res, 403, { error: 'That name is reserved for the owner.' });
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
    return send(res, 200, { ok: true, save: got.a.save, admin: db.admins.includes(got.name), blocked: (db.blocked || []).includes(got.name) });
  }

  // push the current save; response carries pending admin commands + admin flag
  if (url.pathname === '/api/save' && req.method === 'POST'){
    const b = await readBody(req);
    const got = auth(b);
    if (!got) return send(res, 401, { error: 'Wrong name or PIN.' });
    if (b.save && typeof b.save === 'object') got.a.save = b.save;
    got.a.lastSeen = Date.now(); persist();
    return send(res, 200, { ok: true, commands: takeCommands(got.name), admin: db.admins.includes(got.name), blocked: (db.blocked || []).includes(got.name) });
  }

  // rename an account (auth by pin)
  if (url.pathname === '/api/rename' && req.method === 'POST'){
    const b = await readBody(req);
    const got = auth(b);
    if (!got) return send(res, 401, { error: 'Wrong name or PIN.' });
    const to = cleanName(b.newName);
    if (!to) return send(res, 400, { error: 'Pick a new name.' });
    if (!nameOk(to)) return send(res, 400, { error: "That name isn't allowed — keep it clean and pick another." });
    if (db.accounts[to]) return send(res, 409, { error: 'That name is taken.' });
    db.accounts[to] = got.a;
    delete db.accounts[got.name];
    if (db.commands[got.name]){ db.commands[to] = db.commands[got.name]; delete db.commands[got.name]; }
    db.admins = db.admins.map(x => x === got.name ? to : x);
    db.chatMuted = (db.chatMuted || []).map(x => x === got.name ? to : x);
    for (const k of Object.keys(db.dms || {})){ // carry DM threads to the new name
      let pair; try { pair = JSON.parse(k); } catch { continue; }
      if (!pair.includes(got.name)) continue;
      const msgs = db.dms[k];
      msgs.forEach(m => { if (m.from === got.name) m.from = to; });
      delete db.dms[k];
      db.dms[dmKey(pair[0] === got.name ? to : pair[0], pair[1] === got.name ? to : pair[1])] = msgs;
    }
    persist();
    return send(res, 200, { ok: true });
  }

  // delete your own account (auth by pin — you can only delete yourself)
  if (url.pathname === '/api/account/delete' && req.method === 'POST'){
    const b = await readBody(req);
    const got = auth(b);
    if (!got) return send(res, 401, { error: 'Wrong name or PIN.' });
    if (OWNER_ACCOUNTS.includes(got.name)) return send(res, 403, { error: "The owner account can't be deleted from in the game." });
    removeAccount(got.name);
    persist();
    return send(res, 200, { ok: true, deleted: true });
  }

  // anyone can message the owner
  if (url.pathname === '/api/message' && req.method === 'POST'){
    const b = await readBody(req);
    const text = (typeof (b && b.text) === 'string' ? b.text : '').trim().slice(0, 500);
    if (!text) return send(res, 400, { error: 'Type a message first.' });
    db.messages.push({ from: cleanName(b && b.from) || 'Guest', text, at: Date.now(), read: false });
    if (db.messages.length > 300) db.messages = db.messages.slice(-300);
    persist();
    return send(res, 200, { ok: true });
  }

  // owner: read the inbox
  if (url.pathname === '/api/inbox' && req.method === 'GET'){
    if (!currentAdminKey()) return send(res, 503, { error: 'Set the ADMIN_KEY variable on the server first.' });
    if (!isOwner(req)) return send(res, 401, { error: 'wrong passcode' });
    if (!ownerAcct(req)) return send(res, 403, { error: 'Only the owner account can use the admin panel.' });
    return send(res, 200, { messages: db.messages.slice().reverse() }); // newest first
  }

  // owner: mark all read, or clear the inbox
  if (url.pathname === '/api/inbox' && req.method === 'POST'){
    if (!currentAdminKey()) return send(res, 503, { error: 'Set the ADMIN_KEY variable on the server first.' });
    if (!isOwner(req)) return send(res, 401, { error: 'wrong passcode' });
    if (!ownerAcct(req)) return send(res, 403, { error: 'Only the owner account can use the admin panel.' });
    const b = await readBody(req);
    if (b && b.action === 'clear') db.messages = [];
    else db.messages.forEach(m => { m.read = true; });
    persist();
    return send(res, 200, { ok: true });
  }

  // chat: send a private DM to another account (accounts only — PIN auth)
  if (url.pathname === '/api/chat/send' && req.method === 'POST'){
    const b = await readBody(req);
    const got = auth(b);
    if (!got) return send(res, 401, { error: 'Wrong name or PIN.' });
    if ((db.chatMuted || []).includes(got.name)) return send(res, 403, { error: 'You are muted.' });
    const to = cleanName(b && b.to);
    if (!to || !db.accounts[to]) return send(res, 400, { error: 'Unknown player.' });
    if (to === got.name) return send(res, 400, { error: "You can't message yourself." });
    const text = (typeof b.text === 'string' ? b.text : '').trim().slice(0, 300);
    if (!text) return send(res, 400, { error: 'Type a message first.' });
    if (Date.now() - (lastChatAt.get(got.name) || 0) < 1000) return send(res, 429, { error: 'Slow down.' });
    lastChatAt.set(got.name, Date.now());
    const k = dmKey(got.name, to);
    const m = { id: ++db.dmSeq, from: got.name, text, at: Date.now() };
    (db.dms[k] = db.dms[k] || []).push(m);
    if (db.dms[k].length > 200) db.dms[k] = db.dms[k].slice(-200);
    persist();
    return send(res, 200, { ok: true, id: m.id });
  }

  // chat: all my DM threads
  if (url.pathname === '/api/chat/fetch' && req.method === 'POST'){
    const b = await readBody(req);
    const got = auth(b);
    if (!got) return send(res, 401, { error: 'Wrong name or PIN.' });
    const threads = {};
    for (const [k, msgs] of Object.entries(db.dms || {})){
      let pair; try { pair = JSON.parse(k); } catch { continue; }
      if (pair[0] === got.name) threads[pair[1]] = msgs;
      else if (pair[1] === got.name) threads[pair[0]] = msgs;
    }
    return send(res, 200, { threads, muted: (db.chatMuted || []).includes(got.name) });
  }

  // owner: recent messages across every thread, for moderation
  if (url.pathname === '/api/chat/all' && req.method === 'GET'){
    if (!currentAdminKey()) return send(res, 503, { error: 'Set the ADMIN_KEY variable on the server first.' });
    if (!isOwner(req)) return send(res, 401, { error: 'wrong passcode' });
    if (!ownerAcct(req)) return send(res, 403, { error: 'Only the owner account can use the admin panel.' });
    const messages = [];
    for (const [k, msgs] of Object.entries(db.dms || {})){
      let pair; try { pair = JSON.parse(k); } catch { continue; }
      for (const m of msgs) messages.push({ ...m, to: m.from === pair[0] ? pair[1] : pair[0] });
    }
    messages.sort((x, y) => y.at - x.at);
    return send(res, 200, { messages: messages.slice(0, 100), muted: db.chatMuted || [] });
  }

  // owner: delete any chat message by id
  if (url.pathname === '/api/chat/delete' && req.method === 'POST'){
    if (!currentAdminKey()) return send(res, 503, { error: 'Set the ADMIN_KEY variable on the server first.' });
    if (!isOwner(req)) return send(res, 401, { error: 'wrong passcode' });
    if (!ownerAcct(req)) return send(res, 403, { error: 'Only the owner account can use the admin panel.' });
    const b = await readBody(req);
    const id = num(b && b.id);
    for (const k of Object.keys(db.dms || {})){
      const i = db.dms[k].findIndex(m => m.id === id);
      if (i >= 0){
        db.dms[k].splice(i, 1);
        if (!db.dms[k].length) delete db.dms[k];
        persist();
        return send(res, 200, { ok: true, deleted: true });
      }
    }
    return send(res, 404, { error: 'Message not found.' });
  }

  // public: global leaderboard data (+ market/goal state — one poll for everything).
  // The envelope { rows, announcement, version } must stay: pre-cutover clients
  // rely on it to detect the version change and force-reload into this game.
  if (url.pathname === '/api/leaderboard' && req.method === 'GET'){
    const rows = Object.entries(db.accounts).map(([name, a]) => {
      const s = statsOf(a.save);
      return { name, lifetime: s.lifetime, dm: s.dm, planets: s.planets, bestStreak: s.bestStreak, collection: s.collection,
               contrib: num((goal().contributed || {})[name]), lastSeen: a.lastSeen };
    });
    const m = market(), g = goal();
    return send(res, 200, { rows, announcement: activeAnnouncement(), version: ver(),
      market: { ore: m.ore, ice: m.ice },
      goal: { text: g.text, res: g.res, target: g.target, donated: totalDonated(g), boost: goalBoost() } });
  }

  // market: sell/buy ore or ice at the current server price (accounts only)
  if (url.pathname === '/api/market/trade' && req.method === 'POST'){
    const b = await readBody(req);
    const got = auth(b);
    if (!got) return send(res, 401, { error: 'Wrong name or PIN.' });
    const res_ = (b && b.res === 'ice') ? 'ice' : (b && b.res === 'ore') ? 'ore' : null;
    const dir = (b && b.dir === 'buy') ? 'buy' : (b && b.dir === 'sell') ? 'sell' : null;
    const amount = Math.floor(num(b && b.amount));
    if (!res_ || !dir || amount <= 0) return send(res, 400, { error: 'Bad trade.' });
    const m = market();
    const price = m[res_].price;
    const credits = Math.floor(amount * price);
    // pressure: player sells push the price down, buys push it up (clamped)
    const push = Math.min(0.1, amount / 1e6);
    m.pressure[res_] = Math.max(-0.3, Math.min(0.3, (m.pressure[res_] || 0) + (dir === 'sell' ? push : -push)));
    got.a.lastSeen = Date.now(); persist();
    return send(res, 200, { ok: true, price, credits, dir, res: res_, amount });
  }

  // weekly goal: donate the goal resource (accounts only; client deducts locally)
  if (url.pathname === '/api/goal/donate' && req.method === 'POST'){
    const b = await readBody(req);
    const got = auth(b);
    if (!got) return send(res, 401, { error: 'Wrong name or PIN.' });
    const g = goal();
    const amount = Math.floor(num(b && b.amount));
    if (!amount || amount <= 0 || (b && b.res) !== g.res) return send(res, 400, { error: 'Bad donation.' });
    g.contributed[got.name] = num(g.contributed[got.name]) + amount;
    persist();
    return send(res, 200, { ok: true, donated: totalDonated(g), target: g.target, mine: g.contributed[got.name] });
  }

  // owner: every account in the game
  if (url.pathname === '/api/players' && req.method === 'GET'){
    if (!currentAdminKey()) return send(res, 503, { error: 'Set the ADMIN_KEY variable on the server first.' });
    if (!isOwner(req)) return send(res, 401, { error: 'wrong passcode' });
    if (!ownerAcct(req)) return send(res, 403, { error: 'Only the owner account can use the admin panel.' });
    const players = {};
    for (const [name, a] of Object.entries(db.accounts)) players[name] = {
      ...statsOf(a.save), lastSeen: a.lastSeen,
      pending: (db.commands[name] || []).reduce((t, c) => t + num(c.give), 0), // queued gives not yet collected
    };
    return send(res, 200, { players, admins: db.admins, blocked: db.blocked || [], chatMuted: db.chatMuted || [], announcement: db.announcement });
  }

  // owner: set or clear the global announcement everyone sees on login
  if (url.pathname === '/api/announce' && req.method === 'POST'){
    if (!currentAdminKey()) return send(res, 503, { error: 'Set the ADMIN_KEY variable on the server first.' });
    if (!isOwner(req)) return send(res, 401, { error: 'wrong passcode' });
    if (!ownerAcct(req)) return send(res, 403, { error: 'Only the owner account can use the admin panel.' });
    const b = await readBody(req);
    const text = (typeof (b && b.text) === 'string' ? b.text : '').trim().slice(0, 300);
    const until = num(b && b.until);   // absolute ms timestamp; 0 = until manually cleared
    db.announcement = { text, id: (db.announcement.id || 0) + 1, at: Date.now(), until: until > 0 ? until : 0 };
    persist();
    return send(res, 200, { ok: true, announcement: db.announcement });
  }

  // owner: give money / reset / grant admin
  if (url.pathname === '/api/command' && req.method === 'POST'){
    if (!currentAdminKey()) return send(res, 503, { error: 'Set the ADMIN_KEY variable on the server first.' });
    if (!isOwner(req)) return send(res, 401, { error: 'wrong passcode' });
    if (!ownerAcct(req)) return send(res, 403, { error: 'Only the owner account can use the admin panel.' });
    const b = await readBody(req);
    const name = cleanName(b && b.name);
    if (!name || !db.accounts[name] || !b.cmd || typeof b.cmd !== 'object') return send(res, 400, { error: 'unknown account or empty cmd' });
    if (b.cmd.delete === true){ // remove the account entirely
      removeAccount(name);
      persist();
      return send(res, 200, { ok: true, deleted: true });
    }
    const cmd = {};
    if (num(b.cmd.give) > 0) cmd.give = num(b.cmd.give);
    if (b.cmd.reset === true) cmd.reset = true;
    if (typeof b.cmd.message === 'string' && b.cmd.message.trim()) cmd.message = b.cmd.message.trim().slice(0, 500);
    if (typeof b.cmd.admin === 'boolean') db.admins = b.cmd.admin
      ? [...new Set([...db.admins, name])] : db.admins.filter(x => x !== name);
    if (typeof b.cmd.block === 'boolean' && !OWNER_ACCOUNTS.includes(name)){ // owner accounts can never be blocked
      db.blocked = b.cmd.block ? [...new Set([...(db.blocked || []), name])] : (db.blocked || []).filter(x => x !== name);
      if (b.cmd.block) db.admins = db.admins.filter(x => x !== name); // blocking also strips admin
    }
    if (typeof b.cmd.chatmute === 'boolean' && !OWNER_ACCOUNTS.includes(name)) // ...or muted from chat
      db.chatMuted = b.cmd.chatmute ? [...new Set([...(db.chatMuted || []), name])] : (db.chatMuted || []).filter(x => x !== name);
    // set leaderboard-rankable stats to chosen values
    if (b.cmd.set && typeof b.cmd.set === 'object'){
      cmd.set = {};
      for (const k of ['credits', 'lifetime', 'ore', 'ice', 'fuel', 'dm', 'dmEarned', 'bestStreak']){
        if (k in b.cmd.set){ const v = num(b.cmd.set[k]); if (v >= 0) cmd.set[k] = v; }
      }
      if (!Object.keys(cmd.set).length) delete cmd.set;
      else if (db.accounts[name].save && typeof db.accounts[name].save === 'object')
        for (const k in cmd.set) db.accounts[name].save[k] = cmd.set[k];   // mirror so the board updates now
    }
    // reset wipes the stored save now AND queues it for a live session, but
    // keeps the permanent collection: crew, artifacts, tech, dark matter.
    if (cmd.reset){
      const old = db.accounts[name].save;
      db.accounts[name].save = old ? { crew: old.crew || [], artifacts: old.artifacts || [], tech: old.tech || [], dm: num(old.dm), dmEarned: num(old.dmEarned) } : null;
    }
    if (Object.keys(cmd).length) (db.commands[name] = db.commands[name] || []).push(cmd);
    persist();
    return send(res, 200, { ok: true });
  }

  // owner: change the panel passcode (requires the current passcode)
  if (url.pathname === '/api/admin/passcode' && req.method === 'POST'){
    if (!currentAdminKey()) return send(res, 503, { error: 'Set the ADMIN_KEY variable on the server first.' });
    if (!isOwner(req)) return send(res, 401, { error: 'wrong passcode' });
    if (!ownerAcct(req)) return send(res, 403, { error: 'Only the owner account can use the admin panel.' });
    const b = await readBody(req);
    const nk = (typeof (b && b.newKey) === 'string' ? b.newKey : '').trim();
    if (nk.length < 3) return send(res, 400, { error: 'New passcode must be at least 3 characters.' });
    db.adminKey = nk; db.verBump = (db.verBump || 0) + 1; persist();   // force everyone to reload
    return send(res, 200, { ok: true });
  }

  // owner: force every open client to reload (e.g. after a hosting hiccup)
  if (url.pathname === '/api/admin/bump' && req.method === 'POST'){
    if (!currentAdminKey()) return send(res, 503, { error: 'Set the ADMIN_KEY variable on the server first.' });
    if (!isOwner(req)) return send(res, 401, { error: 'wrong passcode' });
    if (!ownerAcct(req)) return send(res, 403, { error: 'Only the owner account can use the admin panel.' });
    db.verBump = (db.verBump || 0) + 1; persist();
    return send(res, 200, { ok: true, version: ver() });
  }

  send(res, 404, { error: 'not found' });
});

server.listen(PORT, () => console.log(`Hardwood Tycoon server on :${PORT} (admin key ${ADMIN_KEY ? 'set' : 'NOT SET'})`));
