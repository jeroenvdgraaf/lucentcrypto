// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jeroen van de Graaf
// Cruzamento de listas (LucentPSI/1): normalização e protocolo.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as C from "../cruzamento/core.mjs";

const cpfs = (n, start = 123456) => Array.from({ length: n }, (_, i) => C.cpfComplete(String(start + i * 7919).padStart(9, "0")));

test("normalização: CPF e CNPJ com dígitos verificadores; e-mail, telefone e nome", () => {
  assert.deepEqual(C.normalize("cpf", "529.982.247-25"), { key: "52998224725" });
  assert.equal(C.normalize("cpf", "529.982.247-24").error, "cpf");
  assert.equal(C.normalize("cpf", "111.111.111-11").error, "cpf");
  assert.deepEqual(C.normalize("cnpj", "11.222.333/0001-81"), { key: "11222333000181" });
  assert.equal(C.normalize("cnpj", "11.222.333/0001-82").error, "cnpj");
  assert.deepEqual(C.normalize("email", "  Ana.Souza@Exemplo.COM "), { key: "ana.souza@exemplo.com" });
  assert.deepEqual(C.normalize("telefone", "(31) 99999-0000"), { key: "5531999990000" });
  assert.deepEqual(C.normalize("telefone", "+1 555 010 0000"), { key: "15550100000" });
  assert.deepEqual(C.normalize("nome", "  JOSÉ  da Silva-Júnior "), { key: "jose da silva junior" });
  assert.equal(C.cpfComplete("529982247"), "52998224725");
});

test("lista colada: rótulo opcional, cabeçalho ignorado, repetidos e inválidos apontados", () => {
  const r = C.parseItems("cpf", "nome;cpf\nAna; 529.982.247-25\n529.982.247-25\nBruno; 123\n" + C.fmtCpf(cpfs(1)[0]));
  assert.equal(r.items.length, 2);
  assert.deepEqual(r.items[0], { key: "52998224725", label: "Ana", raw: "529.982.247-25" });
  assert.deepEqual(r.errors.map((e) => e.error), ["repetido", "cpf"]);
});

test("protocolo: os dois lados encontram exatamente a interseção, em qualquer ordem", () => {
  const all = cpfs(30), A = all.slice(0, 18).map((key) => ({ key })), B = all.slice(10).reverse().map((key) => ({ key }));
  const r = C.run("sessao-teste", "cpf", A, B);
  assert.deepEqual(r.resA.hits.map((i) => A[i].key).sort(), all.slice(10, 18).sort());
  assert.deepEqual(r.resB.hits.map((i) => B[i].key).sort(), all.slice(10, 18).sort());
  assert.equal(r.resA.count, 8);
});

test("só o tamanho: a contagem sai, os itens não", () => {
  const all = cpfs(12), A = all.slice(0, 8).map((key) => ({ key })), B = all.slice(5).map((key) => ({ key }));
  const r = C.run("s", "cpf", A, B, { onlyCount: true });
  assert.deepEqual(r.resA, { count: 3 }); assert.deepEqual(r.resB, { count: 3 });
});

test("valores cegados: dependem do segredo, da sessão e do perfil; k_A·k_B·H(x) comuta", () => {
  const kA = C.randScalar(), kB = C.randScalar(), x = "52998224725";
  const h = C.hashToPoint("s1", "cpf", x).toHex();
  assert.equal(C.blind(kB, C.blind(kA, h)), C.blind(kA, C.blind(kB, h)));
  assert.notEqual(C.hashToPoint("s2", "cpf", x).toHex(), h, "outra sessão, outro ponto");
  assert.notEqual(C.hashToPoint("s1", "telefone", x).toHex(), h, "outro perfil, outro ponto");
  assert.notEqual(C.blind(kA, h), C.blind(kB, h));
});

test("primeira passada embaralha: a ordem enviada não é a da lista", () => {
  const A = cpfs(40).map((key) => ({ key })), sent = C.firstPass("s", "cpf", C.randScalar(), A);
  assert.notDeepEqual(sent.map((x) => x.i), A.map((_, i) => i));
  assert.deepEqual(sent.map((x) => x.i).sort((a, b) => a - b), A.map((_, i) => i));
});

test("hash de CPF: a busca exaustiva acha o CPF entre os que começam com o prefixo", async () => {
  const d = C.cpfComplete("529982247"), r = await C.crackCpf(C.cpfHash(d), "52998");
  assert.equal(r.cpf, d);
});
