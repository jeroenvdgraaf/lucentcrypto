# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Jeroen van de Graaf
"""Testes LucentDraw/3 do verify_draw.py (sem rede): vetores da SPEC-v3, pesos, regra de escolha,
codificação das loterias, horário das loterias, comprovantes e adulterações (mesmas do teste Node)."""
import copy
import io
import json
import os
import random
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "verifier"))
sys.path.insert(0, os.path.join(ROOT, "spec"))
sys.path.insert(0, HERE)
sys.dont_write_bytecode = True

import verify_draw as v  # noqa: E402
import world as w  # noqa: E402
import lucentdraw3_ref as ref  # noqa: E402

with open(os.path.join(ROOT, "spec", "lucentdraw3_vectors.json"), encoding="utf-8") as f:
    VECTORS = json.load(f)
TEST_PK = w.load("drand_test_beacons.json")["publicKey"]
TAMPER = w.load("tamper_v3.json")["cases"]
CROSS = w.load("v3_cross.json")["cases"]


def verify(cert, fetched=None, **kw):
    kw.setdefault("drand_pubkey", TEST_PK)
    return v.verify_certificate(cert, w.fetched_for(cert) if fetched is None else fetched, **kw)


def status(rep):
    return {c["id"]: c["status"] for c in rep["checks"]}


def failing(rep):
    return sorted(c["id"] for c in rep["checks"] if c["status"] == v.FAIL)


def flip(h, i=10):
    return h[:i] + ("1" if h[i] == "0" else "0") + h[i + 1:]


class Vectors(unittest.TestCase):
    def test_spec_v3_section_8(self):
        for vec in VECTORS:
            with self.subTest(vec["name"]):
                spec = json.loads(vec["canonical"])
                self.assertEqual(v.canonical_json(spec), vec["canonical"])
                self.assertEqual(v.validate_spec(spec), [])
                C = v.commitment_of(spec)
                self.assertEqual(C, vec["C"])
                seed = v.seed_v3(C, vec["values"])
                self.assertEqual(seed, vec["seed"])
                self.assertEqual(v.pick_hash(seed, 0), vec["firstR"])
                picks, steps = v.select_picks(seed, spec["task"])
                self.assertEqual(picks, vec["picks"])
                self.assertEqual([spec["task"]["options"][i] for i in picks], vec["result"])
                self.assertEqual(steps[0]["W"], vec["W"])

    def test_example_weights(self):
        ints, L, W = v.integer_weights(["3", "0,35", "1/7", "0"])
        self.assertEqual((ints, L, W), ([420, 49, 20, 0], 140, 489))
        self.assertEqual([v.share_text(i, W) for i in ints], ["85,9 %", "10,0 %", "4,1 %", "0 %"])

    def test_agrees_with_spec_reference_and_html_core(self):
        # v3_cross.json foi resolvido pelo núcleo do HTML; o teste Node confere o mesmo arquivo.
        for c in CROSS:
            picks, _ = v.select_picks(c["seed"], c["task"])
            self.assertEqual(picks, c["picks"])
            self.assertEqual(picks, ref.picks(c["seed"], c["task"]))
            self.assertEqual([str(x) for x in v.integer_weights(c["task"]["weights"])[0]], c["ints"])

    def test_random_tasks_against_reference(self):
        rng = random.Random(7)
        forms = lambda: rng.choice(["0", str(rng.randint(1, 9)), f"{rng.randint(0, 3)},{rng.randint(0, 999)}",  # noqa: E731
                                    f".{rng.randint(1, 99)}", f"{rng.randint(1, 9)}.", f"{rng.randint(0, 4)}/{rng.randint(1, 40)}"])
        for _ in range(200):
            n = rng.randint(1, 25)
            ws = [forms() for _ in range(n)]
            if all(v.parse_weight(x) == 0 for x in ws):
                ws[0] = "1"
            pos = sum(1 for x in ws if v.parse_weight(x) > 0)
            rep_ = rng.random() < 0.5
            task = {"preset": "list", "options": [f"o{i}" for i in range(n)], "weights": ws,
                    "count": rng.randint(1, 30) if rep_ else rng.randint(1, pos), "replace": rep_}
            self.assertEqual(v.validate_task(task), [])
            seed = "%064x" % rng.getrandbits(256)
            self.assertEqual(v.select_picks(seed, task)[0], ref.picks(seed, task))


class Weights(unittest.TestCase):
    def test_valid(self):
        from fractions import Fraction as F
        for s, f in {"3": F(3), "0.35": F(7, 20), "0,35": F(7, 20), ".5": F(1, 2), "2.": F(2), "1/7": F(1, 7), "0": F(0),
                     " 3 ": F(3), "1 / 7": F(1, 7), "007": F(7), "2/4": F(1, 2)}.items():
            with self.subTest(s):
                self.assertEqual(v.parse_weight(s), f)

    def test_invalid(self):
        for s, code in {"-1": "negative", "1/0": "zeroDen", "abc": "syntax", "1/2/3": "syntax", "": "empty",
                        "1e3": "syntax", "½": "syntax", "٣": "syntax", "1,2,3": "syntax", ".": "syntax"}.items():
            with self.subTest(s):
                with self.assertRaises(ValueError) as cm:
                    v.parse_weight(s)
                self.assertEqual(str(cm.exception), code)
        self.assertRaises(ValueError, v.parse_weight, 3)

    def test_task_rules(self):
        base = json.loads(VECTORS[3]["canonical"])["task"]
        bad = lambda **p: v.validate_task({**base, **p})  # noqa: E731
        self.assertEqual(bad(), [])
        self.assertTrue(bad(options=[]))
        self.assertTrue(any("repetidas" in p for p in bad(options=["A", "A", "B", "C"])))
        self.assertTrue(any("peso 2" in p for p in bad(weights=["1", "1/0", "1", "1"])))
        self.assertTrue(any("maior que zero" in p for p in bad(weights=["0", "0", "0", "0/2"])))
        self.assertTrue(any("sem reposição" in p for p in bad(count=4)))
        self.assertEqual(bad(count=4, replace=True), [])
        self.assertTrue(bad(replace=1))
        self.assertTrue(bad(count=True))
        self.assertTrue(bad(preset="roleta"))
        spec = json.loads(VECTORS[3]["canonical"])
        self.assertTrue(any("booleano" in p for p in v.validate_spec({**spec, "title": True})))


class Lottery(unittest.TestCase):
    def test_v3_encoding(self):
        self.assertEqual(v.lottery_value("megasena", "3001", {"numbers": [58, 4, 41, 12, 35, 23]}, v.V3), "3001:4-12-23-35-41-58")
        self.assertEqual(v.lottery_value("federal", "6120", {"prizes": [17469, 81210, 7767, 41317, 79412]}, v.V3),
                         "6120:17469-81210-7767-41317-79412")
        self.assertEqual(v.lottery_value("federal", 5900, {"prizes": ["01234", "56789", "13579", "24680", "97531"]}),
                         "5900:01234-56789-13579-24680-97531")
        for c in ("3001", "6054-2"):
            self.assertTrue(v.contest_ok_v3(c))
        for c in (3001, "03001", "6054-", "6054-02", "", "3001:1"):
            self.assertFalse(v.contest_ok_v3(c))
        self.assertEqual(v.normalize_caixa("federal", "6120", {"numero": 6120, "dataApuracao": "20/01/2027",
                                                               "listaDezenas": ["017469", "081210", "007767", "041317", "079412"]}),
                         {"game": "federal", "contest": "6120", "prizes": [17469, 81210, 7767, 41317, 79412], "drawDate": "2027-01-20"})

    def test_no_calendar(self):
        self.assertFalse(hasattr(v, "LOTTERY_CALENDAR"))
        self.assertEqual(v.draw_day_start("2027-01-20"), 1800414000)  # 2027-01-20T03:00:00Z
        self.assertIsNone(v.draw_day_start("2027-02-30"))

    def test_relay_v3_route(self):
        from test_verify_draw import FakeSession, FakeResp
        relay = {"game": "federal", "contest": "6054-2", "prizes": [1, 2, 3, 4, 5], "drawDate": "2027-01-20"}
        s = FakeSession([("https://relay.example/v3/lottery/federal/6054-2", lambda u, b: FakeResp(200, relay))])
        self.assertEqual(v.fetch_lottery("federal", "6054-2", relay="https://relay.example", session=s), relay)


class LotteryTiming(unittest.TestCase):
    def fed(self, draw_date, unreachable=()):
        c = w.cert("v3-scheduled-federal-order")
        world = copy.deepcopy(w.WORLD)
        world["lottery"]["federal/6120"]["drawDate"] = draw_date
        return c, verify(c, w.fetched_for(c, world, unreachable))

    def test_stamp_before_draw_day_passes(self):
        c, rep = self.fed("2027-01-20")
        self.assertEqual(status(rep)["federalTiming"], v.PASS)
        self.assertNotIn("timing", status(rep))
        self.assertEqual(rep["verdict"], "confere", rep["message"])

    def test_stamp_on_or_after_draw_day_fails(self):
        c = w.cert("v3-scheduled-federal-order")
        stamp = v.iso_to_ms(c["anchors"][0]["time"])
        import datetime as dt
        same_day = dt.datetime.fromtimestamp(stamp / 1000, v.BRT).date().isoformat()
        for day in (same_day, "2026-11-01"):
            with self.subTest(day):
                _, rep = self.fed(day)
                self.assertEqual(failing(rep), ["federalTiming"])
        next_day = (dt.datetime.fromtimestamp(stamp / 1000, v.BRT).date() + dt.timedelta(days=1)).isoformat()
        self.assertEqual(status(self.fed(next_day)[1])["federalTiming"], v.PASS)

    def test_no_anchors_is_unverified_with_sealed_at(self):
        c = w.cert("v3-scheduled-megasena-dice-manual")
        rep = verify(c)
        t = next(x for x in rep["checks"] if x["id"] == "megasenaTiming")
        self.assertEqual(t["status"], v.UNVERIFIED)
        self.assertIn(c["sealedAt"], t["detail"])
        self.assertIn("sorteio em 2027-01-21", t["detail"])
        self.assertEqual(failing(rep), [])
        self.assertEqual(rep["verdict"], "incompleto")

    def test_v2_lottery_gets_the_same_check(self):
        rep = verify(w.cert("v2-scheduled-megasena"))
        self.assertEqual(status(rep)["megasenaTiming"], v.PASS)
        rep = verify(w.cert("v2-scheduled-federal-drand-manual"))
        self.assertEqual(status(rep)["federalTiming"], v.UNVERIFIED)


class Certificates(unittest.TestCase):
    def test_fixtures(self):
        for name, verdict in (("v3-live-drand-cards", "confere"), ("v3-live-eth-weights", "confere"),
                              ("v3-scheduled-federal-order", "confere"), ("v3-scheduled-megasena-dice-manual", "incompleto"),
                              ("v3-seal-only-coin", "incompleto")):
            with self.subTest(name):
                rep = verify(w.cert(name))
                self.assertEqual(rep["verdict"], verdict, rep["message"])
                self.assertEqual(failing(rep), [])

    def test_report_shows_weights_integers_and_W(self):
        rep = verify(w.cert("v3-live-eth-weights"))
        self.assertEqual(rep["v3"]["ints"], [420, 49, 20, 0])
        out = v.format_report(rep)
        for s in ("W = 489", "0,35", "49", "85,9 %", "Resultado recalculado"):
            self.assertIn(s, out)

    def test_cli_json(self):
        c = w.cert("v3-live-drand-cards")
        with tempfile.TemporaryDirectory() as d:
            cp, vp = os.path.join(d, "c.json"), os.path.join(d, "v.json")
            with open(cp, "w", encoding="utf-8") as f:
                json.dump(c, f, ensure_ascii=False)
            with open(vp, "w", encoding="utf-8") as f:
                json.dump(w.fetched_for(c), f)
            out = io.StringIO()
            with redirect_stdout(out):
                code = v.main([cp, "--values", vp, "--no-tsa-check", "--json"])
            # A chave drand de TESTE não é a da quicknet: o CLI usa a chave verdadeira, logo drand falha.
            rep = json.loads(out.getvalue())
            self.assertEqual(code, 1)
            self.assertEqual(rep["version"], "LucentDraw/3")
            self.assertIn("BLS", next(x for x in rep["checks"] if x["id"] == "drand")["title"])


def apply_ops(c, ops):
    for op in ops:
        o = c
        for k in op["path"][:-1]:
            o = o[k]
        last = op["path"][-1]
        if op["op"] == "flip":
            o[last] = flip(o[last])
        elif op["op"] == "delete":
            del o[last]
        elif op["op"] == "swap01":
            o[last][0], o[last][1] = o[last][1], o[last][0]
        else:
            o[last] = copy.deepcopy(op["value"])


class Tampering(unittest.TestCase):
    def test_same_cases_as_the_html(self):
        for t in TAMPER:
            with self.subTest(t["name"]):
                c = copy.deepcopy(w.cert(t["fixture"]))
                fetched = w.fetched_for(c)  # a rede não muda quando o comprovante é adulterado
                apply_ops(c, t["ops"])
                rep = verify(c, fetched)
                self.assertEqual(rep["verdict"], "nao_confere")
                self.assertEqual(status(rep)[t["main"]], v.FAIL)
                self.assertEqual(failing(rep), sorted(t["fails"]))


if __name__ == "__main__":
    unittest.main()


class OwnSeed(unittest.TestCase):
    """Semente própria (SPEC-v3 5.3): mesmos comprovantes que o teste Node."""

    def test_canon(self):
        c = v.canon_own_seed
        self.assertEqual(c("33 05 12"), {"value": "5-12-33", "reading": "int"})
        self.assertEqual(c(" 5 -12\n\t033 "), {"value": "5-12-33", "reading": "int"})
        self.assertEqual(c("100 99 1000000000000000000000")["value"], "99-100-1000000000000000000000")
        self.assertEqual(c("12.345"), {"value": "12-345", "reading": "int"})
        self.assertEqual(c("  ana, gato \r\n"), {"value": "ANA-GATO", "reading": "text"})
        self.assertEqual(c("Ána  Gato."), c("ana gato"))
        self.assertNotEqual(c("ana gato"), c("gato ana"))
        self.assertEqual(c("maçã, avó, nº 07"), {"value": "MACA-AVO-NO-7", "reading": "text"})
        self.assertEqual(c("gato 🐈"), {"error": "ascii"})
        self.assertEqual(c("---"), {"error": "empty"})
        self.assertIsNone(v.own_format_error("megasena", c("5 12 33 41 47 58")))
        self.assertEqual(v.own_format_error("megasena", c("5 5 33 41 47 58")), "megasena")
        self.assertEqual(v.own_format_error("federal", c("1234567 1 2 3 4")), "federal")

    def test_certificates(self):
        for case in w.load("v3_own.json")["cases"]:
            cert = case["cert"]
            self.assertEqual(v.canon_own_seed(case["typed"])["value"], cert["randomness"]["own"]["value"])
            rep = v.verify_certificate(cert, {})
            self.assertEqual(rep["verdict"], "incompleto", rep["checks"])
            self.assertTrue(rep["message"].startswith("Confere, desde que a lista"))
            self.assertEqual([c["id"] for c in rep["checks"] if c["status"] != v.PASS], ["own"])
            bad = copy.deepcopy(cert)
            bad["randomness"]["own"]["value"] += " "
            self.assertEqual(v.verify_certificate(bad, {})["verdict"], "nao_confere")


class Inmetro(unittest.TestCase):
    """Farol do Inmetro (SPEC-v3 5.4): pulso real nº 1049644 e o comprovante feito pela página."""

    def setUp(self):
        self.pulse = w.load("inmetro_pulse_1049644.json")["pulse"]
        self.cert = w.load("v3_inmetro.json")["cert"]

    def st(self, rep, cid):
        return next(c["status"] for c in rep["checks"] if c["id"] == cid)

    def test_intact(self):
        self.assertTrue(v.inmetro_intact(self.pulse))
        q = copy.deepcopy(self.pulse)
        q["listValues"][0]["value"] = "00" + q["listValues"][0]["value"][2:]
        self.assertFalse(v.inmetro_intact(q))
        self.assertEqual(v.inmetro_minute_after(v.iso_to_ms("2026-11-20T18:33:00.000Z")), v.iso_to_ms("2026-11-20T18:34:00.000Z"))

    def test_certificate(self):
        rep = v.verify_certificate(self.cert, {"inmetro": {"pulse": self.pulse, "atT": False}})
        self.assertEqual(self.st(rep, "inmetro"), v.PASS)
        self.assertEqual(self.st(rep, "result"), v.PASS)
        self.assertNotEqual(rep["verdict"], "nao_confere")
        rep = v.verify_certificate(self.cert, {})
        self.assertEqual(self.st(rep, "inmetro"), v.UNVERIFIED)
        bad = copy.deepcopy(self.cert)
        bad["randomness"]["inmetro"]["precommitmentValue"] = "00" + bad["randomness"]["inmetro"]["precommitmentValue"][2:]
        self.assertEqual(v.verify_certificate(bad, {"inmetro": {"pulse": self.pulse, "atT": False}})["verdict"], "nao_confere")
        other = copy.deepcopy(self.pulse)
        other["outputValue"] = "00" + other["outputValue"][2:]
        self.assertEqual(v.verify_certificate(self.cert, {"inmetro": {"pulse": other, "atT": False}})["verdict"], "nao_confere")


class InmetroReal(unittest.TestCase):
    """Sorteio real (20/11/2026): lacre 19:15:16, carimbos FreeTSA e DigiCert 19:15:19, pulso do Inmetro 19:16:00."""

    def test_real_draw(self):
        cert = w.load("v3_inmetro_real.json")["cert"]
        fetched = {"inmetro": {"pulse": cert["randomness"]["inmetro"], "atT": False}}
        rep = v.verify_certificate(cert, fetched)
        self.assertEqual(rep["verdict"], "confere", rep["checks"])
        if shutil.which("openssl"):
            rep = v.verify_certificate(cert, fetched, tsa_validator=v.openssl_tsa_validator())
            self.assertEqual(rep["verdict"], "confere", [c for c in rep["checks"] if c["status"] != v.PASS])
