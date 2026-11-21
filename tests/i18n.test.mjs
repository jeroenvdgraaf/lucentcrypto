// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jeroen van de Graaf
// Página inicial em quatro línguas: mesmas chaves em todas, páginas geradas atualizadas, seletor e hreflang.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LANGS, render, outPath } from "../tools/build-home.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dict = (l) => JSON.parse(readFileSync(join(ROOT, "site", "i18n", l + ".json"), "utf8"));

test("as quatro línguas têm exatamente as mesmas chaves, e nenhum texto vazio além da nota do laboratório e do Lattes (só em português)", () => {
  const keys = Object.keys(dict("pt")).sort();
  for (const l of LANGS) {
    assert.deepEqual(Object.keys(dict(l)).sort(), keys, l);
    for (const [k, v] of Object.entries(dict(l))) if (k !== "lab.note" && !(k === "who.lattes" && l !== "pt")) assert.ok(String(v).trim(), l + ": " + k);
  }
});
test("site/index.html e site/{en,es,nl}/index.html estão atualizados (rode node tools/build-home.mjs)", () => {
  for (const l of LANGS) assert.equal(readFileSync(outPath(l), "utf8"), render(l), l);
});
test("cada página: língua certa, seletor com as quatro, a atual marcada, hreflang e canonical", () => {
  for (const l of LANGS) {
    const h = render(l), d = dict(l);
    assert.ok(h.includes(`<html lang="${d.htmlLang}">`));
    assert.ok(h.includes(`<link rel="canonical" href="https://lucentcrypto.org${d.path}">`));
    for (const o of LANGS) assert.ok(h.includes(`hreflang="${dict(o).htmlLang}" href="https://lucentcrypto.org${dict(o).path}"`), l + "→" + o);
    assert.equal((h.match(/ aria-current="page">/g) || []).length, 1);
    assert.ok(h.includes(`href="${d.path}" data-lang="${l}" hreflang="${d.htmlLang}" lang="${d.htmlLang}" title="${d.langName}" aria-current="page"`));
  }
});
test("raiz: cookie do seletor vence; senão Accept-Language pela ordem de preferência; senão inglês", async () => {
  const { homeLanguage } = await import("../worker/index.js");
  assert.equal(homeLanguage("", "pt-BR,pt;q=0.9,en;q=0.8"), "pt");
  assert.equal(homeLanguage("", "en-US,en;q=0.9,pt;q=0.5"), "en");
  assert.equal(homeLanguage("", "de-DE,nl;q=0.8,en;q=0.5"), "nl");
  assert.equal(homeLanguage("", "es-CL"), "es");
  assert.equal(homeLanguage("", "fr-FR,de;q=0.9"), "en");
  assert.equal(homeLanguage("", ""), "en");
  assert.equal(homeLanguage("lang=en", "pt-BR"), "en", "escolheu inglês num navegador em português");
  assert.equal(homeLanguage("x=1; lang=nl; y=2", "pt-BR"), "nl");
  assert.equal(homeLanguage("lang=xx", "es"), "es");
});

test("Lattes só na página em português; página do DCC em todas", () => {
  for (const l of LANGS) {
    const h = readFileSync(outPath(l), "utf8");
    assert.equal(h.includes("lattes.cnpq.br"), l === "pt", l);
    assert.ok(h.includes('href="https://dcc.ufmg.br/professor/jeroen-van-de-graaf/"'), l);
  }
});
