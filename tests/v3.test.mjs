// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jeroen van de Graaf
// LucentDraw/3 no núcleo do HTML: vetores da SPEC-v3 8, pesos, regra de escolha, modo rápido,
// codificação das loterias, conferência e adulterações de certificados v3.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCore, ROOT } from "./core_loader.mjs";
import { cert, clone, depsFor, statusOf, failing, flipHex, WORLD, readJson } from "./helpers.mjs";

const C = await loadCore();
const VECTORS = JSON.parse(readFileSync(join(ROOT, "spec", "lucentdraw3_vectors.json"), "utf8"));
const verify = (c, opts = {}, deps = depsFor()) => C.verifyCertificate(c, deps, opts);

// ---- vetores (SPEC-v3 8)
for (const v of VECTORS) {
  test("SPEC-v3 8 · " + v.name, async () => {
    const spec = JSON.parse(v.canonical);
    assert.equal(C.canon(spec), v.canonical, "canonical JSON");
    assert.deepEqual(C.validateSpec(spec), []);
    assert.equal(await C.commitmentOf(spec), v.C, "C");
    const seed = await C.seedV3(v.C, v.values);
    assert.equal(seed, v.seed, "seed");
    assert.equal(await C.pickHash(seed, 0), v.firstR, "r da escolha 0");
    const { picks, steps, ints } = await C.selectPicks(seed, spec.task);
    assert.deepEqual(picks, v.picks, "picks");
    assert.deepEqual(picks.map((i) => spec.task.options[i]), v.result, "result");
    assert.equal(steps[0].W, BigInt(v.W), "W");
    assert.equal(ints.reduce((a, b) => a + b, 0n), BigInt(v.W));
    for (const s of steps) assert.ok(s.x >= 0n && s.x < s.W);
  });
}
test("SPEC-v3 3 example: [3, 0,35, 1/7, 0] -> L = 140, [420, 49, 20, 0], W = 489", () => {
  const r = C.integerWeights(["3", "0,35", "1/7", "0"]);
  assert.equal(r.L, 140n);
  assert.deepEqual(r.ints, [420n, 49n, 20n, 0n]);
  assert.equal(r.W, 489n);
  assert.deepEqual(r.ints.map((w) => C.shareText(w, r.W)), ["85,9 %", "10,0 %", "4,1 %", "0 %"]);
});

// ---- pesos (SPEC-v3 2)
test("weight parser: valid forms are exact fractions", () => {
  const ok = { "3": [3n, 1n], "0.35": [7n, 20n], "0,35": [7n, 20n], ".5": [1n, 2n], "2.": [2n, 1n], "1/7": [1n, 7n], "0": [0n, 1n],
    " 3 ": [3n, 1n], "007": [7n, 1n], "2/4": [1n, 2n], "1 / 7": [1n, 7n], "0/5": [0n, 1n], "12345678901234567890.5": [24691357802469135781n, 2n] };
  for (const [w, [n, d]] of Object.entries(ok)) assert.deepEqual(C.parseWeight(w), { n, d }, JSON.stringify(w));
});
test("weight parser: invalid forms are rejected with a reason", () => {
  const bad = { "-1": "negative", "1/0": "zeroDen", "abc": "syntax", "1/2/3": "syntax", "": "empty", "   ": "empty", "1e3": "syntax",
    "1,2,3": "syntax", ".": "syntax", "½": "syntax", "٣": "syntax", "+1": "syntax", "0x10": "syntax", "1/-2": "syntax", "1.5/2": "syntax" };
  for (const [w, code] of Object.entries(bad)) assert.equal(C.parseWeight(w).error, code, JSON.stringify(w));
  assert.equal(C.parseWeight(3).error, "syntax");
  assert.throws(() => C.integerWeights(["1", "abc"]), (e) => e.index === 1);
  for (const code of ["negative", "zeroDen", "syntax", "empty"]) assert.equal(typeof C.STR.weightErr[code], "string");
});
test("percentages are computed from the integer weights", () => {
  assert.equal(C.shareText(1n, 3n), "33,3 %");
  assert.equal(C.shareText(2n, 3n), "66,7 %");
  assert.equal(C.shareText(1n, 100000n), "< 0,1 %");
  assert.equal(C.shareText(99999n, 100000n), "> 99,9 %");
  assert.equal(C.shareText(5n, 5n), "100 %");
});

// ---- regra de escolha: comparação com a referência e sanidade estatística
test("cross-implementation file: HTML core reproduces every case (Python checks the same file)", async () => {
  const { cases } = readJson("v3_cross.json");
  assert.ok(cases.length >= 50);
  for (const c of cases) {
    const { picks, ints } = await C.selectPicks(c.seed, c.task);
    assert.deepEqual(ints.map(String), c.ints);
    assert.deepEqual(picks, c.picks);
  }
});
test("statistics: 50,000 random seeds land in proportion to the weights (3 · 0,35 · 1/7 · 0)", async () => {
  const task = { preset: "list", options: ["A", "B", "C", "D"], weights: ["3", "0,35", "1/7", "0"], count: 1, replace: false };
  const N = 50000, hits = [0, 0, 0, 0];
  for (let i = 0; i < N; i++) {
    const seed = C.bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    hits[(await C.selectPicks(seed, task)).picks[0]]++;
  }
  const expected = [420 / 489, 49 / 489, 20 / 489, 0];
  hits.forEach((h, i) => {
    const sigma = Math.sqrt((expected[i] * (1 - expected[i])) / N);
    assert.ok(Math.abs(h / N - expected[i]) <= 6 * sigma, "opção " + i + ": " + h + " de " + N); // 6 sigma: falso alarme ~1e-9
  });
  assert.equal(hits[3], 0, "peso 0 nunca sai");
});
test("statistics: without replacement every card is equally likely in every position, and never repeats", async () => {
  const task = C.presetTask("cards", { count: 52 });
  const N = 2000, first = new Array(52).fill(0), last = new Array(52).fill(0);
  for (let i = 0; i < N; i++) {
    const { picks } = await C.selectPicks(C.bytesToHex(crypto.getRandomValues(new Uint8Array(32))), task);
    assert.equal(new Set(picks).size, 52);
    first[picks[0]]++; last[picks[51]]++;
  }
  // qui-quadrado com 51 graus de liberdade; 100 corresponde a p ~ 5e-5
  const chi = (arr) => arr.reduce((a, h) => a + (h - N / 52) ** 2 / (N / 52), 0);
  assert.ok(chi(first) < 100, "primeira carta: " + chi(first));
  assert.ok(chi(last) < 100, "última carta: " + chi(last));
});
test("selection uses integers only: huge and tiny weights stay exact", async () => {
  const task = { preset: "list", options: ["grande", "minúsculo"], weights: ["123456789012345678901234567890", "1/999999999999999999999"], count: 2, replace: false };
  const { picks, ints } = await C.selectPicks("00".repeat(32), task);
  assert.deepEqual([...picks].sort(), [0, 1]);
  assert.equal(ints[1], 1n);
  assert.equal(ints[0], 123456789012345678901234567890n * 999999999999999999999n);
  const core = readFileSync(join(ROOT, "LucentSorteios.html"), "utf8");
  const sel = /async function selectPicks[\s\S]*?\n}\n/.exec(core)[0];
  assert.ok(!/Math\.|parseFloat|Number\(/.test(sel), "nenhum ponto flutuante na regra");
});

// ---- modo rápido (SPEC-v3 5.2)
test("Rápido: 32 random bytes as hex seed, same rule, no certificate fields", async () => {
  const task = C.presetTask("die", { count: 3, faces: 6 });
  const fixed = (b) => b.fill(0xab);
  const q = await C.quickDraw(task, fixed);
  assert.equal(q.seed, "ab".repeat(32));
  const ref = await C.selectPicks("ab".repeat(32), task);
  assert.deepEqual(q.picks, ref.picks);
  assert.deepEqual(q.result, ref.picks.map((i) => task.options[i]));
  for (const k of ["spec", "commitment", "anchors", "randomness", "sealedAt"]) assert.ok(!(k in q), k);
  const q2 = await C.quickDraw(task);
  assert.match(q2.seed, /^[0-9a-f]{64}$/);
  assert.notEqual(q2.seed, q.seed);
});

// ---- presets e validação da task
test("presets: coin, die, cards (exact 52-card order), list", () => {
  assert.deepEqual(C.presetTask("coin", { count: 3 }), { preset: "coin", options: ["Cara", "Coroa"], weights: ["1", "1"], count: 3, replace: true });
  const d = C.presetTask("die", { count: 2, faces: 20 });
  assert.equal(d.options.length, 20); assert.equal(d.options[19], "20"); assert.equal(d.replace, true);
  assert.deepEqual(C.DIE_FACES, [4, 6, 8, 10, 12, 20]);
  const cards = C.presetTask("cards", { count: 52 });
  assert.deepEqual(cards.options, JSON.parse(VECTORS[2].canonical).task.options);
  assert.equal(cards.replace, false);
  for (const t of [C.presetTask("coin", { count: 1 }), d, cards]) assert.deepEqual(C.validateTask(t), []);
});
test("task validation (SPEC-v3 2)", () => {
  const base = JSON.parse(VECTORS[3].canonical).task;
  const bad = (patch) => C.validateTask({ ...base, ...patch });
  assert.deepEqual(bad({}), []);
  assert.ok(bad({ options: [] }).length);
  assert.ok(bad({ options: ["A", "A", "B", "C"] }).some((p) => p.includes("repetidas")));
  assert.ok(bad({ options: ["A ", "B", "C", "D"] }).some((p) => p.includes("normalizada")));
  assert.ok(bad({ weights: ["1", "1", "1"] }).some((p) => p.includes("um peso para cada")));
  assert.ok(bad({ weights: ["1", "1/0", "1", "1"] }).some((p) => p.includes("peso 2")));
  assert.ok(bad({ weights: ["1", " 1", "1", "1"] }).some((p) => p.includes("normalizado")));
  assert.ok(bad({ weights: ["0", "0", "0/3", "0"] }).some((p) => p.includes("maior que zero")));
  assert.ok(bad({ weights: [1, "1", "1", "1"] }).length);
  assert.ok(bad({ count: 0 }).length);
  assert.ok(bad({ count: 4 }).some((p) => p.includes("sem reposição"))); // 3 pesos positivos
  assert.deepEqual(bad({ count: 4, replace: true }), []);
  assert.ok(bad({ replace: 1 }).length);
  assert.ok(bad({ preset: "roleta" }).length);
  assert.ok(bad({ extra: 1 }).some((p) => p.includes("desconhecidos")));
  const spec = JSON.parse(VECTORS[3].canonical);
  assert.ok(C.validateSpec({ ...spec, candidates: ["A", "B"] }).some((p) => p.includes("desconhecidos")));
  assert.ok(C.validateSpec({ ...spec, task: undefined }).length);
  // booleano só em task.replace
  assert.ok(C.validateSpec({ ...spec, title: true }).some((p) => p.includes("booleano")));
  assert.deepEqual(C.boolPathsOf(spec), ["spec.task.replace"]);
});

// ---- loterias (SPEC-v3 4)
test("v3 lottery encoding: contest as text, plain integers", () => {
  assert.equal(C.lotteryValue("megasena", "3001", { numbers: [58, 4, 41, 12, 35, 23] }, C.V3), "3001:4-12-23-35-41-58");
  assert.equal(C.lotteryValue("federal", "6120", { prizes: [17469, 81210, 7767, 41317, 79412] }, C.V3), "6120:17469-81210-7767-41317-79412");
  assert.equal(C.lotteryValue("federal", "6054-2", { prizes: ["017469", "081210", "007767", "041317", "079412"] }, C.V3), "6054-2:17469-81210-7767-41317-79412");
  assert.equal(C.lotteryValue("federal", 5900, { prizes: ["01234", "56789", "13579", "24680", "97531"] }), "5900:01234-56789-13579-24680-97531"); // v2 inalterado
  for (const c of ["3001", "6054-2", "1"]) assert.ok(C.contestOkV3(c), c);
  for (const c of [3001, "03001", "6054-", "6054-02", "", " 3001", "3001:1", "6054-2-1"]) assert.ok(!C.contestOkV3(c), JSON.stringify(c));
  assert.ok(C.federalOkV3([0, 999999, 1, 2, 3]));
  assert.ok(!C.federalOkV3([1000000, 1, 2, 3, 4]) && !C.federalOkV3(["17469", 1, 2, 3, 4]));
  const spec = JSON.parse(VECTORS[4].canonical);
  assert.ok(C.validateSpec({ ...spec, sources: { federal: { contest: 6120 } } }).some((p) => p.includes("concurso")));
  assert.deepEqual(C.planSources("federal", 0, { contest: "6054-2", drawMs: 0 }), { federal: { contest: "6054-2" } });
});
test("v3 Caixa normalization, relay route and manual entry", async () => {
  assert.deepEqual(C.normalizeCaixa("federal", "6120", { numero: 6120, dataApuracao: "20/01/2027", listaDezenas: ["017469", "081210", "007767", "041317", "079412"] }),
    { game: "federal", contest: "6120", prizes: [17469, 81210, 7767, 41317, 79412], drawDate: "2027-01-20" });
  assert.equal(C.normalizeCaixa("federal", "6120", { numero: 6121, listaDezenas: ["1", "2", "3", "4", "5"] }), null);
  assert.equal(C.normalizeCaixa("federal", "6120", { listaDezenas: ["1234567", "2", "3", "4", "5"] }), null);
  assert.deepEqual(C.normalizeCaixa("megasena", "3010-2", { numero: "3010-2", listaDezenas: ["60", "01", "07", "13", "22", "48"] }).numbers, [1, 7, 13, 22, 48, 60]);
  const seen = [];
  const fetchJson = async (url) => {
    seen.push(url);
    if (url.includes("caixa")) throw new TypeError("Failed to fetch (CORS)");
    return { game: "federal", contest: "6054-2", prizes: [1, 2, 3, 4, 5], drawDate: "2027-01-20" };
  };
  assert.deepEqual((await C.fetchLottery(fetchJson, "federal", "6054-2", "https://relay.test/")).prizes, [1, 2, 3, 4, 5]);
  assert.equal(seen[1], "https://relay.test/v3/lottery/federal/6054-2");
  assert.deepEqual(C.parseManualLottery("federal", "017469 81210 7767 41317 79412", "2027-01-20", C.V3).prizes, [17469, 81210, 7767, 41317, 79412]);
  assert.ok(C.parseManualLottery("federal", "1234567 1 2 3 4", "2027-01-20", C.V3).error);
});
test("no draw calendar (owner decision): draw day starts at 00:00 in Brasília", () => {
  assert.equal(C.LOTTERY.calendar, undefined);
  for (const k of ["suggestContest", "lotteryDrawTime", "contestForDate", "dateForContest"]) assert.equal(C[k], undefined, k);
  assert.equal(C.drawDayStart("2027-01-20"), Date.UTC(2027, 0, 20, 3, 0));
  assert.equal(C.drawDayStart("2027-02-30"), null);
  assert.equal(C.drawDayStart(""), null);
});

// ---- horário das loterias: o carimbo mais antigo precisa ser anterior ao início do dia do sorteio
const withDrawDate = (key, drawDate) => { const w = clone(WORLD); w.lottery[key].drawDate = drawDate; return depsFor(w); };
test("lottery timing: seal stamped before the draw day passes", async () => {
  const rep = await verify(cert("v3-scheduled-federal-order"));
  assert.equal(statusOf(rep).federalTiming, "passou");
  assert.ok(!("timing" in statusOf(rep)), "sem eth/drand não há checagem geral de horário");
  assert.match(rep.checks.find((x) => x.id === "federalTiming").detail, /< sorteio em 2027-01-20 \(data oficial\); início do dia 2027-01-20T03:00:00Z/);
});
test("lottery timing: seal stamped on or after the draw day fails", async () => {
  const c = cert("v3-scheduled-federal-order");
  const brtDay = (ms) => new Date(ms - 3 * 3600e3).toISOString().slice(0, 10);
  const stamp = C.isoToMs(c.anchors[0].time), sameDay = brtDay(stamp), dayAfter = brtDay(stamp + 86400e3);
  for (const day of [sameDay, "2026-11-01"]) {
    const rep = await verify(c, {}, withDrawDate("federal/6120", day));
    assert.equal(statusOf(rep).federalTiming, "falhou", day);
    assert.deepEqual(failing(rep), ["federalTiming"], day);
    assert.equal(rep.verdict, "nao_confere");
  }
  // um dia depois do carimbo: passa
  assert.equal(statusOf(await verify(c, {}, withDrawDate("federal/6120", dayAfter))).federalTiming, "passou");
  // a data oficial vale; sem a Caixa, usa a data do certificado
  const off = await verify(c, {}, depsFor(WORLD, { unreachable: ["federal"] }));
  assert.match(off.checks.find((x) => x.id === "federalTiming").detail, /data certificado/);
});
test("lottery timing: no anchors gives 'não verificado' with the sealedAt claim next to the draw date", async () => {
  const c = cert("v3-scheduled-megasena-dice-manual");
  const rep = await verify(c);
  const t = rep.checks.find((x) => x.id === "megasenaTiming");
  assert.equal(t.status, "nao_verificado");
  assert.ok(t.detail.includes(c.sealedAt) && t.detail.includes("sorteio em 2027-01-21"), t.detail);
  const seal = await verify(cert("v3-seal-only-coin"));
  assert.equal(statusOf(seal).timing, "atencao");
});

// ---- conferência de certificados v3
test("v3 cards via drand with RFC 3161 anchor: confere, with W and result reported", async () => {
  const c = cert("v3-live-drand-cards");
  const rep = await verify(c);
  assert.equal(rep.verdict, "confere", rep.message);
  assert.deepEqual(statusOf(rep), { parse: "passou", spec: "passou", commitment: "passou", drand: "passou", result: "passou", anchors: "passou", timing: "passou" });
  assert.equal(rep.v3.W, 52n);
  assert.deepEqual(rep.v3.result, c.result);
  assert.equal(rep.v3.steps.length, 5);
  assert.deepEqual(Object.keys(c).sort(), ["anchors", "commitment", "picks", "randomness", "result", "sealedAt", "seed", "spec"]);
});
test("v3 weighted list via Ethereum: confere; weights as typed, integers and W in the spec check", async () => {
  const rep = await verify(cert("v3-live-eth-weights"));
  assert.equal(rep.verdict, "confere", rep.message);
  const d = rep.checks.find((x) => x.id === "spec").detail;
  assert.ok(d.includes("W = 489") && d.includes("0,35 → 49") && d.includes("1/7 → 20"), d);
  assert.deepEqual(rep.v3.ints, [420n, 49n, 20n, 0n]);
});
test("v3 Loteria Federal ordering: confere with the official result (section 4 encoding)", async () => {
  const rep = await verify(cert("v3-scheduled-federal-order"));
  assert.equal(rep.verdict, "confere", rep.message);
  assert.ok(rep.checks.find((x) => x.id === "federal").detail.includes("6120:17469-81210-7767-41317-79412"));
});
test("v3 Mega-Sena with suffixed contest, manual entry, no anchor: incompleto, nothing failed", async () => {
  const rep = await verify(cert("v3-scheduled-megasena-dice-manual"));
  assert.deepEqual(failing(rep), []);
  assert.match(rep.checks.find((x) => x.id === "megasena").title, /3010-2.*inserido manualmente/);
  assert.equal(statusOf(rep).megasenaTiming, "nao_verificado");
  assert.equal(rep.verdict, "incompleto");
  const rep2 = await verify(cert("v3-scheduled-megasena-dice-manual"), {}, depsFor(WORLD, { unreachable: ["megasena"] }));
  assert.equal(statusOf(rep2).megasena, "nao_verificado");
  assert.ok(rep2.checks.find((x) => x.id === "megasena").detail.includes("3010-2:1-7-13-22-48-60"));
});
test("v3 seal without randomness is pending, not failed", async () => {
  const rep = await verify(cert("v3-seal-only-coin"));
  assert.deepEqual(failing(rep), []);
  assert.equal(statusOf(rep).result, "nao_verificado");
});
test("v3 certificate shape, ata and v1/v2 still accepted", async () => {
  const c = cert("v3-scheduled-federal-order");
  const ata = C.ataText(c);
  for (const s of [c.spec.id, c.commitment, c.seed, "LucentDraw/3", "W = 11", "1/2 → 1", "1. " + c.result[0], "6120", "17469-81210-7767-41317-79412", "verify_draw.py"]) assert.ok(ata.includes(s), s);
  const ata2 = C.ataText(cert("v3-live-drand-cards"));
  assert.ok(ata2.includes("52 opções, todas com peso 1") && ata2.includes("5 cartas"));
  assert.ok(!/bitcoin/i.test(ata + ata2));
  assert.ok(C.isDone(c) && !C.isDone(cert("v3-seal-only-coin")) && C.isDone(cert("v2-live-eth-drand")));
  assert.equal((await verify(cert("v2-live-eth-drand"))).verdict, "confere");
  assert.deepEqual(failing(await verify(cert("v1-legacy-eth-drand"))), []);
});

// ---- adulterações v3: cada uma falha na checagem certa (as mesmas listas no teste Python)
const TAMPER_V3 = readJson("tamper_v3.json");
for (const t of TAMPER_V3.cases) {
  test("v3 tampering: " + t.name + " -> " + t.main + " falhou", async () => {
    const c = clone(cert(t.fixture));
    applyPatch(c, t);
    const rep = await verify(c);
    assert.equal(rep.verdict, "nao_confere", rep.message);
    assert.equal(statusOf(rep)[t.main], "falhou");
    assert.deepEqual(failing(rep), [...t.fails].sort());
  });
}
function applyPatch(c, t) {
  for (const op of t.ops) {
    let o = c;
    for (const k of op.path.slice(0, -1)) o = o[k];
    const last = op.path[op.path.length - 1];
    if (op.op === "flip") o[last] = flipHex(o[last]);
    else if (op.op === "delete") delete o[last];
    else if (op.op === "swap01") [o[last][0], o[last][1]] = [o[last][1], o[last][0]];
    else o[last] = op.value;
  }
}

// ---- semente própria (SPEC-v3 5.3)
test("semente própria · leitura canônica", () => {
  const c = (t) => C.canonOwnSeed(t);
  assert.deepEqual(c("33 05 12"), { value: "5-12-33", reading: "int" });
  assert.deepEqual(c(" 5 -12\n\t033 "), { value: "5-12-33", reading: "int" });
  assert.deepEqual(c("05-12-33"), c("5 12 33"));
  assert.deepEqual(c("0 00 7"), { value: "0-0-7", reading: "int" });
  assert.deepEqual(c("100 99 1000000000000000000000"), { value: "99-100-1000000000000000000000", reading: "int" });
  assert.deepEqual(c("12.345"), { value: "12-345", reading: "int" });
  assert.deepEqual(c("  ana, gato \r\n"), { value: "ANA-GATO", reading: "text" });
  assert.deepEqual(c("Ána  Gato."), c("ana gato"));
  assert.notDeepEqual(c("ana gato"), c("gato ana"));
  assert.deepEqual(c("maçã, avó, nº 07"), { value: "MACA-AVO-NO-7", reading: "text" });
  assert.deepEqual(c("Quina 06612"), { value: "QUINA-6612", reading: "text" });
  assert.deepEqual(c("gato 🐈"), { error: "ascii" });
  assert.deepEqual(c("  \n "), { error: "empty" });
  assert.deepEqual(c("---"), { error: "empty" });
  assert.equal(C.ownFormatError("megasena", c("5 12 33 41 47 58")), null);
  assert.equal(C.ownFormatError("megasena", c("5 12 33 41 47 61")), "megasena");
  assert.equal(C.ownFormatError("megasena", c("5 5 33 41 47 58")), "megasena");
  assert.equal(C.ownFormatError("federal", c("012345 99999 1 2 3")), null);
  assert.equal(C.ownFormatError("federal", c("1234567 1 2 3 4")), "federal");
  assert.equal(C.ownFormatError("outro", c("qualquer coisa")), null);
});
test("semente própria · rápido = verificável, e independe do título e do ID", async () => {
  const OWN = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "v3_own.json"), "utf8")).cases;
  for (const { typed, cert: c } of OWN) {
    const q = await C.quickDrawOwn(c.spec.task, C.canonOwnSeed(typed).value);
    assert.deepEqual(q.result, c.result);
    const rep = await verify(c);
    assert.equal(rep.verdict, "incompleto", JSON.stringify(rep.checks.filter((x) => x.status !== C.STATUS.PASS)));
    assert.match(rep.message, /^Confere, desde que a lista/);
    assert.deepEqual(rep.checks.filter((x) => x.status !== C.STATUS.PASS).map((x) => x.id), ["own"]);
    const t = clone(c); t.spec.title = "outro título"; t.spec.id = "x"; t.commitment = await C.commitmentOf(t.spec);
    assert.equal((await verify(t)).verdict, "incompleto", "título/ID não mudam o resultado");
    const bad = clone(c); bad.randomness.own.value = bad.randomness.own.value + " ";
    assert.equal((await verify(bad)).verdict, "nao_confere", "não canônica");
    const other = clone(c); other.spec.sources.eth = { chain: "ethereum-mainnet", rule: "first-block-after", notBefore: 1, confirmations: 1 }; other.commitment = await C.commitmentOf(other.spec);
    assert.equal((await verify(other)).verdict, "nao_confere", "não combina com outras fontes");
  }
});

// ---- farol do Inmetro (SPEC-v3 5.4)
test("Inmetro · outputValue = SHA-512 da serialização NIST (pulso real nº 1049644)", async () => {
  const pulse = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "inmetro_pulse_1049644.json"), "utf8")).pulse;
  assert.equal(await C.inmetroIntact(pulse), true);
  for (const mut of [(p) => { p.localRandomValue = "00" + p.localRandomValue.slice(2); }, (p) => { p.listValues[2].value = "ff" + p.listValues[2].value.slice(2); },
    (p) => { p.timeStamp = "2026-11-20T18:34:00.000Z"; }, (p) => { p.pulseIndex += 1; }, (p) => { p.signatureValue = p.signatureValue.slice(0, -2) + "00"; }]) {
    const q = clone(pulse); mut(q); assert.equal(await C.inmetroIntact(q), false);
  }
  assert.equal(C.inmetroMinuteAfter(Date.parse("2026-11-20T18:32:30Z")), Date.parse("2026-11-20T18:33:00Z"));
  assert.equal(C.inmetroMinuteAfter(Date.parse("2026-11-20T18:33:00Z")), Date.parse("2026-11-20T18:34:00Z"), "estritamente depois");
});
test("Inmetro · certificado: confere com o arquivo, fica aberto sem rede, falha se alterado", async () => {
  const { cert } = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "v3_inmetro.json"), "utf8"));
  const pulse = cert.randomness.inmetro;
  const online = { inmetro: async () => ({ pulse, atT: false }) };
  const st = (rep, id) => rep.checks.find((c) => c.id === id).status;
  let rep = await C.verifyCertificate(cert, online);
  assert.equal(st(rep, "inmetro"), C.STATUS.PASS);
  assert.equal(st(rep, "result"), C.STATUS.PASS);
  assert.notEqual(rep.verdict, "nao_confere");
  rep = await C.verifyCertificate(cert, {});
  assert.equal(st(rep, "inmetro"), C.STATUS.UNVERIFIED);
  const other = clone(pulse); other.outputValue = "00" + other.outputValue.slice(2);
  rep = await C.verifyCertificate(cert, { inmetro: async () => ({ pulse: other, atT: false }) });
  assert.equal(rep.verdict, "nao_confere");
  const bad = clone(cert); bad.randomness.inmetro.localRandomValue = "00" + bad.randomness.inmetro.localRandomValue.slice(2);
  assert.equal((await C.verifyCertificate(bad, online)).verdict, "nao_confere");
  const late = clone(cert); late.spec.sources.inmetro.notBefore = Date.parse("2026-11-20T18:33:10Z"); late.commitment = await C.commitmentOf(late.spec);
  assert.equal((await C.verifyCertificate(late, online)).verdict, "nao_confere", "pulso anterior ao lacre");
  // Seed: a linha inmetro= só aparece com a fonte; sem ela, nada muda (vetores antigos continuam valendo).
  assert.notEqual(await C.seedV3(cert.commitment, { inmetro: "ab" }), await C.seedV3(cert.commitment, {}));
});
