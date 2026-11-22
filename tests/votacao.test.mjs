// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jeroen van de Graaf
// Lucent Votação: núcleo do protocolo (votacao/core.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as V from "../votacao/core.mjs";
import { RistrettoPoint as P } from "../votacao/vendor/noble.mjs";

const B = P.BASE;
// Monta um quadro como o Worker o faria (eventos com número, hora e cadeia de hashes).
function board() {
  const events = []; let t = Date.UTC(2026, 10, 20, 17, 0);
  return {
    events,
    push(ev) { const e = { n: events.length + 1, t: (t += 1000), ...ev }; e.h = V.eventHash(events.at(-1)?.h || V.ZERO_HASH, e); events.push(e); return e; },
  };
}
function setup(keyMode = "dividida", nVoters = 4) {
  const sid = "c2Vzc2FvLWRlLXRlc3Rl", m = V.hex(V.randBytes(32)), adm = V.deriveAdmin(m);
  const w = V.randScalar(), W = B.multiply(w), A = B.multiply(adm.a);
  const bd = board();
  bd.push({ type: "criada", sid, title: "Assembleia", by: "Ana", display: "nomes", keyMode, limit: nVoters > V.FREE_LIMIT ? nVoters : undefined,
    A: keyMode === "dividida" ? V.pHex(A) : undefined, pokA: keyMode === "dividida" ? V.provePok(sid, adm.a, A) : undefined,
    W: V.pHex(W), pokW: V.provePok(sid, w, W), th: adm.th });
  const voters = [];
  for (let i = 1; i <= nVoters; i++) { const s = adm.voterSecret(i), f = V.fingerprint(s); voters.push({ i, s, f }); bd.push({ type: "eleitor-incluido", i, f, name: "Eleitor " + i }); }
  const K = keyMode === "dividida" ? V.pHex(A.add(W)) : V.pHex(W);
  return { sid, adm, w, W: V.pHex(W), A: V.pHex(A), K, bd, voters };
}
const rollOf = (st) => [...st.roll.keys()].sort();
function runItem(S, item, spec, choices) {
  const st0 = V.verifyBoard(S.bd.events);
  S.bd.push({ type: "item-aberto", item, spec, roll: rollOf(st0) });
  choices.forEach((ch, i) => { if (ch === null) return; const v = S.voters[i]; S.bd.push({ type: "cedula", item, f: v.f, ballot: V.makeBallot(S.sid, S.K, item, spec.m, v.f, ch) }); });
  const st1 = V.verifyBoard(S.bd.events), it = st1.items.get(item);
  const T = V.sumBallots(it.ballots.map((b) => b.ballot), spec.m);
  S.bd.push({ type: "item-encerrado", item, T, dW: V.partialDecrypt(S.sid, item, S.w, S.W, T) });
  if (V.verifyBoard(S.bd.events).session.keyMode === "dividida") {
    const dA = V.partialDecrypt(S.sid, item, S.adm.a, S.A, T);
    S.bd.push({ type: "item-apurado", item, dA, counts: V.counts(T, [S.bd.events.at(-1).dW, dA]) });
  }
  return V.verifyBoard(S.bd.events);
}

test("prova de conhecimento da chave: confere e não serve para outra sessão", () => {
  const x = V.randScalar(), X = B.multiply(x), pr = V.provePok("s1", x, X);
  assert.ok(V.verifyPok("s1", V.pHex(X), pr));
  assert.ok(!V.verifyPok("s2", V.pHex(X), pr));
  assert.ok(!V.verifyPok("s1", V.pHex(B.multiply(x + 1n)), pr));
});
test("cédula: cada escolha confere; não serve para outro eleitor ou item; valor 2 não passa", () => {
  const S = setup();
  for (const m of [2, 3]) for (let ch = 0; ch <= m; ch++) {
    const b = V.makeBallot(S.sid, S.K, 1, m, S.voters[0].f, ch);
    assert.ok(V.verifyBallot(S.sid, S.K, 1, m, S.voters[0].f, b), "m=" + m + " escolha " + ch);
    assert.ok(!V.verifyBallot(S.sid, S.K, 1, m, S.voters[1].f, b), "cópia por outro eleitor");
    assert.ok(!V.verifyBallot(S.sid, S.K, 2, m, S.voters[0].f, b), "outro item");
  }
  // trapaça: cifra 2 na opção 1 (somando duas cédulas válidas) — a prova não acompanha
  const b1 = V.makeBallot(S.sid, S.K, 1, 2, S.voters[0].f, 1), b2 = V.makeBallot(S.sid, S.K, 1, 2, S.voters[0].f, 1);
  const two = { c: V.sumBallots([b1, b2], 2), p: b1.p };
  assert.ok(!V.verifyBallot(S.sid, S.K, 1, 2, S.voters[0].f, two));
});
test("sim/não com chave dividida: contagem, abstenção, não votaram", () => {
  const S = setup("dividida", 5);
  const st = runItem(S, 1, { type: "simnao", q: "Aprovar as contas?", m: 2 }, [1, 1, 2, 0, null]);
  assert.ok(st.ok, st.problems.join(" "));
  assert.deepEqual(st.items.get(1).result, { counts: [2, 1], abst: 1, ballots: 4, eligible: 5, notVoted: 1 });
});
test("escolha com 3 opções e chave só da LucentCrypto", () => {
  const S = setup("lucent", 6);
  const st = runItem(S, 1, { type: "escolha", q: "Síndico: 1 = Ana, 2 = Bruno, 3 = Carla", label: "Candidato", numbering: "123", m: 3 }, [3, 3, 1, 2, 3, 0]);
  assert.ok(st.ok, st.problems.join(" "));
  assert.deepEqual(st.items.get(1).result.counts, [1, 1, 3]);
  assert.deepEqual(V.optionLabels(st.items.get(1).spec), ["Candidato 1", "Candidato 2", "Candidato 3"]);
});
test("rol congelado: incluído durante o item só vota no próximo; excluído não vota mais", () => {
  const S = setup("dividida", 3), sp = { type: "simnao", q: "Item 1", m: 2 };
  const st0 = V.verifyBoard(S.bd.events);
  S.bd.push({ type: "item-aberto", item: 1, spec: sp, roll: rollOf(st0) });
  const sNew = S.adm.voterSecret(4), fNew = V.fingerprint(sNew);
  S.bd.push({ type: "eleitor-incluido", i: 4, f: fNew, name: "Diego" });
  S.bd.push({ type: "cedula", item: 1, f: fNew, ballot: V.makeBallot(S.sid, S.K, 1, 2, fNew, 1) });
  let st = V.verifyBoard(S.bd.events);
  assert.ok(!st.ok && /fora do rol/.test(st.problems[0]));
  S.bd.events.pop();
  S.bd.push({ type: "eleitor-excluido", i: 1 });
  st = V.verifyBoard(S.bd.events); assert.ok(st.ok);
  assert.ok(st.items.get(1).roll.has(S.voters[0].f), "excluído durante o item 1 ainda está no rol do item 1");
});
test("segunda cédula do mesmo eleitor, cédula depois do encerramento: o quadro não confere", () => {
  const S = setup();
  runItem(S, 1, { type: "simnao", q: "x", m: 2 }, [1, 2, null, null]);
  const ev = { type: "cedula", item: 1, f: S.voters[2].f, ballot: V.makeBallot(S.sid, S.K, 1, 2, S.voters[2].f, 1) };
  S.bd.push(ev);
  assert.ok(!V.verifyBoard(S.bd.events).ok);
});
test("cadeia de hashes: alterar um evento antigo é percebido", () => {
  const S = setup();
  runItem(S, 1, { type: "simnao", q: "x", m: 2 }, [1, 2, 1, 0]);
  const evs = structuredClone(S.bd.events); evs[2].name = "Outro nome";
  const st = V.verifyBoard(evs);
  assert.ok(!st.ok && /cadeia/.test(st.problems[0]));
});
test("decifração parcial falsa e contagem falsa são percebidas", () => {
  const S = setup();
  runItem(S, 1, { type: "simnao", q: "x", m: 2 }, [1, 1, 2, 0]);
  const evs = S.bd.events, last = evs.at(-1);
  const fake = structuredClone(evs); fake.at(-1).counts = [3, 0];
  let prev = fake.at(-2).h; fake.at(-1).h = V.eventHash(prev, fake.at(-1));
  assert.ok(!V.verifyBoard(fake).ok);
  const fake2 = structuredClone(evs); fake2.at(-1).dA = V.partialDecrypt(S.sid, 1, V.randScalar(), S.A, last.dA ? V.verifyBoard(evs).items.get(1).T : null);
  fake2.at(-1).h = V.eventHash(prev, fake2.at(-1));
  assert.ok(!V.verifyBoard(fake2).ok);
});
test("chave rebelde: sem conhecer a, o organizador não consegue anular a chave da LucentCrypto", () => {
  const S = setup();
  const evs = structuredClone(S.bd.events);
  const rogue = B.multiply(V.randScalar()).subtract(V.pOf(S.W)); // A' = X − W
  evs[0].A = V.pHex(rogue); evs[0].h = V.eventHash(V.ZERO_HASH, evs[0]);
  assert.ok(!V.verifyBoard(evs).ok);
});
test("item cancelado: cédulas não são decifradas; próximo item segue", () => {
  const S = setup(), st0 = V.verifyBoard(S.bd.events);
  S.bd.push({ type: "item-aberto", item: 1, spec: { type: "simnao", q: "errado", m: 2 }, roll: rollOf(st0) });
  S.bd.push({ type: "cedula", item: 1, f: S.voters[0].f, ballot: V.makeBallot(S.sid, S.K, 1, 2, S.voters[0].f, 1) });
  S.bd.push({ type: "item-cancelado", item: 1 });
  const st = runItem(S, 2, { type: "simnao", q: "certo", m: 2 }, [2, 2, 2, 2]);
  assert.ok(st.ok, st.problems.join(" "));
  assert.equal(st.items.get(1).state, "cancelado"); assert.deepEqual(st.items.get(2).result.counts, [0, 4]);
});
test("apagamento: primeira meia-noite de Brasília depois do fim, mais 24 horas", () => {
  // 20/11 22:30 em Brasília = 21/11 01:30 UTC → meia-noite de 21/11 em Brasília = 03:00 UTC; +24 h = 22/11 03:00 UTC
  assert.equal(new Date(V.deletionTime(Date.UTC(2026, 10, 21, 1, 30))).toISOString(), "2026-11-22T03:00:00.000Z");
  // 20/11 10:00 em Brasília → meia-noite de 21/11 → 22/11 03:00 UTC
  assert.equal(new Date(V.deletionTime(Date.UTC(2026, 10, 20, 13, 0))).toISOString(), "2026-11-22T03:00:00.000Z");
});
test("desempenho: conferir 50 cédulas de 3 opções", () => {
  const S = setup("dividida", 50), sp = { type: "escolha", q: "x", label: "Opção", numbering: "ABC", m: 3 };
  const t0 = performance.now();
  const st = runItem(S, 1, sp, S.voters.map((_, i) => i % 4));
  const ms = performance.now() - t0;
  assert.ok(st.ok); assert.deepEqual(st.items.get(1).result.counts, [13, 12, 12]);
  console.log("    50 cédulas (criar + conferir várias vezes): " + Math.round(ms) + " ms");
  const t1 = performance.now(); V.verifyBoard(S.bd.events); console.log("    conferência completa do quadro: " + Math.round(performance.now() - t1) + " ms");
});

test("códigos Crockford de 40 bits: formato XXXX-YYYY e leitura tolerante", () => {
  assert.equal(V.code40(new Uint8Array([0, 0, 0, 0, 0])), "0000-0000");
  assert.equal(V.code40(new Uint8Array([255, 255, 255, 255, 255])), "ZZZZ-ZZZZ");
  const S = setup(), b = V.makeBallot(S.sid, S.K, 1, 2, S.voters[0].f, 1), c = V.ballotFingerprint(b);
  assert.match(c, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(V.readCode40(c.toLowerCase().replace("-", " ")), c);
  assert.equal(V.readCode40("o1il-0000"), "0111-0000");
  assert.equal(V.readCode40("abcd-efgU"), null);
  assert.match(V.voterCode(S.voters[0].f), /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
});

test("limite: 20 sem código; o limite da reunião vale também para inclusões", () => {
  const S = setup("dividida", 20);
  S.bd.push({ type: "eleitor-incluido", i: 21, f: V.fingerprint(S.adm.voterSecret(21)) });
  const st = V.verifyBoard(S.bd.events);
  assert.ok(!st.ok && /limite/.test(st.problems[0]));
  const S2 = setup("dividida", 30); assert.ok(V.verifyBoard(S2.bd.events).ok);
});
test("código de liberação: limite e validade; chave errada, alteração e vencimento recusados", () => {
  const key = V.hex(V.randBytes(32)), code = V.makeRelease(key, 50, "2026-12-31");
  assert.match(code, /^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{2}$/);
  assert.deepEqual(V.checkRelease(key, code, Date.UTC(2026, 11, 31, 23, 0)), { limit: 50, until: "2026-12-31" }); // 20h em Brasília
  assert.equal(V.checkRelease(key, code, Date.UTC(2027, 0, 1, 4, 0)), null);  // 1/1, 01h em Brasília
  assert.equal(V.checkRelease(V.hex(V.randBytes(32)), code), null);
  const alt = code.slice(0, 5) + (code[5] === "0" ? "1" : "0") + code.slice(6);
  assert.equal(V.checkRelease(key, alt), null);
  assert.deepEqual(V.checkRelease(key, code.toLowerCase().replace(/-/g, " "), Date.UTC(2026, 10, 21)), { limit: 50, until: "2026-12-31" });
  assert.throws(() => V.makeRelease(key, 101, "2026-12-31"));
  assert.throws(() => V.makeRelease(key, 20, "2026-12-31"));
});
test("applyEvent: incremental igual à conferência completa; evento inválido não muda o estado", () => {
  const S = setup("dividida", 4);
  runItem(S, 1, { type: "simnao", q: "x", m: 2 }, [1, 2, 1, 0]);
  const st = V.newBoardState(), cache = new Map();
  for (const e of S.bd.events) V.applyEvent(st, e, cache);
  const full = V.verifyBoard(S.bd.events);
  assert.equal(st.head, full.head); assert.deepEqual(st.items.get(1).result, full.items.get(1).result);
  // contagem falsa: lança, e o estado continua igual
  const S3 = setup("dividida", 3), st3 = V.newBoardState();
  runItem(S3, 1, { type: "simnao", q: "x", m: 2 }, [1, 1, 2]);
  const evs = S3.bd.events, last = structuredClone(evs.at(-1)); last.counts = [3, 0]; last.h = V.eventHash(evs.at(-2).h, last);
  for (const e of evs.slice(0, -1)) V.applyEvent(st3, e);
  const before = JSON.stringify([st3.count, st3.head, st3.items.get(1).state]);
  assert.throws(() => V.applyEvent(st3, last));
  assert.equal(JSON.stringify([st3.count, st3.head, st3.items.get(1).state]), before);
  V.applyEvent(st3, evs.at(-1)); assert.equal(st3.items.get(1).state, "apurado");
});

// ---- inscrição pelo grupo (seção 2.2)
function groupSetup(join, nVoters = 1, extra = {}) {
  const sid = "Z3J1cG8tZGUtdGVzdGVfXw", m = V.hex(V.randBytes(32)), adm = V.deriveAdmin(m);
  const w = V.randScalar(), W = B.multiply(w), A = B.multiply(adm.a);
  const bd = board();
  bd.push({ type: "criada", sid, title: "Assembleia", by: "Ana", display: "nomes", keyMode: "dividida", inscricao: join, gh: V.sha256hex(adm.g), verPedidos: true,
    A: V.pHex(A), pokA: V.provePok(sid, adm.a, A), W: V.pHex(W), pokW: V.provePok(sid, w, W), th: adm.th, ...extra });
  for (let i = 1; i <= nVoters; i++) bd.push({ type: "eleitor-incluido", i, f: V.fingerprint(adm.voterSecret(i)), name: "Eleitor " + i });
  return { sid, adm, w, W: V.pHex(W), A: V.pHex(A), K: V.pHex(A.add(W)), bd };
}
const selfVoter = () => { const s = V.hex(V.randBytes(16)); return { s, f: V.fingerprint(s) }; };
const at = (bd, t, ev) => { const e = { n: bd.events.length + 1, t, ...ev }; e.h = V.eventHash(bd.events.at(-1)?.h || V.ZERO_HASH, e); bd.events.push(e); return e; };

test("inscrição pelo grupo: exige nomes no quadro e o hash do token", () => {
  for (const extra of [{ display: "digitais" }, { gh: undefined }, { inscricao: "qualquer" }]) {
    const st = V.verifyBoard(groupSetup("grupo-aprovado", 0, extra).bd.events);
    assert.ok(!st.ok, JSON.stringify(extra));
  }
  assert.ok(V.verifyBoard(groupSetup("grupo-pendente", 0).bd.events).ok);
  const S = setup("dividida", 1), v = selfVoter();
  S.bd.push({ type: "pedido", i: 2, f: v.f, name: "Bruno" });
  assert.match(V.verifyBoard(S.bd.events).problems[0], /não aceita inscrição/);
});

test("aprovado por padrão: entra na hora, mas quem entrou a menos de 5 s da abertura fica fora dessa votação", () => {
  const S = groupSetup("grupo-aprovado", 1), b = selfVoter(), c = selfVoter(), sp = { type: "simnao", q: "Item 1", m: 2 };
  const t0 = S.bd.events.at(-1).t;
  at(S.bd, t0 + 1000, { type: "pedido", i: 2, f: b.f, name: "Bruno" });
  at(S.bd, t0 + 9000, { type: "pedido", i: 3, f: c.f, name: "Carla" });
  let st = V.verifyBoard(S.bd.events);
  assert.ok(st.ok && st.roll.size === 3 && st.roll.get(b.f).via === "grupo" && !st.roll.get(b.f).checked);
  const T = t0 + 12000, roll = V.rollAt(st, T);
  assert.ok(roll.includes(b.f) && !roll.includes(c.f), "Bruno entrou 11 s antes; Carla, 3 s antes");
  at(S.bd, T, { type: "item-aberto", item: 1, spec: sp, roll });
  st = V.verifyBoard(S.bd.events); assert.ok(st.ok);
  // publicar Carla no rol não confere
  const bad = groupSetup("grupo-aprovado", 0); bad.bd.events.length = 0;
  const evs = S.bd.events.slice(0, -1).map((e) => ({ ...e })); let h = V.ZERO_HASH;
  for (const e of evs) { e.h = V.eventHash(h, e); h = e.h; }
  const fake = { n: evs.length + 1, t: T, type: "item-aberto", item: 1, spec: sp, roll: [...st.roll.keys()].sort() }; fake.h = V.eventHash(h, fake);
  assert.match(V.verifyBoard(evs.concat(fake)).problems[0], /rol congelado/);
  // Carla vota a partir da próxima; Bruno vota nesta
  at(S.bd, T + 1000, { type: "cedula", item: 1, f: b.f, ballot: V.makeBallot(S.sid, S.K, 1, 2, b.f, 1) });
  assert.ok(V.verifyBoard(S.bd.events).ok);
  at(S.bd, T + 2000, { type: "cedula", item: 1, f: c.f, ballot: V.makeBallot(S.sid, S.K, 1, 2, c.f, 1) });
  assert.match(V.verifyBoard(S.bd.events).problems[0], /fora do rol/);
});

test("conferido pelo organizador entra mesmo logo antes da abertura; pendente só com aprovação", () => {
  const S = groupSetup("grupo-pendente", 1), b = selfVoter(), c = selfVoter();
  const t0 = S.bd.events.at(-1).t;
  at(S.bd, t0 + 1000, { type: "pedido", i: 2, f: b.f, name: "Bruno" });
  at(S.bd, t0 + 1500, { type: "pedido", i: 3, f: c.f, name: "Bruno" }); // nome repetido: o organizador decide
  let st = V.verifyBoard(S.bd.events);
  assert.ok(st.ok && st.roll.size === 1 && st.reqs.get(2).status === "pendente");
  at(S.bd, t0 + 2000, { type: "decisao", aprovar: [2], recusar: [3] });
  st = V.verifyBoard(S.bd.events);
  assert.ok(st.ok && st.roll.has(b.f) && !st.roll.has(c.f) && st.reqs.get(3).status === "recusado");
  assert.ok(V.rollAt(st, t0 + 2500).includes(b.f), "aprovado à mão entra mesmo 0,5 s antes");
  // recusado pode ser aprovado depois
  at(S.bd, t0 + 3000, { type: "decisao", aprovar: [3] });
  assert.ok(V.verifyBoard(S.bd.events).roll.has(c.f));
  // decisão sobre um número que não é pedido não confere
  at(S.bd, t0 + 4000, { type: "decisao", recusar: [1] });
  assert.match(V.verifyBoard(S.bd.events).problems[0], /pedido inexistente/);
});

test("recusado durante a votação não vota mais; as cédulas já dadas continuam", () => {
  const S = groupSetup("grupo-aprovado", 1), b = selfVoter(), c = selfVoter(), sp = { type: "simnao", q: "Item 1", m: 2 };
  const t0 = S.bd.events.at(-1).t;
  at(S.bd, t0 + 1000, { type: "pedido", i: 2, f: b.f, name: "Bruno" });
  at(S.bd, t0 + 1100, { type: "pedido", i: 3, f: c.f, name: "Carla" });
  const T = t0 + 10000; at(S.bd, T, { type: "item-aberto", item: 1, spec: sp, roll: V.rollAt(V.verifyBoard(S.bd.events), T) });
  at(S.bd, T + 1000, { type: "cedula", item: 1, f: b.f, ballot: V.makeBallot(S.sid, S.K, 1, 2, b.f, 1) });
  at(S.bd, T + 2000, { type: "decisao", recusar: [2, 3] });
  let st = V.verifyBoard(S.bd.events); assert.ok(st.ok && st.items.get(1).ballots.length === 1);
  at(S.bd, T + 3000, { type: "cedula", item: 1, f: c.f, ballot: V.makeBallot(S.sid, S.K, 1, 2, c.f, 1) });
  assert.match(V.verifyBoard(S.bd.events).problems[0], /excluído da lista/);
});

test("inscrições encerradas, impressão digital repetida e excesso de pedidos pendentes", () => {
  const S = groupSetup("grupo-pendente", 0, { limit: 2 }), t0 = S.bd.events.at(-1).t;
  const vs = [1, 2, 3, 4, 5].map(selfVoter);
  vs.slice(0, 4).forEach((v, k) => at(S.bd, t0 + 1000 * (k + 1), { type: "pedido", i: k + 1, f: v.f, name: "P" + k }));
  assert.ok(V.verifyBoard(S.bd.events).ok, "4 pendentes = 2 × limite");
  at(S.bd, t0 + 6000, { type: "pedido", i: 5, f: vs[4].f, name: "P4" });
  assert.match(V.verifyBoard(S.bd.events).problems[0], /pendentes demais/);
  S.bd.events.pop();
  at(S.bd, t0 + 6000, { type: "pedido", i: 5, f: vs[0].f, name: "Outro" });
  assert.match(V.verifyBoard(S.bd.events).problems[0], /impressão digital/);
  S.bd.events.pop();
  at(S.bd, t0 + 6000, { type: "inscricoes-encerradas" });
  at(S.bd, t0 + 7000, { type: "pedido", i: 5, f: vs[4].f, name: "P4" });
  assert.match(V.verifyBoard(S.bd.events).problems[0], /inscrições encerradas/);
});

test("inscrito pelo grupo: o segredo é do eleitor; o organizador não consegue derivá-lo", () => {
  const S = groupSetup("grupo-aprovado", 0), b = selfVoter();
  const derived = new Set(Array.from({ length: 300 }, (_, k) => V.fingerprint(S.adm.voterSecret(k + 1))));
  assert.ok(!derived.has(b.f));
});
