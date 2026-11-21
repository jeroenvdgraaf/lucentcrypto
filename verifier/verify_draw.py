#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Jeroen van de Graaf
"""verify_draw.py: reference verifier for Lucent Draw / Lucent Sorteios (protocols LucentDraw/3, /2 and /1).

A second implementation of the verification algorithm, independent of the HTML page
(SPEC, section 9; SPEC-v3, section 7 for LucentDraw/3). It uses only the Python standard library; the `requests`
package is needed only to fetch the values from the sources (Ethereum blocks, drand beacon,
Caixa lottery results). The drand BLS verification is done right here, in pure Python
(BLS12-381, RFC 9380), without external libraries.

Usage:
    python3 verify_draw.py draw-proof-<id>.json        (or comprovante-sorteio-<id>.json)
    python3 verify_draw.py proof.json --rpc https://my-ethereum-node.example
    python3 verify_draw.py proof.json --confirm-lottery   # I checked the numbers by eye
    python3 verify_draw.py proof.json --values values.json  # offline (values already obtained)
    python3 verify_draw.py proof.json --tsa-ca tsa-chain.pem # validates RFC 3161 signatures

Pure function for tests and programmatic use:
    verify_certificate(cert, fetched, ...) -> dict
where `fetched` holds the source values obtained independently
(see the docstring of verify_certificate).

Exit codes: 0 = checks out, 1 = does not check out, 2 = incomplete check, 3 = usage error.
"""

from __future__ import annotations

import argparse
import base64
import datetime as _dt
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
from fractions import Fraction
from functools import lru_cache
from math import gcd

# =============================================================================
# Constantes do protocolo
# =============================================================================

V3 = "LucentDraw/3"
V2 = "LucentDraw/2"
V1 = "LucentDraw/1"
SOURCE_ORDER = ("eth", "drand", "megasena", "federal")

ETH_GENESIS = 1606824023
ETH_SLOT = 12

QUICKNET_HASH = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971"
QUICKNET_PUBKEY = (
    "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d"
    "1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a"
)
QUICKNET_GENESIS = 1692803367
QUICKNET_PERIOD = 3
DRAND_DST = b"BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_"
DRAND_ENDPOINTS = ("https://api.drand.sh", "https://drand.cloudflare.com")

DEFAULT_RPCS = (
    "https://ethereum-rpc.publicnode.com",
    "https://eth.llamarpc.com",
    "https://1rpc.io/eth",
)

# Endpoint não oficial da Caixa (SPEC 4.5). A CONFIRMAR PELO RESPONSÁVEL (ver DECISIONS.md).
CAIXA_API = "https://servicebus2.caixa.gov.br/portaldeloterias/api/{game}/{contest}"
OFFICIAL_PAGES = {
    "megasena": "https://loterias.caixa.gov.br/Paginas/Mega-Sena.aspx",
    "federal": "https://loterias.caixa.gov.br/Paginas/Federal.aspx",
}
# Não há calendário de sorteios (decisão do responsável, ver DECISIONS.md e SPEC-v3 4): o horário de
# uma loteria é comparado com o INÍCIO do dia do sorteio (00:00 em America/Sao_Paulo, UTC−3).
BRT = _dt.timezone(_dt.timedelta(hours=-3))  # Brasil sem horário de verão desde 2019

OID_SHA256 = "2.16.840.1.101.3.4.2.1"
OID_SIGNED_DATA = "1.2.840.113549.1.7.2"
OID_TSTINFO = "1.2.840.113549.1.9.16.1.4"

# Status das checagens
PASS, FAIL, UNVERIFIED, WARN = "passou", "falhou", "nao_verificado", "atencao"
STATUS_LABEL = {PASS: "passed", FAIL: "failed", UNVERIFIED: "not verified", WARN: "attention"}

# Caracteres removidos por "trim": o mesmo conjunto de String.prototype.trim do ECMAScript,
# para que a página e este verificador concordem byte a byte.
_TRIM = "\t\n\v\f\r                  　﻿"
_HEX64 = re.compile(r"^[0-9a-f]{64}$")


# =============================================================================
# Codificação canônica e regras de ordem (SPEC 3.1, 5)
# =============================================================================

def H(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def norm_text(s: str) -> str:
    return unicodedata.normalize("NFC", s).strip(_TRIM)


def norm_hex(h) -> str:
    h = (h or "").lower()
    return h[2:] if h.startswith("0x") else h


def _check_json_types(v, path="spec", bool_paths=()):
    """Só inteiros (sem float) dentro de spec (SPEC 3.1); booleano só nos caminhos de bool_paths
    (em LucentDraw/3, apenas spec.task.replace)."""
    if isinstance(v, bool):
        if path in bool_paths:
            return
        raise ValueError(f"{path}: a boolean value is not allowed")
    if isinstance(v, float):
        raise ValueError(f"{path}: a non-integer number is not allowed")
    if isinstance(v, dict):
        for k, x in v.items():
            if not isinstance(k, str):
                raise ValueError(f"{path}: non-text key")
            _check_json_types(x, f"{path}.{k}", bool_paths)
    elif isinstance(v, list):
        for i, x in enumerate(v):
            _check_json_types(x, f"{path}[{i}]", bool_paths)
    elif v is not None and not isinstance(v, (str, int)):
        raise ValueError(f"{path}: unsupported type")


def _bool_paths(spec):
    return ("spec.task.replace",) if isinstance(spec, dict) and spec.get("v") == V3 else ()


def canonical_json(obj) -> str:
    _check_json_types(obj, "spec", _bool_paths(obj))
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def commitment_of(spec) -> str:
    return H(canonical_json(spec))


def seed_v2(C: str, values: dict) -> str:
    lines = [V2, "seed", C] + [f"{k}={values.get(k) or '-'}" for k in SOURCE_ORDER]
    return H("\n".join(lines))


def key_v2(seed: str, name: str) -> str:
    return H(V2 + "\nkey\n" + seed + "\n" + name)


def order_v2(seed: str, names):
    # Chave ascendente; empate (probabilidade ~2^-256) pelo nome em ordem de código Unicode.
    return sorted(names, key=lambda n: (key_v2(seed, n), n))


def seed_v1(C: str, eth_hash, drand_rand) -> str:
    return H("\n".join([V1, "seed", C, norm_hex(eth_hash) if eth_hash else "-",
                        norm_hex(drand_rand) if drand_rand else "-"]))


def key_v1(seed: str, name: str) -> str:
    return H(V1 + "\nkey\n" + seed + "\n" + name)


def order_v1(seed: str, names):
    return sorted(names, key=lambda n: key_v1(seed, n))  # sem desempate (sort estável)


# ----------------------------------------------------------------- LucentDraw/3 (SPEC-v3 2, 3)

TASK_PRESETS = ("list", "coin", "die", "cards")
_W_INT = re.compile(r"[0-9]+")
_W_DEC = re.compile(r"[0-9]*\.[0-9]+|[0-9]+\.[0-9]*")
_W_FRAC = re.compile(r"([0-9]+)[ \t]*/[ \t]*([0-9]+)")
WEIGHT_ERRORS = {
    "empty": "empty weight: use 1 for a normal chance or 0 to leave it out of the draw",
    "syntax": "use a whole number (3), a decimal (0.35) or a fraction (1/7)",
    "negative": "negative weights are not allowed",
    "zeroDen": "fraction with a zero denominator",
}


def parse_weight(w):
    """Peso digitado -> Fraction exata (>= 0). Gramática da SPEC-v3 2 depois de NFC, trim e "," -> ".".

    Só algarismos ASCII; espaço ou tab só em volta de "/". Lança ValueError(código) se inválido.
    """
    if not isinstance(w, str):
        raise ValueError("syntax")
    s = norm_text(w).replace(",", ".")
    if not s:
        raise ValueError("empty")
    if _W_INT.fullmatch(s):
        return Fraction(int(s))
    if _W_DEC.fullmatch(s):
        a, b = s.split(".")
        return Fraction(int((a or "0") + b), 10 ** len(b))
    m = _W_FRAC.fullmatch(s)
    if m:
        if int(m.group(2)) == 0:
            raise ValueError("zeroDen")
        return Fraction(int(m.group(1)), int(m.group(2)))
    raise ValueError("negative" if s[:1] in ("-", "−") else "syntax")


def integer_weights(weights):
    """w_i = n_i * (L / d_i), L = mmc dos denominadores (frações reduzidas). Devolve (ints, L, W)."""
    fr = [parse_weight(w) for w in weights]
    L = 1
    for f in fr:
        L = L * f.denominator // gcd(L, f.denominator)
    ints = [f.numerator * (L // f.denominator) for f in fr]
    return ints, L, sum(ints)


def share_text(w: int, W: int) -> str:
    """Porcentagem exata de w/W arredondada a 0,1 (só para exibir)."""
    if not W or w == 0:
        return "0%"
    if w == W:
        return "100%"
    tenths = (w * 2000 + W) // (2 * W)
    if tenths == 0:
        return "< 0.1%"
    if tenths >= 1000:
        return "> 99.9%"
    return f"{tenths // 10}.{tenths % 10}%"


def seed_v3(C: str, values: dict) -> str:
    # A linha "inmetro=" entra só quando a fonte é usada (SPEC-v3 5.4): comprovantes antigos não mudam.
    extra = [f"inmetro={values['inmetro']}"] if values.get("inmetro") else []
    return H("\n".join([V3, "seed", C] + [f"{k}={values.get(k) or '-'}" for k in SOURCE_ORDER] + extra))


# Farol do Inmetro (SPEC-v3 5.4): pulsos NIST (NISTIR 8213), um por minuto.
INMETRO_BASE = "https://beacon.inmetro.gov.br/beacon/2.1"
INMETRO_RULE = "first-pulse-after"
INMETRO_LISTS = ("previous", "hour", "day", "month", "year")


def inmetro_minute_after(ms: int) -> int:
    """O primeiro minuto cheio estritamente depois de ms."""
    return ms // 60000 * 60000 + 60000


def inmetro_serialize(p: dict) -> bytes:
    """Serialização NIST: textos/bytes com 4 bytes de tamanho; cipherSuite, period, statusCode em 4 bytes;
    chainIndex, pulseIndex em 8 bytes; big-endian. Inclui a assinatura; não inclui o outputValue."""
    import struct
    out = []
    u32 = lambda n: out.append(struct.pack(">I", n))  # noqa: E731
    u64 = lambda n: out.append(struct.pack(">Q", n))  # noqa: E731

    def b(x):
        u32(len(x)); out.append(x)
    s_ = lambda x: b(str(x).encode("utf-8"))  # noqa: E731
    h_ = lambda x: b(bytes.fromhex(norm_hex(x)))  # noqa: E731
    ext = p.get("external") or {}
    lv = p.get("listValues") if isinstance(p.get("listValues"), list) else []
    s_(p["uri"]); s_(p["version"]); u32(p["cipherSuite"]); u32(p["period"]); h_(p["certificateId"])
    u64(p["chainIndex"]); u64(p["pulseIndex"]); s_(p["timeStamp"]); h_(p["localRandomValue"])
    h_(ext["sourceId"]); u32(ext["statusCode"]); h_(ext["value"])
    for t in INMETRO_LISTS:
        e = next((x for x in lv if isinstance(x, dict) and x.get("type") == t), None)
        if e is None:
            raise ValueError("listValues without " + t)
        h_(e["value"])
    h_(p["precommitmentValue"]); u32(p["statusCode"]); h_(p["signatureValue"])
    return b"".join(out)


def inmetro_intact(p) -> bool:
    """O outputValue é o SHA-512 de todos os campos do pulso, assinatura incluída."""
    try:
        if not isinstance(p, dict) or not _is_int(p.get("pulseIndex")) or not _is_int(p.get("chainIndex")):
            return False
        return hashlib.sha512(inmetro_serialize(p)).hexdigest() == norm_hex(p.get("outputValue"))
    except (KeyError, TypeError, ValueError, OverflowError, __import__("struct").error):
        return False


# Semente própria (SPEC-v3 5.3): sem acentos (NFKD), maiúsculas; só A-Z e 0-9 contam, o resto separa.
# Números sem zeros à esquerda. Só números: ordem crescente. Com palavras: ordem digitada. Unidos por "-".
OWN_FORMATS = ("megasena", "federal", "outro")
_OWN_ASCII = re.compile(r"^[\x20-\x7e\t\n\r]*$")


def canon_own_seed(text):
    d = "".join(ch for ch in unicodedata.normalize("NFKD", str(text)) if not unicodedata.category(ch).startswith("M"))
    if not _OWN_ASCII.match(d):
        return {"error": "ascii"}
    parts = [re.sub(r"^0+(?=[0-9])", "", x) if x.isdigit() else x for x in re.findall(r"[A-Z0-9]+", d.upper())]
    if not parts:
        return {"error": "empty"}
    if all(x.isdigit() for x in parts):
        parts.sort(key=lambda x: (len(x), x))
        return {"value": "-".join(parts), "reading": "int"}
    return {"value": "-".join(parts), "reading": "text"}


def own_format_error(fmt, c):
    if fmt == "outro":
        return None
    nums = c["value"].split("-") if c.get("reading") == "int" else []
    if fmt == "megasena":
        ok = len(nums) == 6 and len(set(nums)) == 6 and all(len(x) <= 2 and 1 <= int(x) <= 60 for x in nums)
        return None if ok else "megasena"
    if fmt == "federal":
        return None if len(nums) == 5 and all(len(x) <= 6 for x in nums) else "federal"
    return "format"


def seed_own(value: str) -> str:
    return H("\n".join([V3, "own", value]))


def pick_hash(seed: str, j: int) -> str:
    return H(V3 + "\npick\n" + seed + "\n" + str(j))


def select_picks(seed: str, task: dict):
    """Regra de escolha (SPEC-v3 3), só inteiros. Devolve (picks, steps), steps = [{j, r, x, W, index}]."""
    ints, _, _ = integer_weights(task["weights"])
    alive = [i for i, w in enumerate(ints) if w > 0]
    picks, steps = [], []
    for j in range(task["count"]):
        W = sum(ints[i] for i in alive)
        if W == 0:
            raise ValueError("no options left")
        r = pick_hash(seed, j)
        x = (int(r, 16) * W) >> 256  # em [0, W)
        acc = 0
        for k, i in enumerate(alive):
            acc += ints[i]
            if x < acc:
                picks.append(i)
                steps.append({"j": j, "r": r, "x": x, "W": W, "index": i})
                if not task["replace"]:
                    del alive[k]
                break
    return picks, steps


def validate_task(task) -> list:
    """Regras de task (SPEC-v3 2). Lista de problemas, vazia se bem formada."""
    if not isinstance(task, dict):
        return ["task is not an object"]
    problems = []
    expected = {"preset", "options", "weights", "count", "replace"}
    missing, extra = expected - task.keys(), task.keys() - expected
    if missing:
        problems.append("task: missing fields: " + ", ".join(sorted(missing)))
    if extra:
        problems.append("task: unknown fields: " + ", ".join(sorted(extra)))
    if task.get("preset") not in TASK_PRESETS:
        problems.append('task.preset must be "list", "coin", "die" or "cards"')
    opts = task.get("options") if isinstance(task.get("options"), list) else None
    if not opts:
        problems.append("task.options must be a list with at least one option")
    for i, o in enumerate(opts or []):
        if not isinstance(o, str) or not o:
            problems.append(f"option {i + 1} empty or invalid")
        elif norm_text(o) != o:
            problems.append(f"option {i + 1} is not normalized (NFC, no leading or trailing spaces)")
    strs = [o for o in (opts or []) if isinstance(o, str)]
    dups = sorted({o for o in strs if strs.count(o) > 1})
    if dups:
        problems.append("repeated options: " + ", ".join(dups))
    ws = task.get("weights") if isinstance(task.get("weights"), list) else None
    positive, bad_weight = 0, False
    if ws is None:
        problems.append("task.weights is not a list")
    else:
        if opts is not None and len(ws) != len(opts):
            problems.append("task.weights must have one weight for each option")
        for i, w in enumerate(ws):
            if not isinstance(w, str):
                bad_weight = True
                problems.append(f"weight {i + 1}: " + WEIGHT_ERRORS["syntax"])
                continue
            if norm_text(w) != w:
                problems.append(f"weight {i + 1} is not normalized (NFC, no leading or trailing spaces)")
            try:
                if parse_weight(w) > 0:
                    positive += 1
            except ValueError as e:
                bad_weight = True
                problems.append(f"weight {i + 1}: " + WEIGHT_ERRORS.get(str(e), str(e)))
        if not bad_weight and positive == 0:
            problems.append("at least one weight must be greater than zero")
    count = task.get("count")
    if not _is_int(count) or count < 1:
        problems.append("task.count must be an integer greater than or equal to 1")
    if not isinstance(task.get("replace"), bool):
        problems.append("task.replace must be true or false")
    elif not task["replace"] and _is_int(count) and ws is not None and positive > 0 and count > positive:
        problems.append("without replacement, task.count cannot exceed the number of options with a weight above zero")
    return problems


def task_summary(task: dict) -> str:
    n, preset = task["count"], task["preset"]
    if preset == "coin":
        return f"{n} toss" + ("" if n == 1 else "es")
    if preset == "die":
        loaded = any(w != "1" for w in task["weights"])
        return (f"{n} " + ("die" if n == 1 else "dice") + f" with {len(task['options'])} faces"
                + (" (loaded die: different weights)" if loaded else ""))
    if preset == "cards":
        return "shuffle the deck (52 cards, without replacement)" if n == 52 else (
            f"{n} card" + ("" if n == 1 else "s") + ", without replacement")
    o = len(task["options"])
    return (f"{o} option" + ("" if o == 1 else "s") + f", {n} pick" + ("" if n == 1 else "s")
            + (", with replacement" if task["replace"] else ", without replacement"))


# ----------------------------------------------------------------- strings de valor (SPEC 4)

def megasena_value(contest: int, numbers) -> str:
    return f"{contest}:" + "-".join(f"{n:02d}" for n in sorted(numbers))


def federal_value(contest: int, prizes) -> str:
    return f"{contest}:" + "-".join(prizes)


def _megasena_numbers_ok(nums) -> bool:
    return (isinstance(nums, list) and len(nums) == 6
            and all(isinstance(n, int) and not isinstance(n, bool) and 1 <= n <= 60 for n in nums)
            and len(set(nums)) == 6)


def _federal_prizes_ok(prizes) -> bool:
    return (isinstance(prizes, list) and len(prizes) == 5
            and all(isinstance(p, str) and re.fullmatch(r"[0-9]{5}", p) for p in prizes))


# LucentDraw/3 (SPEC-v3 4): concurso como texto ("3001", "6054-2"), números inteiros sem zeros à esquerda.
_CONTEST_V3 = re.compile(r"[1-9][0-9]*(?:-[1-9][0-9]*)?")


def contest_ok_v3(c) -> bool:
    return isinstance(c, str) and _CONTEST_V3.fullmatch(c) is not None


def _federal_prizes_ok_v3(prizes) -> bool:
    return (isinstance(prizes, list) and len(prizes) == 5
            and all(_is_int(p) and 0 <= p <= 999999 for p in prizes))


def _to_int(x):
    """Valores vindos de fora (Caixa, relay) podem ser inteiros ou texto com algarismos."""
    return int(x) if isinstance(x, str) and re.fullmatch(r"[0-9]{1,9}", x) else x


def megasena_value_v3(contest: str, numbers) -> str:
    return f"{contest}:" + "-".join(str(n) for n in sorted(_to_int(x) for x in numbers))


def federal_value_v3(contest: str, prizes) -> str:
    return f"{contest}:" + "-".join(str(_to_int(p)) for p in prizes)


def lottery_evidence_ok(game: str, ev: dict, v: str = V2) -> bool:
    if game == "megasena":
        return _megasena_numbers_ok(ev.get("numbers"))
    return _federal_prizes_ok_v3(ev.get("prizes")) if v == V3 else _federal_prizes_ok(ev.get("prizes"))


def lottery_value(game: str, contest, ev: dict, v: str = V2) -> str:
    if v == V3:
        return megasena_value_v3(contest, ev["numbers"]) if game == "megasena" else federal_value_v3(contest, ev["prizes"])
    if game == "megasena":
        return megasena_value(contest, ev["numbers"])
    return federal_value(contest, [f"{p:05d}" if _is_int(p) else p for p in ev["prizes"]])


def drand_round_time(r: int) -> int:
    return QUICKNET_GENESIS + (r - 1) * QUICKNET_PERIOD


def draw_day_start(draw_date) -> int | None:
    """Início do dia do sorteio (00:00 em Brasília, UTC−3), unix s; None se a data for inválida."""
    try:
        d = _dt.date.fromisoformat(draw_date)
        return int(_dt.datetime(d.year, d.month, d.day, 0, 0, tzinfo=BRT).timestamp())
    except (TypeError, ValueError):
        return None


# =============================================================================
# Normalização do resultado da Caixa (endpoint não oficial; formato a confirmar)
# =============================================================================

def _caixa_date(s):
    m = re.fullmatch(r"(\d{2})/(\d{2})/(\d{4})", s or "")
    return f"{m.group(3)}-{m.group(2)}-{m.group(1)}" if m else None


def normalize_caixa(game: str, contest, j: dict):
    """Converte a resposta JSON da Caixa para o formato normalizado, ou None se não houver resultado.

    contest inteiro = formato LucentDraw/2 (bilhetes com 5 algarismos, texto); contest texto =
    LucentDraw/3 (SPEC-v3 4: bilhetes inteiros de até 6 algarismos).
    """
    if not isinstance(j, dict):
        return None
    v3 = isinstance(contest, str)
    num = j.get("numero")
    if num is not None:
        try:
            if (str(num).strip() != contest) if v3 else (int(num) != contest):
                return None
        except (TypeError, ValueError):
            return None
    raw = j.get("listaDezenas") or j.get("dezenasSorteadasOrdemSorteio") or []
    date = _caixa_date(j.get("dataApuracao"))
    if game == "megasena":
        try:
            nums = sorted(int(x) for x in raw)
        except (TypeError, ValueError):
            return None
        if not _megasena_numbers_ok(nums):
            return None
        return {"game": game, "contest": contest, "numbers": nums, "drawDate": date}
    if v3:
        prizes = [int(str(x).strip()) if re.fullmatch(r"[0-9]{1,6}", str(x).strip()) else None for x in raw]
        if not _federal_prizes_ok_v3(prizes):
            return None
        return {"game": game, "contest": contest, "prizes": prizes, "drawDate": date}
    prizes = []
    for x in raw:
        d = re.sub(r"\D", "", str(x))
        while len(d) > 5 and d.startswith("0"):
            d = d[1:]
        prizes.append(d.zfill(5))
    if not _federal_prizes_ok(prizes):
        return None
    return {"game": game, "contest": contest, "prizes": prizes, "drawDate": date}


# =============================================================================
# DER mínimo para tokens RFC 3161
# =============================================================================

class DERError(ValueError):
    pass


def _der_read(buf: bytes, pos: int):
    """Lê um TLV; devolve (tag, início do conteúdo, fim do conteúdo)."""
    if pos + 2 > len(buf):
        raise DERError("DER truncado")
    tag = buf[pos]
    if tag & 0x1F == 0x1F:
        raise DERError("long DER tag not supported")
    ln = buf[pos + 1]
    pos += 2
    if ln & 0x80:
        n = ln & 0x7F
        if n == 0 or n > 4 or pos + n > len(buf):
            raise DERError("invalid DER length")
        ln = int.from_bytes(buf[pos:pos + n], "big")
        pos += n
    if pos + ln > len(buf):
        raise DERError("DER truncado")
    return tag, pos, pos + ln


def _der_children(buf: bytes, start: int, end: int):
    out = []
    pos = start
    while pos < end:
        tag, s, e = _der_read(buf, pos)
        out.append((tag, s, e, pos))
        pos = e
    if pos != end:
        raise DERError("DER malformado")
    return out


def _der_oid(b: bytes) -> str:
    if not b:
        raise DERError("OID vazio")
    first = b[0]
    parts = [min(first // 40, 2), first - 40 * min(first // 40, 2)]
    v = 0
    for c in b[1:]:
        v = (v << 7) | (c & 0x7F)
        if not c & 0x80:
            parts.append(v)
            v = 0
    return ".".join(str(p) for p in parts)


def parse_generalized_time(s: str) -> int:
    """GeneralizedTime (UTC, 'Z') para milissegundos unix."""
    m = re.fullmatch(r"(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:[.,](\d+))?Z", s)
    if not m:
        raise DERError("genTime in unsupported format: " + s)
    y, mo, d, hh, mi, ss, frac = m.groups()
    dt = _dt.datetime(int(y), int(mo), int(d), int(hh), int(mi), int(ss), tzinfo=_dt.timezone.utc)
    ms = int((frac or "0")[:3].ljust(3, "0"))
    return int(dt.timestamp()) * 1000 + ms


def ms_to_iso(ms: int) -> str:
    dt = _dt.datetime.fromtimestamp(ms // 1000, _dt.timezone.utc)
    base = dt.strftime("%Y-%m-%dT%H:%M:%S")
    return base + (f".{ms % 1000:03d}" if ms % 1000 else "") + "Z"


def iso_to_ms(s: str):
    m = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z", s or "")
    if not m:
        return None
    y, mo, d, hh, mi, ss, frac = m.groups()
    dt = _dt.datetime(int(y), int(mo), int(d), int(hh), int(mi), int(ss), tzinfo=_dt.timezone.utc)
    return int(dt.timestamp()) * 1000 + int((frac or "0")[:3].ljust(3, "0"))


def parse_timestamp_response(der: bytes) -> dict:
    """Lê o suficiente de um TimeStampResp para obter status, hash carimbado e genTime.

    Devolve {"status", "hashAlg", "imprint", "genTimeMs", "genTime", "token": bytes do TimeStampToken}.
    """
    tag, s, e = _der_read(der, 0)
    if tag != 0x30 or e != len(der):
        raise DERError("TimeStampResp is not a SEQUENCE")
    kids = _der_children(der, s, e)
    if not kids or kids[0][0] != 0x30:
        raise DERError("PKIStatusInfo missing")
    st = _der_children(der, kids[0][1], kids[0][2])
    if not st or st[0][0] != 0x02:
        raise DERError("status missing")
    status = int.from_bytes(der[st[0][1]:st[0][2]], "big")
    if status not in (0, 1):
        raise DERError(f"TSA recusou o pedido (status {status})")
    if len(kids) < 2:
        raise DERError("token missing")
    ttag, ts, te, tpos = kids[1]
    token = der[tpos:te]
    ci = _der_children(der, ts, te)
    if len(ci) < 2 or ci[0][0] != 0x06 or _der_oid(der[ci[0][1]:ci[0][2]]) != OID_SIGNED_DATA:
        raise DERError("token is not SignedData")
    if ci[1][0] != 0xA0:
        raise DERError("token content missing")
    sd_tag, sds, sde = _der_read(der, ci[1][1])
    sd = _der_children(der, sds, sde)
    # SignedData: version, digestAlgorithms, encapContentInfo, ...
    if len(sd) < 3 or sd[2][0] != 0x30:
        raise DERError("encapContentInfo missing")
    eci = _der_children(der, sd[2][1], sd[2][2])
    if len(eci) < 2 or _der_oid(der[eci[0][1]:eci[0][2]]) != OID_TSTINFO:
        raise DERError("content is not TSTInfo")
    _, os_s, os_e = _der_read(der, eci[1][1])  # [0] EXPLICIT -> OCTET STRING
    tst = _der_children(der, *_der_read(der, os_s)[1:])
    # TSTInfo: version, policy, messageImprint, serialNumber, genTime, ...
    if len(tst) < 5:
        raise DERError("TSTInfo incompleto")
    mi = _der_children(der, tst[2][1], tst[2][2])
    alg = _der_children(der, mi[0][1], mi[0][2])
    hash_alg = _der_oid(der[alg[0][1]:alg[0][2]])
    imprint = der[mi[1][1]:mi[1][2]].hex()
    if tst[4][0] != 0x18:
        raise DERError("genTime missing")
    gt = der[tst[4][1]:tst[4][2]].decode("ascii")
    gms = parse_generalized_time(gt)
    return {"status": status, "hashAlg": hash_alg, "imprint": imprint,
            "genTimeMs": gms, "genTime": ms_to_iso(gms), "token": token}


def openssl_tsa_validator(ca_files=()):
    """Valida assinatura (e cadeia, se houver CA) de um token com o binário `openssl`.

    Devolve uma função (resp_der, token_der, commitment) -> (status, detalhe).
    """
    exe = shutil.which("openssl")

    def validate(resp_der: bytes, token_der: bytes, commitment: str):
        if not exe:
            return None, "TSA signature not validated (openssl not found)"
        with tempfile.TemporaryDirectory() as d:
            tok = os.path.join(d, "token.der")
            with open(tok, "wb") as f:
                f.write(token_der)
            # 1) assinatura CMS, sem cadeia
            r = subprocess.run([exe, "cms", "-verify", "-noverify", "-inform", "DER", "-in", tok,
                                "-binary", "-out", os.devnull], capture_output=True, text=True)
            if r.returncode != 0:
                return FAIL, "invalid TSA signature"
            # 2) cadeia até uma CA confiável
            # As CAs pedidas (--tsa-ca), as que acompanham o verificador (tsa-ca/: a raiz da FreeTSA,
            # que não está nas listas do sistema) e a lista de CAs do sistema (DigiCert e outras).
            cas = [c for c in ca_files if c] + sorted(glob.glob(os.path.join(os.path.dirname(os.path.abspath(__file__)), "tsa-ca", "*.pem")))
            for c in ("/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/cert.pem"):
                if os.path.exists(c):
                    cas.append(c)
                    break
            if not cas:
                return WARN, "valid signature; chain not validated (no CA available)"
            bundle = os.path.join(d, "ca.pem")
            with open(bundle, "w") as out:
                for c in cas:
                    with open(c) as f:
                        out.write(f.read() + "\n")
            resp = os.path.join(d, "resp.tsr")
            with open(resp, "wb") as f:
                f.write(resp_der)
            r = subprocess.run([exe, "ts", "-verify", "-digest", commitment, "-sha256", "-in", resp,
                                "-CAfile", bundle], capture_output=True, text=True)
            if r.returncode == 0:
                return PASS, "TSA signature and chain valid (openssl ts -verify)"
            return WARN, "valid signature, but the chain does not reach a trusted CA (use --tsa-ca)"

    return validate


# =============================================================================
# BLS12-381 em Python puro (verificação de assinaturas drand quicknet)
#   assinatura em G1, chave pública em G2, hash_to_curve RFC 9380
#   (BLS12381G1_XMD:SHA-256_SSWU_RO_). Lento (cerca de 1 s), mas sem dependências.
# =============================================================================

_P = 0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab
_R = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001
_X_ABS = 0xd201000000010000  # |x|, x = -0xd201000000010000
_H_EFF_G1 = 0xd201000000010001  # 1 - x

_G2_GEN = (
    (0x024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb8,
     0x13e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e),
    (0x0ce5d527727d6e118cc9cdc6da2e351aadfd9baa8cbdd3a76d429a695160d12c923ac9cc3baca289e193548608b82801,
     0x0606c4a02ea734cc32acd2b02bc28b99cb3e287e85a763af267492ab572e99ab3f370d275cec1da1aaa9075ff05f79be),
)

# SSWU para a curva isógena E1': y² = x³ + A'x + B', Z = 11
_SSWU_A = 0x144698a3b8e9433d693a02c96d4982b0ea985383ee66a8d8e8981aefd881ac98936f8da0e0f97f5cf428082d584c1d
_SSWU_B = 0x12e2908d11688030018b12e8753eee3b2016c1f0f24f4070a0b9c14fcef35ef55a23215a316ceaa5d1cc48e98e172be0
_SSWU_Z = 11

# Isogenia de grau 11 de E1' para E1 (RFC 9380, apêndice E.2); coeficiente i = termo x^i.
_ISO_XNUM = (
    0x11a05f2b1e833340b809101dd99815856b303e88a2d7005ff2627b56cdb4e2c85610c2d5f2e62d6eaeac1662734649b7,
    0x17294ed3e943ab2f0588bab22147a81c7c17e75b2f6a8417f565e33c70d1e86b4838f2a6f318c356e834eef1b3cb83bb,
    0xd54005db97678ec1d1048c5d10a9a1bce032473295983e56878e501ec68e25c958c3e3d2a09729fe0179f9dac9edcb0,
    0x1778e7166fcc6db74e0609d307e55412d7f5e4656a8dbf25f1b33289f1b330835336e25ce3107193c5b388641d9b6861,
    0xe99726a3199f4436642b4b3e4118e5499db995a1257fb3f086eeb65982fac18985a286f301e77c451154ce9ac8895d9,
    0x1630c3250d7313ff01d1201bf7a74ab5db3cb17dd952799b9ed3ab9097e68f90a0870d2dcae73d19cd13c1c66f652983,
    0xd6ed6553fe44d296a3726c38ae652bfb11586264f0f8ce19008e218f9c86b2a8da25128c1052ecaddd7f225a139ed84,
    0x17b81e7701abdbe2e8743884d1117e53356de5ab275b4db1a682c62ef0f2753339b7c8f8c8f475af9ccb5618e3f0c88e,
    0x80d3cf1f9a78fc47b90b33563be990dc43b756ce79f5574a2c596c928c5d1de4fa295f296b74e956d71986a8497e317,
    0x169b1f8e1bcfa7c42e0c37515d138f22dd2ecb803a0c5c99676314baf4bb1b7fa3190b2edc0327797f241067be390c9e,
    0x10321da079ce07e272d8ec09d2565b0dfa7dccdde6787f96d50af36003b14866f69b771f8c285decca67df3f1605fb7b,
    0x6e08c248e260e70bd1e962381edee3d31d79d7e22c837bc23c0bf1bc24c6b68c24b1b80b64d391fa9c8ba2e8ba2d229,
)
_ISO_XDEN = (
    0x8ca8d548cff19ae18b2e62f4bd3fa6f01d5ef4ba35b48ba9c9588617fc8ac62b558d681be343df8993cf9fa40d21b1c,
    0x12561a5deb559c4348b4711298e536367041e8ca0cf0800c0126c2588c48bf5713daa8846cb026e9e5c8276ec82b3bff,
    0xb2962fe57a3225e8137e629bff2991f6f89416f5a718cd1fca64e00b11aceacd6a3d0967c94fedcfcc239ba5cb83e19,
    0x3425581a58ae2fec83aafef7c40eb545b08243f16b1655154cca8abc28d6fd04976d5243eecf5c4130de8938dc62cd8,
    0x13a8e162022914a80a6f1d5f43e7a07dffdfc759a12062bb8d6b44e833b306da9bd29ba81f35781d539d395b3532a21e,
    0xe7355f8e4e667b955390f7f0506c6e9395735e9ce9cad4d0a43bcef24b8982f7400d24bc4228f11c02df9a29f6304a5,
    0x772caacf16936190f3e0c63e0596721570f5799af53a1894e2e073062aede9cea73b3538f0de06cec2574496ee84a3a,
    0x14a7ac2a9d64a8b230b3f5b074cf01996e7f63c21bca68a81996e1cdf9822c580fa5b9489d11e2d311f7d99bbdcc5a5e,
    0xa10ecf6ada54f825e920b3dafc7a3cce07f8d1d7161366b74100da67f39883503826692abba43704776ec3a79a1d641,
    0x95fc13ab9e92ad4476d6e3eb3a56680f682b4ee96f7d03776df533978f31c1593174e4b4b7865002d6384d168ecdd0a,
    0x1,
)
_ISO_YNUM = (
    0x90d97c81ba24ee0259d1f094980dcfa11ad138e48a869522b52af6c956543d3cd0c7aee9b3ba3c2be9845719707bb33,
    0x134996a104ee5811d51036d776fb46831223e96c254f383d0f906343eb67ad34d6c56711962fa8bfe097e75a2e41c696,
    0xcc786baa966e66f4a384c86a3b49942552e2d658a31ce2c344be4b91400da7d26d521628b00523b8dfe240c72de1f6,
    0x1f86376e8981c217898751ad8746757d42aa7b90eeb791c09e4a3ec03251cf9de405aba9ec61deca6355c77b0e5f4cb,
    0x8cc03fdefe0ff135caf4fe2a21529c4195536fbe3ce50b879833fd221351adc2ee7f8dc099040a841b6daecf2e8fedb,
    0x16603fca40634b6a2211e11db8f0a6a074a7d0d4afadb7bd76505c3d3ad5544e203f6326c95a807299b23ab13633a5f0,
    0x4ab0b9bcfac1bbcb2c977d027796b3ce75bb8ca2be184cb5231413c4d634f3747a87ac2460f415ec961f8855fe9d6f2,
    0x987c8d5333ab86fde9926bd2ca6c674170a05bfe3bdd81ffd038da6c26c842642f64550fedfe935a15e4ca31870fb29,
    0x9fc4018bd96684be88c9e221e4da1bb8f3abd16679dc26c1e8b6e6a1f20cabe69d65201c78607a360370e577bdba587,
    0xe1bba7a1186bdb5223abde7ada14a23c42a0ca7915af6fe06985e7ed1e4d43b9b3f7055dd4eba6f2bafaaebca731c30,
    0x19713e47937cd1be0dfd0b8f1d43fb93cd2fcbcb6caf493fd1183e416389e61031bf3a5cce3fbafce813711ad011c132,
    0x18b46a908f36f6deb918c143fed2edcc523559b8aaf0c2462e6bfe7f911f643249d9cdf41b44d606ce07c8a4d0074d8e,
    0xb182cac101b9399d155096004f53f447aa7b12a3426b08ec02710e807b4633f06c851c1919211f20d4c04f00b971ef8,
    0x245a394ad1eca9b72fc00ae7be315dc757b3b080d4c158013e6632d3c40659cc6cf90ad1c232a6442d9d3f5db980133,
    0x5c129645e44cf1102a159f748c4a3fc5e673d81d7e86568d9ab0f5d396a7ce46ba1049b6579afb7866b1e715475224b,
    0x15e6be4e990f03ce4ea50b3b42df2eb5cb181d8f84965a3957add4fa95af01b2b665027efec01c7704b456be69c8b604,
)
_ISO_YDEN = (
    0x16112c4c3a9c98b252181140fad0eae9601a6de578980be6eec3232b5be72e7a07f3688ef60c206d01479253b03663c1,
    0x1962d75c2381201e1a0cbd6c43c348b885c84ff731c4d59ca4a10356f453e01f78a4260763529e3532f6102c2e49a03d,
    0x58df3306640da276faaae7d6e8eb15778c4855551ae7f310c35a5dd279cd2eca6757cd636f96f891e2538b53dbf67f2,
    0x16b7d288798e5395f20d23bf89edb4d1d115c5dbddbcd30e123da489e726af41727364f2c28297ada8d26d98445f5416,
    0xbe0e079545f43e4b00cc912f8228ddcc6d19c9f0f69bbb0542eda0fc9dec916a20b15dc0fd2ededda39142311a5001d,
    0x8d9e5297186db2d9fb266eaac783182b70152c65550d881c5ecd87b6f0f5a6449f38db9dfa9cce202c6477faaf9b7ac,
    0x166007c08a99db2fc3ba8734ace9824b5eecfdfa8d0cf8ef5dd365bc400a0051d5fa9c01a58b1fb93d1a1399126a775c,
    0x16a3ef08be3ea7ea03bcddfabba6ff6ee5a4375efa1f4fd7feb34fd206357132b920f5b00801dee460ee415a15812ed9,
    0x1866c8ed336c61231a1be54fd1d74cc4f9fb0ce4c6af5920abc5750c4bf39b4852cfe2f7bb9248836b233d9d55535d4a,
    0x167a55cda70a6e1cea820597d94a84903216f763e13d87bb5308592e7ea7d4fbc7385ea3d529b35e346ef48bb8913f55,
    0x4d2f259eea405bd48f010a01ad2911d9c6dd039bb61a6290e591b36e636a5c871a5c29f4f83060400f8b49cba8f6aa8,
    0xaccbb67481d033ff5852c1e48c50c477f94ff8aefce42d28c0f9a88cea7913516f968986f7ebbea9684b529e2561092,
    0xad6b9514c767fe3c3613144b45f1496543346d98adf02267d5ceef9a00d9b8693000763e3b90ac11e99b138573345cc,
    0x2660400eb2e4f3b628bdd0d53cd76f2bf565b94e72927c1cb748df27942480e420517bd8714cc80d1fadc1326ed06f7,
    0xe0fa1d816ddc03e6b24255e0d7819c171c40f65e273b853324efcd6356caa205ca2f570f13497804415473a1d634b8f,
    0x1,
)


class _Fp:
    zero, one = 0, 1

    @staticmethod
    def add(a, b): return (a + b) % _P

    @staticmethod
    def sub(a, b): return (a - b) % _P

    @staticmethod
    def mul(a, b): return (a * b) % _P

    @staticmethod
    def neg(a): return (-a) % _P

    @staticmethod
    def inv(a):
        if a % _P == 0:
            raise ZeroDivisionError
        return pow(a, _P - 2, _P)

    @staticmethod
    def small(n): return n % _P


class _Fp2:
    zero, one = (0, 0), (1, 0)

    @staticmethod
    def add(a, b): return ((a[0] + b[0]) % _P, (a[1] + b[1]) % _P)

    @staticmethod
    def sub(a, b): return ((a[0] - b[0]) % _P, (a[1] - b[1]) % _P)

    @staticmethod
    def mul(a, b):
        return ((a[0] * b[0] - a[1] * b[1]) % _P, (a[0] * b[1] + a[1] * b[0]) % _P)

    @staticmethod
    def neg(a): return ((-a[0]) % _P, (-a[1]) % _P)

    @staticmethod
    def inv(a):
        n = (a[0] * a[0] + a[1] * a[1]) % _P
        if n == 0:
            raise ZeroDivisionError
        t = pow(n, _P - 2, _P)
        return (a[0] * t % _P, (-a[1] * t) % _P)

    @staticmethod
    def small(n): return (n % _P, 0)

    @staticmethod
    def pow(a, e):
        r, b = (1, 0), a
        while e:
            if e & 1:
                r = _Fp2.mul(r, b)
            b = _Fp2.mul(b, b)
            e >>= 1
        return r


def _fp_sqrt(a):
    a %= _P
    s = pow(a, (_P + 1) // 4, _P)
    return s if s * s % _P == a else None


def _fp2_sqrt(a):
    if a == (0, 0):
        return (0, 0)
    a1 = _Fp2.pow(a, (_P - 3) // 4)
    alpha = _Fp2.mul(_Fp2.mul(a1, a1), a)
    a0 = _Fp2.mul((alpha[0], (-alpha[1]) % _P), alpha)
    if a0 == (_P - 1, 0):
        return None
    x0 = _Fp2.mul(a1, a)
    if alpha == (_P - 1, 0):
        x = _Fp2.mul((0, 1), x0)
    else:
        x = _Fp2.mul(_Fp2.pow(_Fp2.add((1, 0), alpha), (_P - 1) // 2), x0)
    return x if _Fp2.mul(x, x) == a else None


def _ec_double(F, pt):
    if pt is None:
        return None
    x, y = pt
    if y == F.zero:
        return None
    m = F.mul(F.mul(F.small(3), F.mul(x, x)), F.inv(F.mul(F.small(2), y)))
    x3 = F.sub(F.mul(m, m), F.mul(F.small(2), x))
    return (x3, F.sub(F.mul(m, F.sub(x, x3)), y))


def _ec_add(F, p1, p2):
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    (x1, y1), (x2, y2) = p1, p2
    if x1 == x2:
        return _ec_double(F, p1) if y1 == y2 else None
    m = F.mul(F.sub(y2, y1), F.inv(F.sub(x2, x1)))
    x3 = F.sub(F.sub(F.mul(m, m), x1), x2)
    return (x3, F.sub(F.mul(m, F.sub(x1, x3)), y1))


def _ec_mul(F, pt, n):
    r = None
    while n:
        if n & 1:
            r = _ec_add(F, r, pt)
        pt = _ec_double(F, pt)
        n >>= 1
    return r


def _ec_neg(F, pt):
    return None if pt is None else (pt[0], F.neg(pt[1]))


_B_G1 = 4
_B_G2 = (4, 4)


def _on_g1(pt):
    x, y = pt
    return (y * y - x * x * x - _B_G1) % _P == 0


def _on_g2(pt):
    x, y = pt
    return _Fp2.sub(_Fp2.mul(y, y), _Fp2.add(_Fp2.mul(_Fp2.mul(x, x), x), _B_G2)) == (0, 0)


def g1_decompress(b: bytes):
    if len(b) != 48:
        raise ValueError("assinatura G1 deve ter 48 bytes")
    flags = b[0]
    if not flags & 0x80:
        raise ValueError("G1 point not compressed")
    if flags & 0x40:
        raise ValueError("ponto G1 no infinito")
    x = int.from_bytes(bytes([flags & 0x1F]) + b[1:], "big")
    if x >= _P:
        raise ValueError("G1 coordinate outside the field")
    y = _fp_sqrt(x * x * x + _B_G1)
    if y is None:
        raise ValueError("G1 point not on the curve")
    if (y > (_P - 1) // 2) != bool(flags & 0x20):
        y = (-y) % _P
    pt = (x, y)
    if _ec_mul(_Fp, pt, _R) is not None:
        raise ValueError("G1 point not in the subgroup")
    return pt


def g2_decompress(b: bytes):
    if len(b) != 96:
        raise ValueError("chave G2 deve ter 96 bytes")
    flags = b[0]
    if not flags & 0x80 or flags & 0x40:
        raise ValueError("invalid G2 key")
    x1 = int.from_bytes(bytes([flags & 0x1F]) + b[1:48], "big")
    x0 = int.from_bytes(b[48:], "big")
    if x0 >= _P or x1 >= _P:
        raise ValueError("G2 coordinate outside the field")
    x = (x0, x1)
    y = _fp2_sqrt(_Fp2.add(_Fp2.mul(_Fp2.mul(x, x), x), _B_G2))
    if y is None:
        raise ValueError("G2 point not on the curve")
    largest = (y[1] > (_P - 1) // 2) if y[1] else (y[0] > (_P - 1) // 2)
    if largest != bool(flags & 0x20):
        y = _Fp2.neg(y)
    pt = (x, y)
    if _ec_mul(_Fp2, pt, _R) is not None:
        raise ValueError("G2 point not in the subgroup")
    return pt


def _expand_message_xmd(msg: bytes, dst: bytes, length: int) -> bytes:
    ell = -(-length // 32)
    if ell > 255 or len(dst) > 255:
        raise ValueError("expand_message_xmd: invalid parameters")
    dst_prime = dst + bytes([len(dst)])
    b0 = hashlib.sha256(bytes(64) + msg + length.to_bytes(2, "big") + b"\x00" + dst_prime).digest()
    bi = hashlib.sha256(b0 + b"\x01" + dst_prime).digest()
    out = bi
    for i in range(2, ell + 1):
        bi = hashlib.sha256(bytes(x ^ y for x, y in zip(b0, bi)) + bytes([i]) + dst_prime).digest()
        out += bi
    return out[:length]


def _hash_to_field_fp(msg: bytes, dst: bytes, count: int):
    u = _expand_message_xmd(msg, dst, 64 * count)
    return [int.from_bytes(u[64 * i:64 * (i + 1)], "big") % _P for i in range(count)]


def _is_square(a):
    a %= _P
    return a == 0 or pow(a, (_P - 1) // 2, _P) == 1


def _sswu(u):
    A, B, Z = _SSWU_A, _SSWU_B, _SSWU_Z
    zu2 = Z * u * u % _P
    den = (zu2 * zu2 + zu2) % _P
    if den == 0:
        x1 = B * pow(Z * A % _P, _P - 2, _P) % _P
    else:
        x1 = (-B) * pow(A, _P - 2, _P) * (1 + pow(den, _P - 2, _P)) % _P
    gx1 = (x1 * x1 * x1 + A * x1 + B) % _P
    if _is_square(gx1):
        x, y = x1, _fp_sqrt(gx1)
    else:
        x = zu2 * x1 % _P
        y = _fp_sqrt((x * x * x + A * x + B) % _P)
    if (u % 2) != (y % 2):
        y = (-y) % _P
    return x, y


def _horner(coeffs, x):
    acc = 0
    for c in reversed(coeffs):
        acc = (acc * x + c) % _P
    return acc


def _iso_map_g1(x, y):
    xn, xd = _horner(_ISO_XNUM, x), _horner(_ISO_XDEN, x)
    yn, yd = _horner(_ISO_YNUM, x), _horner(_ISO_YDEN, x)
    return (xn * pow(xd, _P - 2, _P) % _P, y * yn * pow(yd, _P - 2, _P) % _P)


def hash_to_g1(msg: bytes, dst: bytes):
    u0, u1 = _hash_to_field_fp(msg, dst, 2)
    q0 = _iso_map_g1(*_sswu(u0))
    q1 = _iso_map_g1(*_sswu(u1))
    return _ec_mul(_Fp, _ec_add(_Fp, q0, q1), _H_EFF_G1)


# ---- Fp12 = Fp[w] / (w^12 - 2 w^6 + 2); Fp2 entra por i = w^6 - 1

_F12_ONE = [1] + [0] * 11
_F12_MOD = [2, 0, 0, 0, 0, 0, _P - 2, 0, 0, 0, 0, 0, 1]


def _f12_mul(a, b):
    prod = [0] * 23
    for i, ai in enumerate(a):
        if ai:
            for j, bj in enumerate(b):
                if bj:
                    prod[i + j] += ai * bj
    for k in range(22, 11, -1):
        c = prod[k]
        if c:
            prod[k - 6] += 2 * c
            prod[k - 12] -= 2 * c
    return [x % _P for x in prod[:12]]


def _f12_add(a, b): return [(x + y) % _P for x, y in zip(a, b)]


def _f12_sub(a, b): return [(x - y) % _P for x, y in zip(a, b)]


def _f12_scale(a, k): return [(x * k) % _P for x in a]


def _poly_trim(a):
    a = list(a)
    while len(a) > 1 and a[-1] == 0:
        a.pop()
    return a


def _poly_divmod(n, d):
    n = _poly_trim(n)
    d = _poly_trim(d)
    q = [0] * max(1, len(n) - len(d) + 1)
    inv_lead = pow(d[-1], _P - 2, _P)
    n = n[:]
    while len(n) >= len(d) and any(n):
        k = len(n) - len(d)
        c = n[-1] * inv_lead % _P
        q[k] = c
        for i, di in enumerate(d):
            n[k + i] = (n[k + i] - c * di) % _P
        n = _poly_trim(n)
        if len(n) == 1 and len(d) == 1:
            break
    return q, n


def _poly_mul(a, b):
    out = [0] * (len(a) + len(b) - 1)
    for i, x in enumerate(a):
        if x:
            for j, y in enumerate(b):
                out[i + j] = (out[i + j] + x * y) % _P
    return out


def _poly_sub(a, b):
    n = max(len(a), len(b))
    a = a + [0] * (n - len(a))
    b = b + [0] * (n - len(b))
    return _poly_trim([(x - y) % _P for x, y in zip(a, b)])


def _f12_inv(a):
    r0, r1 = _F12_MOD[:], _poly_trim(a)
    s0, s1 = [0], [1]
    while len(r1) > 1:
        q, rem = _poly_divmod(r0, r1)
        r0, r1 = r1, rem
        s0, s1 = s1, _poly_sub(s0, _poly_mul(q, s1))
    if r1[0] == 0:
        raise ZeroDivisionError
    c = pow(r1[0], _P - 2, _P)
    _, s1 = _poly_divmod(s1, _F12_MOD) if len(s1) > 12 else (None, s1)
    s1 = [x * c % _P for x in s1]
    return s1 + [0] * (12 - len(s1))


def _f12_pow(a, e):
    r = _F12_ONE[:]
    for bit in bin(e)[2:]:
        r = _f12_mul(r, r)
        if bit == "1":
            r = _f12_mul(r, a)
    return r


_W_INV = _f12_inv([0, 1] + [0] * 10)
_W_INV2 = _f12_mul(_W_INV, _W_INV)
_W_INV3 = _f12_mul(_W_INV2, _W_INV)


def _f2_to_f12(a):
    out = [0] * 12
    out[0] = (a[0] - a[1]) % _P
    out[6] = a[1] % _P
    return out


def _twist(pt):
    x, y = pt
    return (_f12_mul(_f2_to_f12(x), _W_INV2), _f12_mul(_f2_to_f12(y), _W_INV3))


def _embed_g1(pt):
    return ([pt[0]] + [0] * 11, [pt[1]] + [0] * 11)


def _miller(Q, Pt):
    """Laço de Miller (ate) para Q em G2 (torcido para Fp12) e P em G1 (embutido)."""
    xt, yt = Pt
    R = Q
    f = _F12_ONE[:]
    for i in range(_X_ABS.bit_length() - 2, -1, -1):
        x1, y1 = R
        m = _f12_mul(_f12_scale(_f12_mul(x1, x1), 3), _f12_inv(_f12_scale(y1, 2)))
        line = _f12_sub(_f12_mul(m, _f12_sub(xt, x1)), _f12_sub(yt, y1))
        f = _f12_mul(_f12_mul(f, f), line)
        x3 = _f12_sub(_f12_mul(m, m), _f12_scale(x1, 2))
        R = (x3, _f12_sub(_f12_mul(m, _f12_sub(x1, x3)), y1))
        if (_X_ABS >> i) & 1:
            (x1, y1), (x2, y2) = R, Q
            m = _f12_mul(_f12_sub(y2, y1), _f12_inv(_f12_sub(x2, x1)))
            line = _f12_sub(_f12_mul(m, _f12_sub(xt, x1)), _f12_sub(yt, y1))
            f = _f12_mul(f, line)
            x3 = _f12_sub(_f12_sub(_f12_mul(m, m), x1), x2)
            R = (x3, _f12_sub(_f12_mul(m, _f12_sub(x1, x3)), y1))
    return f


_FINAL_EXP = (_P ** 12 - 1) // _R


def pairing_check(pairs) -> bool:
    """True se o produto dos emparelhamentos e(P_i, Q_i) (P em G1, Q em G2) for 1."""
    f = _F12_ONE[:]
    for p1, q2 in pairs:
        if p1 is None or q2 is None:
            continue
        f = _f12_mul(f, _miller(_twist(q2), _embed_g1(p1)))
    return _f12_pow(f, _FINAL_EXP) == _F12_ONE


def bls_verify_g1(signature: bytes, message: bytes, pubkey: bytes, dst: bytes = DRAND_DST) -> bool:
    """Verificação BLS com assinatura em G1 e chave pública em G2 (esquema drand quicknet)."""
    try:
        sig = g1_decompress(signature)
        pk = g2_decompress(pubkey)
    except ValueError:
        return False
    hm = hash_to_g1(message, dst)
    # e(S, G2) == e(H(m), PK)  <=>  e(S, G2) · e(H(m), -PK) == 1
    return pairing_check([(sig, _G2_GEN), (hm, _ec_neg(_Fp2, pk))])


@lru_cache(maxsize=64)
def drand_beacon_valid(round_: int, signature_hex: str, pubkey_hex: str = QUICKNET_PUBKEY) -> bool:
    msg = hashlib.sha256(round_.to_bytes(8, "big")).digest()
    try:
        return bls_verify_g1(bytes.fromhex(signature_hex), msg, bytes.fromhex(pubkey_hex))
    except ValueError:
        return False


# =============================================================================
# Validação do spec (SPEC 3.2, 9 passo 2)
# =============================================================================

def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def _is_norm_str(v):
    return isinstance(v, str) and norm_text(v) == v


def validate_spec(spec) -> list:
    """Lista de problemas do spec (vazia se bem formado)."""
    problems = []
    if not isinstance(spec, dict):
        return ["spec is not an object"]
    v = spec.get("v")
    try:
        _check_json_types(spec, "spec", _bool_paths(spec))
    except ValueError as e:
        problems.append(str(e))
    if v in (V2, V3):
        expected = ({"v", "id", "title", "mode", "contribution", "sources", "task"} if v == V3
                    else {"v", "id", "title", "mode", "candidates", "contribution", "sources"})
        missing, extra = expected - spec.keys(), spec.keys() - expected
        if missing:
            problems.append("missing fields: " + ", ".join(sorted(missing)))
        if extra:
            problems.append("unknown fields: " + ", ".join(sorted(extra)))
        if spec.get("mode") not in ("live", "scheduled"):
            problems.append("mode must be \"live\" or \"scheduled\"")
    for f in ("id", "title", "contribution"):
        if f in spec and not _is_norm_str(spec[f]):
            problems.append(f"{f} is not normalized (NFC, no leading or trailing spaces)")
    if not isinstance(spec.get("id"), str) or not spec.get("id"):
        problems.append("the draw ID is empty")
    if v == V3:
        problems.extend(validate_task(spec.get("task")))
    else:
        cands = spec.get("candidates")
        if not isinstance(cands, list):
            problems.append("candidates is not a list")
            cands = []
        if len(cands) < 2:
            problems.append("at least 2 participants are needed")
        for i, n in enumerate(cands):
            if not isinstance(n, str) or not n:
                problems.append(f"participant {i + 1} empty or invalid")
            elif norm_text(n) != n:
                problems.append(f"participant {i + 1} is not normalized (NFC, no leading or trailing spaces)")
        strs = [n for n in cands if isinstance(n, str)]
        dups = sorted({n for n in strs if strs.count(n) > 1})
        if dups:
            problems.append("nomes repetidos: " + ", ".join(dups))
    src = spec.get("sources")
    if not isinstance(src, dict) or not src:
        problems.append("sources empty or invalid")
        return problems
    allowed = SOURCE_ORDER + ("own", "inmetro") if v == V3 else SOURCE_ORDER if v == V2 else ("eth", "drand")
    for k in src:
        if k not in allowed:
            problems.append(f"unknown source: {k}")
    strict = v in (V2, V3)

    def need(name, obj, fields):
        if not isinstance(obj, dict):
            problems.append(f"sources.{name} is not an object")
            return False
        if strict and set(obj.keys()) != set(fields):
            problems.append(f"sources.{name} must have exactly the fields " + ", ".join(fields))
            return False
        return True

    if "eth" in src:
        e = src["eth"]
        fields = ("chain", "rule", "notBefore", "confirmations")
        if need("eth", e, fields if strict else ()):
            if strict and (e.get("chain") != "ethereum-mainnet" or e.get("rule") != "first-block-after"):
                problems.append("sources.eth: chain/rule inesperados")
            if not _is_int(e.get("notBefore")) or not _is_int(e.get("confirmations")) or e.get("confirmations", 0) < 1:
                problems.append("sources.eth: invalid notBefore/confirmations")
    if "drand" in src:
        d = src["drand"]
        if need("drand", d, ("chain", "chainHash", "round") if strict else ()):
            if d.get("chainHash") != QUICKNET_HASH or (strict and d.get("chain") != "quicknet"):
                problems.append("sources.drand: the chain is not quicknet")
            if not _is_int(d.get("round")) or d.get("round", 0) < 1:
                problems.append("sources.drand: invalid round")
    if "inmetro" in src:
        if len(src) != 1:
            problems.append("the Inmetro beacon cannot be combined with other sources")
        if need("inmetro", src["inmetro"], ("chain", "rule", "notBefore")):
            i_ = src["inmetro"]
            if not (_is_int(i_.get("chain")) and i_["chain"] >= 0 and i_.get("rule") == INMETRO_RULE
                    and _is_int(i_.get("notBefore")) and i_["notBefore"] > 0):
                problems.append('sources.inmetro needs chain (integer), rule "first-pulse-after" and notBefore (ms, integer)')
    if "own" in src:
        if len(src) != 1:
            problems.append("the own seed cannot be combined with other sources")
        if need("own", src["own"], ("format", "label")):
            if src["own"].get("format") not in OWN_FORMATS:
                problems.append("unknown own-seed format (megasena, federal or outro)")
            if not _is_norm_str(src["own"].get("label")):
                problems.append("sources.own.label is not normalized (NFC, no leading or trailing spaces)")
    for g in ("megasena", "federal"):
        if g in src and need(g, src[g], ("contest",)):
            c = src[g].get("contest")
            if (not contest_ok_v3(c)) if v == V3 else (not _is_int(c) or c < 1):
                problems.append(f"sources.{g}: invalid draw number")
    return problems


# =============================================================================
# Algoritmo de conferência (SPEC 9), função pura
# =============================================================================

def _same_list(a, b) -> bool:
    """Igualdade estrita de listas (em Python, True == 1; aqui não)."""
    return isinstance(a, list) and len(a) == len(b) and all(type(x) is type(y) and x == y for x, y in zip(a, b))


def _fmt_unix(s):
    return ms_to_iso(int(s * 1000))


def verify_certificate(cert, fetched=None, *, drand_pubkey: str = QUICKNET_PUBKEY,
                       lottery_confirmed: bool = False, tsa_validator=None) -> dict:
    """Confere um comprovante com valores das fontes já obtidos de forma independente.

    `fetched` (todas as chaves opcionais; ausência ou {"error": ...} = não consultado):
      "eth":   {"block": {"number","hash","timestamp"} | None,
                "parent": {"number","hash","timestamp"} | None, "head": int}
      "drand": {"round", "randomness", "signature"}       (resposta crua; BLS verificado aqui)
      "megasena": {"contest","numbers","drawDate"} | None  (None = sem resultado publicado)
      "federal":  {"contest","prizes","drawDate"}  | None
    `tsa_validator(resp_der, token_der, commitment) -> (status|None, detalhe)` valida a
    assinatura RFC 3161 (ex.: openssl_tsa_validator()); None = só lê o token.

    Devolve {"drawId", "version", "checks": [{"id","status","title","detail"}], "verdict", "message", "order"}
    e, para LucentDraw/3, "v3": {"task", "ints", "W", "seed", "picks", "result", "steps"}.
    """
    fetched = fetched or {}
    checks = []
    v3info = {}

    def add(cid, status, title, detail=""):
        checks.append({"id": cid, "status": status, "title": title, "detail": detail})

    def result(order=None):
        rep = _verdict(cert, checks, lottery_confirmed, order)
        if v3info:
            rep["v3"] = v3info
        return rep

    # 1. Formato
    if not isinstance(cert, dict) or not isinstance(cert.get("spec"), dict):
        add("parse", FAIL, "The proof has no spec object.")
        return result()
    spec = cert["spec"]
    v = spec.get("v")
    if v not in (V1, V2, V3):
        add("parse", FAIL, f"Unknown protocol version: {v!r}.")
        return result()
    if not isinstance(cert.get("commitment"), str):
        add("parse", FAIL, "The proof has no commitment.")
        return result()
    add("parse", PASS, f"Proof read (protocol {v}).")

    # 2. Spec bem formado
    problems = validate_spec(spec)
    task_ok = v == V3 and not validate_task(spec.get("task"))
    if task_ok:
        ints, _, W = integer_weights(spec["task"]["weights"])
        v3info.update({"task": spec["task"], "ints": ints, "W": W, "seed": None, "picks": None, "result": None, "steps": None})
    if problems:
        add("spec", FAIL, "The sealed record is not well formed.", "; ".join(problems))
    elif v == V3:
        t = spec["task"]
        n = len(t["options"])
        pairs = ", ".join(f"{w} → {i}" for w, i in list(zip(t["weights"], ints))[:12]) + (", …" if n > 12 else "")
        add("spec", PASS, "Sealed record well formed.",
            f"{n} option" + ("" if n == 1 else "s") + f" · W = {W} · {task_summary(t)} · "
            f"weights (typed → integer): {pairs}")
    else:
        add("spec", PASS, "Sealed record well formed.",
            f"{len(spec['candidates'])} participants, names unique and normalized")

    # 3. Compromisso
    try:
        C = commitment_of(spec)
    except ValueError as e:
        add("commitment", FAIL, "Could not compute the commitment.", str(e))
        return result()
    if C == cert["commitment"]:
        add("commitment", PASS, "The commitment matches the sealed record.", C)
    else:
        add("commitment", FAIL, "The commitment does not match the sealed record.",
            f"computed {C}, proof {cert['commitment']}")

    sources = spec.get("sources") if isinstance(spec.get("sources"), dict) else {}
    rand = cert.get("randomness") if isinstance(cert.get("randomness"), dict) else {}
    # Um lacre (SPEC 3.3): sem aleatoriedade, sem semente e sem ordem. Fontes ficam pendentes, não falham.
    is_seal = not rand and not any(k in cert for k in ("seed", "order", "result", "picks"))
    missing = UNVERIFIED if is_seal else FAIL
    indep = {}   # valores obtidos de forma independente
    claimed = {}  # valores segundo o comprovante
    rtimes = {}  # momento em que cada aleatoriedade passou a existir (unix s), só eth e drand
    draw_dates = {}  # loteria -> (data do sorteio, "oficial" | "comprovante")

    # 4. semente própria: a forma canônica e o formato se conferem; a origem, não (fica "não verificado")
    if "own" in sources:
        so = sources["own"] if isinstance(sources["own"], dict) else {}
        ev = rand.get("own") if isinstance(rand.get("own"), dict) else None
        if not ev or not isinstance(ev.get("value"), str):
            add("own", missing, "Seal: the own seed has not been recorded yet." if is_seal
                else "The own seed is not in the proof.")
        else:
            c = canon_own_seed(ev["value"])
            if "error" in c or c["value"] != ev["value"] or c["reading"] != ev.get("reading"):
                add("own", FAIL, "The own seed is not in canonical form.", json.dumps(ev["value"], ensure_ascii=False))
            elif own_format_error(so.get("format"), c):
                add("own", FAIL, f"The own seed does not have the declared format: {so.get('format')}", c["value"])
            else:
                claimed["own"] = c["value"]
                add("own", UNVERIFIED, f"Own seed ({so.get('label')}): {c['value']}",
                    "given by the organizer; its origin cannot be checked automatically. "
                    "Check it at the stated source.")

    # 4a. eth
    if "eth" in sources:
        s = sources["eth"]
        ev = rand.get("eth") if isinstance(rand.get("eth"), dict) else None
        f = fetched.get("eth") or {}
        nb = s.get("notBefore") if _is_int(s.get("notBefore")) else None
        if ev and isinstance(ev.get("hash"), str):
            claimed["eth"] = norm_hex(ev["hash"])
        if nb is not None:
            rtimes["eth"] = nb + 1
        if not ev or not _is_int(ev.get("number")):
            add("eth", missing, "Seal: the Ethereum block has not been recorded yet." if is_seal
                else "The proof does not say which Ethereum block was used.")
        elif "error" in f or "block" not in f:
            add("eth", UNVERIFIED, f"Ethereum block #{ev['number']} could not be looked up.",
                f.get("error", "not looked up"))
        else:
            b, p = f.get("block"), f.get("parent")
            if not b or not p:
                add("eth", FAIL, f"Block #{ev['number']} or its predecessor does not exist on the chain consulted.")
            else:
                bh = norm_hex(b["hash"])
                rtimes["eth"] = b["timestamp"]
                is_first = nb is not None and b["timestamp"] > nb >= p["timestamp"]
                same = bh == claimed.get("eth")
                conf = f.get("head", b["number"]) - b["number"]
                det = (f"notBefore {_fmt_unix(nb or 0)} · block {_fmt_unix(b['timestamp'])} · "
                       f"previous {_fmt_unix(p['timestamp'])} · {conf} confirmations now")
                if not is_first:
                    add("eth", FAIL, f"Block #{b['number']} is not the first block after the seal.", det)
                elif not same:
                    indep["eth"] = bh
                    add("eth", FAIL, f"The hash of block #{b['number']} differs from the canonical chain "
                        "(a chain reorganization or a tampered value). By the rule, the canonical block counts.",
                        f"canonical {bh} · proof {claimed.get('eth')} · {det}")
                elif ev.get("timestamp") not in (None, b["timestamp"]) or (
                        ev.get("parentTimestamp") not in (None, p["timestamp"])):
                    indep["eth"] = bh
                    add("eth", FAIL, "The block times in the proof do not match the chain.", det)
                elif conf < s.get("confirmations", 1):
                    indep["eth"] = bh
                    add("eth", WARN, f"Block #{b['number']} matches, but has only {conf} confirmations so far.", det)
                else:
                    indep["eth"] = bh
                    add("eth", PASS, f"Block #{b['number']} is the first after the seal and is on the canonical chain.",
                        f"{bh} · {det}")

    # 4b. drand
    if "drand" in sources:
        s = sources["drand"]
        rnd = s.get("round")
        ev = rand.get("drand") if isinstance(rand.get("drand"), dict) else None
        if ev and isinstance(ev.get("randomness"), str):
            claimed["drand"] = norm_hex(ev["randomness"])
        if _is_int(rnd):
            rtimes["drand"] = drand_round_time(rnd)
        f = fetched.get("drand") or {}
        if not ev:
            add("drand", missing, f"Seal: drand round #{rnd} has not been recorded yet." if is_seal
                else f"The proof does not contain drand round #{rnd}.")
        elif "error" in f or "signature" not in f:
            add("drand", UNVERIFIED, f"drand round #{rnd} could not be looked up.", f.get("error", "not looked up"))
        else:
            sig = norm_hex(f["signature"])
            r_hex = norm_hex(f.get("randomness"))
            try:
                sig_hash = hashlib.sha256(bytes.fromhex(sig)).hexdigest()
            except ValueError:
                sig_hash = None
            if f.get("round") != rnd:
                add("drand", FAIL, f"The source returned round {f.get('round')} instead of {rnd}.")
            elif sig_hash != r_hex:
                add("drand", FAIL, "The drand randomness is not the SHA-256 of the signature.")
            elif not drand_beacon_valid(rnd, sig, drand_pubkey):
                add("drand", FAIL, f"The BLS signature of drand round #{rnd} is invalid.")
            elif r_hex != claimed.get("drand"):
                indep["drand"] = r_hex
                add("drand", FAIL, f"drand round #{rnd} verified, but the proof contains a different value.",
                    f"beacon {r_hex} · proof {claimed.get('drand')}")
            else:
                indep["drand"] = r_hex
                add("drand", PASS, f"drand round #{rnd}: BLS signature verified, value matches.", r_hex)

    # 4c. loterias
    for game, label in (("megasena", "Mega-Sena"), ("federal", "Loteria Federal")):
        if game not in sources:
            continue
        contest = sources[game].get("contest")
        ev = rand.get(game) if isinstance(rand.get(game), dict) else None
        link = OFFICIAL_PAGES[game]
        ok_ev = bool(ev) and ev.get("contest") == contest and lottery_evidence_ok(game, ev, v)
        if ok_ev:
            claimed[game] = lottery_value(game, contest, ev, v)
            if draw_day_start(ev.get("drawDate")) is not None:
                draw_dates[game] = (ev["drawDate"], "the proof")
        manual = " (result entered by hand)" if ev and ev.get("source") == "manual" else ""
        f = fetched.get(game, {"error": "not looked up"})
        if not ok_ev:
            add(game, missing, f"Seal: the result of draw no. {contest} ({label}) has not been recorded yet." if is_seal
                else f"{label}: the proof does not contain a valid result for draw no. {contest}.")
            continue
        if isinstance(f, dict) and "error" not in f:
            off = lottery_value(game, contest, f, v)
            indep[game] = off
            if draw_day_start(f.get("drawDate")) is not None:
                draw_dates[game] = (f["drawDate"], "the official page")
            if off == claimed[game]:
                add(game, PASS, f"{label}, draw no. {contest}: matches the official result{manual}.",
                    f"{off} · {link}")
            else:
                add(game, FAIL, f"{label}, draw no. {contest}: the proof differs from the official result{manual}.",
                    f"official {off} · proof {claimed[game]} · {link}")
        else:
            why = "no result published" if f is None else f.get("error", "")
            add(game, UNVERIFIED, f"{label}, draw no. {contest}: not verified automatically{manual}. "
                "Compare the numbers with the official page.",
                f"numbers used: {claimed[game]} · {link} · ({why})")

    # 4c. farol do Inmetro
    if "inmetro" in sources:
        s = sources["inmetro"] if isinstance(sources["inmetro"], dict) else {}
        p = rand.get("inmetro") if isinstance(rand.get("inmetro"), dict) else None
        T = inmetro_minute_after(s["notBefore"]) if _is_int(s.get("notBefore")) else None
        if T is not None:
            rtimes["inmetro"] = T / 1000
        if not p:
            add("inmetro", missing, "Seal: the Inmetro pulse has not been recorded yet." if is_seal
                else "The Inmetro pulse is not in the proof.")
        else:
            ts = iso_to_ms(p.get("timeStamp")) if isinstance(p.get("timeStamp"), str) else None
            det = f"notBefore {ms_to_iso(s.get('notBefore') or 0)} · pulse {p.get('timeStamp')} · no. {p.get('pulseIndex')}"
            if not inmetro_intact(p):
                add("inmetro", FAIL, "The Inmetro pulse was altered: the outputValue is not the SHA-512 of its fields.", det)
            elif p.get("chainIndex") != s.get("chain"):
                add("inmetro", FAIL, f"The pulse is from Inmetro chain {p.get('chainIndex')}, but the seal specified chain {s.get('chain')}.", det)
            elif ts is None or not ts > s.get("notBefore", 0):
                add("inmetro", FAIL, "The Inmetro pulse is not after the seal.", det)
            else:
                claimed["inmetro"] = norm_hex(p["outputValue"])
                rtimes["inmetro"] = ts / 1000
                f = fetched.get("inmetro") or {}
                if "error" in f or "pulse" not in f:
                    title = (f"Inmetro pulse no. {p['pulseIndex']} intact and in the right minute, but not compared with Inmetro's archive"
                             if ts == T else
                             f"Inmetro pulse no. {p['pulseIndex']} intact, but it could not be confirmed with Inmetro that it is the first after the seal")
                    add("inmetro", UNVERIFIED, title, f"{f.get('error', 'not looked up')} · {det}")
                elif not isinstance(f["pulse"], dict) or norm_hex(f["pulse"].get("outputValue")) != claimed["inmetro"]:
                    add("inmetro", FAIL, f"Inmetro's archive has a different value for pulse no. {p['pulseIndex']}.", det)
                elif ts != T and f.get("atT"):
                    add("inmetro", FAIL, f"There is an Inmetro pulse at {ms_to_iso(T)}, before the pulse used: it is not the first after the seal.", det)
                else:
                    indep["inmetro"] = claimed["inmetro"]
                    add("inmetro", PASS, f"Inmetro pulse no. {p['pulseIndex']}: intact, the first after the seal, and equal to Inmetro's archive",
                        f"{claimed['inmetro']} · {det}")

    # 5. Semente e ordem
    names = spec.get("candidates") if isinstance(spec.get("candidates"), list) else []
    used = {k: indep.get(k, claimed.get(k)) for k in sources}
    # Loterias podem vir do comprovante (a checagem delas fica "não verificado", conferível a olho).
    all_indep = all(k in indep for k in sources if k not in ("megasena", "federal", "own"))
    computed_order = None
    if v == V3:
        claims = cert.get("result") is not None or cert.get("picks") is not None
        if not all(used.get(k) for k in sources):
            add("result", FAIL if claims else UNVERIFIED, "Randomness values are missing to recompute the result.",
                "a proof without randomness is only a seal")
        elif not task_ok:
            add("result", FAIL, "The result cannot be recomputed: the sealed task is invalid.")
        else:
            seed = seed_own(used["own"]) if "own" in sources else seed_v3(C, used)
            picks, steps = select_picks(seed, spec["task"])
            res = [spec["task"]["options"][i] for i in picks]
            v3info.update({"seed": seed, "picks": picks, "result": res, "steps": steps})
            preview = " · ".join(f"{i + 1}. {n}" for i, n in enumerate(res[:5])) + (" …" if len(res) > 5 else "")
            if cert.get("seed") != seed:
                add("result", FAIL, "The recomputed seed differs from the proof's seed.",
                    f"recomputed {seed} · proof {cert.get('seed')}")
            elif not _same_list(cert.get("picks"), picks):
                add("result", FAIL, "The chosen indices (picks) differ from the recomputed ones.",
                    "correct: " + ", ".join(map(str, picks)) + f" · proof: {json.dumps(cert.get('picks'))}")
            elif not _same_list(cert.get("result"), res):
                add("result", FAIL, "The recomputed result differs from the proof's result.", "correct: " + preview)
            elif not all_indep:
                add("result", UNVERIFIED, "Result consistent with the proof's values, "
                    "but not all sources were looked up.", preview)
            else:
                add("result", PASS, "Result recomputed, identical to the proof's.", f"seed {seed} · {preview}")
    elif not all(used.get(k) for k in sources):
        add("order", FAIL if cert.get("order") else UNVERIFIED,
            "Randomness values are missing to recompute the order.",
            "a proof without randomness is only a seal")
    else:
        if v == V2:
            seed = seed_v2(C, used)
            computed_order = order_v2(seed, names)
        else:
            seed = seed_v1(C, used.get("eth"), used.get("drand"))
            computed_order = order_v1(seed, names)
        same_order = isinstance(cert.get("order"), list) and cert["order"] == computed_order
        same_seed = cert.get("seed") == seed
        preview = " · ".join(f"{i + 1}. {n}" for i, n in enumerate(computed_order[:3])) + (
            " …" if len(computed_order) > 3 else "")
        if not same_seed:
            add("order", FAIL, "The recomputed seed differs from the proof's seed.",
                f"recomputed {seed} · proof {cert.get('seed')}")
        elif not same_order:
            add("order", FAIL, "The recomputed order differs from the proof's order.", "correct: " + preview)
        elif not all_indep:
            add("order", UNVERIFIED, "Order consistent with the proof's values, "
                "but not all sources were looked up.", preview)
        else:
            add("order", PASS, "Order recomputed, identical to the proof's.", f"seed {seed} · {preview}")

    # 6. Carimbos de tempo e horário
    anchors = cert.get("anchors") if isinstance(cert.get("anchors"), list) else []
    times = []
    anchor_notes, anchor_bad, anchor_warn = [], [], []
    for a in anchors:
        if not isinstance(a, dict):
            anchor_bad.append("invalid anchor")
            continue
        if a.get("type") == "rfc3161":
            tsa = a.get("tsa", "?")
            try:
                der = base64.b64decode(a.get("token", ""), validate=True)
                tok = parse_timestamp_response(der)
            except (ValueError, DERError) as e:
                anchor_bad.append(f"{tsa}: unreadable token ({e})")
                continue
            if tok["hashAlg"] != OID_SHA256 or tok["imprint"] != C:
                anchor_bad.append(f"{tsa}: the token does not stamp this commitment")
                continue
            if a.get("time") is not None and iso_to_ms(a.get("time")) != tok["genTimeMs"]:
                anchor_bad.append(f"{tsa}: the time in the proof differs from the token ({tok['genTime']})")
                continue
            note = ""
            if tsa_validator:
                st, note = tsa_validator(der, tok["token"], C)
                if st == FAIL:
                    anchor_bad.append(f"{tsa}: {note}")
                    continue
                if st == WARN:
                    anchor_warn.append(f"{tsa}: {note}")
            else:
                note = "TSA signature not validated"
            times.append(tok["genTimeMs"])
            anchor_notes.append(f"{tsa}: {tok['genTime']}" + (f" ({note})" if note else ""))
        elif a.get("type") == "ots":
            anchor_notes.append("long-term public record (OpenTimestamps): "
                                + ("complete" if a.get("complete") else "pending")
                                + "; check with `ots verify`")
        else:
            anchor_bad.append(f"unknown anchor type: {a.get('type')}")
    if anchors:
        if anchor_bad:
            add("anchors", FAIL, "Some timestamps do not match.", "; ".join(anchor_bad + anchor_notes))
        elif anchor_warn:
            add("anchors", WARN, "Timestamps read, with reservations.", "; ".join(anchor_warn + anchor_notes))
        else:
            add("anchors", PASS, "Timestamps correspond to this commitment.", "; ".join(anchor_notes))

    labels = {"eth": "Ethereum block", "drand": "drand round", "inmetro": "Inmetro pulse"}
    live = [k for k in sources if k in labels]
    if live:
        missing_t = [k for k in live if k not in rtimes]
        deadline = min(rtimes.values()) if rtimes else None
        if not times:
            add("timing", WARN, "Attention: no timestamp. There is no proof that the seal came before the draw.",
                ("the seal must have been published before " + _fmt_unix(deadline)) if deadline else "")
        else:
            earliest = min(times)
            parts, ok = [], True
            for k in live:
                if k in rtimes:
                    before = earliest < rtimes[k] * 1000
                    ok = ok and before
                    parts.append(f"{ms_to_iso(earliest)} {'<' if before else '≥'} {labels[k]} {_fmt_unix(rtimes[k])}")
            if missing_t:
                add("timing", UNVERIFIED, "The time of some source is unknown; comparison incomplete.",
                    "; ".join(parts + [f"{labels[k]}: time unknown" for k in missing_t]))
            elif ok:
                add("timing", PASS, "The earliest timestamp is before the randomness.", "; ".join(parts))
            else:
                add("timing", FAIL, "The earliest timestamp is not before the randomness.", "; ".join(parts))

    # 6b. Loterias: o carimbo mais antigo precisa ser anterior ao INÍCIO do dia do sorteio (00:00, Brasília).
    for game, label in (("megasena", "Mega-Sena"), ("federal", "Loteria Federal")):
        if game not in sources:
            continue
        contest = sources[game].get("contest")
        cid = game + "Timing"
        if game not in draw_dates:
            add(cid, UNVERIFIED, f"{label}, draw no. {contest}: date of the lottery draw unknown; time not compared.",
                "the result has not been recorded yet" if is_seal else "the proof does not contain a valid lottery draw date")
            continue
        date, origin = draw_dates[game]
        day0 = draw_day_start(date)
        det = f"lottery draw on {date} (date from {origin}); start of the day {_fmt_unix(day0)} (00:00 in Brasília)"
        if not times:
            add(cid, UNVERIFIED, f"{label}, draw no. {contest}: no timestamp; there is no proof that the seal "
                "came before the day of the lottery draw.",
                f"seal declared at {cert.get('sealedAt')} (the operator's statement, not verified) · {det}")
        else:
            earliest = min(times)
            cmp = f"earliest timestamp {ms_to_iso(earliest)} {'<' if earliest < day0 * 1000 else '≥'} {det}"
            if earliest < day0 * 1000:
                add(cid, PASS, f"{label}, draw no. {contest}: the earliest timestamp is before the day of the lottery draw.", cmp)
            else:
                add(cid, FAIL, f"{label}, draw no. {contest}: the earliest timestamp is not before the day of the lottery draw.", cmp)

    return result(computed_order)


def _verdict(cert, checks, lottery_confirmed, order):
    lottery_ids = {"megasena", "federal"}
    fails = [c for c in checks if c["status"] == FAIL]
    open_ = [c for c in checks if c["status"] in (UNVERIFIED, WARN)
             and not (lottery_confirmed and c["id"] in lottery_ids and c["status"] == UNVERIFIED)]
    if fails:
        verdict, msg = "nao_confere", "This draw does not check out: " + "; ".join(c["title"] for c in fails)
    elif open_:
        verdict = "incompleto"
        anchors = cert.get("anchors") if isinstance(cert, dict) else None
        only_stamp = not (isinstance(anchors, list) and anchors) and all(
            c["id"] == "timing" or c["id"].endswith("Timing") for c in open_)
        src = cert.get("spec", {}).get("sources") if isinstance(cert.get("spec"), dict) else None
        own = src.get("own") if isinstance(src, dict) and isinstance(src.get("own"), dict) else None
        if own and all(c["id"] == "own" for c in open_):
            msg = (f"Checks out, provided the list (in this order) and the seed ({own.get('label')}) were agreed "
                   "beforehand. The computation is right; check the seed at the stated source.")
        elif only_stamp:
            msg = ("Checks out, except for the moment of sealing. The computation is right, but without a timestamp "
                   "there is no proof the seal came before the random value. If you saw the seal beforehand (at the meeting, "
                   "in the group), the draw checks out.")
        else:
            msg = ("Incomplete check: nothing failed, but these could not be confirmed: "
                   + "; ".join(c["title"] for c in open_))
    else:
        verdict, msg = "confere", "This draw checks out."
    spec = cert.get("spec") if isinstance(cert, dict) and isinstance(cert.get("spec"), dict) else {}
    return {"drawId": spec.get("id"), "version": spec.get("v"), "checks": checks,
            "verdict": verdict, "message": msg, "order": order}


# =============================================================================
# Rede (requests). Cada valor é buscado de forma independente do comprovante.
# =============================================================================

def _requests():
    try:
        import requests  # noqa: WPS433
        return requests
    except ImportError:
        raise SystemExit("Install the requests package (pip install requests) or use --values.")


def fetch_eth(number: int, rpcs=DEFAULT_RPCS, session=None):
    rq = session or _requests()
    last = None
    for url in rpcs:
        try:
            def call(method, params):
                r = rq.post(url, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, timeout=20)
                r.raise_for_status()
                j = r.json()
                if j.get("error"):
                    raise RuntimeError(j["error"].get("message", "erro"))
                return j["result"]

            def blk(n):
                b = call("eth_getBlockByNumber", [hex(n), False])
                return None if not b else {"number": int(b["number"], 16), "hash": norm_hex(b["hash"]),
                                           "timestamp": int(b["timestamp"], 16)}

            head = int(call("eth_blockNumber", []), 16)
            return {"block": blk(number), "parent": blk(number - 1), "head": head}
        except Exception as e:  # tenta o próximo
            last = f"{url}: {e}"
    return {"error": "Nenhum servidor Ethereum respondeu" + (f" ({last})" if last else "")}


def fetch_drand(round_: int, chain_hash: str = QUICKNET_HASH, session=None):
    rq = session or _requests()
    last = None
    for base in DRAND_ENDPOINTS:
        try:
            r = rq.get(f"{base}/{chain_hash}/public/{round_}", timeout=20)
            r.raise_for_status()
            j = r.json()
            return {"round": j["round"], "randomness": norm_hex(j["randomness"]), "signature": norm_hex(j["signature"])}
        except Exception as e:
            last = f"{base}: {e}"
    return {"error": "Nenhum servidor drand respondeu" + (f" ({last})" if last else "")}


def fetch_inmetro(chain: int, index: int, T=None, session=None):
    """O pulso nº index da cadeia no arquivo do Inmetro e se existe um pulso exatamente em T (ms)."""
    rq = session or _requests()
    try:
        r = rq.get(f"{INMETRO_BASE}/chain/{chain}/pulse/{index}", timeout=20, headers={"accept": "application/json"})
        r.raise_for_status()
        j = r.json()
        pulse = j.get("pulse", j)
    except Exception as e:
        return {"error": f"Inmetro: {e}"}
    at_t = False
    if T is not None and iso_to_ms(pulse.get("timeStamp", "")) != T:
        try:
            r = rq.get(f"{INMETRO_BASE}/pulse/time/{T}", timeout=20, headers={"accept": "application/json"})
            if r.status_code == 200:
                q = r.json().get("pulse", {})
                at_t = iso_to_ms(q.get("timeStamp", "")) == T and q.get("chainIndex") == chain
        except Exception:
            at_t = False
    return {"pulse": pulse, "atT": at_t}


def fetch_lottery(game: str, contest, relay: str = None, session=None):
    """contest inteiro: formato LucentDraw/2; texto: LucentDraw/3 (rota /v3/lottery do relay)."""
    rq = session or _requests()
    errors = []
    v3 = isinstance(contest, str)
    try:
        r = rq.get(CAIXA_API.format(game=game, contest=contest), timeout=20,
                   headers={"accept": "application/json"})
        if r.status_code == 200:
            n = normalize_caixa(game, contest, r.json())
            if n:
                return n
            errors.append("Caixa: response without a result")
        else:
            errors.append(f"Caixa: HTTP {r.status_code}")
    except Exception as e:
        errors.append(f"Caixa: {e}")
    if relay:
        try:
            r = rq.get(f"{relay.rstrip('/')}/{'v3' if v3 else 'v1'}/lottery/{game}/{contest}", timeout=20)
            if r.status_code == 200:
                j = r.json()
                ok = isinstance(j, dict) and lottery_evidence_ok(game, j, V3 if v3 else V2)
                if ok and j.get("contest") == contest:
                    return j
            errors.append(f"relay: HTTP {r.status_code}")
        except Exception as e:
            errors.append(f"relay: {e}")
    return {"error": "; ".join(errors)}


def fetch_all(cert, rpcs=DEFAULT_RPCS, relay=None, session=None):
    spec = cert.get("spec", {}) if isinstance(cert, dict) else {}
    src = spec.get("sources", {}) if isinstance(spec.get("sources"), dict) else {}
    rand = cert.get("randomness", {}) if isinstance(cert.get("randomness"), dict) else {}
    out = {}
    if "eth" in src and isinstance(rand.get("eth"), dict) and _is_int(rand["eth"].get("number")):
        out["eth"] = fetch_eth(rand["eth"]["number"], rpcs, session)
    if "drand" in src and _is_int(src["drand"].get("round")):
        out["drand"] = fetch_drand(src["drand"]["round"], session=session)
    p = rand.get("inmetro")
    if "inmetro" in src and isinstance(p, dict) and _is_int(p.get("pulseIndex")) and _is_int(p.get("chainIndex")):
        nb = src["inmetro"].get("notBefore") if isinstance(src["inmetro"], dict) else None
        out["inmetro"] = fetch_inmetro(p["chainIndex"], p["pulseIndex"], inmetro_minute_after(nb) if _is_int(nb) else None, session)
    for g in ("megasena", "federal"):
        c = src[g].get("contest") if g in src and isinstance(src[g], dict) else None
        if _is_int(c) or contest_ok_v3(c):
            out[g] = fetch_lottery(g, c, relay, session)
    return out


# =============================================================================
# Linha de comando
# =============================================================================

def format_report(rep: dict) -> str:
    lines = [f"Draw: {rep.get('drawId')}  ({rep.get('version')})",
             "Reminder: a second seal with the same ID invalidates the draw. Check that this is the only one.", ""]
    for c in rep["checks"]:
        lines.append(f"[{STATUS_LABEL[c['status']]:>14}] {c['title']}")
        if c.get("detail"):
            lines.append(f"{'':17}{c['detail']}")
    if rep.get("order"):
        lines.append("")
        lines.append("Recomputed order:")
        for i, n in enumerate(rep["order"], 1):
            lines.append(f"  {i:>3}. {n}")
    v3 = rep.get("v3")
    if v3:
        # SPEC-v3 7: pesos como digitados, pesos inteiros e W, para acompanhar a conta.
        t, W = v3["task"], v3["W"]
        lines.append("")
        lines.append(f"Weights (W = {W}; {task_summary(t)}):")
        lines.append(f"  {'option':<24} {'typed':>12} {'integer':>14} {'chance':>9}")
        for o, w, i in zip(t["options"], t["weights"], v3["ints"]):
            lines.append(f"  {o:<24} {w:>12} {i:>14} {share_text(i, W):>9}")
        if v3.get("result") is not None:
            lines.append("")
            lines.append("Recomputed result (r = SHA-256 of pick j; x = floor(r·W/2^256)):")
            for s in v3["steps"]:
                lines.append(f"  {s['j'] + 1:>3}. {t['options'][s['index']]}   [index {s['index']}; x = {s['x']} of W = {s['W']}]")
    lines.append("")
    lines.append(rep["message"])
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Verifies a Lucent Draw / Lucent Sorteios proof (LucentDraw/3, /2 or /1).")
    ap.add_argument("certificate", help="JSON file of the proof (or - for standard input)")
    ap.add_argument("--rpc", action="append", help="endpoint JSON-RPC Ethereum (pode repetir)")
    ap.add_argument("--relay", help="relay URL (for lottery results)")
    ap.add_argument("--values", help="JSON with the source values already obtained (offline mode)")
    ap.add_argument("--confirm-lottery", action="store_true",
                    help="states that you checked the lottery numbers by eye on the official page")
    ap.add_argument("--tsa-ca", action="append", default=[], help="PEM file with a TSA's CA (can be repeated)")
    ap.add_argument("--no-tsa-check", action="store_true", help="do not validate RFC 3161 signatures with openssl")
    ap.add_argument("--json", action="store_true", help="JSON output")
    a = ap.parse_args(argv)
    try:
        if a.certificate == "-":
            raw = sys.stdin.read()
        else:
            with open(a.certificate, encoding="utf-8") as f:
                raw = f.read()
        cert = json.loads(raw)
    except (OSError, ValueError) as e:
        print(f"Could not read the proof: {e}", file=sys.stderr)
        return 3
    if a.values:
        with open(a.values, encoding="utf-8") as f:
            fetched = json.load(f)
    else:
        fetched = fetch_all(cert, tuple(a.rpc) if a.rpc else DEFAULT_RPCS, a.relay)
    validator = None if a.no_tsa_check else openssl_tsa_validator(a.tsa_ca)
    rep = verify_certificate(cert, fetched, lottery_confirmed=a.confirm_lottery, tsa_validator=validator)
    print(json.dumps(rep, ensure_ascii=False, indent=2, default=str) if a.json else format_report(rep))
    return {"confere": 0, "nao_confere": 1, "incompleto": 2}[rep["verdict"]]


if __name__ == "__main__":
    sys.exit(main())
