// SPDX-License-Identifier: AGPL-3.0-only
// Gera as versões em inglês das ferramentas a partir da página em português e de uma tabela de
// substituições exatas (texto em português → texto em inglês). Cada chave tem que aparecer na
// página: se o português mudar, a geração falha em vez de deixar texto sem tradução.
//   node tools/translate-pages.mjs          escreve en/…
//   node tools/translate-pages.mjs --check  só confere que en/… está atualizado
// Trechos entre "I18N-KEEP-BEGIN" e "I18N-KEEP-END", e a biblioteca de QR, não são tocados.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PAGES = [
  { src: "votacao/index.html", out: "en/votacao/index.html", tables: ["tools/i18n/frame-sol.en.json", "votacao/en.json"] },
];
const KEEP = /\/\/ I18N-KEEP-BEGIN[\s\S]*?\/\/ I18N-KEEP-END|<script>\n\/\/ qrcode-generator[\s\S]*?<\/script>/g;

export function translate(html, table) {
  const kept = [];
  let s = html.replace(KEEP, (m) => { kept.push(m); return "\u0000KEEP" + (kept.length - 1) + "\u0000"; });
  const missing = [];
  for (const k of Object.keys(table).sort((a, b) => b.length - a.length)) {
    if (!s.includes(k)) { missing.push(k); continue; }
    s = s.split(k).join(table[k]);
  }
  if (missing.length) throw new Error("Texto não encontrado na página:\n  " + missing.join("\n  "));
  return s.replace(/\u0000KEEP(\d+)\u0000/g, (_, i) => kept[+i]);
}

export function build(page) {
  const table = Object.assign({}, ...page.tables.map((t) => JSON.parse(readFileSync(join(ROOT, t), "utf8"))));
  const banner = "<!-- Gerado por tools/translate-pages.mjs a partir de " + page.src + "; não edite à mão. -->\n";
  return translate(readFileSync(join(ROOT, page.src), "utf8"), table).replace(/^<!DOCTYPE html>\n/, "$&" + banner);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const p of PAGES) {
    const out = build(p), path = join(ROOT, p.out);
    if (check) { let cur = ""; try { cur = readFileSync(path, "utf8"); } catch {} if (cur !== out) { console.error("desatualizado: " + p.out); stale++; } }
    else { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, out); console.log("escrito: " + p.out); }
  }
  if (stale) process.exit(1);
}
