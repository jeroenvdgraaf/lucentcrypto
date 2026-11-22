// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jeroen van de Graaf
//
// Lucent Votação (LucentVote/1, spec/VOTACAO.md): núcleo do protocolo, sem DOM e sem rede.
// Usado pela página (votacao/index.html), pelo Worker (worker/votacao.js) e pelos testes.
//
// Grupo: ristretto255. Cédula: um ElGamal "no expoente" por opção (0 ou 1), com provas disjuntivas
// de Chaum–Pedersen (Cramer–Damgård–Schoenmakers) de que cada opção é 0 ou 1 e de que a soma é 0 ou 1
// (tudo 0 = abstenção). Apuração: soma das cédulas aceitas, decifração parcial com prova por quem
// tem cada metade da chave, contagem por busca de 0 a 50.
import { RistrettoPoint as P, ed25519, sha256, sha512, hmac } from "./vendor/noble.mjs";

export const VERSION = "LucentVote/1";
// Demonstração: até 20 participantes; com um código de liberação, até 100.
export const FREE_LIMIT = 20, MAX_LIMIT = 100, MAX_ITEMS = 100, MAX_QUESTION = 300, MAX_TEXT = 128;
// Inscrição pelo grupo (seção 2.2): quem entrou aprovado por padrão a menos de JOIN_GRACE ms da abertura
// de uma votação, sem o organizador ter conferido, fica fora dela (vota a partir da próxima).
export const JOIN_GRACE = 5000, JOIN_MODES = ["organizador", "grupo-aprovado", "grupo-pendente"];
export const maxPending = (limit) => 2 * limit;
export const L = ed25519.CURVE.n;
const B = P.BASE, ZERO = P.ZERO;
const te = new TextEncoder();

// ---- utilidades
export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const unhex = (h) => { if (!/^([0-9a-f]{2})*$/.test(h)) throw new Error("hex"); return Uint8Array.from(h.match(/../g) || [], (x) => parseInt(x, 16)); };
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const bytesToInt = (b) => { let x = 0n; for (const v of b) x = (x << 8n) | BigInt(v); return x; };
export const mod = (x) => ((x % L) + L) % L;
export const sHex = (k) => mod(k).toString(16).padStart(64, "0");
export const sOf = (h) => { if (!/^[0-9a-f]{64}$/.test(h)) throw new Error("escalar"); const k = BigInt("0x" + h); if (k >= L) throw new Error("escalar"); return k; };
export const pHex = (p) => p.toHex();
export const pOf = (h) => { if (!/^[0-9a-f]{64}$/.test(h)) throw new Error("ponto"); return P.fromHex(h); };
// Pontos fixos da sessão (K, A, W) com tabela pré-calculada: multiplicação ~10× mais rápida.
const FIXED = new Map();
const fixedPoint = (h) => { let p = FIXED.get(h); if (!p) { p = pOf(h); p.ep.precompute(8); FIXED.set(h, p); if (FIXED.size > 32) FIXED.delete(FIXED.keys().next().value); } return p; };
export const randBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
export const randScalar = () => { for (;;) { const k = mod(bytesToInt(randBytes(64))); if (k) return k; } };
const mulB = (k) => (k === 0n ? ZERO : B.multiply(k));
export const mulBase = (k) => B.multiply(mod(k));
const mulV = (p, k) => p.multiplyUnsafe(mod(k)); // só com dados públicos (conferência)
const mulS = (p, k) => (k === 0n ? ZERO : p.multiply(k)); // com segredos

// JSON canônico: chaves em ordem, sem espaços (como no Embaralhamento).
export function canon(x) {
  if (Array.isArray(x)) return "[" + x.map(canon).join(",") + "]";
  if (x && typeof x === "object") return "{" + Object.keys(x).filter((k) => x[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canon(x[k])).join(",") + "}";
  return JSON.stringify(x);
}
// Hash para escalar: SHA-512("LucentVote/1/" ‖ domínio ‖ 0x00 ‖ JSON canônico) mod ℓ
export const hs = (domain, obj) => mod(bytesToInt(sha512(cat(te.encode(VERSION + "/" + domain), new Uint8Array([0]), te.encode(canon(obj))))));
export const sha256hex = (s) => hex(sha256(typeof s === "string" ? te.encode(s) : s));

// ---- o segredo do admin m (32 bytes) gera tudo (seção 1)
export function deriveAdmin(mHex) {
  const m = unhex(mHex);
  const lab = (s) => te.encode(VERSION + "/" + s);
  const a = mod(bytesToInt(hmac(sha512, m, lab("chave")))) || 1n;
  const t = hex(hmac(sha256, m, lab("controle")));
  return {
    a, t, th: sha256hex(t),
    kr: hmac(sha256, m, lab("rol")),
    voterSecret: (i) => hex(hmac(sha256, m, lab("eleitor/" + i)).subarray(0, 16)),
    g: hex(hmac(sha256, m, lab("inscricao")).subarray(0, 16)), // token do link do grupo (seção 2.2)
  };
}
export const fingerprint = (sHexStr) => hex(sha256(cat(te.encode(VERSION + "/eleitor"), unhex(sHexStr)))).slice(0, 32);

// ---- prova de conhecimento (Schnorr) de x em X = x·B
export function provePok(sid, x, X) {
  const k = randScalar(), R = B.multiply(k), c = hs("pok", { sid, X: pHex(X), R: pHex(R) });
  return { R: pHex(R), z: sHex(k + c * x) };
}
export function verifyPok(sid, Xh, pr) {
  try {
    const X = pOf(Xh), R = pOf(pr.R), z = sOf(pr.z), c = hs("pok", { sid, X: Xh, R: pr.R });
    return mulB(z).equals(R.add(mulV(X, c)));
  } catch { return false; }
}

// ---- tipos de item (seção 4)
export function optionLabels(item) {
  if (item.type === "simnao") return ["Sim", "Não"];
  const marks = item.numbering === "ABC" ? ["A", "B", "C"] : ["1", "2", "3"];
  return marks.slice(0, item.m).map((x) => item.label + " " + x);
}
export function checkItem(it) {
  const LABELS = ["Candidato", "Proposta", "Opção", "Alternativa"];
  if (!it || typeof it.q !== "string" || !it.q.trim() || it.q.length > MAX_QUESTION) return "pergunta";
  if (it.type === "simnao") return it.m === 2 ? null : "m";
  if (it.type !== "escolha") return "tipo";
  if (!LABELS.includes(it.label) || !["123", "ABC"].includes(it.numbering) || ![2, 3].includes(it.m)) return "opções";
  return null;
}

// ---- cédula
// Ramo de uma prova disjuntiva: (R, S) cifra o valor v, com R = r·B e S = r·K + v·B.
// Para o ramo verdadeiro: a = w·B, b = w·K. Para os simulados: z, c aleatórios,
// a = z·B − c·R, b = z·K − c·(S − v·B). O desafio de cada prova é dividido entre os ramos;
// um só hash (domínio "cedula") cobre o enunciado e todos os compromissos da cédula.
function orCommit(K, R, S, values, truth, r) {
  const br = values.map((v, j) => {
    if (j === truth) { const w = randScalar(); return { w, a: B.multiply(w), b: K.multiply(w) }; }
    const c = randScalar(), z = randScalar();
    return { c, z, a: mulB(z).subtract(mulV(R, c)), b: mulV(K, z).subtract(mulV(S.subtract(mulB(BigInt(v))), c)) };
  });
  return { br, finish: (cg) => {
    const others = br.reduce((s, x, j) => (j === truth ? s : s + x.c), 0n);
    return br.map((x, j) => (j === truth ? (() => { const c = mod(cg - others); return [sHex(c), sHex(x.w + c * r)]; })() : [sHex(x.c), sHex(x.z)]));
  } };
}
function orRecompute(K, R, S, values, pr) {
  if (!Array.isArray(pr) || pr.length !== values.length) throw new Error("prova");
  return pr.map(([ch, zh], j) => {
    const c = sOf(ch), z = sOf(zh);
    return { c, a: mulB(z).subtract(mulV(R, c)), b: mulV(K, z).subtract(mulV(S.subtract(mulB(BigInt(values[j]))), c)) };
  });
}
const ballotStatement = (sid, item, f, m, cts, commits) => ({ sid, item, f, m, c: cts, a: commits });

// choice: 0 = abstenção, 1..m = opção
export function makeBallot(sid, Kh, item, m, f, choice) {
  const K = fixedPoint(Kh), rs = [], cts = [], ors = [];
  for (let j = 0; j < m; j++) {
    const r = randScalar(), v = choice === j + 1 ? 1n : 0n, R = B.multiply(r), S = K.multiply(r).add(mulB(v));
    rs.push(r); cts.push([R, S]); ors.push(orCommit(K, R, S, [0, 1], Number(v), r));
  }
  const RS = cts.reduce((s, [R]) => s.add(R), ZERO), SS = cts.reduce((s, [, S]) => s.add(S), ZERO), rsum = mod(rs.reduce((s, r) => s + r, 0n));
  ors.push(orCommit(K, RS, SS, [0, 1], choice ? 1 : 0, rsum));
  const c = cts.map(([R, S]) => [pHex(R), pHex(S)]);
  const commits = ors.map((o) => o.br.map((x) => [pHex(x.a), pHex(x.b)]));
  const cg = hs("cedula", ballotStatement(sid, item, f, m, c, commits));
  return { c, p: ors.map((o) => o.finish(cg)) };
}
export function verifyBallot(sid, Kh, item, m, f, ballot) {
  try {
    const K = fixedPoint(Kh);
    if (!ballot || !Array.isArray(ballot.c) || ballot.c.length !== m || !Array.isArray(ballot.p) || ballot.p.length !== m + 1) return false;
    const cts = ballot.c.map(([R, S]) => [pOf(R), pOf(S)]);
    const RS = cts.reduce((s, [R]) => s.add(R), ZERO), SS = cts.reduce((s, [, S]) => s.add(S), ZERO);
    const recs = cts.map(([R, S], j) => orRecompute(K, R, S, [0, 1], ballot.p[j]));
    recs.push(orRecompute(K, RS, SS, [0, 1], ballot.p[m]));
    const commits = recs.map((rc) => rc.map((x) => [pHex(x.a), pHex(x.b)]));
    const cg = hs("cedula", ballotStatement(sid, item, f, m, ballot.c, commits));
    return recs.every((rc) => mod(rc.reduce((s, x) => s + x.c, 0n)) === cg);
  } catch { return false; }
}
// Códigos curtos para pessoas: Crockford Base32 (sem I, L, O, U), 40 bits, como XXXX-YYYY.
const CROCK = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function code40(bytes) {
  let x = 0n; for (const v of bytes.subarray(0, 5)) x = (x << 8n) | BigInt(v);
  let s = ""; for (let i = 0; i < 8; i++) { s = CROCK[Number(x & 31n)] + s; x >>= 5n; }
  return s.slice(0, 4) + "-" + s.slice(4);
}
// Leitura tolerante: maiúsculas ou minúsculas, O = 0, I e L = 1, hífen e espaços opcionais.
export function readCode40(t) {
  const s = String(t || "").toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(s) ? s.slice(0, 4) + "-" + s.slice(4) : null;
}
// Número de acompanhamento da cédula, e código do participante (a partir da impressão digital f).
export const ballotFingerprint = (ballot) => code40(sha256(te.encode(canon(ballot))));
export const voterCode = (f) => code40(unhex(f));

// Crockford Base32 de qualquer tamanho (para códigos de liberação), em grupos de 4.
export function crockEncode(bytes) {
  let x = 0n; for (const v of bytes) x = (x << 8n) | BigInt(v);
  const bits = bytes.length * 8, n = Math.ceil(bits / 5); x <<= BigInt(n * 5 - bits);
  let s = ""; for (let i = 0; i < n; i++) { s = CROCK[Number(x & 31n)] + s; x >>= 5n; }
  return s.match(/.{1,4}/g).join("-");
}
export function crockDecode(t, len) {
  const s = String(t || "").toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  const n = Math.ceil(len * 8 / 5);
  if (s.length !== n || /[^0-9A-HJKMNP-TV-Z]/.test(s)) return null;
  let x = 0n; for (const ch of s) x = (x << 5n) | BigInt(CROCK.indexOf(ch));
  x >>= BigInt(n * 5 - len * 8);
  const out = new Uint8Array(len); for (let i = len - 1; i >= 0; i--) { out[i] = Number(x & 255n); x >>= 8n; }
  return out;
}

// ---- código de liberação: permite mais de 20 participantes (até 100)
//   6 bytes: versão 1 · limite · último dia válido (2 bytes, dias desde 2000-01-01, horário de Brasília) · nº (2 bytes)
//   + 10 bytes de HMAC-SHA-256(chave, "LucentVote/1/liberacao" ‖ os 6 bytes). Só o Worker (e quem emite) tem a chave.
const DAY0 = Date.UTC(2000, 0, 1), BRT = 3 * 36e5;
const brDay = (ms) => Math.floor((ms - BRT - DAY0) / 864e5);
export function makeRelease(keyHex, limit, untilIso, id = Number(randBytes(2)[0]) * 256 + randBytes(1)[0]) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(untilIso); if (!m) throw new Error("data");
  if (!(limit > FREE_LIMIT && limit <= MAX_LIMIT)) throw new Error("limite entre " + (FREE_LIMIT + 1) + " e " + MAX_LIMIT);
  const day = Math.round((Date.UTC(+m[1], m[2] - 1, +m[3]) - DAY0) / 864e5);
  const p = new Uint8Array([1, limit, day >> 8, day & 255, (id >> 8) & 255, id & 255]);
  const mac = hmac(sha256, unhex(keyHex), cat(te.encode(VERSION + "/liberacao"), p)).subarray(0, 10);
  return crockEncode(cat(p, mac));
}
export function checkRelease(keyHex, code, now = Date.now()) {
  const b = crockDecode(code, 16); if (!b || !keyHex) return null;
  const p = b.subarray(0, 6), mac = hmac(sha256, unhex(keyHex), cat(te.encode(VERSION + "/liberacao"), p)).subarray(0, 10);
  let diff = 0; for (let i = 0; i < 10; i++) diff |= mac[i] ^ b[6 + i];
  if (diff || p[0] !== 1) return null;
  const day = (p[2] << 8) | p[3], limit = p[1];
  if (brDay(now) > day || !(limit > FREE_LIMIT && limit <= MAX_LIMIT)) return null;
  return { limit, until: new Date(DAY0 + day * 864e5).toISOString().slice(0, 10) };
}

// ---- apuração
export function sumBallots(ballots, m) {
  const T = Array.from({ length: m }, () => [ZERO, ZERO]);
  for (const b of ballots) b.c.forEach(([R, S], j) => { T[j] = [T[j][0].add(pOf(R)), T[j][1].add(pOf(S))]; });
  return T.map(([R, S]) => [pHex(R), pHex(S)]);
}
// Decifração parcial D_j = x·R(T_j), com uma prova de Chaum–Pedersen por opção e um só desafio.
export function partialDecrypt(sid, item, x, Xh, T) {
  const ks = T.map(() => randScalar()), Rs = T.map(([R]) => pOf(R));
  const D = Rs.map((R) => pHex(mulS(R, x)));
  const a = ks.map((k, j) => [pHex(B.multiply(k)), pHex(mulS(Rs[j], k))]);
  const c = hs("decifra", { sid, item, X: Xh, T, D, a });
  return { D, c: sHex(c), z: ks.map((k) => sHex(k + c * x)) };
}
export function verifyPartial(sid, item, Xh, T, pd) {
  try {
    if (!pd || pd.D.length !== T.length || pd.z.length !== T.length) return false;
    const X = fixedPoint(Xh), c = sOf(pd.c);
    const a = T.map(([R], j) => {
      const z = sOf(pd.z[j]), Rp = pOf(R), D = pOf(pd.D[j]);
      return [pHex(mulB(z).subtract(mulV(X, c))), pHex(mulV(Rp, z).subtract(mulV(D, c)))];
    });
    return hs("decifra", { sid, item, X: Xh, T, D: pd.D, a }) === c;
  } catch { return false; }
}
// Contagem: n_j·B = S(T_j) − ΣD_j; n_j entre 0 e max.
export function counts(T, partials, max = MAX_LIMIT) {
  const table = [ZERO]; for (let i = 1; i <= max; i++) table.push(table[i - 1].add(B));
  return T.map(([, S], j) => {
    let M = pOf(S); for (const pd of partials) M = M.subtract(pOf(pd.D[j]));
    const n = table.findIndex((X) => X.equals(M));
    if (n < 0) throw new Error("contagem fora do intervalo");
    return n;
  });
}

// ---- quadro: cadeia de hashes e conferência completa (seções 5 e 6)
export const ZERO_HASH = "0".repeat(64);
export const eventHash = (prevHex, ev) => { const { h, ...body } = ev; return hex(sha256(cat(unhex(prevHex), te.encode(canon(body))))); };

// Delete: primeira meia-noite (America/Sao_Paulo, UTC−3) depois de t, mais 24 horas.
export function deletionTime(t) {
  const DAY = 864e5, OFF = 3 * 36e5;
  return Math.floor((t - OFF) / DAY) * DAY + DAY + OFF + DAY;
}

// Estado de um quadro conferido. verifyBoard confere a lista inteira; applyEvent acrescenta um evento
// (o Worker e as páginas ao vivo usam applyEvent, para não reconferir tudo a cada cédula).
// cache (opcional): Map chave → resultado das provas já conferidas (por exemplo, num Web Worker).
export function newBoardState() {
  return { ok: true, problems: [], session: null, roll: new Map(), reqs: new Map(), nums: new Set(), joinClosed: false, items: new Map(), order: [], open: null, head: ZERO_HASH, count: 0, ended: false, last: 0 };
}
// strict (Worker): um evento inválido lança e o estado não muda.
// não strict (páginas): um evento inválido é anotado em st.problems, e a conferência segue.
export function applyEvent(st, ev, cache = new Map(), strict = true) {
  if (ev.n !== st.count + 1) throw new Error("Evento fora de ordem (nº " + ev.n + ").");
  const h = eventHash(st.head, ev);
  if (ev.h !== h) throw new Error("A cadeia de hashes não confere no evento " + ev.n + ".");
  try { apply(st, ev, cache); }
  catch (e) { if (strict) throw e; st.ok = false; st.problems.push("Evento " + ev.n + " (" + ev.type + "): " + e.message); }
  st.count++; st.head = h; st.last = ev.t;
}
export function verifyBoard(events, cache = new Map()) {
  const st = newBoardState();
  for (const ev of events) {
    try { applyEvent(st, ev, cache, false); } catch (e) { st.ok = false; st.problems.push(e.message); break; }
  }
  return st;
}
// As provas de cédula de uma lista de eventos ainda não conferidas: [{ key, args }] (para um Web Worker).
export function pendingBallotChecks(events, cache, K, sid, mOf = () => undefined) {
  const ms = new Map(), out = [];
  for (const ev of events) {
    if (ev.type === "item-aberto") ms.set(ev.item, ev.spec?.m);
    if (ev.type === "cedula" && !cache.has("c:" + ev.h)) out.push({ key: "c:" + ev.h, args: [sid, K, ev.item, ms.get(ev.item) ?? mOf(ev.item), ev.f, ev.ballot] });
  }
  return out;
}
function apply(st, ev, cache) {
  const S = st.session;
  if (ev.n === 1) {
    if (ev.type !== "criada") throw new Error("o primeiro evento deve ser a criação");
    const split = ev.keyMode === "dividida";
    if (!split && ev.keyMode !== "lucent") throw new Error("modo de chave");
    if (!verifyPok(ev.sid, ev.W, ev.pokW)) throw new Error("prova da chave da LucentCrypto não confere");
    if (split && !verifyPok(ev.sid, ev.A, ev.pokA)) throw new Error("prova da chave do organizador não confere");
    const K = split ? pOf(ev.A).add(pOf(ev.W)) : pOf(ev.W);
    const limit = ev.limit ?? FREE_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error("limite de participantes");
    const join = ev.inscricao ?? "organizador";
    if (!JOIN_MODES.includes(join)) throw new Error("modo de inscrição");
    if (join !== "organizador" && (ev.display !== "nomes" || !/^[0-9a-f]{64}$/.test(ev.gh || ""))) throw new Error("inscrição pelo grupo exige nomes no quadro e o hash do token");
    st.session = { sid: ev.sid, title: ev.title, by: ev.by, display: ev.display, keyMode: ev.keyMode, A: ev.A, W: ev.W, K: pHex(K), th: ev.th, created: ev.t, limit,
      join, gh: ev.gh, showReqs: !!ev.verPedidos };
    return;
  }
  if (!S) throw new Error("sem criação");
  if (st.ended && ev.type !== "reuniao-encerrada") throw new Error("depois do fim da reunião");
  switch (ev.type) {
    case "eleitor-incluido": {
      if (!Number.isInteger(ev.i) || ev.i < 1 || st.nums.has(ev.i)) throw new Error("número de eleitor");
      if (!/^[0-9a-f]{32}$/.test(ev.f) || st.roll.has(ev.f) || knownF(st, ev.f)) throw new Error("impressão digital");
      if (st.roll.size >= S.limit) throw new Error("mais de " + S.limit + " participantes (o limite desta reunião)");
      st.nums.add(ev.i);
      st.roll.set(ev.f, { i: ev.i, f: ev.f, name: ev.name || null, priv: ev.priv || null, added: ev.t, via: "organizador", checked: true });
      return;
    }
    case "eleitor-excluido": {
      const e = [...st.roll.values()].find((v) => v.i === ev.i);
      if (!e) throw new Error("eleitor inexistente");
      st.roll.delete(e.f);
      const r = st.reqs.get(ev.i); if (r) Object.assign(r, { status: "recusado", decided: ev.t });
      return;
    }
    // Inscrição pelo grupo (seção 2.2). O pedido traz só o nome e a impressão digital: o segredo do
    // eleitor foi gerado no aparelho dele, e o organizador não o conhece.
    case "pedido": {
      if (S.join === "organizador") throw new Error("esta reunião não aceita inscrição pelo grupo");
      if (st.joinClosed) throw new Error("inscrições encerradas");
      if (!Number.isInteger(ev.i) || ev.i < 1 || st.nums.has(ev.i)) throw new Error("número de eleitor");
      if (!/^[0-9a-f]{32}$/.test(ev.f) || st.roll.has(ev.f) || knownF(st, ev.f)) throw new Error("impressão digital");
      if (typeof ev.name !== "string" || !ev.name.trim() || ev.name !== ev.name.trim() || te.encode(ev.name).length > MAX_TEXT) throw new Error("nome");
      if ([...st.reqs.values()].filter((r) => r.status === "pendente").length >= maxPending(S.limit)) throw new Error("pedidos pendentes demais");
      st.nums.add(ev.i);
      const r = { i: ev.i, f: ev.f, name: ev.name, t: ev.t, status: "pendente", checked: false };
      st.reqs.set(ev.i, r);
      // aprovado por padrão: entra na lista na hora, se houver vaga; senão fica pendente
      if (S.join === "grupo-aprovado" && st.roll.size < S.limit) admit(st, r, ev.t, false);
      return;
    }
    case "decisao": {
      const ap = ev.aprovar || [], rc = ev.recusar || [];
      if (!Array.isArray(ap) || !Array.isArray(rc) || !ap.length && !rc.length) throw new Error("decisão vazia");
      const all = ap.concat(rc);
      if (new Set(all).size !== all.length || all.some((i) => !st.reqs.has(i))) throw new Error("pedido inexistente ou repetido");
      for (const i of rc) { const r = st.reqs.get(i); st.roll.delete(r.f); Object.assign(r, { status: "recusado", decided: ev.t, checked: true }); }
      for (const i of ap) {
        const r = st.reqs.get(i);
        if (r.status === "aprovado") { r.checked = true; const e = st.roll.get(r.f); if (e) e.checked = true; continue; }
        if (st.roll.size >= S.limit) throw new Error("mais de " + S.limit + " participantes (o limite desta reunião)");
        admit(st, r, ev.t, true);
      }
      return;
    }
    case "inscricoes-encerradas": {
      if (S.join === "organizador" || st.joinClosed) throw new Error("não há inscrições abertas");
      st.joinClosed = true; st.joinClosedAt = ev.t; return;
    }
    case "item-aberto": {
      if (st.open) throw new Error("já há um item aberto");
      if (st.items.has(ev.item) || ev.item !== st.order.length + 1) throw new Error("número do item");
      const err = checkItem(ev.spec); if (err) throw new Error("item inválido (" + err + ")");
      // Rol congelado: todos da lista, menos quem entrou aprovado por padrão há menos de JOIN_GRACE ms
      // sem ter sido conferido pelo organizador (corrida entre o pedido e a abertura).
      const roll = [...st.roll.values()].filter((v) => v.checked || ev.t - v.added >= JOIN_GRACE).map((v) => v.f).sort();
      if (canon(roll) !== canon(ev.roll)) throw new Error("o rol congelado não é o rol atual");
      st.items.set(ev.item, { n: ev.item, spec: ev.spec, options: optionLabels(ev.spec), roll: new Set(roll), state: "aberto", ballots: [], opened: ev.t });
      st.order.push(ev.item); st.open = ev.item; return;
    }
    case "cedula": {
      const it = st.items.get(ev.item);
      if (!it || it.state !== "aberto") throw new Error("item não está aberto");
      if (!it.roll.has(ev.f)) throw new Error("eleitor fora do rol deste item");
      if (!st.roll.has(ev.f)) throw new Error("eleitor excluído da lista"); // excluído durante a votação: não vota mais
      if (it.ballots.some((b) => b.f === ev.f)) throw new Error("segunda cédula do mesmo eleitor");
      const key = "c:" + ev.h;
      const ok = cache.get(key) ?? verifyBallot(S.sid, S.K, ev.item, it.spec.m, ev.f, ev.ballot);
      cache.set(key, ok);
      if (!ok) throw new Error("prova da cédula não confere");
      it.ballots.push({ f: ev.f, t: ev.t, ballot: ev.ballot, fp: ballotFingerprint(ev.ballot) });
      return;
    }
    case "item-encerrado": {
      const it = st.items.get(ev.item);
      if (!it || it.state !== "aberto") throw new Error("item não está aberto");
      const T = sumBallots(it.ballots.map((b) => b.ballot), it.spec.m);
      if (canon(T) !== canon(ev.T)) throw new Error("os totais cifrados não conferem");
      const key = "w:" + ev.h, ok = cache.get(key) ?? verifyPartial(S.sid, ev.item, S.W, T, ev.dW);
      cache.set(key, ok);
      if (!ok) throw new Error("a decifração da LucentCrypto não confere");
      const result = S.keyMode === "lucent" ? resultOf(it, T, [ev.dW]) : null; // calcula antes de mudar o estado
      Object.assign(it, { state: result ? "apurado" : "encerrado", T, dW: ev.dW, closed: ev.t }); if (result) it.result = result;
      st.open = null;
      return;
    }
    case "item-apurado": {
      const it = st.items.get(ev.item);
      if (!it || it.state !== "encerrado" || S.keyMode !== "dividida") throw new Error("item não está aguardando apuração");
      const key = "a:" + ev.h, ok = cache.get(key) ?? verifyPartial(S.sid, ev.item, S.A, it.T, ev.dA);
      cache.set(key, ok);
      if (!ok) throw new Error("a decifração do organizador não confere");
      const result = resultOf(it, it.T, [it.dW, ev.dA]);
      if (canon(result.counts) !== canon(ev.counts)) throw new Error("a contagem publicada não confere");
      Object.assign(it, { dA: ev.dA, state: "apurado", result });
      return;
    }
    case "item-cancelado": {
      const it = st.items.get(ev.item);
      if (!it || !["aberto", "encerrado"].includes(it.state)) throw new Error("item não pode ser cancelado");
      if (st.open === ev.item) st.open = null;
      it.state = "cancelado"; it.cancelled = ev.t; return;
    }
    case "reuniao-encerrada": {
      if (st.ended) throw new Error("reunião já encerrada");
      st.ended = true; st.endedAt = ev.t; return;
    }
    default: throw new Error("tipo desconhecido");
  }
}
function knownF(st, f) { for (const r of st.reqs.values()) if (r.f === f) return true; return false; }
function admit(st, r, t, checked) {
  Object.assign(r, { status: "aprovado", decided: t, checked });
  st.roll.set(r.f, { i: r.i, f: r.f, name: r.name, priv: null, added: t, via: "grupo", checked, req: r.t });
}
// O rol que o Worker deve publicar ao abrir uma votação no instante t (mesma regra de "item-aberto").
export function rollAt(st, t) { return [...st.roll.values()].filter((v) => v.checked || t - v.added >= JOIN_GRACE).map((v) => v.f).sort(); }
function resultOf(it, T, partials) {
  const n = it.ballots.length, c = counts(T, partials, n), sum = c.reduce((a, b) => a + b, 0);
  if (sum > n) throw new Error("contagem maior que o número de cédulas");
  return { counts: c, abst: n - sum, ballots: n, eligible: it.roll.size, notVoted: it.roll.size - n };
}
