// Gera tests/fixtures/v3_own.json: comprovantes com semente própria, feitos pelo código da página.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCore, ROOT } from "../core_loader.mjs";
const C = await loadCore();
const task = { preset: "list", options: ["Apto 101", "Apto 102", "Apto 201", "Apto 202", "Apto 301"], weights: ["1", "1", "2", "1", "0,5"], count: 5, replace: false };
async function make(id, format, label, typed) {
  const c = C.canonOwnSeed(typed);
  const spec = C.buildSpecV3({ id, title: "Vagas de garagem", mode: "live", contribution: "", preset: "own", sealMs: 0, task, own: { format, label } });
  const seed = await C.seedOwn(c.value);
  const { picks } = await C.selectPicks(seed, spec.task);
  return { typed, cert: { spec, commitment: await C.commitmentOf(spec), sealedAt: "2026-11-19T18:00:00Z", anchors: [], randomness: { own: { value: c.value, reading: c.reading } }, seed, result: picks.map((i) => task.options[i]), picks } };
}
const cases = [
  await make("own-mega", "megasena", "Mega-Sena, concurso 2890", " 33 05-12\n58 047 41 "),
  await make("own-text", "outro", "Combinado na assembleia", "Assembleia de 19/11, ata nº 7"),
];
writeFileSync(join(ROOT, "tests", "fixtures", "v3_own.json"), JSON.stringify({ cases }, null, 2) + "\n");
console.log(cases.map((x) => x.cert.randomness.own.value + " -> " + x.cert.result.join(", ")).join("\n"));
