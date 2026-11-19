// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jeroen van de Graaf
// Normaliza a resposta do endpoint não oficial da Caixa (formato A CONFIRMAR, ver DECISIONS.md).
const megasenaOk = (n) => Array.isArray(n) && n.length === 6 && n.every((x) => Number.isInteger(x) && x >= 1 && x <= 60) && new Set(n).size === 6;
const federalOk = (p) => Array.isArray(p) && p.length === 5 && p.every((x) => typeof x === "string" && /^[0-9]{5}$/.test(x));

export function normalizeCaixa(game, contest, j) {
  if (!j || typeof j !== "object") return null;
  if (j.numero != null && parseInt(j.numero, 10) !== contest) return null;
  const raw = j.listaDezenas || j.dezenasSorteadasOrdemSorteio || [];
  if (!Array.isArray(raw)) return null;
  const dm = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(j.dataApuracao || "");
  const drawDate = dm ? dm[3] + "-" + dm[2] + "-" + dm[1] : null;
  if (game === "megasena") {
    const numbers = raw.map((x) => parseInt(x, 10)).sort((a, b) => a - b);
    return megasenaOk(numbers) ? { game, contest, numbers, drawDate } : null;
  }
  const prizes = raw.map((x) => { let d = String(x).replace(/\D/g, ""); while (d.length > 5 && d[0] === "0") d = d.slice(1); return d.padStart(5, "0"); });
  return federalOk(prizes) ? { game, contest, prizes, drawDate } : null;
}

// LucentDraw/3 (SPEC-v3 4): concurso como texto, exatamente como pedido ("6120", "6054-2");
// Mega-Sena em ordem crescente e bilhetes da Federal como inteiros (até 6 algarismos), na ordem dos prêmios.
const federalOkV3 = (p) => Array.isArray(p) && p.length === 5 && p.every((x) => Number.isSafeInteger(x) && x >= 0 && x <= 999999);
export function normalizeCaixaV3(game, contest, j) {
  if (!j || typeof j !== "object") return null;
  if (j.numero != null && String(j.numero).trim() !== contest) return null;
  const raw = j.listaDezenas || j.dezenasSorteadasOrdemSorteio || [];
  if (!Array.isArray(raw)) return null;
  const dm = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(j.dataApuracao || "");
  const drawDate = dm ? dm[3] + "-" + dm[2] + "-" + dm[1] : null;
  if (game === "megasena") {
    const numbers = raw.map((x) => parseInt(x, 10)).sort((a, b) => a - b);
    return megasenaOk(numbers) ? { game, contest, numbers, drawDate } : null;
  }
  const prizes = raw.map((x) => { const d = String(x).trim(); return /^[0-9]{1,6}$/.test(d) ? parseInt(d, 10) : NaN; });
  return federalOkV3(prizes) ? { game, contest, prizes, drawDate } : null;
}
