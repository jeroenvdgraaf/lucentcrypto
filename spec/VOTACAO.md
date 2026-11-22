<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright (C) 2026 Jeroen van de Graaf -->
# Lucent Votação — spec (draft, LucentVote/1)

A teaser for a larger voting application: secret ballots during **one meeting**, online or in person, with at most **20 participants** (up to **100** with a release code, section 2.1). The person running the meeting (the **admin**, usually the president) opens items one at a time, improvising as needed; voters vote from a personal link on their phone; a public **board** on our Worker holds the encrypted ballots; the result of each item is decrypted only as a total. Where this document says MUST, the behavior affects verification or privacy.

The interface exists in Portuguese (`/votacao/`) and English (`/en/votacao/`); terms in *italics* are the Portuguese interface words. The protocol is the same in both: option names and actions stay in Portuguese in the data.

## 1. Roles and links

| Role | Link | Can |
|---|---|---|
| Admin | `/votacao/#s=<sessão>&a=<segredo do admin>` | add or remove voters, open, close and cancel items, end the session; holds half of the key |
| Group (*inscrição*) | `/votacao/#s=<sessão>&g=<token do grupo>` | ask to be on the roll (section 2.2); only when the session allows it |
| Voter | `/votacao/#s=<sessão>&v=<segredo do eleitor>` | vote once on each open item for which they are on the frozen roll; see results |
| Board (*quadro*) | `/votacao/#s=<sessão>` | read only: at the top, large, the current item and how many have voted (or the latest result); below, all results, everything on the board, verified in the browser; download the *ata*. *Tela cheia* shows only the top block, for projecting (`&tela` opens it that way) |

- `sessão`: 16 random bytes, base64url. Knowing it lets you read the board; it does not let you vote.
- Everything after `#` stays in the browser, as in Segredo; the page sends to the Worker only what each request needs.

**The admin link is everything.** From the admin secret `m` (32 random bytes) the page derives, with HMAC-SHA-256 and distinct labels:

- `a` = the admin's half of the decryption key (reduced mod ℓ, section 3);
- `t` = the control token sent to the Worker to authorize admin actions (the Worker stores only SHA-256(`t`));
- `s_i` = the secret of voter number *i* (so the admin can resend any voter's link after a reload);
- `kr` = an AES-GCM key for the parts of the roll kept private (section 5);
- `g` = the token of the group link (16 bytes, label `inscricao`; the Worker stores only SHA-256(`g`)).

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

### 2.1 Limits, release codes, participant lists

- **Limit.** A session allows 20 participants. With a **release code** it allows up to the code's limit (21 to 100). The limit is fixed at creation and recorded in the `criada` event (`limit`); it applies to inclusions during the meeting too. Above 20, the page says *A demonstração vai até 20 participantes. Para mais (até 100), informe um código de liberação*, with a pre-filled e-mail to info@lucentcrypto.org.
- **Release code** (MUST): 16 bytes in Crockford Base32, 26 symbols in groups of four (`XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XX`), read leniently.
  - The first 6 bytes: version `1` · limit · last valid day (2 bytes, days since 2000-01-01, Brasília time) · a 2-byte serial.
  - Then the first 10 bytes of HMAC-SHA-256(key, `"LucentVote/1/liberacao"` ‖ those 6 bytes).
  - The key is a Worker secret (`LIBERACAO_KEY`), never in the repository. Codes are issued with `tools/liberar.mjs`.
  - The board stores only the resulting limit, never the code.
- **Importing participants** (when preparing): *Colar uma lista* or *Importar arquivo (.csv)*. Fields may be separated by comma, semicolon or tab, quoted or not. A header line is used to find the name and contact columns when present. Names already on the list (case-insensitive) are skipped, and the preview says how many.
- **Exporting** (organizer page): *Exportar planilha (CSV)*, UTF-8 with BOM, `;`-separated, with columns `nº;nome;contato;código;link`. The same file can be imported when preparing another meeting.

### 2.2 Self-registration by group link

An alternative to typing the roll, for a meeting whose participants share a WhatsApp group. Chosen at creation, fixed for the session (*Como montar a lista*):

- `organizador` (default): only the admin adds voters, as above.
- `grupo-aprovado`: anyone with the group link asks to join and is **on the roll at once**; the admin can reject (remove) them, or confirm them.
- `grupo-pendente`: a request waits until the admin approves it.

In both group modes the admin can still add voters by hand, and the board MUST show names (*impressões digitais* mode is not offered): the point is that everyone sees who is on the roll.

1. **Group link.** The admin posts `#s=<sessão>&g=<g>` in the group (*Mandar no WhatsApp*, *Copiar link*, *QR*).
2. **Request.** The person types their name. **Their page generates the voter secret `s` (16 random bytes) on their own device**, stores it, and sends only the name and `f = fingerprint(s)` with `g`. The page then becomes their voter page (`&v=<s>`) and offers *Copiar meu link*. Reopening the group link on the same device goes straight to it. The admin never knows `s`, so, unlike a voter added by hand, **the admin cannot vote in a self-registered voter's place.**
3. **Decisions.** The admin page lists the requests, most recent first, with name, time and the participant code, and flags a repeated name. Checkboxes, *Selecionar todos os pendentes* (in `grupo-aprovado`: also those not yet confirmed), *Aprovar selecionados*, *Recusar selecionados*. One batch is one event. Approving a rejected request later is allowed; rejecting an approved one removes it from the roll.
4. **Closing.** *Encerrar inscrições* (a button only; opening a vote does not close registration). The group link then says registration is closed.
5. **Who sees requests.** Requests and decisions are events on the public board, always. The session option `verPedidos` decides whether voter pages also list them.

Rules (MUST, in the Worker and in every verifying page):

- **Race at opening (`grupo-aprovado`).** The frozen roll of an item is the current roll **minus voters who entered by default less than 5 s (`JOIN_GRACE`) before the item opened and were not confirmed by the admin**. They vote from the next item, and their page says *Você entrou logo antes desta votação abrir; vota a partir da próxima.* The rule is checkable from the event times (server clock).
- **Unconfirmed voters in an open item.** The admin page warns: *Esta votação abriu com N pessoas não conferidas: …*. Rejecting such a person stops them from voting from then on; a ballot they already cast stays counted, because nobody can tell which ballot is whose without breaking secrecy.
- **Removed during an item.** A voter removed (by hand or by rejection) while an item is open cannot cast a ballot in it any more. This holds for voters added by hand too.
- **Limits.** The session limit (section 2.1) counts voters on the roll. In `grupo-aprovado`, a request that arrives when the roll is full stays pending. At most 2 × limit requests may be pending at a time; further requests are refused (not logged). A fingerprint can request only once; a rejected person may ask again from another device or after clearing the page, which is a new request.
- **Numbers.** Request numbers and voter numbers share one sequence; the Worker assigns the number of a request.

## 3. Cryptography

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
- `n_j·B = S(T_j) − D_j^A − D_j^W`; `n_j` is found by trying 0 to the number of accepted ballots.
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
| `criada` | title, admin's name, display mode (names or fingerprints), key mode (section 3.1), `A` and its proof (split mode only), `W` and its proof, SHA-256(`t`); in the group modes also `inscricao`, SHA-256(`g`) as `gh`, and `verPedidos` |
| `eleitor-incluido` | voter number *i*, fingerprint `f_i`, name (only in names mode), `privado`: AES-GCM under `kr` of {name, contact} |
| `eleitor-excluido` | voter number *i* |
| `pedido` | number *i* (assigned by the Worker), fingerprint `f`, name (section 2.2) |
| `decisao` | `aprovar`: list of request numbers; `recusar`: list of request numbers |
| `inscricoes-encerradas` | — |
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
- **Limits:** the session's limit of participants on the roll at any time (section 2.1), 100 items, 300 characters per question, 128 bytes per name and title.

## 6. Verification (MUST, in every browser that shows a result)

The board and voter pages verify, from the event list alone:

1. the hash chain;
2. the proofs of knowledge, and `K = A + W` (split) or `K = W` (Worker only);
3. each ballot: on the item's frozen roll, at most one per fingerprint, valid proof, posted while the item was open;
4. the totals `T_j`, recomputed from the accepted ballots;
5. the partial-decryption proofs, and the counts.

Verification is incremental: the Worker and the pages keep the verified state and apply each new event to it, so a new ballot does not cost a re-verification of the whole board. In pages, ballot proofs are checked in a Web Worker, with *Conferindo as provas das cédulas neste aparelho: 312 de 500…* while it runs, so the page never freezes. A Worker event that fails verification is rejected and leaves the state unchanged.

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
- **The admin controls the roll.** Every inclusion and exclusion is public, so participants can notice an unknown name, but only in names mode. With the group link, every request and decision is public as well, and the board says how each voter entered (by hand or by the group).
- **Who can vote in someone's place.** The admin can derive the secret of every voter added by hand; a self-registered voter's secret exists only on their device and in their link.
- **Not protected:** a voter who votes under someone's eyes, or who shares their link; malware on a phone; a lost admin link (in split mode the open items can never be tallied; in either mode the meeting can no longer be run).
- **No legal value:** *Esta é uma demonstração. Nenhum valor jurídico pode ser atribuído a estas votações.* Plus the same *sem garantias* notice as Segredo.

## 10. Site

- Page `/votacao/`: `index.html` plus the protocol module `core.mjs` and the vendored `vendor/noble.mjs`, all from the same origin; no other external requests except to `/api/votacao/`. The same `core.mjs` runs in the Worker and in the tests. Card on the home page, *em breve* line pointing to the full application.
- Worker route `/api/votacao/<sessão>/…` → Durable Object class `Sessao` (SQLite storage), WebSocket for live updates, alarm for deletion.
- Creating sessions is open to anyone; limits in section 5 and deletion keep the cost small. If abused, add Cloudflare Turnstile to *Criar*.
- Tests: proofs and tallies in Node (as for Segredo); a Worker test with a local Durable Object; an end-to-end browser test with an admin, three voters and the board in full-screen mode.
