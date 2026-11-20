// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jeroen van de Graaf
//
// Worker do site lucentcrypto.org. Além de servir os arquivos estáticos, tem três rotas:
//
// /api/votacao/... o quadro da Lucent Votação (worker/votacao.js, um Durable Object por reunião).
//
// /api/relay/...  o relay de carimbo de tempo (relay/src/index.js, SPEC 6.2) no próprio site:
//                 POST /api/relay/v1/timestamp, POST /api/relay/v1/ots/upgrade. Recebe só o hash do lacre.
//
// /api/inmetro/..., que repassa sem alterar os pulsos do farol do Inmetro para o
// navegador quando o Inmetro não permite leitura direta (CORS). Só aceita estes caminhos:
//   /api/inmetro/pulse                      (último pulso)
//   /api/inmetro/pulse/time/<ms>            (pulso de um instante)
//   /api/inmetro/chain/<c>/pulse/<i>        (pulso por número)
// A página confere cada pulso por conta própria (outputValue = SHA-512 dos campos), então
// esta rota não pode alterar um resultado sem que a conferência falhe.
import { handle as relay } from "../relay/src/index.js";
import { handleVotacao, Sessao } from "./votacao.js";
export { Sessao };

const UPSTREAM = "https://beacon.inmetro.gov.br/beacon/2.1/";
const ALLOWED = /^\/api\/inmetro\/(pulse|pulse\/time\/\d{10,16}|chain\/\d{1,4}\/pulse\/\d{1,12})$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (url.pathname.startsWith("/api/relay/")) {
      const u = new URL(request.url);
      u.pathname = u.pathname.slice("/api/relay".length);
      return relay(new Request(u.toString(), request), env);
    }
    if (url.pathname.startsWith("/api/votacao/")) return handleVotacao(request, env);
    if (request.method !== "GET") return new Response("Método não permitido.\n", { status: 405 });
    const m = url.pathname.match(ALLOWED);
    if (!m) return new Response("Rota desconhecida.\n", { status: 404 });
    let up;
    try {
      up = await fetch(UPSTREAM + m[1], { headers: { accept: "application/json" }, cf: { cacheTtl: m[1] === "pulse" ? 0 : 300 } });
    } catch (e) {
      return new Response(JSON.stringify({ error: "Inmetro não respondeu" }), { status: 502, headers: { "content-type": "application/json" } });
    }
    return new Response(await up.text(), {
      status: up.status,
      headers: { "content-type": up.headers.get("content-type") || "application/json", "cache-control": "no-store" },
    });
  },
};
