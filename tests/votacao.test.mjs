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
  bd.push({ type: "criada", sid, title: "Assembleia", by: "Ana", display: "nomes", keyMode,
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
