// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jeroen van de Graaf
//
// Avisa os buscadores que usam o IndexNow (Bing, e por ele DuckDuckGo e outros; Yandex; Seznam) de que as
// páginas do sitemap mudaram. A chave está em site/<chave>.txt, publicada na raiz do site.
// Uso, depois de publicar: node tools/indexnow.mjs            (todas as páginas do sitemap)
//                          node tools/indexnow.mjs /votacao/  (só as indicadas)
// Desnecessário se o Cloudflare tiver os "Crawler Hints" ligados: ele avisa sozinho.
import { readFileSync } from "node:fs";

const HOST = "lucentcrypto.org";
const KEY = "c04cc0abe797b12ebf2dec3719c0bcc7";
const args = process.argv.slice(2);
const urls = args.length
  ? args.map((p) => `https://${HOST}${p}`)
  : [...readFileSync(new URL("../site/sitemap.xml", import.meta.url), "utf8").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

const res = await fetch("https://api.indexnow.org/indexnow", {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify({ host: HOST, key: KEY, keyLocation: `https://${HOST}/${KEY}.txt`, urlList: urls }),
});
console.log(res.status, res.statusText, `(${urls.length} páginas)`); // 200 ou 202: aceito
if (res.status >= 300) process.exitCode = 1;
