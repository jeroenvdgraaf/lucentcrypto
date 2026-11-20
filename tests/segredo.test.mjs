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
const C = new Function(core + "; return { lsSeal, lsOpen, lsSplit, lsRecover, lsEncodeShare, lsDecodeShare, lsHeader, lsHeaderHash, gfMul, gfDiv, LS_MAX_BYTES, LS_MAX_N, LS_HINT };")();
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
const H0 = new Uint8Array(32);
const META = (k, n) => ({ id: "0123456789abcdef", title: "Senhas da família", by: "Ana", date: "2026-11-20", k, n, guardians: Array.from({ length: n }, (_, i) => "Guardião " + (i + 1)) });
// Partes como a página as usa: { x, y, hdr }
async function makeShares(text, k, n, meta = META(k, n)) {
  const sh = C.lsSplit(await C.lsSeal(text, rand, await C.lsHeaderHash(meta)), k, n, rand), hdr = C.lsHeader(meta);
  return sh.map((p) => ({ x: p.x, y: p.y, hdr }));
}
const copy = (sh) => sh.map((p) => ({ x: p.x, y: p.y.slice(), hdr: p.hdr }));

test("GF(2^8): inverso e um vetor conhecido do AES", () => {
  assert.equal(C.gfMul(0x57, 0x83), 0xc1);
  for (let a = 1; a < 256; a++) assert.equal(C.gfMul(a, C.gfDiv(1, a)), 1);
});
test("OAEP: embrulha e abre; tamanho escondido em múltiplos de 32; cabeçalho amarrado", async () => {
  for (const t of ["a", "x".repeat(30), "x".repeat(31), "ação ✓"]) assert.equal(await C.lsOpen(await C.lsSeal(t, rand, H0), H0), t);
  assert.equal((await C.lsSeal("a", rand, H0)).length, 32 + 16 + 32);
  assert.equal((await C.lsSeal("x".repeat(31), rand, H0)).length, 112);
  await assert.rejects(C.lsSeal("x".repeat(C.LS_MAX_BYTES + 1), rand, H0));
  const p = await C.lsSeal("segredo", rand, H0); p[3] ^= 1; await assert.rejects(C.lsOpen(p, H0));
  const h1 = H0.slice(); h1[0] = 1; await assert.rejects(C.lsOpen(await C.lsSeal("segredo", rand, H0), h1));
});
test("divide e recupera: exatamente k, todas, k-1 não basta", async () => {
  for (let trial = 0; trial < 50; trial++) {
    const n = 2 + (trial % 11), k = 2 + (trial % (n - 1)), text = "Banco: 1234 · ação ✓ " + trial;
    const pick = (await makeShares(text, k, n)).sort(() => Math.random() - 0.5);
    let r = await C.lsRecover(pick.slice(0, k), k);
    assert.equal(r.text, text);
    r = await C.lsRecover(pick, k);
    assert.equal(r.text, text); assert.deepEqual(r.bad, []);
    assert.equal((await C.lsRecover(pick.slice(0, k - 1), k)).error, "faltam");
  }
});
test("partes alteradas: exatamente k percebe, k+1 encontra, k+2e corrige", async () => {
  for (let trial = 0; trial < 30; trial++) {
    const k = 2 + (trial % 4), n = Math.min(12, k + 2 + (trial % 5)), e = Math.floor((n - k) / 2), text = "segredo " + trial;
    const sh = await makeShares(text, k, n);
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
test("cabeçalho alterado (título, nomes): percebido com k, apontado com k+1", async () => {
  const meta = META(2, 3), sh = await makeShares("segredo", 2, 3, meta);
  const forged = C.lsHeader({ ...meta, title: "Outro título" });
  assert.equal((await C.lsRecover([sh[0], { ...sh[1], hdr: forged }], 2)).error, "alterada");
  const names = C.lsHeader({ ...meta, guardians: ["Guardião 1", "Mallory", "Guardião 3"] });
  const r = await C.lsRecover([sh[0], { ...sh[1], hdr: names }, sh[2]], 2);
  assert.equal(r.text, "segredo"); assert.deepEqual(r.bad, [2]);
  // forjar cabeçalho E valor numa só parte, com k partes: ainda percebido
  const both = copy([sh[0], sh[1]]); both[1].hdr = forged; both[1].y[5] ^= 3;
  assert.equal((await C.lsRecover(both, 2)).error, "alterada");
});
test("limites: no máximo 12 guardiões e 128 bytes por texto", () => {
  assert.equal(C.LS_MAX_N, 12);
  assert.throws(() => C.lsHeader(META(2, 13)));
  assert.throws(() => C.lsHeader({ ...META(2, 3), title: "x".repeat(129) }));
  assert.doesNotThrow(() => C.lsHeader({ ...META(2, 3), title: "é".repeat(64) }));
  assert.throws(() => C.lsHeader({ ...META(2, 3), by: "é".repeat(65) }));
});
test("formato LS2: nomes de todos, CRC contra erro de cópia, conjunto identificado", async () => {
  const meta = { ...META(2, 3), guardians: ["Bruno", "Carla", "Diego"] };
  const sh = C.lsSplit(await C.lsSeal("x", rand, await C.lsHeaderHash(meta)), 2, 3, rand), s = C.lsEncodeShare(meta, 2, sh[1].y);
  assert.match(s, /^LS2\.[A-Za-z0-9_-]+$/);
  const d = C.lsDecodeShare("https://lucentcrypto.org/segredo/#p=" + s + "&h=" + C.LS_HINT);
  assert.equal(d.share.guardian, "Carla"); assert.deepEqual(d.share.names, ["Bruno", "Carla", "Diego"]);
  assert.equal(d.share.x, 2); assert.equal(d.share.id, meta.id); assert.equal(d.share.title, meta.title);
  assert.equal(d.share.by, "Ana"); assert.equal(d.share.date, "2026-11-20"); assert.equal(d.share.k, 2); assert.equal(d.share.n, 3);
  assert.deepEqual([...d.share.y], [...sh[1].y]); assert.deepEqual([...d.share.hdr], [...C.lsHeader(meta)]);
  const flip = s.slice(0, 30) + (s[30] === "A" ? "B" : "A") + s.slice(31);
  assert.ok(C.lsDecodeShare(flip).error);
  assert.equal(C.lsDecodeShare("qualquer coisa").error, "formato");
  // a dica só usa caracteres que sobrevivem num link
  assert.match(C.LS_HINT, /^[A-Za-z0-9\-._~!$'()*+,;=:@\/?]+$/);
});
test("fixture (criada uma vez) para o decodificador independente em Python (tests/test_segredo_hint.py)", async () => {
  const meta = { id: "a1b2c3d4e5f60718", title: "Teste da dica", by: "Ana", date: "2026-11-20", k: 3, n: 4, guardians: ["Bruno", "Carla", "Diego", "Eva Ünal"] };
  const text = "o segredo: 42 · ação ✓";
  const sh = C.lsSplit(await C.lsSeal(text, rand, await C.lsHeaderHash(meta)), 3, 4, rand);
  const links = sh.map((p) => "https://lucentcrypto.org/segredo/#p=" + C.lsEncodeShare(meta, p.x, p.y) + "&h=" + C.LS_HINT);
  const { writeFileSync, existsSync } = await import("node:fs");
  if (!existsSync(join(ROOT, "tests", "fixtures", "segredo_ls2.json"))) writeFileSync(join(ROOT, "tests", "fixtures", "segredo_ls2.json"), JSON.stringify({ secret: text, k: 3, links }, null, 1) + "\n");
});
