<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright (C) 2026 Jeroen van de Graaf -->
# Lucent Sorteios — spec addition: LucentDraw/3

This document extends [`SPEC.md`](SPEC.md) (LucentDraw/2). Everything in SPEC.md still applies unless this document says otherwise. Where it says MUST, the behavior affects verification. A reference implementation of the selection rule is in [`lucentdraw3_ref.py`](lucentdraw3_ref.py), and the test vectors are in [`lucentdraw3_vectors.json`](lucentdraw3_vectors.json).

## 1. What changes

1. **One engine for everything:** a list of options with weights, from which `count` results are chosen, with or without replacement. Coin, dice, cards and the ordered list are presets of it.
2. **Weights:** exact numbers such as `3`, `0.35`, `0,35` or `1/7`.
3. **Two modes:**
   - **Verificável:** seal, beacon, proof, as in LucentDraw/2.
   - **Rápido:** local cryptographic randomness, instant, no proof.
4. **Lottery encodings fixed:** the contest identifier is text, and the drawn numbers are written as plain integers (section 4).
5. **The verifier keeps accepting LucentDraw/1 and LucentDraw/2 proofs.** New seals are always LucentDraw/3.

## 2. The sealed `spec` (MUST)

```json
{
  "v": "LucentDraw/3",
  "id": "cartas-2026-11-19-1101",
  "title": "Cartas para o jogo de sábado",
  "mode": "live",
  "contribution": "",
  "sources": { "drand": { "chain": "quicknet", "chainHash": "52db…e971", "round": 33900000 } },
  "task": {
    "preset": "cards",
    "options": ["A♠", "2♠", "…", "K♣"],
    "weights": ["1", "1", "…", "1"],
    "count": 5,
    "replace": false
  }
}
```

`v`, `id`, `title`, `mode`, `contribution` and `sources` are as in SPEC.md section 3.2. The `candidates` field is replaced by `task`:

| Field | Rule |
|---|---|
| `preset` | `"list"`, `"coin"`, `"die"` or `"cards"`. Informational for the UI; verification uses only the fields below. |
| `options` | Non-empty array of distinct, NFC-normalized, trimmed, non-empty strings. Order matters: it defines the intervals. |
| `weights` | Array of strings, same length as `options`. Grammar after trimming and replacing `,` with `.`: an integer (`3`), a decimal (`0.35`, `.5`, `2.`), or a fraction `a/b` with integers a ≥ 0, b > 0. Stored **as the user typed it**, NFC-normalized and trimmed (so `0,35` stays `0,35`); parsing happens at verification. Zero means "excluded". At least one weight must be positive. |
| `count` | Integer ≥ 1. Without replacement, `count` ≤ number of options with positive weight. |
| `replace` | `true`: each result is independent (coins, dice). `false`: a chosen option is removed before the next pick (cards, lists, ordering). |

### Presets (what the UI fills in)

| Preset | Options | Weights | Replace | Notes |
|---|---|---|---|---|
| `coin` | `["Cara", "Coroa"]` | `["1", "1"]` | true | count = number of tosses |
| `die` | `["1", …, "N"]`, N ∈ {4, 6, 8, 10, 12, 20}, default 6 | all `"1"` | true | count = number of dice; weights editable as "dado viciado" under Detalhes |
| `cards` | 52 cards in this exact order: suits ♠ ♥ ♦ ♣, each A 2 3 4 5 6 7 8 9 10 J Q K; written rank + suit, e.g. `"10♥"` | all `"1"` | false | count = cards dealt, max 52; count 52 = shuffle the deck |
| `list` | user's list, default 8 rows "Opção 1" … "Opção 8" | user's, default `"1"` | user's choice; default false | "Ordenar todos" sets count = number of positive-weight options, replace false: that is the LucentDraw/2 list draw, now with weights |

## 3. Computing the result (MUST)

```
C    = SHA-256( canonicalJSON(spec) )                         (as in SPEC.md 3.1)
seed = SHA-256( "LucentDraw/3\nseed\n" + C + "\n"
                + "eth=" + (value or "-") + "\n" + "drand=" + … + "\n" + "megasena=" + … + "\n" + "federal=" + … )
```

Same as LucentDraw/2 section 5, with the label `LucentDraw/3`.

**Integer weights:** parse each weight to an exact fraction nᵢ/dᵢ (reduced or not, it doesn't matter), let L = lcm of all dᵢ, and set wᵢ = nᵢ · (L / dᵢ). Example: `["3", "0,35", "1/7", "0"]` → L = 140 → `[420, 49, 20, 0]`, total 489.

**Selection,** for j = 0, 1, …, count − 1:

1. `alive` = the indices with wᵢ > 0 not yet removed, in the order of `options`; W = sum of their weights.
2. r = the integer value of SHA-256( "LucentDraw/3\npick\n" + seed + "\n" + j ), with j in decimal; the hash is read as a 256-bit big-endian integer.
3. x = ⌊ r · W / 2²⁵⁶ ⌋, which lies in [0, W).
4. Walk through `alive`, adding up weights; the first index whose running sum exceeds x is result j.
5. If `replace` is false, remove that index from `alive`.

The result is the list of chosen options, in pick order. Integer arithmetic only: Python `int`, JavaScript `BigInt`. No floating point anywhere in this rule. The bias of step 3 is below W / 2²⁵⁶, negligible for any realistic W.

**Why this rule:** it is exactly "divide [0, 2²⁵⁶) into intervals proportional to the weights and see where the hash lands", applied once per pick with a fresh hash. The UI SHOULD show it that way (section 6).

## 4. Lottery values (MUST, LucentDraw/3 only)

Checking current Caixa practice showed two problems with the LucentDraw/2 encoding: Loteria Federal tickets are published with six digits, and contest identifiers can carry a suffix ("6054-2" for a moved draw).

- `sources.megasena.contest` and `sources.federal.contest` are **strings**, exactly as Caixa publishes them (`"3001"`, `"6054-2"`).
- **Value strings:** `"<contest>:" + numbers joined by "-"`, each number written as a **plain decimal integer without leading zeros**.
  - Mega-Sena: the six numbers in ascending order, e.g. `"3001:4-12-23-35-41-58"`.
  - Loteria Federal: the five prizes in prize order (1st to 5th), e.g. `"6120:17469-81210-7767-41317-79412"`.
- **No draw calendar (owner decision, 2026-11-19).** Draw days and times change (Federal on Wednesday 20:00 and Sunday 11:00 in 2026, Mega-Sena with extra draws and delays of hours), so the app keeps no calendar and suggests neither a contest nor a date. This replaces the calendar and contest suggestion of SPEC.md 4.5.
  - The operator types the contest identifier as shown on Caixa's site, next to a link to `https://loterias.caixa.gov.br` and the hint: "Use o número do PRÓXIMO concurso, anunciado no site da Caixa. Um concurso já sorteado não serve: o resultado já seria conhecido."
  - At seal time, if Caixa or the relay already returns a result for that contest, the app refuses to seal ("Este concurso já foi sorteado"). This is best effort only; the timing check of section 7 is the real protection.
  - No countdown for lottery sources. Because no draw time is known, the "lottery + drand" presets of SPEC.md 4.6 are not offered (the drand round must follow the draw); the verifier still accepts such proofs.
- **Evidence (MUST):** `randomness.megasena` = `{ "contest", "numbers": [int × 6], "drawDate": "YYYY-MM-DD", "source" }`, `randomness.federal` = `{ "contest", "prizes": [int × 5, each 0–999999], "drawDate", "source" }`, with `contest` equal to the sealed string. `drawDate` is the official draw date, from the Caixa / relay result or typed by the operator with the numbers in manual mode (`"source": "manual"`).

## 5. Modes

### 5.1 Verificável (default when on a web address)
Exactly the LucentDraw/2 flow: prepare, seal (the whole `spec`, including `task`), wait for the sources, compute, proof and ata. Live presets as in SPEC.md 4.6. The proof gains `result` (the chosen options) and `picks` (their indices); the LucentDraw/2 field `order` is not used in v3.

### 5.2 Rápido
- seed = 32 bytes from `crypto.getRandomValues`, as lowercase hex; then the selection rule of section 3, with the same code.
- If the operator types a semente própria, seed = SHA-256("LucentDraw/3\nown\n" + canonical value) as in 5.3 (no format check needed, no label), so the result equals the verifiable one.
- **No seal, no proof, no ata.** The result screen says plainly: "Modo rápido: resultado instantâneo, mas ninguém pode conferir depois. Para um sorteio que vale perante outras pessoas, use o modo verificável."
- Works offline, and from a local file.
- Optionally shows the seed under Detalhes técnicos.

### 5.3 Semente própria (source `own`)

A seed the participants agreed on beforehand: the result of a past or present lottery contest, dice thrown in the room, any text. Nothing to wait for. On the free page it is the first and default source; the scheduled lottery mode (`megasena`/`federal` as sources) is no longer offered there, but proofs that use it still verify.

**Sealed spec:** `sources = { "own": { "format": "megasena" | "federal" | "outro", "label": "<normalized text>" } }`. `own` is the only source (MUST NOT be combined). For `megasena`/`federal` the UI builds the label as "Mega-Sena, concurso N" / "Loteria Federal, concurso N"; for `outro` the operator types it (required in the verifiable mode). `mode` is `"live"`, `contribution` is `""`.

**Canonical reading (MUST, identical in HTML and Python):**

1. Unicode NFKD, then remove every combining mark (general category M): accents disappear ("maçã" → "maca", "nº" → "no").
2. Every remaining character must be in U+0020–U+007E, TAB, LF or CR; otherwise refuse (e.g. emoji).
3. Uppercase (ASCII). The pieces are the maximal runs of `A–Z0–9`; everything else only separates (space, hyphen, comma, full stop, slash, line break…). A piece made only of digits loses its leading zeros ("007" → "7", "000" → "0"). No pieces: refuse.
4. If every piece is a number, sort ascending numerically (by length, then lexicographically); reading = `"int"`. Example: `" 33 05-12\n58 047 41 "` → `5-12-33-41-47-58`.
5. Otherwise keep the pieces in the typed order; reading = `"text"`. "ana, gato" and "Ána  Gato." → `ANA-GATO`, but "gato ana" → `GATO-ANA`. Numbers among words stay where they are: "Quina 06612" → `QUINA-6612`.
6. value = the pieces joined with "-".

**Input (UI only, does not change the value):** the three formats have separate fields. The Mega-Sena and Federal fields accept only digits and separators (space, hyphen, comma, semicolon, full stop); in the Federal field the full stop is a thousands separator ("12.345" = 12345). The typed numbers are then read with the canonical rule above, so the stored value is the same as in the free field.

**Format checks:** `megasena`: reading int, exactly 6 distinct numbers, each 1–60. `federal`: reading int, exactly 5 numbers, each at most 6 digits (0–999999). `outro`: none.

**Randomness and seed:** `randomness.own = { "value": <canonical>, "reading": "int" | "text" }` and

```
seed = SHA-256( "LucentDraw/3\nown\n" + value )
```

The seed does **not** depend on C (title, ID, time): the result depends only on the task (options in their order, weights, count, replace) and the canonical seed. So the rápido mode with the same seed gives the same result, anyone can reproduce it, and the organizer has no free field to retry. No timestamp is requested: with a seed that may already be public it would prove nothing.

**Verification:** `value` must equal its own canonical reading with the same `reading`, and pass the format check; otherwise FAIL. The origin of the seed cannot be checked automatically, so check `own` is UNVERIFIED and there is no timing check. If it is the only open item, verdict `incompleto` (exit code 2) with the message "Confere, desde que a lista (nesta ordem) e a semente (<label>) tenham sido combinadas antes. As contas estão certas; confira a semente na fonte indicada."

**What remains a matter of trust:** if the list, its order or the seed's source was settled after the seed was known, the organizer could have arranged the outcome. The proof says so; no page can prevent it.

### 5.4 Farol do Inmetro (source `inmetro`)

The randomness beacon of Inmetro, the Brazilian federal metrology institute (beacon.inmetro.gov.br), in the NIST format (NISTIR 8213, version 2.1): one pulse per minute, hash-chained, signed, each committing in advance to the next. A judge can follow it: "a lista foi lacrada às 14:03:21; o resultado veio do número que o Inmetro publicou às 14:04".

**Sealed spec:** `sources = { "inmetro": { "chain": 2, "rule": "first-pulse-after", "notBefore": <ms> } }`. `inmetro` is the only source (MUST NOT be combined). `notBefore` is the seal time plus 15 seconds, in milliseconds (the margin lets the seal's timestamps arrive before the pulse's minute, so the timing check can pass); `chain` is Inmetro's chain index at sealing time.

**Which pulse:** the first pulse of that chain with `timeStamp` strictly after `notBefore`. Pulses fall on whole minutes, so normally it is the minute T = ⌊notBefore / 60000⌋ · 60000 + 60000. If Inmetro had no pulse at T, the next existing pulse counts.

**Randomness:** `randomness.inmetro` is the complete pulse object exactly as published (uri, version, cipherSuite, period, certificateId, chainIndex, pulseIndex, timeStamp, localRandomValue, external, listValues, precommitmentValue, statusCode, signatureValue, outputValue). The proof is therefore self-contained.

**Seed:** as in section 4, with one extra final line only when this source is used:

```
seed = SHA-256( "LucentDraw/3\nseed\n" + C + "\neth=…\ndrand=…\nmegasena=…\nfederal=…" + "\ninmetro=" + outputValue )
```

(the four standard lines are `-` here, as always for unused sources). Proofs without `inmetro` are unchanged.

**Integrity (MUST, offline):** `outputValue` = SHA-512 of the NIST serialization: uri, version (UTF-8, 4-byte length prefix); cipherSuite, period (uint32); certificateId (bytes, 4-byte length prefix); chainIndex, pulseIndex (uint64); timeStamp (UTF-8, prefixed); localRandomValue, external.sourceId (bytes, prefixed); external.statusCode (uint32); external.value; listValues previous, hour, day, month, year (bytes, prefixed, in that order); precommitmentValue (bytes, prefixed); statusCode (uint32); signatureValue (bytes, prefixed). All big-endian. Checked against Inmetro's pulse nº 1049644 (2026-11-20T18:33:00Z).

**Verification:** FAIL if the pulse is not intact, is from another chain, or is not after `notBefore`. With network access the verifier fetches the same pulse from Inmetro by number (`/beacon/2.1/chain/<c>/pulse/<i>`) and compares `outputValue`; if the pulse is not at T, it also asks Inmetro whether a pulse exists at T (then FAIL: not the first). Without network the check is UNVERIFIED and the verdict `incompleto`, as for Ethereum. The pulse signature will be checked once Inmetro publishes the certificate for `certificateId`. The timing check (seal timestamp before the pulse) is the same as for Ethereum and drand.

**Timestamps:** on lucentcrypto.org the relay of SPEC 6.2 runs inside the site's own Worker at `/api/relay` (worker/index.js imports relay/src/index.js), so every verifiable draw gets RFC 3161 timestamps (FreeTSA and DigiCert) without configuration. OpenTimestamps is not requested there: its Bitcoin anchor takes hours and adds nothing to proving the moment of sealing; proofs that carry an `ots` anchor still verify. The Python verifier ships FreeTSA's root CA in `verifier/tsa-ca/` (FreeTSA is not in the system trust lists) and also uses the system list (DigiCert). A relay address typed in "Detalhes técnicos" still takes precedence.

**Fetching from the browser:** directly from beacon.inmetro.gov.br; if the browser blocks it (CORS), through the site's own route `/api/inmetro/…` (worker/index.js), which accepts only the three pulse paths above and passes the response through unchanged. Trust does not depend on that route: every pulse is checked by its `outputValue`.

## 6. Interface (pt-BR)

- **Tabs at the top:** **Lista · Moeda · Dado · Cartas**. The Lista tab replaces the current participant list: each row has an option and a weight (default 1), with a choice between "Ordenar todos" and "Escolher N".
- **Mode switch:** **Verificável / Rápido**, next to the tabs. In Rápido, the seal and source settings are hidden.
- **Dado:** face selector 4 · 6 · 8 · 10 · 12 · 20 (default 6) and number of dice. **Cartas:** number of cards (1–52); 52 is labeled "embaralhar o baralho". **Moeda:** number of tosses.
- **Weights:** the list shows each option's share as a percentage, computed exactly from the integer weights. Invalid weights are marked in red with an explanation; `0` grays out the row ("fora do sorteio").
- **The interval bar (key visual):** a horizontal bar for [0, 2²⁵⁶), split into segments proportional to the weights, each labeled. For each pick, a needle at x/W shows where the hash landed. Without replacement, show one bar per pick, the chosen segment removed from the next. More than about 20 options: show the needle and the selected segment's label only; tiny segments may be thinner than a pixel, which is fine.
- **Result visuals:** a coin face (Cara/Coroa), dice drawn with pips for d6 and the number on a polygon for the others, playing cards with rank and suit (red for ♥ ♦). Animate only after the result is known. While waiting for a beacon, show the countdown, never a spinning coin or rolling dice.
- Everything else (seal panel, status, proof, ata, verify tab) as in LucentDraw/2, adapted to show `result`.

## 7. Verification (MUST, HTML and Python)

As SPEC.md section 9, with these changes for `v: "LucentDraw/3"`:
- **Well-formed:** check every `task` rule in section 2, including the weight grammar.
- **Values:** lottery values use the section 4 encoding.
- **Result:** recompute seed and picks; `result` and `picks` must equal the proof's.
- **Display:** show the weights as typed, the integer weights and W, so a reader can follow the arithmetic.
- **Lottery timing (MUST, all versions, owner decision):** for each `megasena` / `federal` source, a separate check compares the earliest valid anchor time with the **start of the draw day**, 00:00 in America/Sao_Paulo (UTC−3), of the draw date: the official one when the verifier fetched the result, otherwise the proof's `drawDate`. Earliest anchor before that instant: *passou*; at or after: *falhou*. No anchors: *não verificado*, and the detail shows the operator's `sealedAt` claim next to the draw date so a person can judge. No valid draw date: *não verificado*. The general timing check of SPEC.md 6.4 then covers only `eth` and `drand`.

## 8. Test vectors (MUST pass in HTML and Python)

The full vectors, including the canonical JSON of each spec, are in `lucentdraw3_vectors.json`. Source values are invented for testing.

| # | Case | W | Result | C (first 12 hex) |
|---|---|---|---|---|
| 1 | coin, 3 tosses, drand | 2 | Cara, Coroa, Coroa | 327d428b5c55 |
| 2 | 2 dice of 20 faces, drand | 20 | 18, 8 | 970fa2b3932a |
| 3 | 5 cards without replacement, drand | 52 | 7♦, 6♦, A♣, 9♠, 5♥ | a0ec97f49b03 |
| 4 | list, weights 3 · 0,35 · 1/7 · 0, pick 1, eth | 489 | Bruno | 13842746d38d |
| 5 | list, weights 1 · 1 · 2 · 1 · 1/2, order all, Loteria Federal | 11 | Apto 202, Apto 201, Apto 101, Apto 102, Apto 301 | 64496148ed57 |

The weights of vector 4 convert to integers [420, 49, 20, 0]. A 200,000-sample run of the reference rule matched the expected shares (85.9 %, 10.0 %, 4.1 %, 0 %).

## 9. Site layout (product guidance)

One repository and one Cloudflare Pages project, with separate pages:
- `/` — a short home page for LucentCrypto in Portuguese, linking to the two products;
- `/sorteios/` — Lucent Sorteios (this spec);
- `/amigo-oculto/` — Lucent Amigo Oculto, the existing page unchanged, except that its footer links to `/sorteios/`.

A build script produces `dist/` with that structure, so the Cloudflare build command is a single line.
