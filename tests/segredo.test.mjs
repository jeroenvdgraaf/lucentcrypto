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
const C = new Function(core + "; return { lsPack, lsUnpack, lsSplit, lsRecover, lsEncodeShare, lsDecodeShare, gfMul, gfDiv, LS_MAX_BYTES };")();
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

test("GF(2^8): inverso e um vetor conhecido do AES", () => {
  assert.equal(C.gfMul(0x57, 0x83), 0xc1);
  for (let a = 1; a < 256; a++) assert.equal(C.gfMul(a, C.gfDiv(1, a)), 1);
});
test("divide e abre: exatamente k, todas, k-1 não basta", () => {
  for (let trial = 0; trial < 100; trial++) {
    const n = 2 + (trial % 9), k = 2 + (trial % (n - 1)), text = "Banco: 1234 · ação ✓ " + trial;
    const sh = C.lsSplit(C.lsPack(text, rand), k, n, rand), pick = sh.slice().sort(() => Math.random() - 0.5);
    let r = C.lsRecover(pick.slice(0, k), k);
    assert.equal(C.lsUnpack(r.payload), text); assert.equal(r.checked, false);
    r = C.lsRecover(pick, k);
    assert.equal(C.lsUnpack(r.payload), text); assert.equal(r.checked, n > k); assert.deepEqual(r.bad, []);
    assert.equal(C.lsRecover(pick.slice(0, k - 1), k).error, "faltam");
  }
});
test("tamanho escondido: conteúdo completado até múltiplo de 32", () => {
  assert.equal(C.lsPack("a", rand).length, 32);
  assert.equal(C.lsPack("x".repeat(30), rand).length, 32);
  assert.equal(C.lsPack("x".repeat(31), rand).length, 64);
  assert.throws(() => C.lsPack("x".repeat(C.LS_MAX_BYTES + 1), rand));
});
test("partes erradas: k+1 detecta, k+2e corrige e aponta", () => {
  for (let trial = 0; trial < 60; trial++) {
    const k = 2 + (trial % 4), n = k + 2 + (trial % 5), e = Math.floor((n - k) / 2), text = "segredo " + trial;
    const sh = C.lsSplit(C.lsPack(text, rand), k, n, rand);
    const one = sh.slice(0, k + 1).map((p) => ({ x: p.x, y: p.y.slice() })); one[1].y[0] ^= 9;
    assert.ok(C.lsRecover(one, k).error, "k+1 com uma errada");
    const bad = sh.map((p) => ({ x: p.x, y: p.y.slice() }));
    for (let i = 0; i < e; i++) bad[i * 2].y[(i * 7) % bad[i * 2].y.length] ^= 1 + i;
    const r = C.lsRecover(bad, k);
    assert.equal(C.lsUnpack(r.payload), text);
    assert.deepEqual(r.bad, Array.from({ length: e }, (_, i) => sh[i * 2].x));
  }
});
test("formato: link ou texto, CRC contra erro de cópia, conjunto identificado", () => {
  const meta = { id: "0123456789abcdef", title: "Senhas da família", by: "Ana", date: "2026-11-20", k: 2, n: 3, guardians: ["Bruno", "Carla", "Diego"] };
  const sh = C.lsSplit(C.lsPack("x", rand), 2, 3, rand), s = C.lsEncodeShare(meta, 2, sh[1].y);
  const d = C.lsDecodeShare("https://lucentcrypto.org/segredo/#p=" + s);
  assert.equal(d.share.guardian, "Carla"); assert.equal(d.share.x, 2); assert.equal(d.share.id, meta.id);
  const flip = s.slice(0, 30) + (s[30] === "A" ? "B" : "A") + s.slice(31);
  assert.ok(C.lsDecodeShare(flip).error);
  assert.equal(C.lsDecodeShare("qualquer coisa").error, "formato");
  // nenhuma parte traz um resumo do segredo: só metadados e o valor do polinômio
  assert.deepEqual(Object.keys(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s.split(".")[1].replace(/-/g, "+").replace(/_/g, "/") + "==="[0].repeat((4 - s.split(".")[1].length % 4) % 4)), (c) => c.charCodeAt(0))))).sort(),
    ["by", "d", "g", "id", "k", "n", "t", "v", "x", "y"]);
});
