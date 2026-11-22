// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jeroen van de Graaf
//
// Cruzamento de listas (LucentPSI/1, spec/CRUZAMENTO.md): interseção privada de conjuntos (PSI) pelo
// método clássico de Diffie–Hellman, em ristretto255. Cada lado cega os seus itens com um segredo k,
// troca, cega de novo o que recebeu e compara: k_A·k_B·H(x) é o mesmo dos dois lados.
import { RistrettoPoint as P, ed25519, sha256, sha512 } from "../votacao/vendor/noble.mjs";

export const VERSION = "LucentPSI/1";
export const MAX_ITEMS = 500; // por lado, nesta demonstração
export const L = ed25519.CURVE.n;
const te = new TextEncoder();
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const bytesToInt = (b) => b.reduce((n, x) => (n << 8n) | BigInt(x), 0n);
export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

// ---- normalização (perfil combinado entre os dois lados)
export const PROFILES = ["cpf", "cnpj", "email", "telefone", "nome"];
const digitsOf = (s) => String(s).replace(/\D/g, "");
const cpfCheck = (d) => {
  const dv = (n) => { let s = 0; for (let i = 0; i < n; i++) s += +d[i] * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === +d[9] && dv(10) === +d[10];
};
const cnpjCheck = (d) => {
  const dv = (n) => { const w = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; let s = 0; for (let i = 0; i < n; i++) s += +d[i] * w[i]; const r = s % 11; return r < 2 ? 0 : 11 - r; };
  return dv(12) === +d[12] && dv(13) === +d[13];
};
// Os dois dígitos verificadores de um CPF a partir dos 9 primeiros.
export function cpfComplete(nine) {
  const d = String(nine).padStart(9, "0").split("").map(Number);
  for (const n of [9, 10]) { let s = 0; for (let i = 0; i < n; i++) s += d[i] * (n + 1 - i); const r = (s * 10) % 11; d.push(r === 10 ? 0 : r); }
  return d.join("");
}
export const fmtCpf = (d) => d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
// { key } com o identificador normalizado, ou { error } com o motivo (código curto, traduzido na página).
export function normalize(profile, raw) {
  const s = String(raw ?? "").normalize("NFKC").trim();
  if (!s) return { error: "vazio" };
  switch (profile) {
    case "cpf": { const d = digitsOf(s); if (d.length !== 11 || /^(\d)\1{10}$/.test(d) || !cpfCheck(d)) return { error: "cpf" }; return { key: d }; }
    case "cnpj": { const d = digitsOf(s); if (d.length !== 14 || /^(\d)\1{13}$/.test(d) || !cnpjCheck(d)) return { error: "cnpj" }; return { key: d }; }
    case "email": { const e = s.toLowerCase().replace(/\s+/g, ""); if (!/^[^@]+@[^@]+\.[^@]+$/.test(e)) return { error: "email" }; return { key: e }; }
    case "telefone": { const d = digitsOf(s); if (d.length < 10 || d.length > 15) return { error: "telefone" }; return { key: s.startsWith("+") || d.length > 11 ? d : "55" + d }; }
    case "nome": { const n = s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(); if (!n) return { error: "nome" }; return { key: n }; }
  }
  return { error: "perfil" };
}
// Lê uma lista colada: uma linha por item; "rótulo; identificador" ou só o identificador (a última coluna).
// O rótulo fica só neste aparelho (para mostrar o resultado); só o identificador entra no protocolo.
export function parseItems(profile, text) {
  const items = [], errors = [], seen = new Set();
  String(text || "").split(/\r?\n/).forEach((line, n) => {
    if (!line.trim()) return;
    const parts = line.split(/[;\t]|,(?=[^,]*$)/).map((x) => x.trim()).filter(Boolean);
    const id = parts.length > 1 ? parts[parts.length - 1] : parts[0], label = parts.length > 1 ? parts.slice(0, -1).join(" · ") : "";
    const r = normalize(profile, id);
    if (r.error) { if (n === 0 && profile !== "nome") return; errors.push({ line: n + 1, error: r.error, text: line.trim() }); return; } // 1ª linha: talvez cabeçalho
    if (seen.has(r.key)) { errors.push({ line: n + 1, error: "repetido", text: line.trim() }); return; }
    seen.add(r.key); items.push({ key: r.key, label: label || id, raw: id });
  });
  return { items, errors };
}

// ---- protocolo
const wrap = (sid, profile, key) => cat(te.encode(VERSION), new Uint8Array([0]), te.encode(sid), new Uint8Array([0]), te.encode(profile), new Uint8Array([0]), te.encode(key));
// H(x): ristretto255 a partir de 64 bytes uniformes (RFC 9496, 4.3.4), com a sessão e o perfil no hash.
export const hashToPoint = (sid, profile, key) => P.hashToCurve(sha512(wrap(sid, profile, key)));
export function randScalar() { for (;;) { const b = crypto.getRandomValues(new Uint8Array(64)); const k = bytesToInt(b) % L; if (k) return k; } }
export const blind = (k, pHex) => P.fromHex(pHex).multiply(k).toHex();
// Passo 1: cada lado calcula k·H(x) para cada item e embaralha a ordem (para não revelar a ordem da lista).
export function firstPass(sid, profile, k, items, shuffle = shuffled) {
  const out = items.map((it, i) => ({ i, v: hashToPoint(sid, profile, it.key).multiply(k).toHex() }));
  return shuffle(out);
}
// Passo 2: quem recebe cega de novo cada valor; no modo "tamanho", embaralha antes de devolver.
export function secondPass(k, received, { keepOrder = true, shuffle = shuffled } = {}) {
  const out = received.map((v) => blind(k, v));
  return keepOrder ? out : shuffle(out);
}
// Comparação: os meus valores duplamente cegados (na ordem que mandei) contra os do outro lado.
// Devolve os índices (na lista original) dos meus itens que estão na interseção, ou só a contagem.
export function compare(mineSent, mineBack, theirsDouble, { onlyCount = false } = {}) {
  const set = new Set(theirsDouble);
  if (onlyCount) return { count: mineBack.filter((v) => set.has(v)).length };
  const hits = []; mineBack.forEach((v, j) => { if (set.has(v)) hits.push(mineSent[j].i); });
  return { count: hits.length, hits: hits.sort((a, b) => a - b) };
}
export function shuffled(a) {
  const o = a.slice();
  for (let i = o.length - 1; i > 0; i--) { const r = new Uint32Array(1); crypto.getRandomValues(r); const j = r[0] % (i + 1); [o[i], o[j]] = [o[j], o[i]]; }
  return o;
}
// O protocolo inteiro, entre dois lados na mesma página (o modo de simulação).
export function run(sid, profile, A, B, { onlyCount = false, kA = randScalar(), kB = randScalar() } = {}) {
  const a1 = firstPass(sid, profile, kA, A), b1 = firstPass(sid, profile, kB, B);
  const a2 = secondPass(kB, a1.map((x) => x.v), { keepOrder: !onlyCount }); // B cega o que A mandou e devolve
  const b2 = secondPass(kA, b1.map((x) => x.v), { keepOrder: !onlyCount }); // A cega o que B mandou e devolve
  return { kA, kB, a1, b1, a2, b2, resA: compare(a1, a2, b2, { onlyCount }), resB: compare(b1, b2, a2, { onlyCount }) };
}

// ---- por que não basta trocar hashes: SHA-256 de um CPF (só os 11 dígitos), e a busca exaustiva
export const cpfHash = (d) => hex(sha256(te.encode(d)));
// Procura, entre os CPFs que começam com `prefix`, o que tem este SHA-256. Em blocos, para a página não travar.
export async function crackCpf(target, prefix, onProgress = () => {}) {
  const free = 9 - prefix.length, total = 10 ** free, base = +prefix * total;
  const t0 = performance.now();
  for (let i = 0; i < total; i++) {
    const d = cpfComplete(String(base + i).padStart(9, "0"));
    if (cpfHash(d) === target) return { cpf: d, tried: i + 1, ms: performance.now() - t0 };
    if ((i & 0x3fff) === 0x3fff) { onProgress(i + 1, total); await new Promise((r) => setTimeout(r, 0)); }
  }
  return { cpf: null, tried: total, ms: performance.now() - t0 };
}
