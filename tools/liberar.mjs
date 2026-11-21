// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jeroen van de Graaf
//
// Emite códigos de liberação da Lucent Votação (mais de 20 participantes, até 100).
//
//   Uma vez: criar a chave e guardá-la como segredo do Worker na Cloudflare
//     node tools/liberar.mjs --nova-chave
//     → copie a chave; no painel da Cloudflare: Workers → lucentcrypto → Settings → Variables and Secrets
//       → Add → tipo Secret, nome LIBERACAO_KEY, valor = a chave. (Ou: npx wrangler secret put LIBERACAO_KEY)
//
//   Cada pedido: emitir um código (limite e último dia de validade, horário de Brasília)
//     LIBERACAO_KEY=<a chave> node tools/liberar.mjs 50 2026-12-31
//
// A chave nunca vai para o GitHub. O código não aparece no quadro: lá fica só o limite.
import * as V from "../votacao/core.mjs";

const args = process.argv.slice(2);
if (args[0] === "--nova-chave") {
  console.log(V.hex(V.randBytes(32)));
  process.exit(0);
}
const key = process.env.LIBERACAO_KEY || "";
const [limit, until] = [parseInt(args[0], 10), args[1]];
if (!/^[0-9a-f]{64}$/.test(key) || !limit || !until) {
  console.error("Uso: LIBERACAO_KEY=<chave de 64 dígitos hex> node tools/liberar.mjs <limite 21–100> <AAAA-MM-DD>\n     node tools/liberar.mjs --nova-chave");
  process.exit(1);
}
try {
  const code = V.makeRelease(key, limit, until);
  const ok = V.checkRelease(key, code);
  console.log(code);
  console.error("Até " + ok.limit + " participantes, válido até " + ok.until + " (inclusive).");
} catch (e) { console.error(e.message); process.exit(1); }
