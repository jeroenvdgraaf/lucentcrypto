// Gera tests/fixtures/v3_inmetro.json: um comprovante com o farol do Inmetro, feito pelo código da página,
// usando o pulso real nº 1049644 (18:33:00Z). Lacre às 18:32:30Z, então esse é o primeiro pulso após o lacre.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCore, ROOT } from "../core_loader.mjs";
const C = await loadCore();
const pulse = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "inmetro_pulse_1049644.json"), "utf8")).pulse;
const sealMs = Date.parse("2026-11-20T18:32:30.000Z");
const task = { preset: "list", options: ["Apto 101", "Apto 102", "Apto 201", "Apto 202", "Apto 301"], weights: ["1", "1", "1", "1", "1"], count: 5, replace: false };
const spec = C.buildSpecV3({ id: "vagas-2026-11-20-1532", title: "Vagas de garagem", mode: "live", contribution: "", preset: "inmetro", sealMs, task });
const commitment = await C.commitmentOf(spec);
const randomness = { inmetro: pulse };
const seed = await C.seedV3(commitment, C.sourceValues(randomness, C.V3));
const { picks } = await C.selectPicks(seed, spec.task);
const cert = { spec, commitment, sealedAt: new Date(sealMs).toISOString(), anchors: [], randomness, seed, result: picks.map((i) => task.options[i]), picks };
writeFileSync(join(ROOT, "tests", "fixtures", "v3_inmetro.json"), JSON.stringify({ cert }, null, 2) + "\n");
console.log(cert.result.join(", "), seed.slice(0, 16));
