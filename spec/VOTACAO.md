<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright (C) 2026 Jeroen van de Graaf -->
# Lucent Votação — spec (draft, LucentVote/1)

A teaser for a larger voting application: secret ballots during **one meeting**, online or in person, with at most **50 voters**. The person running the meeting (the **admin**, usually the president) opens items one at a time, improvising as needed; voters vote from a personal link on their phone; a public **board** on our Worker holds the encrypted ballots; the result of each item is decrypted only as a total. Where this document says MUST, the behavior affects verification or privacy.

Interface language is Portuguese; terms in *italics* are the interface words.

## 1. Roles and links

| Role | Link | Can |
|---|---|---|
| Admin | `/votacao/#s=<sessão>&a=<segredo do admin>` | add or remove voters, open, close and cancel items, end the session; holds half of the key |
| Voter | `/votacao/#s=<sessão>&v=<segredo do eleitor>` | vote once on each open item for which they are on the frozen roll; see results |
| Board (*quadro*) | `/votacao/#s=<sessão>` | read only: at the top, large, the current item and how many have voted (or the latest result); below, all results, everything on the board, verified in the browser; download the *ata*. *Tela cheia* shows only the top block, for projecting (`&tela` opens it that way) |

- `sessão`: 16 random bytes, base64url. Knowing it lets you read the board; it does not let you vote.
- Everything after `#` stays in the browser, as in Segredo; the page sends to the Worker only what each request needs.

**The admin link is everything.** From the admin secret `m` (32 random bytes) the page derives, with HMAC-SHA-256 and distinct labels:

- `a` = the admin's half of the decryption key (reduced mod ℓ, section 3);
- `t` = the control token sent to the Worker to authorize admin actions (the Worker stores only SHA-256(`t`));
- `s_i` = the secret of voter number *i* (so the admin can resend any voter's link after a reload);
- `kr` = an AES-GCM key for the parts of the roll kept private (section 5).

The page MUST say plainly: *Guarde uma cópia deste link. Ele conduz a reunião e guarda metade da chave: sem ele, os resultados não podem ser apurados; com ele, qualquer pessoa conduz a reunião.* (In the opt-out mode of section 3.1, without *e guarda metade da chave*.)

Keeping the admin link should need no understanding of cryptography:

- **Backup before anything else (MUST).** After *Criar*, the page shows the admin link with *Copiar link*, *QR*, and send-to-myself by WhatsApp or e-mail (buttons only when the admin entered a phone number or address for themself). The voter links appear only after the admin has used one of these.
- **Remembered on the device.** The admin link is also kept in the browser's local storage, so reopening `/votacao/` on the same phone or computer brings the session back without the link. The backup matters only if the device is lost or changed. Local storage is cleared at deletion time (section 8) or by *Esquecer esta reunião neste aparelho*.

## 2. Flow

1. **Create.** The admin enters the meeting title, their own name, and the voters (name and, optionally, phone or e-mail; *Colar uma lista* as in Segredo). Choose *Mostrar no quadro: nomes* or *impressões digitais*. The page derives everything from `m`, publishes the session (section 5) and shows the admin link with the backup options.
2. **Send links.** Per voter, as in Segredo: *Enviar pelo WhatsApp* only for a phone number, *Enviar por e-mail* only for an address, *Copiar link* and *QR* always. Usually before the meeting or at its start.
3. **Items, improvised or prepared.** The admin screen always has *Nova votação*: type the question, choose the type (section 4), *Abrir votação*. Items prepared in advance are optional and can be skipped or reordered. One item is open at a time.
4. **Vote.** The voter's page shows the open item live, the options and *Abstenção*; the voter chooses, confirms, and the page posts the encrypted ballot. It then shows *Sua cédula está no quadro* with the ballot's *número de acompanhamento* (section 5).
5. **Close.** *Encerrar votação*: the Worker stops accepting ballots for the item, computes the encrypted totals and its partial decryption; the admin's browser adds its partial decryption; the result appears on every screen. If the admin's browser is offline at that moment, the item shows *Encerrada, aguardando apuração* until the admin link is opened again anywhere.
6. **Cancel.** *Cancelar votação* (open or closed but not yet tallied): the ballots are discarded without being decrypted; the board shows *item cancelado*.
7. **Roll changes.** *Incluir eleitor* or *Excluir eleitor* at any moment. **The roll of an item is frozen when the item opens**; changes take effect from the next item. Every change is an event on the board, with its time.
8. **End.** *Encerrar a reunião*. Deletion follows section 8.

## 3. Cryptography (MUST)

**Group:** ristretto255 (prime order ℓ, canonical 32-byte encodings, generator `B`). Points and scalars are written as lowercase hex in JSON. Implementation: `@noble/curves` (MIT), pinned version, inline in the page and imported by the Worker.

> Why not the 1536-bit group of Embaralhamento: the Worker has to verify every ballot and compute partial decryptions inside a Cloudflare request, where CPU time is tight. ristretto255 is about 50× faster per operation, has no subgroup checks to forget, and makes ballots six times smaller.

**Hash to scalar:** `Hs(domain, x) = SHA-512("LucentVote/1/" ‖ domain ‖ 0x00 ‖ canonical JSON of x) mod ℓ`. Canonical JSON as in Embaralhamento (sorted keys, no spaces). Every proof's statement includes the session id, so proofs cannot be moved between sessions.

**Key.**
- Admin: `A = a·B`, with a Schnorr proof of knowledge of `a` (domain `pok`).
- Worker: `W = w·B`, `w` random, generated and kept inside the session's Durable Object, with its own Schnorr proof.
- Election key: `K = A + W`. Both proofs MUST verify before any ballot is accepted (this blocks a rogue key, where one side picks its key to cancel the other's).

**Item with m options**, m = 2 or 3. A ballot is one ciphertext per option, `v_j ∈ {0,1}`, and Σ v_j ∈ {0,1}; all zero means *Abstenção*.
- `c_j = (R_j, S_j) = (r_j·B, r_j·K + v_j·B)`, `r_j` random.
- For each j: a disjunctive Chaum–Pedersen proof (Cramer–Damgård–Schoenmakers) that `c_j` encrypts 0 or 1.
- For the sum `(ΣR_j, ΣS_j)`: the same kind of proof that it encrypts 0 or 1.
- All challenges come from one Fiat–Shamir hash (domain `ballot`) over: session id, item number, the voter's fingerprint (section 5), the option count and all `c_j`. Binding the fingerprint stops one voter from copying another's ballot.

**Tally of a closed item.** For each option j, `T_j = Σ_i c_ij` over the accepted ballots of that item (componentwise).
- Worker: `D_j^W = w·R(T_j)` with a Chaum–Pedersen proof that `log_B W = log_{R(T_j)} D_j^W` (domain `dec`).
- Admin's browser: `D_j^A = a·R(T_j)`, same kind of proof.
- `n_j·B = S(T_j) − D_j^A − D_j^W`; `n_j` is found by trying 0…50.
- *Abstenção* = accepted ballots − Σ n_j. *Não votaram* = size of the frozen roll − accepted ballots.

### 3.1 Key modes (chosen at creation, fixed for the session)

| Mode | Interface | Key |
|---|---|---|
| **Split** (default) | *Guardar metade da chave comigo (recomendado)*, checked | `K = A + W` as above; both partial decryptions needed |
| **Worker only** (opt-out) | the same box unchecked | `K = W`; no `A`, no admin proof; the Worker's partial decryption alone gives the counts |

Ballots, proofs, board and verification are otherwise identical. The mode is recorded in the `criada` event and shown on the voter and board pages (section 9), since the admin chooses it on the voters' behalf.

**What the Worker decrypts (MUST).** The Worker computes `D^W` only for the totals `T_j` that it computes itself from the board, for an item that is closed. It MUST NOT decrypt any ciphertext submitted to it. Otherwise the admin could submit one voter's ballot as a "total" and read it.

## 4. Item types (pt-BR)

| Type | Options shown | m |
|---|---|---|
| *Sim / Não* | *Sim*, *Não*, *Abstenção* | 2 |
| *Escolha* | the label (*Candidato*, *Proposta*, *Opção* or *Alternativa*) with numbers (*1, 2, 3*) or letters (*A, B, C*), 2 or 3 options, plus *Abstenção* | 2 or 3 |

- Options have no names. The admin writes the question to fit, for example: *Síndico 2027: Candidato 1 = Ana, Candidato 2 = Bruno*.
- Single choice only.
- Question: at most 300 characters.

## 5. The board (Durable Object, one per session)

The board is an append-only list of **events**. Each event has a sequence number, the server time (UTC, milliseconds), its content, and `h = SHA-256(h_previous ‖ canonical JSON of the event)`, starting from 32 zero bytes. Every page keeps the last `h` it saw and MUST warn if a later read does not extend it: history cannot be rewritten without being noticed.

| Event | Content |
|---|---|
| `criada` | title, admin's name, display mode (names or fingerprints), key mode (section 3.1), `A` and its proof (split mode only), `W` and its proof, SHA-256(`t`) |
| `eleitor-incluido` | voter number *i*, fingerprint `f_i`, name (only in names mode), `privado`: AES-GCM under `kr` of {name, contact} |
| `eleitor-excluido` | voter number *i* |
| `item-aberto` | item number, type, question, label, numbering, m, the frozen roll (list of fingerprints) |
| `cedula` | item number, fingerprint, the ciphertexts and the proof |
| `item-encerrado` | item number, the totals `T_j`, `D^W` with proof |
| `item-apurado` | item number, `D^A` with proof, the counts |
| `item-cancelado` | item number |
| `reuniao-encerrada` | — |

- **Fingerprint:** `f_i = first 16 bytes of SHA-256("LucentVote/1/eleitor" ‖ s_i)`, hex. The voter's page shows the first 8 digits as *sua impressão digital*.
- **Codes shown to people** use Crockford Base32 (digits and letters without I, L, O, U), 40 bits, written `XXXX-YYYY`, read leniently (case-insensitive, O = 0, I and L = 1):
  - *número de acompanhamento* of a ballot: the first 40 bits of SHA-256 of the ballot's canonical JSON;
  - *código* of a participant: the first 40 bits of the fingerprint `f`.
- **Accepting a ballot (MUST, in the Worker):** the item is open; the sender knows `s_i` whose fingerprint is on the item's frozen roll; that fingerprint has no ballot yet for this item; the proof verifies. **One ballot per voter per item, final.** If a voter's page finds a ballot already there, it says *Já há uma cédula com o seu link neste item, às 14:03. Se não foi você, avise a mesa.* (The admin can derive every voter secret; this makes such abuse visible instead of silent.)
- **Admin actions** carry `t`; the Worker checks it against the stored hash.
- **Display:** most recent first. In names mode the board shows names next to ballots; otherwise fingerprints. Never contacts.
- **Live:** pages subscribe by WebSocket to the Durable Object and receive new events as they are appended; polling every 5 s is the fallback.
- **Limits:** 50 voters on the roll at any time, 100 items, 300 characters per question, 128 bytes per name and title.

## 6. Verification (MUST, in every browser that shows a result)

The board and voter pages verify, from the event list alone:

1. the hash chain;
2. the proofs of knowledge, and `K = A + W` (split) or `K = W` (Worker only);
3. each ballot: on the item's frozen roll, at most one per fingerprint, valid proof, posted while the item was open;
4. the totals `T_j`, recomputed from the accepted ballots;
5. the partial-decryption proofs, and the counts.

Any failure is shown as *O quadro não confere* with the reason; no result is shown for that item. *Baixar a ata* downloads the full event list as JSON, so that the results can be verified after the board is deleted (a stand-alone verifier can come later).

## 7. Result display

*Sim 12 · Não 7 · Abstenção 2 · Não votaram 2 (23 aptos)*, or for *Escolha*: *Candidato 1: 9 · Candidato 2: 11 · Abstenção 1 · Não votaram 2*. Only counts: no *aprovado* or *rejeitado*, since rules differ (simple majority, absolute majority, two thirds, quorum).

**Small groups:** when the frozen roll has fewer than 10 voters, or when all votes fall on one option, the result carries *Em grupos pequenos, ou quando todos votam igual, o resultado pode revelar como cada um votou.*

## 8. Deletion (MUST)

The Durable Object deletes everything, including `w`, at **the first midnight (America/Sao_Paulo) after the session ends, plus 24 hours**. If the admin never ends the session, the same rule applies from the last event. After deletion no individual ballot can be decrypted by anyone; the downloaded *ata* still verifies.

## 9. What it guarantees, and what not (shown on the page)

- **Secret vote.** Split mode: *Sigilo: a chave é dividida entre o organizador e a LucentCrypto; nenhum dos dois, sozinho, consegue ler uma cédula. Só os totais são abertos.* Worker-only mode: *Sigilo: a chave fica com a LucentCrypto, que abre só os totais. Tudo é apagado um dia após a reunião.* These sentences appear on the voter page under the item, and on the board.
- **Counted as cast:** each voter sees their ballot on the board; anyone can check that the published result is the decryption of the sum of exactly the accepted ballots.
- **Who voted is visible** (by name or fingerprint, with the time); how they voted is not.
- **The admin controls the roll.** Every inclusion and exclusion is public, so participants can notice an unknown name, but only in names mode.
- **Not protected:** a voter who votes under someone's eyes, or who shares their link; malware on a phone; a lost admin link (in split mode the open items can never be tallied; in either mode the meeting can no longer be run).
- **No legal value:** *Esta é uma demonstração. Nenhum valor jurídico pode ser atribuído a estas votações.* Plus the same *sem garantias* notice as Segredo.

## 10. Site

- Page `/votacao/`: `index.html` plus the protocol module `core.mjs` and the vendored `vendor/noble.mjs`, all from the same origin; no other external requests except to `/api/votacao/`. The same `core.mjs` runs in the Worker and in the tests. Card on the home page, *em breve* line pointing to the full application.
- Worker route `/api/votacao/<sessão>/…` → Durable Object class `Sessao` (SQLite storage), WebSocket for live updates, alarm for deletion.
- Creating sessions is open to anyone; limits in section 5 and deletion keep the cost small. If abused, add Cloudflare Turnstile to *Criar*.
- Tests: proofs and tallies in Node (as for Segredo); a Worker test with a local Durable Object; an end-to-end browser test with an admin, three voters and the board in full-screen mode.
