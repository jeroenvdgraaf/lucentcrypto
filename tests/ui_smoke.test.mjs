// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jeroen van de Graaf
// Teste opcional da camada de interface (DOM) com jsdom. É pulado se o jsdom não estiver instalado:
//   npm i --prefix /tmp/jsdom jsdom@24 && JSDOM_DIR=/tmp/jsdom/node_modules ./run_tests.sh
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { HTML_PATH, loadCore } from "./core_loader.mjs";
import { cert } from "./helpers.mjs";

let JSDOM = null;
try { JSDOM = createRequire(join(process.env.JSDOM_DIR || process.cwd(), "x.js"))("jsdom").JSDOM; } catch { /* opcional */ }
const C = await loadCore();
const html = readFileSync(HTML_PATH, "utf8");
const m = /<script type="module">([\s\S]*)<\/script>/.exec(html);
const shell = html.replace(m[0], "").replace(/<script type="importmap">[\s\S]*?<\/script>/, "");
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const skip = !JSDOM && "jsdom não instalado";

// fetch: por padrão tudo bloqueado (inclusive a Caixa).
function boot(storage = {}, { fetch, url = "https://example.test/sorteios/" } = {}) {
  const dom = new JSDOM(shell, { runScripts: "outside-only", url, pretendToBeVisual: true });
  const w = dom.window, errors = [];
  Object.defineProperty(w, "crypto", { value: globalThis.crypto });
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder; w.matchMedia = () => ({ matches: false });
  w.fetch = fetch || (async (u) => { throw new TypeError("offline " + u); });
  w.Element.prototype.scrollIntoView = () => {};
  for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
  w.addEventListener("unhandledrejection", (e) => errors.push(e.reason));
  w.eval("(async () => {" + m[1].replace(/await import\("drand-client"\)/, 'await Promise.reject(new Error("offline"))') + "\n})().catch(e => { window.__err = e; })");
  opened.push(w);
  const $ = (id) => w.document.getElementById(id);
  const type = (input, value) => { input.value = value; input.dispatchEvent(new w.Event("input")); };
  const pick = (name, value) => { const r = w.document.querySelector('input[name="' + name + '"][value="' + value + '"]'); r.checked = true; r.dispatchEvent(new w.Event("change")); };
  return { w, errors, $, type, pick };
}
const opened = [];
after(() => { for (const w of opened) w.close(); });

test("UI: Rápido coin toss uses the same rule, shows coins and no certificate", { skip }, async () => {
  const { w, $, errors, pick } = boot();
  await tick();
  assert.equal(w.__err, undefined, String(w.__err));
  pick("drawmode", "quick");
  $("tab-coin").click();
  $("coinCount").value = "3";
  $("sealBtn").click(); await tick(100);
  assert.equal($("doneBox").hidden, false);
  assert.equal($("quickNote").hidden, false);
  assert.match($("quickNote").textContent, /^Modo rápido: resultado instantâneo/);
  assert.equal($("certRow").hidden, true); assert.equal($("ataBox").hidden, true);
  assert.equal($("sealPanel").hidden, true);
  assert.equal($("visual").querySelectorAll("figure svg").length, 3);
  const seed = $("quickFacts").querySelector("dd").textContent;
  const { picks } = await C.selectPicks(seed, C.presetTask("coin", { count: 3 }));
  assert.equal($("resultLine").textContent, "Resultado: " + picks.map((i) => C.COIN[i]).join(", "));
  assert.equal($("bars").querySelectorAll(".needle").length, 3);
  assert.equal(w.localStorage.getItem("lucentsorteios.draws"), null, "nada guardado no modo rápido");
  $("tab-cards").click(); $("cardCount").value = "52"; $("sealBtn").click(); await tick(150);
  assert.equal($("visual").querySelectorAll(".pcard").length, 52);
  assert.ok($("visual").querySelectorAll(".pcard.red").length === 26);
  assert.deepEqual(errors, []);
});

test("UI: weights show exact shares, zero grays out, invalid is marked; Verificável seal stores weights as typed", { skip }, async () => {
  const { w, $, errors, type, pick } = boot();
  await tick();
  pick("drawmode", "verif");
  $("tab-list").click();
  $("cands").value = "Ana; 3\nBruno; 0,35\n<b>Célia</b>; 1/7\nDavi; 0";
  $("pasteApply").click(); await tick();
  const rows = [...$("listTable").querySelectorAll(".wrow:not(.whead)")];
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.querySelector(".wshare").textContent), ["85,9 %", "10,0 %", "4,1 %", "fora do sorteio"]);
  assert.ok(rows[3].classList.contains("off"));
  assert.equal($("candCount").textContent, "4 opções · 3 no sorteio");
  const wIn = rows[1].querySelector(".wval");
  type(wIn, "1/0");
  assert.equal(wIn.getAttribute("aria-invalid"), "true");
  assert.match(rows[1].querySelector(".wnote").textContent, /denominador zero/);
  $("drawId").value = "pesos-ui"; $("sealBtn").click(); await tick();
  assert.match($("sealErr").textContent, /Bruno.*denominador zero/);
  type(wIn, "1.000");
  assert.match(rows[1].querySelector(".wnote").textContent, /vale 1,000/);
  type(wIn, "0,35");
  pick("listChoice", "pick"); $("listCount").value = "1";
  pick("preset", "drand");
  $("sealBtn").click(); await tick(200);
  assert.match($("commitHash").textContent, /^[0-9a-f]{64}$/);
  const saved = JSON.parse(w.localStorage.getItem("lucentsorteios.draws"))["pesos-ui"];
  assert.equal(saved.spec.v, "LucentDraw/3");
  assert.deepEqual(saved.spec.task, { preset: "list", options: ["Ana", "Bruno", "<b>Célia</b>", "Davi"], weights: ["3", "0,35", "1/7", "0"], count: 1, replace: false });
  assert.equal(await C.commitmentOf(saved.spec), saved.commitment);
  assert.equal($("anchorMsg").textContent, C.STR.noRelay);
  assert.ok($("tab-coin").disabled && !$("tab-verify").disabled, "abas travadas depois do lacre");
  assert.ok(rows[0].querySelector(".wval").disabled || $("listTable").querySelector(".wval").disabled);
  assert.equal(w.document.querySelectorAll("b").length, [...w.document.querySelectorAll(".src b")].length); // nenhum <b> injetado
  $("newDraw").click(); $("drawId").value = "pesos-ui"; $("sealBtn").click(); await tick();
  assert.match($("sealErr").textContent, /já foi lacrado/);
  assert.equal($("otherIdBtn").hidden, false);
  assert.deepEqual(errors, []);
});

test("UI: a contest that already has a result is refused at seal time (best effort)", { skip }, async () => {
  const caixa = { numero: 6120, dataApuracao: "20/01/2027", listaDezenas: ["017469", "081210", "007767", "041317", "079412"] };
  const { $, pick, errors } = boot({}, { fetch: async (u) => (String(u).includes("servicebus2.caixa.gov.br") ? { ok: true, status: 200, json: async () => caixa } : Promise.reject(new TypeError("offline"))) });
  await tick();
  pick("drawmode", "verif"); $("tab-die").click();
  pick("mode", "scheduled"); pick("preset", "federal");
  assert.equal($("lotteryBox").hidden, false);
  assert.equal($("caixaLink").getAttribute("href"), "https://loterias.caixa.gov.br");
  assert.match($("lotteryBox").textContent, /PRÓXIMO concurso/);
  $("contest").value = "61 20"; $("sealBtn").click(); await tick();
  assert.match($("sealErr").textContent, /como aparece no site da Caixa/);
  $("contest").value = "6120"; $("sealBtn").click(); await tick(200);
  assert.match($("sealErr").textContent, /já foi sorteado/);
  assert.equal($("sealPanel").hidden, true);
  assert.deepEqual(errors, []);
});

test("UI: scheduled v3 draw reopened, Caixa blocked, manual entry with 6-digit tickets verifies", { skip }, async () => {
  const spec = { v: "LucentDraw/3", id: "fila-federal-v3", title: "Fila", mode: "scheduled", contribution: "", sources: { federal: { contest: "6054-2" } },
    task: { preset: "list", options: ["Ana", "Bruno", "Célia", "Davi"], weights: ["1", "1", "2", "1/2"], count: 4, replace: false } };
  const state = { spec, commitment: await C.commitmentOf(spec), sealedAt: "2027-01-18T12:00:00.000Z", anchors: [], randomness: {}, meta: { preset: "federal" } };
  const { w, $, errors } = boot({ "lucentsorteios.draws": JSON.stringify({ [spec.id]: state }), "lucentsorteios.current": JSON.stringify(spec.id) });
  await tick(300);
  assert.ok($("listTable").querySelector(".wval").disabled, "retomado e travado");
  assert.equal($("manualBox").hidden, false);
  assert.equal($("cdWrap").hidden, true, "sem contagem regressiva para loteria");
  $("manualNums").value = "017469 81210 7767 41317 979412"; $("manualDate").value = "2027-01-20"; $("manualConfirm").checked = true;
  $("manualSave").click(); await tick(200);
  const saved = JSON.parse(w.localStorage.getItem("lucentsorteios.draws"))[spec.id];
  assert.deepEqual(saved.randomness.federal, { contest: "6054-2", prizes: [17469, 81210, 7767, 41317, 979412], drawDate: "2027-01-20", source: "manual" });
  assert.match($("ataText").textContent, /inserido manualmente/);
  assert.equal($("orderBody").querySelectorAll("tr").length, 4);
  const rep = await C.verifyCertificate(C.certificateOf(saved), { lottery: async () => { throw new Error("bloqueada"); } }, { lotteryConfirmed: true });
  assert.deepEqual(rep.checks.filter((c) => c.status === "falhou"), []);
  assert.equal(rep.checks.find((c) => c.id === "result").status, "passou");
  assert.equal(rep.checks.find((c) => c.id === "federalTiming").status, "nao_verificado");
  assert.deepEqual(errors, []);
});

test("UI: a LucentDraw/2 seal saved before the update still finishes by its own rule", { skip }, async () => {
  const spec = { v: "LucentDraw/2", id: "fila-federal-v2", title: "Fila", mode: "scheduled", candidates: ["Ana", "Bruno", "Célia", "Davi"], contribution: "", sources: { federal: { contest: 5900 } } };
  const state = { spec, commitment: await C.commitmentOf(spec), sealedAt: "2026-11-09T12:00:00.000Z", anchors: [], randomness: {}, meta: { preset: "federal", lotteryDrawMs: Date.now() - 3600e3 } };
  const { w, $, errors } = boot({ "lucentsorteios.draws": JSON.stringify({ [spec.id]: state }), "lucentsorteios.current": JSON.stringify(spec.id) });
  await tick(300);
  $("manualNums").value = "1234 56789 13579 24680 97531"; $("manualDate").value = "2026-11-11"; $("manualConfirm").checked = true;
  $("manualSave").click(); await tick(200);
  const saved = JSON.parse(w.localStorage.getItem("lucentsorteios.draws"))[spec.id];
  assert.equal(saved.order.length, 4);
  const rep = await C.verifyCertificate(C.certificateOf(saved), {}, { lotteryConfirmed: true });
  assert.equal(rep.checks.find((c) => c.id === "order").status, "passou");
  assert.deepEqual(errors, []);
});

test("UI: Conferir shows the v3 weights table, W and the interval bars", { skip }, async () => {
  const { $, errors } = boot();
  await tick();
  $("tab-verify").click();
  $("certIn").value = JSON.stringify(cert("v3-live-eth-weights"));
  $("verifyBtn").click(); await tick(300);
  assert.equal($("vV3").hidden, false);
  assert.match($("vW").textContent, /W = 489.*L = 140/);
  assert.deepEqual([...$("vTask").querySelectorAll("tr")].map((r) => [...r.children].map((c) => c.textContent).join("|")),
    ["Ana|3|420|85,9 %", "Bruno|0,35|49|10,0 %", "Célia|1/7|20|4,1 %", "Davi|0|0|0 %"]);
  assert.equal($("vBars").querySelectorAll(".needle").length, 1);
  assert.match($("verdict").textContent, /incompleta/); // sem rede
  assert.deepEqual(errors, []);
});

test("UI: opened from a local file, Rápido is the default mode", { skip }, async () => {
  const { $ } = boot({}, { url: "file:///home/x/LucentSorteios.html" });
  await tick();
  assert.equal($("verifBox").hidden, true);
  assert.equal($("sealBtn").textContent, "Sortear agora");
  assert.equal($("footerLinks").childNodes.length, 0);
});
