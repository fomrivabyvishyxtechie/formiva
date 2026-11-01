"""Tests for the corpus generator and validator. Run: python3 -m unittest -v   (from this directory)"""
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import generate
import validate


class CorpusTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        cls.base = cls.tmp / "base"
        cls.manifest = generate.generate(cls.base, generate.DEFAULT_SEED)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def fresh(self, name):
        d = self.tmp / name
        if d.exists():
            shutil.rmtree(d)
        shutil.copytree(self.base, d)
        return d

    def edit_manifest(self, d, fn):
        p = d / "manifest.json"
        m = json.loads(p.read_text(encoding="utf-8"))
        fn(m)
        p.write_text(json.dumps(m), encoding="utf-8")

    def test_valid_and_deterministic(self):
        self.assertEqual(validate.validate(self.base, regenerate_check=True), [])
        again = generate.generate(self.tmp / "again", generate.DEFAULT_SEED)
        self.assertEqual(again["corpus_sha256"], self.manifest["corpus_sha256"])

    def test_zip_files_do_not_record_the_operating_system(self):
        # Python writes 0 (Windows) or 3 (Unix) into every zip entry; unpinned, the corpus hash differs per machine.
        z = generate.make_zip({"a.txt": b"x"})
        i = z.index(b"PK\x01\x02")
        self.assertEqual(z[i + 5], 3)

    def test_different_seed_gives_different_corpus(self):
        other = generate.generate(self.tmp / "other", generate.DEFAULT_SEED + 1)
        self.assertNotEqual(other["corpus_sha256"], self.manifest["corpus_sha256"])

    def test_shape(self):
        self.assertEqual(self.manifest["case_count"], 100)
        self.assertGreaterEqual(self.manifest["hostile_count"], 10)
        langs = {c["language"] for c in self.manifest["cases"]}
        self.assertTrue({"en", "hi", "ta"} <= langs)

    def test_fails_on_missing_label(self):
        d = self.fresh("missing_label")
        self.edit_manifest(d, lambda m: m["cases"][0].pop("expected_route"))
        self.assertTrue(any("expected_route" in e for e in validate.validate(d)))

    def test_fails_on_valid_looking_id_in_label(self):
        d = self.fresh("bad_id")
        def bad(m):
            m["cases"][0]["expected_fields"]["reference"] = "1234 5678 9012"
        self.edit_manifest(d, bad)
        self.assertTrue(any("aadhaar-like" in e for e in validate.validate(d)))

    def test_fails_on_unmasked_aadhaar_label(self):
        d = self.fresh("unmasked")
        def bad(m):
            c = next(c for c in m["cases"] if c["doc_subtype"] == "aadhaar")
            c["expected_fields"]["aadhaar_masked"] = "SYNTHETIC-FULL"
        self.edit_manifest(d, bad)
        self.assertTrue(any("must be masked" in e for e in validate.validate(d)))

    def test_fails_on_missing_hostile_kind(self):
        d = self.fresh("no_hostile")
        self.edit_manifest(d, lambda m: m.update(hostile=[h for h in m["hostile"] if h["kind"] != "malformed_pdf"]))
        self.assertTrue(any("malformed_pdf" in e for e in validate.validate(d)))

    def test_fails_when_too_few_hostile_files(self):
        d = self.fresh("few_hostile")
        self.edit_manifest(d, lambda m: m.update(hostile=m["hostile"][:5]))
        self.assertTrue(any("at least 10" in e for e in validate.validate(d)))

    def test_fails_on_tampered_file(self):
        d = self.fresh("tampered")
        f = d / self.manifest["cases"][0]["file"]
        f.write_bytes(f.read_bytes() + b"x")
        self.assertTrue(any("differs from manifest" in e for e in validate.validate(d)))

    def test_fails_on_missing_file(self):
        d = self.fresh("deleted")
        (d / self.manifest["cases"][1]["file"]).unlink()
        self.assertTrue(any("file missing" in e for e in validate.validate(d)))

    def test_fails_on_absent_watermark(self):
        d = self.fresh("no_watermark")
        c = next(c for c in self.manifest["cases"] if c["format"] == "png")
        f = d / c["file"]
        data = f.read_bytes().replace(b"Comment\x00", b"Remark\x00\x00")  # same length, watermark label gone
        f.write_bytes(data)

        def fix(m):  # keep the hashes consistent so ONLY the watermark rule can fire
            m["cases"] = [dict(x, sha256=validate.sha(data)) if x["id"] == c["id"] else x for x in m["cases"]]
            lines = sorted(f"{e['file']}:{e['sha256']}" for e in m["cases"] + m["hostile"] if e.get("file") and not e.get("opt_in"))
            m["corpus_sha256"] = validate.sha("\n".join(lines).encode())

        self.edit_manifest(d, fix)
        self.assertEqual([e for e in validate.validate(d)], [f"{c['id']}: watermark absent"])

    def test_fails_on_nondeterminism(self):
        d = self.fresh("nondet")
        self.edit_manifest(d, lambda m: m.update(seed=m["seed"] + 7))
        self.assertTrue(any("non-deterministic" in e for e in validate.validate(d, regenerate_check=True)))

    def test_eicar_is_opt_in(self):
        self.assertTrue(all(h["file"] is None for h in self.manifest["hostile"] if h["kind"] == "malware_test_string"))
        # Never write the AV test string to disk in a unit test: desktop antivirus (Windows Defender) blocks it.
        written = []
        with mock.patch.object(Path, "write_bytes", lambda self, data: written.append(self.name) or len(data)):
            items = generate.build_hostile(self.tmp / "eicar_dry", with_eicar=True)
        self.assertIn("eicar.pdf", written)
        self.assertTrue(next(h for h in items if h["kind"] == "malware_test_string")["opt_in"])
        shutil.rmtree(self.tmp / "eicar_dry", ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
