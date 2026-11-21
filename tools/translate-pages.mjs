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
  // Sorteios: a tabela de textos inteira (const STR = {…};) vem de sorteios/strings.en.js.
  { src: "LucentSorteios.html", out: "en/sorteios/index.html", tables: ["tools/i18n/frame-sol.en.json", "sorteios/en.json"],
    blocks: [{ start: "const STR = {\n", end: "\n};\n", file: "sorteios/strings.en.js" }] },
  { src: "embaralhamento/index.html", out: "en/embaralhamento/index.html", tables: ["tools/i18n/frame-sol.en.json", "embaralhamento/en.json"] },
];
const KEEP = /\/\/ I18N-KEEP-BEGIN[\s\S]*?\/\/ I18N-KEEP-END|<script>\n\/\/ qrcode-generator[\s\S]*?<\/script>/g;

// Um bloco inteiro trocado pelo conteúdo de um arquivo (do "const STR = {" até o "};" que fecha).
export const blockText = (text, b) => {
  const i = text.indexOf(b.start), j = i < 0 ? -1 : text.indexOf(b.end, i);
  if (i < 0 || j < 0) throw new Error("Bloco não encontrado: " + JSON.stringify(b.start));
  return { i, j: j + b.end.length, text: text.slice(i, j + b.end.length) };
};

export function translate(html, table, blocks = []) {
  const kept = [];
  for (const b of blocks) {
    const src = blockText(html, b), repl = blockText(b.content, b);
    html = html.slice(0, src.i) + "\u0000BLOCK" + kept.length + "\u0000" + html.slice(src.j); kept.push(repl.text);
  }
  html = html.replace(/\u0000BLOCK(\d+)\u0000/g, (m) => m.replace("BLOCK", "KEEP"));
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
  const blocks = (page.blocks || []).map((b) => ({ ...b, content: readFileSync(join(ROOT, b.file), "utf8") }));
  return translate(readFileSync(join(ROOT, page.src), "utf8"), table, blocks).replace(/^<!DOCTYPE html>\n/, "$&" + banner);
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
