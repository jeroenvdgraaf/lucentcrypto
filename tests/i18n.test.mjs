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

test("as quatro línguas têm exatamente as mesmas chaves, e nenhum texto vazio além da nota do laboratório", () => {
  const keys = Object.keys(dict("pt")).sort();
  for (const l of LANGS) {
    assert.deepEqual(Object.keys(dict(l)).sort(), keys, l);
    for (const [k, v] of Object.entries(dict(l))) if (k !== "lab.note") assert.ok(String(v).trim(), l + ": " + k);
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
    assert.ok(h.includes(`href="${d.path}" hreflang="${d.htmlLang}" lang="${d.htmlLang}" title="${d.langName}" aria-current="page"`));
  }
});
