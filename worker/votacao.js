// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jeroen van de Graaf
//
// Lucent Votação (spec/VOTACAO.md): o quadro de cada reunião é um Durable Object (classe Sessao).
//
//   GET  /api/votacao/<sessão>/eventos?desde=<n>   eventos a partir do nº n (lista pública)
//   GET  /api/votacao/<sessão>/ao-vivo             WebSocket: recebe os novos eventos assim que entram
//   POST /api/votacao/<sessão>/criar               cria a reunião (gera a metade w da chave aqui dentro)
//   POST /api/votacao/<sessão>/admin               ações do organizador, com o token de controle t
//   POST /api/votacao/<sessão>/votar               cédula, com o segredo do eleitor
//
// O Worker confere cada cédula antes de aceitá-la e só decifra os totais que ele mesmo calcula,
// de um item encerrado (seção 3). Tudo, inclusive w, é apagado no horário da seção 8.
import * as V from "../votacao/core.mjs";

const SID = /^[A-Za-z0-9_-]{22}$/;
const MAX_BODY = 64 * 1024;
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const err = (msg, status = 400) => json({ error: msg }, status);

export async function handleVotacao(request, env) {
  const url = new URL(request.url);
  const m = url.pathname.match(/^\/api\/votacao\/([^/]+)\/(eventos|ao-vivo|criar|admin|votar)$/);
  if (!m || !SID.test(m[1])) return err("Rota desconhecida.", 404);
  if (!env.SESSAO) return err("Votação indisponível neste servidor.", 503);
  const stub = env.SESSAO.get(env.SESSAO.idFromName(m[1]));
  return stub.fetch(request);
}

export class Sessao {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.state = null; this.events = null;
    ctx.blockConcurrencyWhile(async () => {
      this.table();
      this.events = ctx.storage.sql.exec("SELECT body FROM ev ORDER BY n").toArray().map((r) => JSON.parse(r.body));
      this.cache = new Map();
      this.state = this.events.length ? V.verifyBoard(this.events, this.cache) : null;
    });
  }

  async fetch(request) {
    const url = new URL(request.url), sid = url.pathname.split("/")[3], action = url.pathname.split("/")[4];
    if (action === "ao-vivo") {
      if (request.headers.get("Upgrade") !== "websocket") return err("Use WebSocket.", 426);
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (action === "eventos") {
      if (!this.events.length) return err("Reunião não encontrada (ou já apagada).", 404);
      const from = Math.max(0, parseInt(url.searchParams.get("desde") || "0", 10) || 0);
      return json({ events: this.events.slice(from), deleteAt: V.deletionTime(this.lastActivity()) });
    }
    if (request.method !== "POST") return err("Método não permitido.", 405);
    const text = await request.text();
    if (text.length > MAX_BODY) return err("Pedido grande demais.", 413);
    let body; try { body = JSON.parse(text); } catch { return err("JSON inválido."); }
    try {
      if (action === "criar") return await this.create(sid, body);
      if (!this.events.length) return err("Reunião não encontrada (ou já apagada).", 404);
      if (action === "admin") return await this.admin(body);
      if (action === "votar") return await this.vote(body);
    } catch (e) { return err(e.message || "Erro."); }
    return err("Rota desconhecida.", 404);
  }

  table() { this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS ev (n INTEGER PRIMARY KEY, body TEXT NOT NULL)"); }
  lastActivity() { const S = this.state; return S?.ended ? S.endedAt : (this.events.at(-1)?.t || Date.now()); }

  // Acrescenta eventos: confere o quadro com eles antes de gravar (nada inválido entra).
  async append(list) {
    const out = [], evs = this.events.slice();
    for (const ev of list) {
      const e = { n: evs.length + 1, t: Date.now(), ...ev };
      e.h = V.eventHash(evs.at(-1)?.h || V.ZERO_HASH, e);
      evs.push(e); out.push(e);
    }
    const st = V.verifyBoard(evs, this.cache);
    if (!st.ok) throw new Error(st.problems[0]);
    this.table();
    for (const e of out) this.ctx.storage.sql.exec("INSERT INTO ev (n, body) VALUES (?, ?)", e.n, JSON.stringify(e));
    this.events = evs; this.state = st;
    await this.ctx.storage.setAlarm(V.deletionTime(this.lastActivity()));
    const msg = JSON.stringify({ events: out });
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(msg); } catch {} }
    return out;
  }

  async create(sid, b) {
    if (this.events.length) return err("Esta reunião já existe.", 409);
    const keyMode = b.keyMode === "lucent" ? "lucent" : "dividida";
    const textOk = (s, max) => typeof s === "string" && s.trim() && new TextEncoder().encode(s).length <= max;
    if (!textOk(b.title, V.MAX_TEXT) || !textOk(b.by, V.MAX_TEXT)) return err("Título ou nome inválido.");
    if (!/^[0-9a-f]{64}$/.test(b.th || "")) return err("Token inválido.");
    if (!Array.isArray(b.voters) || b.voters.length > V.MAX_VOTERS) return err("Lista de eleitores inválida.");
    const w = V.randScalar(), W = V.mulBase(w);
    await this.ctx.storage.put("w", V.sHex(w));
    const ev = [{ type: "criada", sid, title: b.title.trim(), by: b.by.trim(), display: b.display === "digitais" ? "digitais" : "nomes", keyMode,
      A: keyMode === "dividida" ? b.A : undefined, pokA: keyMode === "dividida" ? b.pokA : undefined,
      W: V.pHex(W), pokW: V.provePok(sid, w, W), th: b.th }];
    for (const v of b.voters) ev.push(this.voterEvent(v, b.display));
    try { const out = await this.append(ev); return json({ events: out }); }
    catch (e) { await this.ctx.storage.deleteAll(); throw e; }
  }

  voterEvent(v, display) {
    const name = typeof v.name === "string" ? v.name.trim() : "";
    if (name && new TextEncoder().encode(name).length > V.MAX_TEXT) throw new Error("Nome longo demais.");
    if (typeof v.priv !== "string" || v.priv.length > 2048) throw new Error("Dados do eleitor inválidos.");
    return { type: "eleitor-incluido", i: v.i, f: v.f, name: (display ?? this.state.session.display) === "nomes" ? name || undefined : undefined, priv: v.priv };
  }

  async admin(b) {
    const S = this.state.session;
    if (typeof b.t !== "string" || V.sha256hex(b.t) !== S.th) return err("Link do organizador inválido.", 403);
    const st = this.state;
    switch (b.acao) {
      case "incluir": return json({ events: await this.append([this.voterEvent(b.voter)]) });
      case "excluir": return json({ events: await this.append([{ type: "eleitor-excluido", i: b.i }]) });
      case "abrir": {
        if (st.order.length >= V.MAX_ITEMS) return err("Limite de itens atingido.");
        if (!st.roll.size) return err("Não há eleitores.");
        return json({ events: await this.append([{ type: "item-aberto", item: st.order.length + 1, spec: b.spec, roll: [...st.roll.keys()].sort() }]) });
      }
      case "encerrar": {
        const it = st.items.get(b.item);
        if (!it || it.state !== "aberto") return err("Este item não está aberto.");
        // Totais calculados aqui, a partir do quadro; nunca se decifra um texto recebido (seção 3).
        const T = V.sumBallots(it.ballots.map((x) => x.ballot), it.spec.m);
        const w = V.sOf(await this.ctx.storage.get("w"));
        return json({ events: await this.append([{ type: "item-encerrado", item: b.item, T, dW: V.partialDecrypt(S.sid, b.item, w, S.W, T) }]) });
      }
      case "apurar": {
        const it = st.items.get(b.item);
        if (!it || it.state !== "encerrado" || S.keyMode !== "dividida") return err("Este item não está aguardando apuração.");
        if (!V.verifyPartial(S.sid, b.item, S.A, it.T, b.dA)) return err("A decifração do organizador não confere.");
        const c = V.counts(it.T, [it.dW, b.dA]);
        return json({ events: await this.append([{ type: "item-apurado", item: b.item, dA: b.dA, counts: c }]) });
      }
      case "cancelar": return json({ events: await this.append([{ type: "item-cancelado", item: b.item }]) });
      case "fim": return json({ events: await this.append([{ type: "reuniao-encerrada" }]) });
    }
    return err("Ação desconhecida.");
  }

  async vote(b) {
    const st = this.state;
    if (typeof b.s !== "string" || !/^[0-9a-f]{32}$/.test(b.s)) return err("Link de eleitor inválido.", 403);
    const f = V.fingerprint(b.s), it = st.items.get(b.item);
    if (!it || it.state !== "aberto") return err("Esta votação não está aberta.", 409);
    if (!it.roll.has(f)) return err("Seu link não está na lista desta votação.", 403);
    const prev = it.ballots.find((x) => x.f === f);
    if (prev) return json({ error: "Já há uma cédula com o seu link neste item.", at: prev.t }, 409);
    return json({ events: await this.append([{ type: "cedula", item: b.item, f, ballot: b.ballot }]) });
  }

  async alarm() {
    if (this.events.length && Date.now() < V.deletionTime(this.lastActivity()) - 1000) {
      await this.ctx.storage.setAlarm(V.deletionTime(this.lastActivity())); return;
    }
    for (const ws of this.ctx.getWebSockets()) { try { ws.close(1000, "apagada"); } catch {} }
    await this.ctx.storage.deleteAll();
    this.events = []; this.state = null; this.cache = new Map();
  }

  webSocketMessage() {}
  webSocketClose(ws, code) { try { ws.close(code, "fim"); } catch {} }
}
