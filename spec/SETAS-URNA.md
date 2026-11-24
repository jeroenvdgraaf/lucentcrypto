<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright (C) 2026 Jeroen van de Graaf -->
# Urna de setas — build brief for the Raspberry Pi voting machine (draft)

This brief is for whoever builds the machine, person or assistant. It assumes the reader has already prepared an air-gapped Raspberry Pi (as for the DuraShare key ceremony) and has read `spec/SETAS.md`, the arrow ballot.

> **In one paragraph.** The arrows exist only on paper. Each voter draws a sealed slip with the candidates, the arrows and a code. In the booth the voter scans the code, reads the arrows on the slip, and types **box numbers** on a keypad. The machine prints a strip with the code and the box numbers, which goes into a sealed box; the slip is destroyed. **The strips are the vote:** at the count they are scanned, and each image is published next to its reading. The machine knows codes and box numbers, **never candidates**: it cannot read a vote, and it cannot favour a candidate, because it does not know which box belongs to whom.

## 0. What the machine is

An in-person voting machine for the arrow ballot that **never sees the arrows**.

1. The voter draws a **sealed ballot slip** (section 6a) at random from an opaque box. The slip is an 80 mm strip with the candidates in the fixed order, the arrows, and the code with its QR code; it can also be the A4 mail sheet (SETAS.md section 3).
2. In the booth, the voter opens the slip, **scans its QR code** with the machine's scanner, follows the arrows on the paper, and **types the numbers of the boxes** of their candidates on a numeric keypad.
3. The machine **prints the vote strip** on an 80 mm thermal printer: the ballot code and the chosen box numbers, in large print and as a grid of boxes (section 7.3).
4. The voter checks the strip against the slip, **destroys the slip** (shredder in the booth) and drops the strip into a **sealed box**.

**What this machine is not.** It MUST NOT:

- store, receive or derive candidate names, permutations, arrows, or encrypted arrows;
- show a candidate or an arrow on the screen: the screen shows instructions and box numbers only;
- decrypt anything, or hold any key but its own signing key;
- print the ballot slips. Slips are printed beforehand on a separate printer (section 6a).

A design that preloads permutations, shows arrows on screen, or unlocks a ballot with a typed code is a **different scheme**, in which the machine could display false arrows and shift votes undetectably. It is out of scope.

What follows from this design, and MUST be kept:

- The machine knows codes and box numbers, never which candidate is behind a box. Its software, display and storage MUST NOT ask for, accept or store candidate names, arrows or encrypted arrows.
- A compromised machine cannot shift votes to a chosen candidate. It could print boxes other than those typed; the voter sees that on the strip, and the spoil procedure (section 7.4) handles it.
- **The strips are the vote.** The count uses the scanned strips (section 7.7). The machine keeps only a low-profile log (section 5): to refuse a code twice, to recover after a power cut, and as a quiet cross-check against the scanned strips.
- Nobody signs or initials a strip, digitally or by hand: anyone who did would see the voter and the code together. Forged strips are caught by the counts (section 7.7).
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
| Slip box | Opaque, with a hand opening, at the desk | The voter draws a slip without the poll worker seeing which |
| Slip printer | A **separate** printer, used only during preparation (section 6a) | Never connected to the voting machine |
| Count camera | A **separate** Raspberry Pi with the Camera Module 3 on a fixed stand, used at the count (section 7.7); never the voting machine | The stand holds the camera at a fixed height over a matte black base with guides for the strip; diffuse light from the side avoids glare on the thermal paper. Same air-gapped image as the voting machine, with the reading software; a screen, no keypad, scanner or printer |

## 2. Operating system and hardening

Start from the air-gapped image used for DuraShare if it meets this list; otherwise build a new one.

1. **Base:** Raspberry Pi OS Lite, 64-bit, current release. No desktop.
2. **Radios off** in `/boot/firmware/config.txt`: `dtoverlay=disable-wifi` and `dtoverlay=disable-bt`. Verify after boot that no wireless interface exists (`ip link`, `rfkill list`).
3. **No network services:** remove or disable `ssh`, `avahi-daemon`, `NetworkManager` or `dhcpcd`, `bluetooth`, `ModemManager`. No Ethernet cable is ever connected; disable `eth0` as well.
4. **Read-only system:** enable the overlay file system (`raspi-config nonint enable_overlayfs`) and make the boot partition read-only. The application writes only to the data partition. Do this **after** item 5: once the overlay is on, changes to the system, including the `/etc/fstab` line that mounts the data partition, are lost at the next reboot, and the log would silently go to RAM.
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
| QR codes | None printed by the machine; the scanner decodes the slip's QR code |
| Signatures | `PyNaCl` (Ed25519): verifying the package; signing the log's digest and the reports |
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
  printer.py       # renders and prints vote strips and reports
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

`codes.txt`: the valid ballot codes for this polling place, one per line, without the hyphen. Only codes: the machine MUST NOT receive the manifest's encrypted arrows. It is generated after the public sample audit (section 6a), so the voided codes are left out.

`package.sig`: an Ed25519 signature by LucentCrypto over `SHA-256(election.json) ‖ SHA-256(codes.txt)`. The public key is built into the image. A package whose signature fails MUST be refused.

## 5. The machine's log

The log is low profile: it is **not** the count. It lets the machine refuse a code used twice, recover after a power cut (section 7.6), and serves as a quiet cross-check against the scanned strips (section 7.7).

One JSON line per event, canonical (sorted keys, no spaces), in `/var/lib/urna/records.jsonl`:

```json
{"boxes":[3,7,11],"code":"K7F29QXM","kind":"vote","n":17,"prev":"<hex>"}
```

- `kind`: `open`, `vote`, `pending`, `spoil`, `close`.
- `boxes`: sorted, distinct, each in `1..boxes`, at most `maxChoices`; `[]` is a blank vote.
- `n`: the position in this file, for the chain only. The strip MUST NOT show it, since it reveals the order of voting.
- `prev`: SHA-256 of the previous line (the `open` record has the hash of the election package).
- Lines are not signed one by one. The machine signs the chain head in its reports and the digest of the export.

No time, no voter data, no screen content beyond the boxes.

**Casting order.** The chain on the data partition is in the order of voting, and the desk's list of who checked in could be in the same order. Together they would link the nth voter to the nth code. Therefore:

- the **export** (section 7.5) MUST list the `vote` and `spoil` records **sorted by code**, as `(kind, code, boxes)` only, without `n` or `prev`, plus the SHA-256 of that list and the chain head, signed together by the machine. The ordered chain stays only on the sealed SD card, for disputes;
- the desk's list of voters MUST record names only: no order numbers, no times.

## 6. Preparation (before election day, air-gapped)

1. Flash the published image; compare its SHA-256 with the published hash.
2. First boot: the machine generates its **machine key** (Ed25519) on the data partition and shows its fingerprint (first 16 hex characters of the public key's SHA-256).
3. Insert the election package stick; the machine verifies `package.sig`, copies the package, and shows the election title, box count and number of codes.
4. Print the **preparation report**: image hash, package hash, machine key fingerprint, number of valid codes. LucentCrypto keeps it; the public key goes to the bulletin board.
5. Power off, seal the case, the SD slot and unused ports. Record the seal numbers on the report.

## 6a. Ballot slips

**Printing.** Slips are printed from the ballot file (SETAS.md section 3) on a separate 80 mm printer, by a computer that never connects to the voting machine. Each slip, about 15 cm long: the title, the candidates in the fixed order, the arrows into numbered boxes as in SETAS.md, the code in text and as a QR code. The QR code holds only the code.

**Sealing.** Each slip is folded so that the arrows are inside and sealed with a numbered sticker, like a bank PIN letter (or the arrows are covered by a scratch-off strip). The voter opens it in the booth. Photographing the arrows means breaking a seal, which shows.

**Custody.**

- At printing: slips are counted, put in bags with numbered seals, and the seal numbers and counts go into the minutes.
- Before printing ends: a random sample is opened in public to check that the printed arrows match the encrypted ones (SETAS.md section 5); those codes are voided.
- At opening: the bag is opened in front of the poll workers and observers; the slips go into the opaque slip box.
- At closing: used (codes on the machine), spoiled, and unused slips MUST add up to the number received. Unused slips are sealed back in their bag. A slip with a broken seal is set aside as spoiled.

**Drawing.** The voter draws one slip from the slip box, out of the poll worker's sight; the code stays inside the sealed slip until the booth. Nobody records which slip a voter took.

**What photographing the slips would give.** Someone who photographs open slips knows which arrows go with which codes; with the votes per code (machine records, cast table) they know the vote cast with each photographed code. They still do not know **who** cast it, unless they also know which slip each voter drew. Seals make photographing visible; the draw and the sorted export (section 5) keep "who drew which code" unknown. This is a risk to secrecy, not to the result.

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
IMPRIMIR     append `pending` (code, boxes); print the vote strip; append `vote`; mark the code used
   ▼
DEPOSITAR    "Confira o papel: devem estar os quadrados 3, 7 e 11.
              Se estiver certo, destrua a cédula e coloque o papel na urna.
              Se estiver errado, chame o mesário."
   │ after 20 seconds or CONFIRMA
   ▼
AGUARDANDO
```

- **Blank vote:** BRANCO, or CONFIRMA with no boxes typed, leads to CONFERIR with its own warning: *Você não digitou nenhum quadrado. Seu voto será EM BRANCO. CONFIRMA para votar em branco · CORRIGE para voltar.*
- **Inactivity:** 3 minutes without a key in LER_CODIGO, DIGITAR or CONFERIR cancels and returns to AGUARDANDO. Nothing is recorded; the code stays unused.
- The screen MUST show only box numbers, never a candidate.

### 7.3 The vote strip

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

   Urna 4F2A·9C1E
```

Four small black squares mark the corners of the printed area, so the reading software can straighten and crop each photo.

The strip has **no QR code and no signature**. It is read at the count by scanning (section 7.7), from three parts: the code in large characters in an OCR-friendly font, the grid with the chosen boxes filled, and the box numbers in text. The grid and the numbers are read independently and must agree, and a person can check both by eye. The layout is fixed for the election, so the scanner finds each part in the same place on every strip. Blank vote: all boxes empty and *Quadrados: em branco*.

### 7.4 Spoiling a wrong printout

If the voter says the printed boxes differ from what they typed: the poll worker presses ANULAR (poll worker keypad, or the card `ANULAR:<secret>`) before the next LIBERAR. The machine appends `spoil` for the code of the last vote; the strip goes into a separate envelope, marked *anulada*. The voter draws a **new slip** and votes again. Spoils are counted and published; many spoils on one machine are a reason to take it out of service.

### 7.5 Closing

The poll worker enters ENCERRAR (poll worker keypad, or `ENCERRAR:<secret>`), then confirms. The machine:

1. stops accepting votes, appends `close` with the counts;
2. prints the **closing report** (*boletim*): votes, blank votes, spoils, codes used, chain head, machine fingerprint. It contains **no tally of boxes**: boxes mean nothing without the arrows;
3. asks for the export stick, mounts it, writes the log's records **sorted by code** with the signed digest (section 5), the package, the closing report as text, and `SHA256SUMS`; unmounts; asks to remove it;
4. powers off.

The data partition keeps everything; the SD card stays sealed in the machine as a second copy.

### 7.6 Power loss

On boot, `store.py` checks the chain from the start. If the last record is `pending` without a following `vote`, the machine shows, to the poll worker only: *Voto pendente: código K7F2-9QXM. O papel foi impresso?* The poll worker answers by key: printed → append `vote`; not printed → append `spoil` and the voter draws a new slip. A corrupted last line (cut in the middle) is dropped and noted in the closing report.

### 7.7 Counting the strips

The sealed box is opened at the count, in public.

1. **Photograph.** Every strip is photographed on the count camera's stand (section 1), one at a time. The reading software on that Pi (open source, OpenCV) straightens each image by its corner marks and reads it; the images and readings are written to a USB stick for publication. The reading is `(code, boxes)`: the boxes from the grid, checked against the box numbers in text, and the code from its printed characters. A strip whose parts disagree, or that cannot be read, is set aside, read by eye by the count committee, and noted in the minutes.
2. **Publish.** Each strip's image is published next to its reading (SETAS.md section 7), so anyone can check by eye that the reading matches the paper.
3. **Check.** Every code is in `codes.txt` and appears once; no strip has more than `maxChoices` boxes; the number of strips equals the number of voters on the desk list minus the spoils; used, spoiled and unused slips add up (section 6a). These counts also catch forged strips.
4. **Count.** The readings form this polling place's part of the cast table (SETAS.md section 6), alongside the scanned mail parts.
5. **Observers.** Anyone may photograph the strips during the public count, and may run the same reading software on their own photos.
6. **Cross-check, low profile.** The readings are compared with the machine's exported log. A difference is noted in the minutes and investigated; the strips decide.

## 8. Checker

`verify.py` runs on any computer with Python and checks an export: the package signature, the machine's signature over the sorted records and the chain head, that codes are valid and unique, that `vote` and `spoil` records obey the rules, and that the counts in `close` match. Given the strip readings (section 7.7), it also does the low-profile cross-check. In a dispute, it checks the full ordered chain read from the sealed SD card. It prints a summary; any failure is an error. The count itself uses the scanned strips, not this export.

## 9. Tests

| Test | Pass when |
|---|---|
| Unit tests of `machine.py` | Every transition in 7.2–7.6, including invalid codes, repeated boxes, more than k, blank, timeout |
| Fake devices | The whole flow runs with simulated keypad, scanner and printer, writing a valid export |
| 500 votes | 500 scripted votes on real hardware; `verify.py` passes; time per vote is measured |
| Power cut | The plug is pulled at random moments, 50 times; the machine always recovers by 7.6 and the chain verifies |
| Printer | Accents; paper out (the machine waits and says so); paper jam |
| Strip reading | All strips of the 500-vote test are photographed on the count camera's stand; every reading is correct, the grid and the printed numbers agree, and the readings match the log |
| No arrows (acceptance) | The image, the election package and the data partition contain no candidate name, permutation or encrypted arrow (search for the candidate names of a test election); every screen in a full test election shows only instructions and box numbers |
| Sorted export | The exported records are in code order; nothing in the export reveals the casting order |
| Slip custody | A test election's used, spoiled and unused slips add up to the number printed |
| No network | No network interface is up; no listening sockets (`ss -tlnp` empty) |
| Seals | A tester tries to reach the SD card without breaking a seal |

## 10. Open points

- Whether the code should carry a short checksum, so a mistyped code (when the scanner fails) is caught at once.
- The seal for slips: folded with a numbered sticker, or a scratch-off strip; cost and how well each resists careful opening.
- Thermal paper fades over months to years: keep the box only for the challenge period, or use long-life thermal paper.
- Accessibility, to be discussed when a client needs it: audio guidance through headphones (the Pi 4 has an audio jack, the Pi 5 needs USB audio) and a tactile keypad. Audio on this machine can read the instructions and the typed box numbers, never the arrows; a voter who cannot read the arrows needs another solution (SETAS.md section 4.2).
- Whether one machine serves 500 voters in a day: measure the time per vote in the 500-vote test.
- The count camera's stand and lighting, and the reading software: the error rate on thermal paper, and how many strips need reading by eye.
