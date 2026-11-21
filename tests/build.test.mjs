// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jeroen van de Graaf
// build.sh monta o site com a estrutura da SPEC-v3 9.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./core_loader.mjs";

test("build.sh: home, /sorteios/, /amigo-oculto/, /embaralhamento/, /spec/, /verifier/", () => {
  const out = join(mkdtempSync(join(tmpdir(), "lucent-build-")), "dist");
  execFileSync("sh", [join(ROOT, "build.sh"), out], { stdio: "ignore" });
  const same = (a, b) => assert.equal(readFileSync(join(out, a), "utf8"), readFileSync(join(ROOT, b), "utf8"), a);
  same("sorteios/index.html", "LucentSorteios.html");
  same("amigo-oculto/index.html", "amigo-oculto/index.html");
  same("verifier/verify_draw.py", "verifier/verify_draw.py");
  same("spec/SPEC-v3.md", "spec/SPEC-v3.md");
  same("embaralhamento/index.html", "embaralhamento/index.html");
  same("segredo/index.html", "segredo/index.html");
  same("votacao/index.html", "votacao/index.html");
  same("encrypt/index.html", "encrypt/index.html");
  same("votacao/core.mjs", "votacao/core.mjs");
  same("votacao/verifica.mjs", "votacao/verifica.mjs");
  same("votacao/vendor/noble.mjs", "votacao/vendor/noble.mjs");
  same("en/votacao/index.html", "en/votacao/index.html");
  same("en/sorteios/index.html", "en/sorteios/index.html");
  for (const f of ["robots.txt", "sitemap.xml", "og/sorteios.png", "og/embaralhamento.png", "og/segredo.png", "og/encrypt.png", "og/votacao.png"]) assert.ok(existsSync(join(out, f)), f);
  for (const f of ["spec/SPEC.md", "spec/lucentdraw3_vectors.json", "spec/LICENSE", "verifier/LICENSE"]) assert.ok(existsSync(join(out, f)), f);
  assert.ok(!readdirSync(join(out, "spec")).includes("__pycache__"));
  const home = readFileSync(join(out, "index.html"), "utf8");
  for (const l of ["pt", "es", "nl"]) assert.ok(existsSync(join(out, l, "index.html")), l);
  assert.ok(readFileSync(join(out, "pt/index.html"), "utf8").includes('lang="pt-BR"'));
  assert.ok(home.includes('lang="en"') && home.includes('href="/en/sorteios/"') && home.includes('href="/amigo-oculto/"') && home.includes('href="/embaralhamento/"') && home.includes('href="/segredo/"') && home.includes('href="/en/votacao/"') && readFileSync(join(out, "pt/index.html"), "utf8").includes('href="/votacao/"') && home.includes('href="/encrypt/"'));
  // só um script embutido (o destaque sazonal do Amigo Oculto); nenhum script externo
  assert.ok(home.includes("prefers-color-scheme: dark") && !/<script[^>]*\bsrc=/i.test(home));
  const amigo = readFileSync(join(out, "amigo-oculto/index.html"), "utf8");
  assert.match(amigo, /Para sorteios com certificado: <a href="\/sorteios\/"[^>]*>Lucent Sorteios<\/a>/);
});
