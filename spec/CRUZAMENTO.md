# Cruzamento de listas — spec (draft, LucentPSI/1)

A demonstration of private set intersection (PSI): two organizations learn which records they have in common, and nothing else about each other's lists. It is the classic Diffie–Hellman PSI (Meadows 1986; Huberman, Franklin and Hogg 1999), on ristretto255. Pages: `/cruzamento/` (Portuguese) and `/en/cruzamento/` (English). This version is a **simulation**: both sides run in one page, so every step can be followed. A two-organization mode (two browsers, with a relay) is planned.

## 1. Profile (agreed by both sides)

- **Identifier** and its normalization (`cruzamento/core.mjs`, `normalize`):
  - `cpf`: the 11 digits; check digits verified; repeated-digit numbers rejected.
  - `cnpj`: the 14 digits; check digits verified.
  - `email`: lowercase, no whitespace.
  - `telefone`: digits only; a number written with `+` keeps its country code; otherwise `55` is prepended to 10 or 11 digits.
  - `nome`: NFKD without diacritics, lowercase, punctuation to single spaces. (Different people with the same name also match; the page says so.)
  
  All input is NFKC-normalized and trimmed first.
- **Result:** the intersection (default) or only its size.
- **Maximum size:** 500 records per side in this demonstration.

A pasted line is `label; identifier` or just the identifier (the last column). The label stays on its side and is only used to show the result. Repeated identifiers are reported and dropped. An invalid first line is taken as a header and ignored.

## 2. Protocol

Notation: `B` the ristretto255 base point, ℓ its prime order, `sid` the session identifier, `p` the profile.

- `H(x) = map(SHA-512("LucentPSI/1" ‖ 0x00 ‖ sid ‖ 0x00 ‖ p ‖ 0x00 ‖ x))`, where `map` is the one-way map of RFC 9496, section 4.3.4 (64 uniform bytes to a group element; constant time). Including `sid` and `p` means blinded values from one session are useless in another.
- Each side draws a secret scalar `k_A`, `k_B` uniformly in [1, ℓ).

1. **Sizes.** Each side announces its number of records. Either side stops if the other's size exceeds the agreed maximum or makes no sense (section 4).
2. **Blind and swap.** A sends `{k_A·H(a)}` for its records, in a random order; B sends `{k_B·H(b)}` likewise.
3. **Blind again.** A returns `k_A·(k_B·H(b))` for each value received; B returns `k_B·(k_A·H(a))`. In intersection mode each side returns the values **in the order received**; in size-only mode it **shuffles** them first.
4. **Compare.** Since `k_A·k_B·H(x) = k_B·k_A·H(x)`, a record is in both lists exactly when its doubly blinded value appears on both sides. In intersection mode each side maps the matches back to its own records through the order it sent; in size-only mode only the count can be computed.

Points travel as 32-byte canonical encodings (hex in the page).

## 3. Security

- **Assumption:** semi-honest parties, decisional Diffie–Hellman in ristretto255, `H` modelled as a random oracle. Under these, each side's view can be simulated from its own input, the other side's size and the result. (Computational DH alone would only say that the other side cannot compute `k·H(x)`; that the blinded values reveal nothing needs DDH.)
- **Leakage:** both sizes, and the intersection (or its size).
- **Dictionary attack:** any PSI lets a party put the identifiers it wants to test into its own list. With low-entropy identifiers such as CPF (about 10⁹ valid values) this is the real attack, not breaking the cryptography. The defences are procedural and part of the protocol: agree on a maximum size, check the announced size before blinding anything (step 1), and stop if it makes no sense. Each record of the attacker costs the victim a scalar multiplication, so a dictionary is also expensive to process.
- **Malicious parties** (deviating from the protocol, for example returning wrong values) are out of scope; versions with proofs exist.
- **Why not hashes:** the page shows SHA-256 of a CPF being reversed by exhaustive search over the CPFs with a known 3-digit prefix (10⁶ candidates, seconds in a browser), and extrapolates to the full space.

## 4. Page

- Section 1: the hash-reversal demonstration.
- Section 2: the simulation with two example lists, an identifier selector, the result mode, *mostrar os segredos* (shows `k_A`, `k_B`), the five steps (*Próximo passo*, *Executar tudo*, *Recomeçar*) and *Simular um ataque de dicionário* (B announces 1,000,000 records; A stops at step 1).
- What it guarantees and what not; no legal value; for real use (hundreds of thousands of records), contact.
- Measured: 500 × 500 records in about 2 s in a desktop browser (3 scalar operations per record and side).
