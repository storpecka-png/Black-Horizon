/*
 * Frontline Commander – liten testserver för 1-mot-1.
 *
 * Kör med Node.js 18 eller senare:
 *   node frontline-pvp-server.js
 *
 * Servern använder bara Node:s inbyggda moduler. Den håller rum och matchdata
 * i minnet, vilket är avsiktligt för testversionen: startas processen om
 * försvinner pågående rum.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.FC_HOST || '0.0.0.0';
const STATIC_DIR = path.resolve(process.env.FC_STATIC_DIR || __dirname);
const MAX_BODY = 12 * 1024 * 1024;
const LIMITS = {mini: 10, small: 20, large: 30};
const rooms = new Map();

function jsonClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function randomToken() {
  return crypto.randomBytes(18).toString('base64url');
}

function randomSeed() {
  const hex = crypto.randomBytes(16).toString('hex');
  return hex.match(/.{8}/g).join('-');
}

function roomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = '';
    const bytes = crypto.randomBytes(6);
    for (const byte of bytes) code += alphabet[byte % alphabet.length];
  } while (rooms.has(code));
  return code;
}

function allowedSize(size) {
  return Object.prototype.hasOwnProperty.call(LIMITS, size) ? size : 'large';
}

function defaultPrivate(snapshot) {
  const s = snapshot || {};
  return {
    money: Number.isFinite(Number(s.money)) ? Number(s.money) : 10000,
    apPools: jsonClone(s.apPools || {land: 15, sea: 15, air: 30}),
    playerPurchaseQueue: jsonClone(s.playerPurchaseQueue || []),
    playerRegularPurchasesThisRound: Number(s.playerRegularPurchasesThisRound) || 0,
    playerStrategicPurchasesThisRound: Number(s.playerStrategicPurchasesThisRound) || 0,
    satellitesOwned: Number(s.satellitesOwned) || 0,
    satelliteCooldowns: jsonClone(s.satelliteCooldowns || []),
    permanentSatelliteZones: jsonClone(s.permanentSatelliteZones || []),
    satellitePassLine: jsonClone(s.satellitePassLine || null),
    paratrooperOwned: !!s.paratrooperOwned,
    paratrooperCooldown: Number(s.paratrooperCooldown) || 0,
    columnMarchOrders: jsonClone(s.columnMarchOrders || {land: null, sea: null, air: null}),
    columnBonusStepUsed: jsonClone(s.columnBonusStepUsed || {land: 0, sea: 0, air: 0}),
    fakeHQPlacementMode: !!s.fakeHQPlacementMode,
    pendingFakeHQPrice: Number(s.pendingFakeHQPrice) || 0,
    pendingFakeHQPrepaid: !!s.pendingFakeHQPrepaid,
    arrow3PlacementMode: !!s.arrow3PlacementMode,
    pendingArrow3Price: Number(s.pendingArrow3Price) || 0,
    pendingArrow3Prepaid: !!s.pendingArrow3Prepaid
  };
}

function cleanSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('Matchdata saknas.');
  const copy = jsonClone(snapshot);
  if (!copy.board || !Array.isArray(copy.board.terrain) || !Array.isArray(copy.units)) {
    throw new Error('Ogiltig matchdata.');
  }
  copy.money = 0;
  copy.apPools = {land: 0, sea: 0, air: 0};
  copy.playerPurchaseQueue = [];
  copy.playerRegularPurchasesThisRound = 0;
  copy.playerStrategicPurchasesThisRound = 0;
  copy.satellitesOwned = 0;
  copy.satelliteCooldowns = [];
  copy.permanentSatelliteZones = [];
  copy.satellitePassLine = null;
  copy.paratrooperOwned = false;
  copy.paratrooperCooldown = 0;
  copy.columnMarchOrders = {land: null, sea: null, air: null};
  copy.columnBonusStepUsed = {land: 0, sea: 0, air: 0};
  copy.fakeHQPlacementMode = false;
  copy.pendingFakeHQPrice = 0;
  copy.pendingFakeHQPrepaid = false;
  copy.arrow3PlacementMode = false;
  copy.pendingArrow3Price = 0;
  copy.pendingArrow3Prepaid = false;
  copy.playerTurn = false;
  copy.hqPlacementMode = false;
  return copy;
}

function createRoom(size) {
  const code = roomCode();
  const room = {
    code,
    size: allowedSize(size),
    limit: LIMITS[allowedSize(size)],
    seed: randomSeed(),
    phase: 'lobby',
    turnSide: 'blue',
    prepTurns: 0,
    seq: 0,
    events: [],
    players: {
      blue: {token: randomToken(), connectedAt: Date.now()},
      red: null
    },
    snapshot: null,
    private: {blue: null, red: null},
    winner: null,
    createdAt: Date.now(),
    lastActivity: Date.now()
  };
  rooms.set(code, room);
  return room;
}

function playerFor(room, token) {
  if (room.players.blue && room.players.blue.token === token) return 'blue';
  if (room.players.red && room.players.red.token === token) return 'red';
  return null;
}

function publicRoom(room, side, includeToken = true) {
  const result = {
    ok: true,
    room: room.code,
    side,
    size: room.size,
    limit: room.limit,
    seed: room.seed,
    phase: room.phase,
    turnSide: room.turnSide,
    prepTurns: room.prepTurns,
    seq: room.seq,
    opponentJoined: !!room.players.red
  };
  if (includeToken) result.token = room.players[side].token;
  return result;
}

function emit(room, type, payload = {}, audience = 'all') {
  room.seq += 1;
  room.events.push({seq: room.seq, type, audience, ...jsonClone(payload)});
  // A reconnect can use /api/state, so only a modest event history is needed.
  if (room.events.length > 40) room.events.splice(0, room.events.length - 40);
}

function emitState(room, audience) {
  if (!room.snapshot) return;
  const sides = audience === 'all' ? ['blue', 'red'] : [audience];
  for (const side of sides) {
    if (!room.players[side]) continue;
    emit(room, 'state_snapshot', {
      snapshot: room.snapshot,
      privateState: room.private[side] || defaultPrivate(room.snapshot),
      phase: room.phase,
      turnSide: room.turnSide,
      prepTurns: room.prepTurns
    }, side);
  }
}

function requireRoom(body) {
  const code = String(body.room || '').trim().toUpperCase();
  const room = rooms.get(code);
  if (!room) throw new Error('Rummet finns inte längre.');
  const side = playerFor(room, String(body.token || ''));
  if (!side) throw new Error('Ogiltig eller utgången spelaranslutning.');
  room.lastActivity = Date.now();
  return {room, side};
}

function storeState(room, side, snapshot, privateState) {
  room.snapshot = cleanSnapshot(snapshot);
  const supplied = privateState && typeof privateState === 'object' ? privateState : {};
  room.private[side] = {...defaultPrivate(snapshot), ...jsonClone(supplied)};
  if (!room.private.blue) room.private.blue = defaultPrivate(snapshot);
  if (!room.private.red) room.private.red = defaultPrivate(snapshot);
}

function otherSide(side) {
  return side === 'blue' ? 'red' : 'blue';
}

function action(room, side, body) {
  const name = String(body.action || '');
  if (name === 'ping') return {ok: true, phase: room.phase, turnSide: room.turnSide};

  // v6.208 sent this small notification before the real snapshot. It is kept
  // accepted for compatibility and deliberately does not change match state.
  if (name === 'hq_ready') return {ok: true, phase: room.phase, turnSide: room.turnSide};

  if (name === 'hq_snapshot') {
    if (side !== 'blue' || room.phase !== 'hq') throw new Error('Blå spelare måste placera HQ först.');
    storeState(room, side, body.snapshot, body.privateState);
    room.phase = 'prep';
    room.prepTurns = 0;
    room.turnSide = 'blue';
    emitState(room, 'red');
    emit(room, 'fc210_prep_changed', {limit: room.limit, prepTurns: 0, turnSide: room.turnSide});
    return {ok: true, phase: room.phase, turnSide: room.turnSide, prepTurns: room.prepTurns};
  }

  if (name === 'prep_turn') {
    if (room.phase !== 'prep') throw new Error('Förberedelsefasen är inte aktiv.');
    if (side !== room.turnSide) throw new Error('Det är motståndarens förberedelsedrag.');
    storeState(room, side, body.snapshot, body.privateState);
    room.prepTurns += 1;
    if (room.prepTurns >= room.limit) {
      room.phase = 'live';
      room.turnSide = 'blue';
      // The final prep action belongs to red on the large map. Both clients
      // must receive that canonical snapshot before live play begins.
      emitState(room, 'all');
      emit(room, 'fc210_live_changed', {round: Number(body.round) || room.limit + 1, turnSide: room.turnSide, prepTurns: room.prepTurns});
    } else {
      room.turnSide = otherSide(side);
      emitState(room, room.turnSide);
      emit(room, 'fc210_prep_changed', {side, prepTurns: room.prepTurns, limit: room.limit, turnSide: room.turnSide});
    }
    return {ok: true, phase: room.phase, turnSide: room.turnSide, prepTurns: room.prepTurns};
  }

  if (name === 'end_round') {
    if (room.phase !== 'live') throw new Error('Stridsfasen är inte aktiv.');
    if (side !== room.turnSide) throw new Error('Det är inte ditt drag ännu.');
    storeState(room, side, body.snapshot, body.privateState);
    room.turnSide = otherSide(side);
    emitState(room, room.turnSide);
    emit(room, 'fc210_round_changed', {round: Number(body.round) || 1, turnSide: room.turnSide});
    return {ok: true, phase: room.phase, turnSide: room.turnSide, round: Number(body.round) || 1};
  }

  if (name === 'resign') {
    room.phase = 'finished';
    room.winner = body.winner === 'blue' || body.winner === 'red' ? body.winner : otherSide(side);
    emit(room, 'match_finished', {winner: room.winner});
    return {ok: true, phase: room.phase, winner: room.winner};
  }

  throw new Error('Okänd onlineåtgärd.');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY) {
        reject(new Error('För stor begäran.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (_) { reject(new Error('Ogiltig JSON.')); }
    });
    req.on('error', reject);
  });
}

function headers(contentType) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
    'Content-Type': contentType
  };
}

function sendJson(res, status, data) {
  const text = JSON.stringify(data);
  res.writeHead(status, headers('application/json; charset=utf-8'));
  res.end(text);
}

function staticFile(req, res, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); }
  catch (_) { sendJson(res, 400, {ok: false, message: 'Ogiltig sökväg.'}); return; }
  if (decoded === '/') {
    const preferred = process.env.FC_HTML;
    if (preferred) decoded = '/' + path.basename(preferred);
    else {
      const html = fs.readdirSync(STATIC_DIR).filter(n => n.toLowerCase().endsWith('.html')).sort();
      decoded = html.find(n => /v6[_-]?210/i.test(n)) ? '/' + html.find(n => /v6[_-]?210/i.test(n)) : (html[0] ? '/' + html[0] : '');
    }
  }
  if (!decoded) { sendJson(res, 404, {ok: false, message: 'Ingen HTML-fil hittades i servermappen.'}); return; }
  const target = path.resolve(STATIC_DIR, '.' + decoded);
  if (target !== STATIC_DIR && !target.startsWith(STATIC_DIR + path.sep)) {
    sendJson(res, 403, {ok: false, message: 'Otillåten sökväg.'}); return;
  }
  fs.stat(target, (error, stat) => {
    if (error || !stat.isFile()) { sendJson(res, 404, {ok: false, message: 'Filen hittades inte.'}); return; }
    const ext = path.extname(target).toLowerCase();
    const type = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.js' ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, headers(type));
    fs.createReadStream(target).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (req.method === 'OPTIONS') { res.writeHead(204, headers('text/plain')); res.end(); return; }
  if (url.pathname === '/health') { sendJson(res, 200, {ok: true, service: 'frontline-pvp-test-server', rooms: rooms.size}); return; }

  try {
    if (req.method === 'POST' && url.pathname === '/api/room/create') {
      const body = await readBody(req);
      const room = createRoom(body.size);
      sendJson(res, 200, publicRoom(room, 'blue'));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/room/join') {
      const body = await readBody(req);
      const code = String(body.room || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) throw new Error('Rummet finns inte. Kontrollera rumskoden.');
      if (room.players.red) throw new Error('Rummet är redan fullt.');
      room.players.red = {token: randomToken(), connectedAt: Date.now()};
      room.phase = 'hq';
      room.turnSide = 'blue';
      emit(room, 'match_ready', {seed: room.seed, size: room.size, limit: room.limit, turnSide: room.turnSide});
      sendJson(res, 200, publicRoom(room, 'red'));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      const {room, side} = requireRoom({room: url.searchParams.get('room'), token: url.searchParams.get('token')});
      const since = Number(url.searchParams.get('since') || 0);
      const events = room.events.filter(e => e.seq > since && (e.audience === 'all' || e.audience === side)).map(({audience, ...event}) => event);
      sendJson(res, 200, {ok: true, next: room.seq, events, phase: room.phase, turnSide: room.turnSide, prepTurns: room.prepTurns});
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const {room, side} = requireRoom({room: url.searchParams.get('room'), token: url.searchParams.get('token')});
      sendJson(res, 200, {...publicRoom(room, side, false), snapshot: room.snapshot, privateState: room.private[side] || (room.snapshot ? defaultPrivate(room.snapshot) : null)});
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/action') {
      const body = await readBody(req);
      const {room, side} = requireRoom(body);
      sendJson(res, 200, action(room, side, body));
      return;
    }
    if (req.method === 'GET') { staticFile(req, res, url.pathname); return; }
    sendJson(res, 404, {ok: false, message: 'Adressen finns inte.'});
  } catch (error) {
    sendJson(res, 400, {ok: false, message: String(error && error.message || error)});
  }
});

// Testgräns så gamla, övergivna rum inte ligger kvar för evigt under lokal testning.
setInterval(() => {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const [code, room] of rooms) if (room.lastActivity < cutoff) rooms.delete(code);
}, 30 * 60 * 1000).unref();

server.listen(PORT, HOST, () => {
  console.log(`Frontline Commander PvP-testserver kör på http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Servermapp: ${STATIC_DIR}`);
  console.log('Öppna samma HTML via servern eller ange serveradressen i spelets onlinepanel.');
});
