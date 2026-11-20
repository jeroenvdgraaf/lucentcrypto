# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Jeroen van de Graaf
"""Decodificador independente do Lucent Segredo, escrito só a partir da dica (&h=…) que vai em cada link.
Se este teste passa, a dica basta para recuperar um segredo sem a página."""
import base64, hashlib, json, os, struct, unittest, zlib
from urllib.parse import parse_qs, urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))

def gf_mul(a, b):  # GF(256), polinômio 0x11b
    r = 0
    while b:
        if b & 1: r ^= a
        a <<= 1
        if a & 0x100: a ^= 0x11b
        b >>= 1
    return r

def gf_inv(a):
    return next(b for b in range(1, 256) if gf_mul(a, b) == 1)

def mgf1(label, h, seed, n):
    out, c = b"", 0
    while len(out) < n:
        out += hashlib.sha256(label + h + seed + struct.pack(">I", c)).digest(); c += 1
    return out[:n]

def parse(link):
    frag = parse_qs(urlsplit(link).fragment)
    raw = frag["p"][0]
    assert raw.startswith("LS2.")
    b = base64.urlsafe_b64decode(raw[4:] + "=" * (-len(raw[4:]) % 4))
    body, crc = b[:-4], struct.unpack(">I", b[-4:])[0]
    assert zlib.crc32(body) == crc, "CRC"
    v, x = body[0], body[1]
    k, n = body[10], body[11]
    o = 14
    def text():
        nonlocal o
        l = body[o]; s = body[o + 1:o + 1 + l].decode(); o += 1 + l; return s
    title, by = text(), text()
    names = [text() for _ in range(n)]
    return dict(v=v, x=x, k=k, n=n, hdr=body[2:o], y=body[o:], title=title, by=by, names=names, hint=frag["h"][0])

def recover(shares):
    xs = [s["x"] for s in shares]
    P = bytearray(len(shares[0]["y"]))
    for i, xi in enumerate(xs):  # Lagrange em 0
        w = 1
        for j, xj in enumerate(xs):
            if j != i: w = gf_mul(w, gf_mul(xj, gf_inv(xj ^ xi)))
        for t, yv in enumerate(shares[i]["y"]): P[t] ^= gf_mul(w, yv)
    h = hashlib.sha256(shares[0]["hdr"]).digest()
    X, Y = bytes(P[:-32]), bytes(P[-32:])
    r = bytes(a ^ b for a, b in zip(Y, mgf1(b"LS2/H", h, X, 32)))
    M = bytes(a ^ b for a, b in zip(X, mgf1(b"LS2/G", h, r, len(X))))
    assert M[-16:] == bytes(16), "conferência OAEP"
    ln = struct.unpack(">H", M[:2])[0]
    return M[2:2 + ln].decode()

class HintDecoder(unittest.TestCase):
    def setUp(self):
        with open(os.path.join(HERE, "fixtures", "segredo_ls2.json")) as f: self.fx = json.load(f)
        self.sh = [parse(l) for l in self.fx["links"]]
    def test_any_k_recover(self):
        from itertools import combinations
        for sub in combinations(self.sh, self.fx["k"]):
            self.assertEqual(recover(list(sub)), self.fx["secret"])
    def test_metadata(self):
        s = self.sh[3]
        self.assertEqual((s["title"], s["by"], s["names"][s["x"] - 1]), ("Teste da dica", "Ana", "Eva Ünal"))
        self.assertIn("h=SHA256(hdr)", s["hint"])
    def test_tampered_header_fails(self):
        bad = dict(self.sh[0]); bad["hdr"] = bad["hdr"].replace(b"Teste", b"Tests")
        with self.assertRaises(AssertionError): recover([bad] + self.sh[1:3])

if __name__ == "__main__":
    unittest.main()
