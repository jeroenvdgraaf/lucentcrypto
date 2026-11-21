// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jeroen van de Graaf
// Lucent Votação: confere as provas das cédulas fora da linha principal da página (Web Worker),
// para a página não travar quando há muitas cédulas a conferir de uma vez.
import { verifyBallot } from "./core.mjs";
self.onmessage = (e) => {
  const { id, tasks } = e.data, done = [];
  tasks.forEach((t, i) => {
    done.push([t.key, verifyBallot(...t.args)]);
    if ((i + 1) % 5 === 0) self.postMessage({ id, progress: i + 1, total: tasks.length });
  });
  self.postMessage({ id, done });
};
