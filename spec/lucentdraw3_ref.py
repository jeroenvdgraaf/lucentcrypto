# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Jeroen van de Graaf
"""Reference implementation of the LucentDraw/3 selection rule (spec/SPEC-v3.md). Standard library only."""
import hashlib, json, re, unicodedata
from fractions import Fraction
from math import lcm

V = "LucentDraw/3"
SOURCES = ("eth", "drand", "megasena", "federal")

def H(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()

def canon(spec) -> str:
    return json.dumps(spec, sort_keys=True, separators=(",", ":"), ensure_ascii=False)

def parse_weight(w: str) -> Fraction:
    """'3', '0.35', '0,35', '1/7' -> exact non-negative Fraction. Raises ValueError otherwise."""
    s = unicodedata.normalize("NFC", w).strip().replace(",", ".")
    if re.fullmatch(r"\d+", s): return Fraction(int(s))
    if re.fullmatch(r"\d*\.\d+|\d+\.\d*", s): return Fraction(s)
    m = re.fullmatch(r"(\d+)\s*/\s*(\d+)", s)
    if m and int(m.group(2)) > 0: return Fraction(int(m.group(1)), int(m.group(2)))
    raise ValueError("invalid weight: %r" % w)

def integer_weights(weights):
    fr = [parse_weight(w) for w in weights]
    L = lcm(*[f.denominator for f in fr])
    return [f.numerator * (L // f.denominator) for f in fr]

def seed_of(C: str, vals: dict) -> str:
    return H("\n".join([V, "seed", C] + [f"{k}={vals.get(k, '-')}" for k in SOURCES]))

def picks(seed: str, task: dict):
    """Returns the list of chosen option indices."""
    w = integer_weights(task["weights"])
    alive = [i for i, x in enumerate(w) if x > 0]
    out = []
    for j in range(task["count"]):
        W = sum(w[i] for i in alive)
        r = int(H(V + "\npick\n" + seed + "\n" + str(j)), 16)
        x = (r * W) >> 256                      # in [0, W)
        acc = 0
        for i in alive:
            acc += w[i]
            if x < acc:
                out.append(i)
                if not task["replace"]: alive.remove(i)
                break
    return out

def commitment(spec) -> str:
    return H(canon(spec))
