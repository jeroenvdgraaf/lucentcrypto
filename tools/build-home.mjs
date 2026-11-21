// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jeroen van de Graaf
//
// Gera a página inicial nas quatro línguas a partir de site/home.html (modelo) e site/i18n/<língua>.json:
//   site/index.html (pt), site/en/index.html, site/es/index.html, site/nl/index.html
// Uso: node tools/build-home.mjs          (escreve os arquivos)
//      node tools/build-home.mjs --check  (só confere se estão atualizados; usado nos testes)
// No modelo: {{chave}} = texto (escapado), {{url:chave}} = texto para um link (encodeURIComponent),
// {{@langs}}, {{@alternates}}, {{@labNote}}, {{@lattes}} = blocos gerados aqui.
// O seletor grava a escolha num cookie (lang); o Worker usa esse cookie, ou o idioma do navegador,
// só para decidir para onde vai quem abre lucentcrypto.org/ (worker/index.js).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const LANGS = ["pt", "en", "es", "nl"];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// Inglês é a página padrão (/); as outras ficam em /pt/, /es/, /nl/.
export const outPath = (lang) => join(ROOT, "site", lang === "en" ? "index.html" : lang + "/index.html");

export function render(lang) {
  const tpl = readFileSync(join(ROOT, "site", "home.html"), "utf8");
  const all = Object.fromEntries(LANGS.map((l) => [l, JSON.parse(readFileSync(join(ROOT, "site", "i18n", l + ".json"), "utf8"))]));
  const t = all[lang];
  const langs = `<nav class="langs" aria-label="${esc(t.langsLabel)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>` +
    LANGS.map((l) => `<a href="${all[l].path}" data-lang="${l}" hreflang="${all[l].htmlLang}" lang="${all[l].htmlLang}" title="${esc(all[l].langName)}"${l === lang ? ' aria-current="page"' : ""}>${all[l].langCode}</a>`).join("") + `</nav>`;
  const alternates = LANGS.map((l) => `<link rel="alternate" hreflang="${all[l].htmlLang}" href="https://lucentcrypto.org${all[l].path}">`).join("\n") +
    `\n<link rel="alternate" hreflang="x-default" href="https://lucentcrypto.org/">`;
  const labNote = t["lab.note"] ? `<p class="note">${esc(t["lab.note"])}</p>` : "";
  let out = tpl.replace("{{@langs}}", langs).replace("{{@alternates}}", alternates).replace("{{@labNote}}", labNote)
    // Currículo Lattes: só na página em português (fora do Brasil ninguém o conhece).
    .replace("{{@lattes}}", t["who.lattes"] ? `<a href="http://lattes.cnpq.br/0069989873499216">${esc(t["who.lattes"])}</a>` : "");
  out = out.replace(/\{\{(url:)?([A-Za-z0-9_.]+)\}\}/g, (m, url, key) => {
    if (key === "lang") return lang;
    if (!(key in t)) throw new Error(lang + ": falta a chave " + key);
    return url ? encodeURIComponent(t[key]) : esc(t[key]);
  });
  if (/\{\{/.test(out)) throw new Error(lang + ": sobrou um {{…}} no modelo");
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  let stale = [];
  for (const l of LANGS) {
    const html = render(l), p = outPath(l);
    if (check) { if (!existsSync(p) || readFileSync(p, "utf8") !== html) stale.push(p); }
    else { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, html); console.log("escrito", p.slice(ROOT.length + 1)); }
  }
  if (check && stale.length) { console.error("desatualizado (rode node tools/build-home.mjs):\n" + stale.join("\n")); process.exit(1); }
}
