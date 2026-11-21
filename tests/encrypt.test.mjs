// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jeroen van de Graaf
// Lucent Encrypt: testa o núcleo embutido em encrypt/index.html (bibliotecas + ENCRYPT-CORE).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(ROOT, "encrypt", "index.html"), "utf8");
const lib = html.split('<script id="lelib">')[1].split("</script>")[0];
const core = html.split("// ENCRYPT-CORE-BEGIN")[1].split("// ENCRYPT-CORE-END")[0];
const { LE, LELIB } = new Function(lib + "\n" + core + "\nreturn { LE, LELIB };")();
const hex = (b) => Buffer.from(b).toString("hex"), unhex = (x) => Uint8Array.from(Buffer.from(x, "hex"));
const PHRASE = "abacate abaixo abalar abater abduzir abelha aberto";

test("X-Wing da biblioteca confere com os vetores oficiais do draft-connolly-cfrg-xwing-kem", () => {
  const tv = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "xwing_draft10_vectors.json"), "utf8")), XW = LELIB.ml_kem768_x25519;
  for (const t of tv) {
    const { publicKey, secretKey } = XW.keygen(unhex(t.seed));
    assert.equal(hex(publicKey), t.pk);
    const e = XW.encapsulate(publicKey, unhex(t.eseed));
    assert.equal(hex(e.cipherText), t.ct); assert.equal(hex(e.sharedSecret), t.ss);
    assert.equal(hex(XW.decapsulate(unhex(t.ct), secretKey)), t.ss);
  }
});
test("lista de palavras: 2048, só ASCII, 4 a 8 letras, 4 primeiras letras únicas", () => {
  const w = LE.wordlist;
  assert.equal(w.length, 2048); assert.ok(w.every((x) => /^[a-z]{4,8}$/.test(x)));
  assert.equal(new Set(w.map((x) => x.slice(0, 4))).size, 2048);
});
test("frase: acentos e maiúsculas ignorados, 4 letras bastam, palavra fora da lista apontada", () => {
  let p = LE.parsePhrase("ABACÁTE, abai abal abat abdu abel abert");
  assert.ok(p.ok); assert.equal(p.canonical, PHRASE);
  p = LE.parsePhrase("abacate abaixo casx abater"); assert.ok(!p.ok);
  assert.deepEqual(p.words.filter((x) => !x.word).map((x) => x.typed), ["casx"]);
  assert.ok(!LE.parsePhrase("abacaxi abaixo abalar abater abduzir abelha aberto").ok, "abacaxi não é abacate");
  assert.ok(!LE.parsePhrase("aba abaixo abalar abater abduzir abelha aberto").ok, "menos de 4 letras");
  const n = LE.newPhrase(); assert.equal(n.length, 7); assert.ok(LE.parsePhrase(n.join(" ")).ok);
});
test("identificador: e-mail, celular e nome normalizados", () => {
  assert.deepEqual(LE.normId(" Maria@Exemplo.COM "), { kind: "e-mail", value: "maria@exemplo.com" });
  assert.deepEqual(LE.normId("(31) 99999-0000"), { kind: "celular", value: "5531999990000" });
  assert.deepEqual(LE.normId("+55 31 99999 0000"), { kind: "celular", value: "5531999990000" });
  assert.deepEqual(LE.normId("  maría   da  Conceição "), { kind: "nome", value: "MARIA DA CONCEICAO" });
  assert.equal(LE.normId("   "), null); assert.equal(LE.normId("x".repeat(129)), null);
});
test("derivação reproduzível: mesma frase e identificador, mesma chave; outro identificador, outra chave", async () => {
  const k1 = await LE.master(PHRASE, "MARIA SILVA"), k2 = await LE.master(PHRASE, "MARIA SILVA"), k3 = await LE.master(PHRASE, "JOAO");
  assert.equal(hex(k1), hex(k2)); assert.notEqual(hex(k1), hex(k3));
  const pks = LE.MODES.map((m) => hex(LE.keysFor(k1, m).pk));
  assert.deepEqual(LE.MODES.map((m) => LE.keysFor(k1, m).pk.length), [32, 1184, 1216]);
  assert.equal(new Set(pks.map((x) => x.slice(0, 64))).size, 3, "uma chave por modo");
});
test("cifrar e abrir nos três modos; frase errada e mensagem alterada distinguidas", async () => {
  const k = await LE.master(PHRASE, "MARIA SILVA"), kWrong = await LE.master("abacate abaixo abalar abater abduzir abelha abismo", "MARIA SILVA");
  for (const mode of LE.MODES) {
    const pub = LE.encodePublic(mode, "MARIA SILVA", LE.keysFor(k, mode).pk);
    assert.match(LE.fingerprint(pub), /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    const text = "Olá, Maria! Código da porta: 4711 · ação ✓";
    const msg = await LE.encrypt(pub, text);
    assert.equal(await LE.openWith(k, msg), text, mode);
    await assert.rejects(LE.openWith(kWrong, msg), /frase/);
    const bad = msg.slice(); bad[bad.length - 5] ^= 1;
    await assert.rejects(LE.openWith(k, bad), /alterada/);
    const bad2 = msg.slice(); bad2[20 + 13] ^= 1; // dentro do KEM
    await assert.rejects(LE.openWith(k, bad2), /alterada/);
    const enc2 = await LE.encrypt(pub, text); assert.notEqual(hex(enc2), hex(msg), "cifra aleatória");
  }
});
test("tamanhos: preenchimento até múltiplos de 64; limite de 2000 caracteres; tabela confere com o real", async () => {
  const k = await LE.master(PHRASE, "ANA");
  for (const mode of LE.MODES) {
    const pub = LE.encodePublic(mode, "ANA", LE.keysFor(k, mode).pk);
    const a = await LE.encrypt(pub, "x"), b = await LE.encrypt(pub, "x".repeat(60));
    assert.equal(a.length, b.length, "mesmo bloco de 64");
    const sz = LE.sizes("ANA", 100), m100 = await LE.encrypt(pub, "y".repeat(100));
    assert.equal(LE.b64u(m100).length, sz[mode].msg); assert.equal(LE.b64u(pub).length, sz[mode].pub);
    await assert.rejects(LE.encrypt(pub, "z".repeat(2001)), /longa/);
    await assert.rejects(LE.encrypt(pub, ""), /vazia/);
  }
});
