// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jeroen van de Graaf
// Versões em inglês geradas por tools/translate-pages.mjs: atualizadas e sem português sobrando.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./core_loader.mjs";
import { PAGES, build, translate } from "../tools/translate-pages.mjs";

test("translate: en/… está atualizado em relação à fonte e às tabelas", () => {
  for (const p of PAGES) assert.equal(readFileSync(join(ROOT, p.out), "utf8"), build(p), p.out + " desatualizado: rode node tools/translate-pages.mjs");
});

test("translate: chave ausente falha; trecho I18N-KEEP fica intacto", () => {
  assert.throws(() => translate("<p>Olá</p>", { "Tchau": "Bye" }), /não encontrado/);
  const src = '<p>Sim</p>\n// I18N-KEEP-BEGIN\nconst k = "<p>Sim</p>";\n// I18N-KEEP-END\n';
  assert.equal(translate(src, { "<p>Sim</p>": "<p>Yes</p>" }), src.replace("<p>Sim</p>\n", "<p>Yes</p>\n"));
});

test("translate: nenhum texto em português na versão em inglês", () => {
  for (const p of PAGES) {
    const s = readFileSync(join(ROOT, p.out), "utf8")
      .replace(/\/\/ I18N-KEEP-BEGIN[\s\S]*?\/\/ I18N-KEEP-END/g, "")
      .replace(/<script>\n\/\/ qrcode-generator[\s\S]*?<\/script>/, "").replace(/<script id="lelib">[\s\S]*?<\/script>/, "").replace(/<style>[\s\S]*?<\/style>/, "")
      .replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ [^"`]*$/gm, "")
      .replace(/<option value="[^"]*">/g, "<option>").replace(/lang="pt-BR"[^>]*>Português/, "").replace(/Brasília|Dani Biró|guardi\[aã\]o/g, "")
      .replace(/\(\?:concurso\|draw no\\\.\)/, "");
    const bad = s.split("\n").filter((l) => /[ãõçáéíóúâêô]|\b(não|votação|reunião|cédula|participantes)\b/i.test(l));
    assert.deepEqual(bad.map((l) => l.trim().slice(0, 120)), [], p.out);
  }
});

test("translate: a página em inglês muda só o texto, não o protocolo", () => {
  const en = readFileSync(join(ROOT, "en/votacao/index.html"), "utf8");
  assert.match(en, /<html lang="en">/);
  assert.match(en, /import \* as V from "\/votacao\/core\.mjs"/);
  assert.match(en, /<option value="Candidato">Candidate<\/option>/);
  assert.match(en, /acao: "encerrar"/);
  assert.match(en, /href="\/votacao\/" hreflang="pt"/);
});

test("translate: tabela de textos do Sorteios em inglês com as mesmas chaves e os mesmos argumentos", () => {
  const obj = (text) => new Function(text.slice(text.indexOf("const STR = {\n")) + "\nreturn STR;")();
  const pt = obj(readFileSync(join(ROOT, "LucentSorteios.html"), "utf8").match(/const STR = \{\n[\s\S]*?\n\};\n/)[0]);
  const en = obj(readFileSync(join(ROOT, "sorteios/strings.en.js"), "utf8"));
  const shape = (o) => typeof o === "function" ? "fn" + o.length : Array.isArray(o) ? o.map(shape) : o && typeof o === "object" ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, shape(o[k])])) : typeof o;
  assert.deepEqual(shape(en), shape(pt));
  const sorteios = readFileSync(join(ROOT, "en/sorteios/index.html"), "utf8");
  assert.ok(sorteios.includes('ataTitle: "Draw record"') && !sorteios.includes("ATA DO SORTEIO"));
});
