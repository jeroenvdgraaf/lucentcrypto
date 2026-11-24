// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jeroen van de Graaf
//
// Gera site/sitemap.xml: cada página com a data da última mudança (do git) e as versões em outras
// línguas (xhtml:link hreflang), para que os buscadores mostrem a cada pessoa a página na sua língua.
// Uso: node tools/sitemap.mjs   (rodar e commitar quando uma página mudar; o build não tem o histórico)
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const BASE = "https://lucentcrypto.org";
// Grupos de páginas equivalentes: [hreflang, caminho, arquivo de origem], com as mesmas hreflang que as páginas
// declaram. x-default (só na página inicial): a versão para quem não tem língua.
const GROUPS = [
  { def: "/", pages: [["en", "/", "site/i18n/en.json"], ["pt-BR", "/pt/", "site/i18n/pt.json"], ["es", "/es/", "site/i18n/es.json"], ["nl", "/nl/", "site/i18n/nl.json"]] },
  ...[
    ["sorteios", "LucentSorteios.html", "sorteios/strings.en.js"],
    ["embaralhamento", "embaralhamento/index.html", "embaralhamento/en.json"],
    ["cruzamento", "cruzamento/index.html", "cruzamento/en.json"],
    ["votacao", "votacao/index.html", "votacao/en.json"],
    ["encrypt", "encrypt/index.html", "encrypt/en.json"],
    ["segredo", "segredo/index.html", "segredo/en.json"],
    ["amigo-oculto", "amigo-oculto/index.html", "amigo-oculto/en.json"],
  ].map(([t, pt, en]) => ({ def: null, pages: [["pt", `/${t}/`, pt], ["en", `/en/${t}/`, en]] })), // as mesmas hreflang das páginas
];
const HOME_SHARED = ["site/home.html"]; // o modelo das páginas iniciais

const lastChange = (...files) => {
  const out = execFileSync("git", ["log", "-1", "--format=%cs", "--", ...files], { encoding: "utf8" }).trim();
  if (!out) throw new Error("sem histórico no git: " + files.join(", "));
  return out;
};

let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n';
for (const g of GROUPS) {
  for (const [, path, src] of g.pages) {
    // a versão em português é a fonte de todas: muda quando ela ou a tradução mudam
    const sources = g.def === "/" ? [src, ...HOME_SHARED] : [g.pages[0][2], src];
    xml += `  <url>\n    <loc>${BASE}${path}</loc>\n    <lastmod>${lastChange(...sources)}</lastmod>\n`;
    for (const [lang, p] of g.pages) xml += `    <xhtml:link rel="alternate" hreflang="${lang}" href="${BASE}${p}"/>\n`;
    if (g.def) xml += `    <xhtml:link rel="alternate" hreflang="x-default" href="${BASE}${g.def}"/>\n`;
    xml += "  </url>\n";
  }
}
xml += "</urlset>\n";
writeFileSync(new URL("../site/sitemap.xml", import.meta.url), xml);
console.log("escrito site/sitemap.xml:", GROUPS.reduce((n, g) => n + g.pages.length, 0), "páginas");
