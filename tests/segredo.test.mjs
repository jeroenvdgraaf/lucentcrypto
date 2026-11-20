// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jeroen van de Graaf
// Lucent Segredo (demonstração, ainda fora do site): núcleo de Shamir sobre GF(2^8), extraído do HTML.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(ROOT, "segredo", "index.html"), "utf8");
const core = html.slice(html.indexOf("// SEGREDO-CORE-BEGIN"), html.indexOf("// SEGREDO-CORE-END"));
const C = new Function(core + "; return { lsSeal, lsOpen, lsSplit, lsRecover, lsEncodeShare, lsDecodeShare, gfMul, gfDiv, LS_MAX_BYTES };")();
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
const copy = (sh) => sh.map((p) => ({ x: p.x, y: p.y.slice() }));

test("GF(2^8): inverso e um vetor conhecido do AES", () => {
  assert.equal(C.gfMul(0x57, 0x83), 0xc1);
  for (let a = 1; a < 256; a++) assert.equal(C.gfMul(a, C.gfDiv(1, a)), 1);
});
test("OAEP: embrulha e abre; tamanho escondido em múltiplos de 32", async () => {
  for (const t of ["a", "x".repeat(30), "x".repeat(31), "ação ✓"]) assert.equal(await C.lsOpen(await C.lsSeal(t, rand)), t);
  assert.equal((await C.lsSeal("a", rand)).length, 32 + 16 + 32);
  assert.equal((await C.lsSeal("x".repeat(30), rand)).length, 80);
  assert.equal((await C.lsSeal("x".repeat(31), rand)).length, 112);
  await assert.rejects(C.lsSeal("x".repeat(C.LS_MAX_BYTES + 1), rand));
  const p = await C.lsSeal("segredo", rand); p[3] ^= 1; await assert.rejects(C.lsOpen(p));
});
test("divide e abre: exatamente k, todas, k-1 não basta", async () => {
  for (let trial = 0; trial < 60; trial++) {
    const n = 2 + (trial % 9), k = 2 + (trial % (n - 1)), text = "Banco: 1234 · ação ✓ " + trial;
    const sh = C.lsSplit(await C.lsSeal(text, rand), k, n, rand), pick = sh.slice().sort(() => Math.random() - 0.5);
    let r = await C.lsRecover(pick.slice(0, k), k);
    assert.equal(r.text, text); assert.equal(r.checked, true);
    r = await C.lsRecover(pick, k);
    assert.equal(r.text, text); assert.deepEqual(r.bad, []);
    assert.equal((await C.lsRecover(pick.slice(0, k - 1), k)).error, "faltam");
  }
});
test("partes alteradas: exatamente k detecta, k+1 encontra, k+2e corrige", async () => {
  for (let trial = 0; trial < 40; trial++) {
    const k = 2 + (trial % 4), n = k + 2 + (trial % 5), e = Math.floor((n - k) / 2), text = "segredo " + trial;
    const sh = C.lsSplit(await C.lsSeal(text, rand), k, n, rand);
    const exact = copy(sh.slice(0, k)); exact[trial % k].y[trial % exact[0].y.length] ^= 1 + (trial % 200);
    assert.equal((await C.lsRecover(exact, k)).error, "alterada");
    const one = copy(sh.slice(0, k + 1)), w = trial % (k + 1); one[w].y[0] ^= 9;
    let r = await C.lsRecover(one, k);
    assert.equal(r.text, text); assert.deepEqual(r.bad, [sh[w].x]);
    const bad = copy(sh);
    for (let i = 0; i < e; i++) bad[i * 2].y[(i * 7) % bad[i * 2].y.length] ^= 1 + i;
    r = await C.lsRecover(bad, k);
    assert.equal(r.text, text);
    assert.deepEqual(r.bad, Array.from({ length: e }, (_, i) => sh[i * 2].x));
  }
});
test("formato LS2: binário compacto, CRC contra erro de cópia, conjunto identificado", async () => {
  const meta = { id: "0123456789abcdef", title: "Senhas da família", by: "Ana", date: "2026-11-20", k: 2, n: 3, guardians: ["Bruno", "Carla", "Diego"] };
  const sh = C.lsSplit(await C.lsSeal("x", rand), 2, 3, rand), s = C.lsEncodeShare(meta, 2, sh[1].y);
  assert.match(s, /^LS2\.[A-Za-z0-9_-]+$/);
  const d = C.lsDecodeShare("https://lucentcrypto.org/segredo/#p=" + s);
  assert.equal(d.share.guardian, "Carla"); assert.equal(d.share.x, 2); assert.equal(d.share.id, meta.id);
  assert.equal(d.share.title, meta.title); assert.equal(d.share.by, "Ana"); assert.equal(d.share.date, "2026-11-20");
  assert.equal(d.share.k, 2); assert.equal(d.share.n, 3); assert.deepEqual([...d.share.y], [...sh[1].y]);
  const flip = s.slice(0, 30) + (s[30] === "A" ? "B" : "A") + s.slice(31);
  assert.ok(C.lsDecodeShare(flip).error);
  assert.equal(C.lsDecodeShare("qualquer coisa").error, "formato");
  // compacto: metadados + y + 23 bytes de cabeçalho/CRC
  const raw = 1 + 8 + 5 + 3 + "Senhas da família".length + 1 + 3 + 5 + sh[1].y.length + 4;
  assert.equal(s.length, 4 + Math.ceil(raw * 4 / 3));
});
