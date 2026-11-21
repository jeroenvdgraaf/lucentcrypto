// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Jeroen van de Graaf
// Comprovantes LucentDraw/3 de teste e o arquivo de comparação entre implementações.
// Os comprovantes são feitos pelo núcleo do próprio LucentSorteios.html; tokens RFC 3161 da TSA de TESTE;
// rodadas drand de drand_test_beacons.json (chave de TESTE). Todos os valores são FALSOS.
//   node tests/tools/gen_fixtures_v3.mjs          (acrescenta ao world.json existente)
// Também é chamado por gen_fixtures.mjs, que regera tudo.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCore, ROOT } from "../core_loader.mjs";
import { timeStampRequest } from "../../relay/src/der.js";
import { tsaReply } from "./tsa_reply.mjs";

const FIX = join(ROOT, "tests", "fixtures");
const h = (s) => createHash("sha256").update(s).digest("hex");

export async function addV3(world, C) {
  const beacons = JSON.parse(readFileSync(join(FIX, "drand_test_beacons.json"), "utf8"));
  const beacon = (r) => beacons.beacons.find((x) => x.round === r);
  const drandEv = (r) => ({ round: r, randomness: beacon(r).randomness, signature: beacon(r).signature });
  const rfc = (commitment) => C.anchorsFromRelay({ rfc3161: ["https://tsa-test-a.example/tsr"].map((tsa) => ({ tsa, token: tsaReply(timeStampRequest(C.hexToBytes(commitment), new Uint8Array(8).fill(3))).toString("base64") })) }, commitment).anchors;

  // Rede simulada: blocos e resultados no futuro (2027), depois do horário dos carimbos de teste.
  const addBlock = (number, timestamp) => (world.eth.blocks[number] = { number, hash: h("block " + number), timestamp });
  addBlock(25000000, 1812800003); addBlock(24999999, 1812799991);
  world.eth.head = Math.max(world.eth.head, 25000060);
  world.lottery["federal/6120"] = { game: "federal", contest: "6120", prizes: [17469, 81210, 7767, 41317, 79412], drawDate: "2027-01-20" };
  world.lottery["megasena/3010-2"] = { game: "megasena", contest: "3010-2", numbers: [1, 7, 13, 22, 48, 60], drawDate: "2027-01-21" };
  const ethEv = (n) => ({ number: n, hash: world.eth.blocks[n].hash, timestamp: world.eth.blocks[n].timestamp, parentTimestamp: world.eth.blocks[n - 1].timestamp, confirmations: 1 });

  async function finish(spec, sealedAt, randomness, anchors) {
    const commitment = await C.commitmentOf(spec);
    const state = { spec, commitment, sealedAt, anchors: anchors ? rfc(commitment) : [], randomness };
    if (Object.keys(randomness).length) {
      state.seed = await C.seedV3(commitment, C.sourceValues(randomness, C.V3));
      state.picks = (await C.selectPicks(state.seed, spec.task)).picks;
      state.result = state.picks.map((i) => spec.task.options[i]);
    }
    return C.certificateOf(state);
  }
  const base = (id, title, mode, sources, task) => ({ v: C.V3, id, title, mode, contribution: "", sources, task });
  const drandSrc = (round) => ({ drand: { chain: "quicknet", chainHash: C.QUICKNET.hash, round } });
  const certs = {};
  certs["v3-live-drand-cards"] = await finish(base("cartas-teste", "Cartas para o jogo de sábado", "live", drandSrc(40000000), C.presetTask("cards", { count: 5 })),
    "2027-06-14T10:00:00.000Z", { drand: drandEv(40000000) }, true);
  certs["v3-live-eth-weights"] = await finish(base("pesos-teste", "Brinde com pesos", "live",
    { eth: { chain: "ethereum-mainnet", rule: "first-block-after", notBefore: 1812800000, confirmations: 1 } },
    C.presetTask("list", { options: ["Ana", "Bruno", "Célia", "Davi"], weights: ["3", "0,35", "1/7", "0"], count: 1 })),
    "2027-06-12T13:33:20.000Z", { eth: ethEv(25000000) }, true);
  certs["v3-scheduled-federal-order"] = await finish(base("ordem-federal-teste", "Ordem das vagas", "scheduled", { federal: { contest: "6120" } },
    C.presetTask("list", { options: ["Apto 101", "Apto 102", "Apto 201", "Apto 202", "Apto 301"], weights: ["1", "1", "2", "1", "1/2"], count: 5 })),
    "2027-01-18T12:00:00.000Z", { federal: { contest: "6120", prizes: [17469, 81210, 7767, 41317, 79412], drawDate: "2027-01-20", source: "caixa-api" } }, true);
  certs["v3-scheduled-megasena-dice-manual"] = await finish(base("dados-mega-teste", "", "scheduled", { megasena: { contest: "3010-2" } },
    C.presetTask("die", { count: 2, faces: 20 })),
    "2027-01-19T12:00:00.000Z", { megasena: { contest: "3010-2", numbers: [1, 7, 13, 22, 48, 60], drawDate: "2027-01-21", source: "manual" } }, false);
  certs["v3-seal-only-coin"] = await finish(base("moeda-lacre", "", "live", drandSrc(40000000), C.presetTask("coin", { count: 3 })),
    "2027-06-14T10:00:00.000Z", {}, false);

  mkdirSync(join(FIX, "certificates"), { recursive: true });
  for (const [name, cert] of Object.entries(certs)) writeFileSync(join(FIX, "certificates", name + ".json"), JSON.stringify(cert, null, 2) + "\n");

  // Comparação entre implementações: tarefas aleatórias (gerador determinístico) resolvidas pelo núcleo do HTML.
  let s = 0x2545f491;
  const rnd = (n) => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s % n; };
  const weightForms = () => {
    const k = rnd(7);
    if (k === 0) return "0";
    if (k === 1) return String(1 + rnd(9));
    if (k === 2) return rnd(3) + "," + String(rnd(1000)).padStart(1 + rnd(3), "0");
    if (k === 3) return "." + (1 + rnd(99));
    if (k === 4) return (1 + rnd(20)) + ".";
    if (k === 5) return rnd(5) + "/" + (1 + rnd(30));
    return (1 + rnd(3)) + " / " + (1 + rnd(12));
  };
  const cases = [];
  for (let c = 0; c < 60; c++) {
    const n = 1 + rnd(30), options = Array.from({ length: n }, (_, i) => "Opção " + (i + 1));
    let weights = options.map(weightForms);
    if (!weights.some((w) => C.parseWeight(w).n > 0n)) weights[rnd(n)] = "1";
    const positive = weights.filter((w) => C.parseWeight(w).n > 0n).length;
    const replace = rnd(2) === 1, count = replace ? 1 + rnd(40) : 1 + rnd(positive);
    const task = { preset: "list", options, weights, count, replace };
    if (C.validateTask(task).length) throw new Error("tarefa inválida gerada: " + C.validateTask(task).join("; "));
    const seed = h("cross " + c);
    const { picks, ints } = await C.selectPicks(seed, task);
    cases.push({ task, seed, ints: ints.map(String), picks });
  }
  writeFileSync(join(FIX, "v3_cross.json"), JSON.stringify({ note: "Tarefas aleatórias resolvidas pelo núcleo do LucentSorteios.html; o verify_draw.py e a referência devem concordar.", cases }, null, 1) + "\n");
  return Object.keys(certs);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const C = await loadCore();
  const world = JSON.parse(readFileSync(join(FIX, "world.json"), "utf8"));
  const names = await addV3(world, C);
  writeFileSync(join(FIX, "world.json"), JSON.stringify(world, null, 2) + "\n");
  console.log("fixtures v3:", names.join(", "));
}
