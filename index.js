import GAME from './game.html';
// BlockRacer multiplayer server — Cloudflare Workers + Durable Objects (SQLite backend, free plan)
// Hub  : accounts, sessions, room directory (single instance "hub")
// Room : one instance per lobby, holds the players' WebSockets (Hibernation API)

const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', ...CORS } });
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' };
const enc = new TextEncoder();
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const rnd = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const NICK_RE = /^[A-Za-z0-9_\-Ѐ-ӿ]{3,16}$/;
const MAX_PLAYERS = 16, MAX_CAR = 60000, SESSION_DAYS = 30;

async function pbkdf2(pw, saltHex, iter = 100000) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256));
}
function same(a, b) { if (typeof a != 'string' || typeof b != 'string' || a.length != b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
const hub = env => env.HUB.get(env.HUB.idFromName('hub'));
const hubCall = async (env, path, body) => (await hub(env).fetch('https://hub/' + path, { method: 'POST', body: JSON.stringify(body || {}) })).json();

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method == 'OPTIONS') return new Response(null, { headers: CORS });
    if (url.pathname.startsWith('/api/')) {
      const op = url.pathname.slice(5);
      if (!['register', 'login', 'logout', 'me', 'rooms', 'create', 'joincheck', 'save', 'load'].includes(op)) return J({ error: 'not_found' }, 404);
      let body = {}; if (req.method == 'POST') { try { body = await req.json() } catch (e) { return J({ error: 'bad_json' }, 400) } }
      body.ip = req.headers.get('cf-connecting-ip') || '';
      const r = await hubCall(env, op, body);
      return J(r, r.error ? 400 : 200);
    }
    if (url.pathname == '/ws') {
      if (req.headers.get('Upgrade') != 'websocket') return J({ error: 'need_websocket' }, 426);
      const room = url.searchParams.get('room') || '', token = url.searchParams.get('token') || '', pw = url.searchParams.get('pw') || '';
      const chk = await hubCall(env, 'joincheck', { room, token, pw });
      if (chk.error) return J(chk, 403);
      const stub = env.ROOM.get(env.ROOM.idFromName(room));
      const h = new Headers(req.headers); h.set('x-nick', encodeURIComponent(chk.nick)); h.set('x-room', room);
      return stub.fetch(new Request('https://room/ws', { headers: h }));
    }
    if (url.pathname == '/' || url.pathname == '/index.html') return new Response(GAME, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    return new Response('Not found', { status: 404 });
  }
};

export class Hub {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; const sql = ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS users(nick TEXT PRIMARY KEY COLLATE NOCASE, salt TEXT, hash TEXT, created INTEGER)');
    sql.exec('CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, nick TEXT, exp INTEGER)');
    sql.exec('CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY, name TEXT, host TEXT, pws TEXT, pwh TEXT, n INTEGER, created INTEGER)');
    sql.exec('CREATE TABLE IF NOT EXISTS fails(k TEXT, t INTEGER)');
    sql.exec('CREATE TABLE IF NOT EXISTS saves(nick TEXT PRIMARY KEY COLLATE NOCASE, data TEXT, t INTEGER)');
  }
  q(s, ...a) { return this.ctx.storage.sql.exec(s, ...a).toArray(); }
  nickOf(token) { if (typeof token != 'string' || token.length != 64) return null; const r = this.q('SELECT nick,exp FROM sessions WHERE token=?', token)[0]; if (!r || r.exp < Date.now()) return null; return r.nick; }
  limited(k) { const t = Date.now(); this.q('DELETE FROM fails WHERE t<?', t - 600000); return this.q('SELECT COUNT(*) AS c FROM fails WHERE k=?', k)[0].c >= 8; }
  fail(k) { this.q('INSERT INTO fails VALUES(?,?)', k, Date.now()); }
  async fetch(req) {
    const op = new URL(req.url).pathname.slice(1); let b = {}; try { b = await req.json() } catch (e) { }
    try { return Response.json(await this[op]?.(b) ?? { error: 'not_found' }) } catch (e) { return Response.json({ error: 'server', msg: String(e && e.message || e) }) }
  }
  // облачное сохранение карьеры (одна запись на аккаунт)
  async save(b) {
    const nick = this.nickOf(b.token); if (!nick) return { error: 'auth' };
    const d = String(b.data || ''); if (!d.startsWith('BRSAVE1.') || d.length > 900000) return { error: 'bad_save' };
    const last = this.q('SELECT t FROM saves WHERE nick=?', nick)[0]; if (last && Date.now() - last.t < 1500) return { error: 'too_fast' };
    const t = Date.now(); this.q('INSERT OR REPLACE INTO saves VALUES(?,?,?)', nick, d, t); return { ok: true, t };
  }
  async load(b) {
    const nick = this.nickOf(b.token); if (!nick) return { error: 'auth' };
    const r = this.q('SELECT data,t FROM saves WHERE nick=?', nick)[0]; return r ? { data: r.data, t: r.t } : { data: null };
  }
  async register(b) {
    const nick = String(b.nick || '').trim(), pw = String(b.password || '');
    if (!NICK_RE.test(nick)) return { error: 'bad_nick' };
    if (pw.length < 4 || pw.length > 64) return { error: 'bad_password' };
    if (this.limited('ip:' + b.ip)) return { error: 'too_many' };
    if (this.q('SELECT 1 FROM users WHERE nick=?', nick).length) { this.fail('ip:' + b.ip); return { error: 'nick_taken' }; }
    const salt = rnd(16); this.q('INSERT INTO users VALUES(?,?,?,?)', nick, salt, await pbkdf2(pw, salt), Date.now());
    return this.login(b);
  }
  async login(b) {
    const nick = String(b.nick || '').trim(), pw = String(b.password || '');
    if (this.limited('n:' + nick.toLowerCase())) return { error: 'too_many' };
    const u = this.q('SELECT nick,salt,hash FROM users WHERE nick=?', nick)[0];
    if (!u || !same(await pbkdf2(pw, u.salt), u.hash)) { this.fail('n:' + nick.toLowerCase()); return { error: 'bad_login' }; }
    const token = rnd(32); this.q('DELETE FROM sessions WHERE exp<?', Date.now());
    this.q('INSERT INTO sessions VALUES(?,?,?)', token, u.nick, Date.now() + SESSION_DAYS * 864e5);
    return { ok: 1, token, nick: u.nick };
  }
  async logout(b) { this.q('DELETE FROM sessions WHERE token=?', String(b.token || '')); return { ok: 1 }; }
  async me(b) { const n = this.nickOf(b.token); return n ? { ok: 1, nick: n } : { error: 'auth' }; }
  async rooms(b) {
    if (!this.nickOf(b.token)) return { error: 'auth' };
    this.q('DELETE FROM rooms WHERE n=0 AND created<?', Date.now() - 90000);
    return { ok: 1, rooms: this.q('SELECT id,name,host,n,(pwh<>\'\') AS locked FROM rooms ORDER BY n DESC, created DESC LIMIT 100') };
  }
  async create(b) {
    const nick = this.nickOf(b.token); if (!nick) return { error: 'auth' };
    const name = String(b.name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 32); if (name.length < 1) return { error: 'bad_name' };
    const pw = String(b.password || ''); if (pw.length > 32) return { error: 'bad_password' };
    if (this.q('SELECT COUNT(*) AS c FROM rooms WHERE host=? AND n=0', nick)[0].c >= 3) return { error: 'too_many_rooms' };
    const id = rnd(5), pws = pw ? rnd(16) : '', pwh = pw ? await pbkdf2(pw, pws, 20000) : '';
    this.q('INSERT INTO rooms VALUES(?,?,?,?,?,0,?)', id, name, nick, pws, pwh, Date.now());
    return { ok: 1, id, name };
  }
  async joincheck(b) {
    const nick = this.nickOf(b.token); if (!nick) return { error: 'auth' };
    const r = this.q('SELECT * FROM rooms WHERE id=?', String(b.room || ''))[0]; if (!r) return { error: 'no_room' };
    if (r.n >= MAX_PLAYERS) return { error: 'room_full' };
    if (r.pwh) { const k = 'r:' + r.id + ':' + nick; if (this.limited(k)) return { error: 'too_many' };
      if (!same(await pbkdf2(String(b.pw || ''), r.pws, 20000), r.pwh)) { this.fail(k); return { error: 'bad_room_password' }; } }
    return { ok: 1, nick, name: r.name };
  }
  async count(b) { // from Room: current number of players
    const n = Math.max(0, b.n | 0);
    if (n == 0) this.q('DELETE FROM rooms WHERE id=?', String(b.id)); else this.q('UPDATE rooms SET n=? WHERE id=?', n, String(b.id));
    return { ok: 1 };
  }
}

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.rate = new Map();
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS cars(id TEXT PRIMARY KEY, code TEXT)');
  }
  socks() { return this.ctx.getWebSockets().filter(w => { try { return !!w.deserializeAttachment() } catch (e) { return false } }); }
  info(w) { return w.deserializeAttachment(); }
  send(w, o) { try { w.send(typeof o == 'string' ? o : JSON.stringify(o)) } catch (e) { } }
  bcast(o, except) { const s = JSON.stringify(o); for (const w of this.socks()) if (w !== except) this.send(w, s); }
  async report() { const n = this.socks().length, id = this.room; if (!id) return;
    await hubCall(this.env, 'count', { id, n }); if (n == 0) { await this.ctx.storage.deleteAll(); } }
  async fetch(req) {
    const nick = decodeURIComponent(req.headers.get('x-nick') || ''), room = req.headers.get('x-room') || '';
    this.room = room; await this.ctx.storage.put('room', room);
    for (const w of this.socks()) if (this.info(w).nick == nick) { try { w.close(4001, 'replaced') } catch (e) { } } // one connection per nick
    const pair = new WebSocketPair(), [client, server] = Object.values(pair);
    const id = Math.random().toString(36).slice(2, 10);
    this.ctx.acceptWebSocket(server); server.serializeAttachment({ id, nick, room });
    this.bcast({ t: 'join', id, nick }, server);
    await this.report();
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, msg) {
    const me = this.info(ws); if (!me) return; if (!this.room) this.room = me.room;
    if (typeof msg != 'string' || msg.length > MAX_CAR + 200) return;
    const now = Date.now(), r = this.rate.get(me.id) || { t: now, n: 0 }; if (now - r.t > 1000) { r.t = now; r.n = 0 } r.n++; this.rate.set(me.id, r); if (r.n > 40) return;
    let m; try { m = JSON.parse(msg) } catch (e) { return }
    if (m.t == 's') { const p = Array.isArray(m.p) ? m.p.slice(0, 40).map(v => +(+v).toFixed(3)) : null; if (p && !p.every(Number.isFinite)) return; this.bcast({ t: 's', id: me.id, p }, ws); }
    else if (m.t == 'car') { const code = String(m.code || ''); if (!code.startsWith('BRCAR1.') || code.length > MAX_CAR) return;
      this.ctx.storage.sql.exec('INSERT OR REPLACE INTO cars VALUES(?,?)', me.id, code); this.bcast({ t: 'car', id: me.id, code }, ws); }
    else if (m.t == 'hi') { const players = this.socks().filter(w => w !== ws).map(w => { const i = this.info(w); const c = this.ctx.storage.sql.exec('SELECT code FROM cars WHERE id=?', i.id).toArray()[0]; return { id: i.id, nick: i.nick, car: c ? c.code : null }; });
      this.send(ws, { t: 'hello', you: me.id, nick: me.nick, players }); }
    else if (m.t == 'ping') this.send(ws, { t: 'pong', ts: m.ts });
  }
  async gone(ws) { const me = this.info(ws); if (!me) return; if (!this.room) this.room = me.room;
    this.ctx.storage.sql.exec('DELETE FROM cars WHERE id=?', me.id); this.bcast({ t: 'leave', id: me.id }, ws); this.rate.delete(me.id); }
  async webSocketClose(ws, code, reason) { await this.gone(ws); try { ws.close(1000, 'bye') } catch (e) { } this.closing = ws; await this.reportExcept(ws); }
  async webSocketError(ws) { await this.gone(ws); await this.reportExcept(ws); }
  async reportExcept(ws) { const n = this.socks().filter(w => w !== ws).length, id = this.room || (await this.ctx.storage.get('room')); if (!id) return;
    await hubCall(this.env, 'count', { id, n }); if (n == 0) await this.ctx.storage.deleteAll(); }
}
