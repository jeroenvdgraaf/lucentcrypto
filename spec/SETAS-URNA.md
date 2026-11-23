<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright (C) 2026 Jeroen van de Graaf -->
# Urna de setas — build brief for the Raspberry Pi voting machine (draft)

This brief is for whoever builds the machine, person or assistant. It assumes the reader has already prepared an air-gapped Raspberry Pi (as for the DuraShare key ceremony) and has read `spec/SETAS.md`, the arrow ballot.

## 0. What the machine is

An in-person voting machine for the arrow ballot that **never sees the arrows**.

1. The voter receives a **preprinted arrow ballot** (the same sheet as by mail, SETAS.md section 3), picked at random from a pile.
2. In the booth, the voter **scans the ballot's QR code** with the machine's scanner, follows the arrows on the paper, and **types the numbers of the boxes** of their candidates on a numeric keypad.
3. The machine **prints the vote part** on a 80 mm thermal printer: the ballot code, the chosen box numbers, and a signature.
4. The voter checks the printed part against the paper, **destroys the paper sheet** (shredder in the booth) and drops the printed part into a **sealed box**.

What follows from this design, and MUST be kept:

- The machine knows codes and box numbers, never which candidate is behind a box. Its software, display and storage MUST NOT ask for, accept or store candidate names, arrows or encrypted arrows.
- A compromised machine cannot shift votes to a chosen candidate. It could print boxes other than those typed; the voter sees that on the printed part, and the spoil procedure (section 7.4) handles it.
- The printed parts in the box are the paper record. The machine's electronic records are what is counted; the paper serves for audit and recount.
- The pen-marked boxes on the sheet are not used in person. The same sheet works by mail, where the voter marks with a pen.

## 1. Hardware

| Part | Requirement | Notes |
|---|---|---|
| Raspberry Pi | Pi 4 (2 GB or more) or Pi 5 | The Pi 5 has a real-time clock, which is not needed: the machine records no times |
| Power | Official supply for the model | Optional UPS board, so a power cut does not stop the vote |
| Storage | microSD, 32 GB, high-endurance | Two partitions: read-only system, journaled data |
| Numeric keypad | USB, with Enter, Backspace, `*`, `/`, `-`, `+` | Relabel with stickers: CONFIRMA (Enter), CORRIGE (Backspace), BRANCO (`*`) |
| Code scanner | USB 2D scanner (QR) in keyboard (HID) mode | Simpler and more reliable than a camera. Fallback: typing the code on the keypad |
| Printer | 80 mm thermal, USB, ESC/POS, printing raster images, with an automatic cutter | Most print 576 dots per line (some 512): read the width from the printer and set it in the configuration. Confirm it works with `python-escpos` on Linux before buying in quantity |
| Screen | 7" HDMI or USB-C, or the client's monitor | Faces only the voter; a privacy filter helps |
| Poll worker key | A second small USB keypad, kept at the desk, or a QR card read by the scanner | Section 7.1 |
| Export | USB stick | Formatted FAT32, used only at closing |
| Case | Closed, with tamper-evident seals over the SD slot, the screws and unused ports | Block unused USB ports with port blockers |
| Booth | Shredder or slotted bin, the sealed box beside or outside it | The screen and keypad face the voter only |

## 2. Operating system and hardening

Start from the air-gapped image used for DuraShare if it meets this list; otherwise build a new one.

1. **Base:** Raspberry Pi OS Lite, 64-bit, current release. No desktop.
2. **Radios off** in `/boot/firmware/config.txt`: `dtoverlay=disable-wifi` and `dtoverlay=disable-bt`. Verify after boot that no wireless interface exists (`ip link`, `rfkill list`).
3. **No network services:** remove or disable `ssh`, `avahi-daemon`, `NetworkManager` or `dhcpcd`, `bluetooth`, `ModemManager`. No Ethernet cable is ever connected; disable `eth0` as well.
4. **Read-only system:** enable the overlay file system (`raspi-config nonint enable_overlayfs`) and make the boot partition read-only. The application writes only to the data partition.
5. **Data partition:** a separate ext4 partition, mounted at `/var/lib/urna` with `data=journal,sync`, owned by the application user.
6. **Console:** autologin of an unprivileged user `urna` on `tty1`, which starts the application; disable `getty` on the other terminals; disable the kernel's Magic SysRq key; `Ctrl+Alt+Del` does nothing.
7. **USB storage** is not mounted automatically. The application mounts the export stick explicitly at closing (section 7.5), with `noexec,nosuid,nodev`.
8. **Time:** the machine needs no clock and MUST NOT write times into records. Logs of the system itself go to RAM (`Storage=volatile` for journald).
9. **Randomness:** the kernel's random generator (`getrandom`), which the Pi's hardware generator feeds; check that `/dev/hwrng` exists.
10. **Reproducible image:** build with `pi-gen` from a public configuration, so that anyone can rebuild it and obtain the same hash. Publish the hash of the image file.

## 3. Software

Python 3, one application, no network code. Suggested libraries (all in Debian or PyPI, pinned in a lock file):

| Need | Library |
|---|---|
| Keypad and scanner input | `evdev`, grabbing each device exclusively so keys never reach the console |
| Screen | `pygame` with the KMS/DRM driver (no X, no Wayland), large fonts, Portuguese text |
| Printing | `python-escpos`; render each printout as an image as wide as the printer's print line (576 pixels on most 80 mm printers) with `Pillow` and print it as raster, so accents print correctly whatever the printer's code page |
| QR codes | `qrcode` (printing); the scanner decodes |
| Signatures | `PyNaCl` (Ed25519) |
| Hashing | `hashlib` (SHA-256) |
| Storage | an append-only file of JSON lines, `fsync` after every write |

Module layout:

```
urna/
  main.py          # starts the state machine
  devices.py       # finds keypad, scanner, poll worker keypad by USB vendor/product id (from config)
  ui.py            # screens, one function per state
  machine.py       # the state machine (section 7), no I/O of its own
  election.py      # loads and verifies the election package
  store.py         # append-only record chain, recovery after power loss
  printer.py       # renders and prints vote parts and reports
  export.py        # closing export to USB
  verify.py        # standalone checker, also runs on any computer
tests/
```

`machine.py` MUST be pure: it takes events (key pressed, code scanned, printer done) and returns actions (show screen, print, append record). That makes the whole flow testable without hardware.

## 4. The election package

Loaded from a USB stick during preparation (section 6), then kept on the data partition.

`election.json`:

```json
{
  "format": "LucentSetas/1",
  "election": "sindicato-x-conselho-fiscal-2027",
  "title": "Conselho Fiscal · Sindicato X",
  "boxes": 12,
  "maxChoices": 4,
  "pollingPlace": "sede",
  "codeAlphabet": "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
}
```

`codes.txt`: the valid ballot codes for this polling place, one per line, without the hyphen. Only codes: the machine MUST NOT receive the manifest's encrypted arrows.

`package.sig`: an Ed25519 signature by LucentCrypto over `SHA-256(election.json) ‖ SHA-256(codes.txt)`. The public key is built into the image. A package whose signature fails MUST be refused.

## 5. Records

One JSON line per event, canonical (sorted keys, no spaces), in `/var/lib/urna/records.jsonl`:

```json
{"boxes":[3,7,11],"code":"K7F29QXM","kind":"vote","n":17,"prev":"<hex>","sig":"<hex>"}
```

- `kind`: `open`, `vote`, `pending`, `spoil`, `close`.
- `boxes`: sorted, distinct, each in `1..boxes`, at most `maxChoices`; `[]` is a blank vote.
- `n`: the position in this file, for the chain only. The printed part MUST NOT show it, since it reveals the order of voting.
- `prev`: SHA-256 of the previous line (the `open` record has the hash of the election package).
- `sig`: the machine's Ed25519 signature over the line without `sig`.

No time, no voter data, no screen content beyond the boxes.

## 6. Preparation (before election day, air-gapped)

1. Flash the published image; compare its SHA-256 with the published hash.
2. First boot: the machine generates its **machine key** (Ed25519) on the data partition and shows its fingerprint (first 16 hex characters of the public key's SHA-256).
3. Insert the election package stick; the machine verifies `package.sig`, copies the package, and shows the election title, box count and number of codes.
4. Print the **preparation report**: image hash, package hash, machine key fingerprint, number of valid codes. LucentCrypto keeps it; the public key goes to the bulletin board.
5. Power off, seal the case, the SD slot and unused ports. Record the seal numbers on the report.

## 7. Election day: the state machine

Screens are in Portuguese, large, high contrast, one instruction at a time. Keys: digits, CONFIRMA (Enter), CORRIGE (Backspace), BRANCO (`*`).

### 7.1 Opening

On power-up with a package and no `open` record: self-test (printer prints a test line, keypad and scanner respond), then print the **opening report** (*zerésima*): election, image hash, package hash, machine fingerprint, **votes recorded: 0**, chain head. Append `open`. Poll workers and observers sign the paper report.

The **poll worker key**: either a second small keypad at the desk (a key labeled LIBERAR), or a laminated QR card read by the booth scanner, `LIBERAR:<secret>`, with the secret in the package. Each LIBERAR enables exactly one vote.

### 7.2 Voting

```
AGUARDANDO   "Aguarde o mesário liberar a urna."
   │ LIBERAR (poll worker)
   ▼
LER_CODIGO   "Passe o código QR da sua cédula no leitor."
   │ code scanned (or typed + CONFIRMA)
   │   invalid / unknown / already used → "Código não aceito. Chame o mesário." → AGUARDANDO
   ▼
DIGITAR      "Siga as setas na sua cédula. Digite o número do quadrado de cada candidato
              que você escolheu e aperte CONFIRMA. Até 4."
              shows the boxes typed so far: 3 · 7 · 11
   │ digits + CONFIRMA adds a box (rejects 0, > boxes, repeats, more than maxChoices)
   │ CORRIGE removes the last box
   │ BRANCO with no boxes → blank vote
   │ CONFIRMA on an empty entry → done
   ▼
CONFERIR     "Você escolheu os quadrados 3, 7 e 11.
              CONFIRMA para imprimir · CORRIGE para mudar"
   │ CONFIRMA
   ▼
IMPRIMIR     append `pending` (code, boxes); print the vote part; append `vote`; mark the code used
   ▼
DEPOSITAR    "Confira o papel: devem estar os quadrados 3, 7 e 11.
              Se estiver certo, destrua a cédula e coloque o papel na urna.
              Se estiver errado, chame o mesário."
   │ after 20 seconds or CONFIRMA
   ▼
AGUARDANDO
```

- **Inactivity:** 3 minutes without a key in LER_CODIGO, DIGITAR or CONFERIR cancels and returns to AGUARDANDO. Nothing is recorded; the code stays unused.
- The screen MUST show only box numbers, never a candidate.

### 7.3 The printed vote part

Rendered as an image as wide as the print line (576 pixels on most 80 mm printers), then cut:

```
   PARTE DE VOTO
   Conselho Fiscal · Sindicato X

   Código   K7F2-9QXM

   ┌─┐┌─┐┌─┐┌─┐┌─┐┌─┐
   │ ││ ││■││ ││ ││ │   1  2  3  4  5  6
   └─┘└─┘└─┘└─┘└─┘└─┘
   ┌─┐┌─┐┌─┐┌─┐┌─┐┌─┐
   │■││ ││ ││ ││■││ │   7  8  9 10 11 12
   └─┘└─┘└─┘└─┘└─┘└─┘

   Quadrados: 3 · 7 · 11

   [QR: K7F29QXM|3,7,11|<sig>]
   Urna 4F2A·9C1E
```

The QR code holds the code, the boxes and the machine's signature, so the count can read the paper automatically in a recount. Blank vote: all boxes empty and *Quadrados: em branco*.

### 7.4 Spoiling a wrong printout

If the voter says the printed boxes differ from what they typed: the poll worker presses ANULAR (poll worker keypad, or the card `ANULAR:<secret>`) and scans the printed part's QR. The machine appends `spoil` for that code; the printed part goes into a separate envelope, marked *anulada*. The voter receives a **new ballot sheet** and votes again. Spoils are counted and published; many spoils on one machine are a reason to take it out of service.

### 7.5 Closing

The poll worker enters ENCERRAR (poll worker keypad, or `ENCERRAR:<secret>`), then confirms. The machine:

1. stops accepting votes, appends `close` with the counts;
2. prints the **closing report** (*boletim*): votes, blank votes, spoils, codes used, chain head, machine fingerprint. It contains **no tally of boxes**: boxes mean nothing without the arrows;
3. asks for the export stick, mounts it, writes `records.jsonl`, the package, the closing report as text, and `SHA256SUMS`; unmounts; asks to remove it;
4. powers off.

The data partition keeps everything; the SD card stays sealed in the machine as a second copy.

### 7.6 Power loss

On boot, `store.py` checks the chain from the start. If the last record is `pending` without a following `vote`, the machine shows, to the poll worker only: *Voto pendente: código K7F2-9QXM. O papel foi impresso?* The poll worker answers by key: printed → append `vote`; not printed → append `spoil` and give the voter a new ballot. A corrupted last line (cut in the middle) is dropped and noted in the closing report.

## 8. Checker

`verify.py` runs on any computer with Python and checks an export: the package signature, every record's signature with the machine key, the chain, that codes are valid and unique, that `vote` and `spoil` records obey the rules, and that the counts in `close` match. It prints a summary; any failure is an error. It is the same code the count uses (SETAS.md section 6) to read machine records alongside the scanned mail parts.

## 9. Tests

| Test | Pass when |
|---|---|
| Unit tests of `machine.py` | Every transition in 7.2–7.6, including invalid codes, repeated boxes, more than k, blank, timeout |
| Fake devices | The whole flow runs with simulated keypad, scanner and printer, writing a valid export |
| 500 votes | 500 scripted votes on real hardware; `verify.py` passes; time per vote is measured |
| Power cut | The plug is pulled at random moments, 50 times; the machine always recovers by 7.6 and the chain verifies |
| Printer | Accents, QR legible by the same scanner, paper out (the machine waits and says so), paper jam |
| No arrows | Search the code and the data partition for candidate names; there must be none |
| No network | No network interface is up; no listening sockets (`ss -tlnp` empty) |
| Seals | A tester tries to reach the SD card without breaking a seal |

## 10. Open points

- Whether the scanned QR code on the sheet should also carry a short checksum, so a mistyped code is caught before the server lookup.
- Thermal paper fades over months to years: keep the box only for the challenge period, or use long-life thermal paper.
- Accessibility: audio guidance through headphones (the Pi 4 has an audio jack, the Pi 5 needs USB audio) and a tactile keypad.
- Whether one machine serves 500 voters in a day: measure the time per vote in the 500-vote test.
- How the machine records join the mail records in the count (SETAS.md section 6): the vote part's `(code, boxes)` replaces the scanned marks.
