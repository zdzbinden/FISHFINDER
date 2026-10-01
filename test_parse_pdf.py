"""
Regression tests for the header parsing in parse_pdf.py.

Run: python -m unittest test_parse_pdf -v      (standard library only; no PDF needed)

Two defects motivated these tests, both found 2026-10-01. Neither failed: a
missed header files every following species under the previous taxon, and the
database looked fine because FISHFINDER never reads class/order/family.

1. FLAGGED ORDERS. ORDER_RE anchored on a bare "^ORDER", but the book prints a
   `*` before the 20 orders that are new or changed since the 7th edition
   ("*ORDER SILURIFORMES"). 2,595 of 5,086 species carried the wrong order, and
   the database had no Perciformes at all.

2. COMMA SEPARATOR. FAMILY_RE required a dash after the family name. The book
   prints "Gobiesocidae, En-clingfishes" with a comma, so all 43 clingfishes
   were filed as mullets.

A third problem is in the book itself: it omits ORDER CHARACIFORMES, which
MISSING_ORDER_HEADERS supplies. parse_pdf.main() now aborts on any header-like
line it cannot parse, and on an injection that does not fire exactly once.
"""

import unittest

from parse_pdf import (FAMILY_SPELLINGS, MISSING_ORDER_HEADERS, audit_header, parse_class,
                       parse_family, parse_order, parse_species_line)

SPECIES_ROW = ("*\tEptatretus caribbeaus Fernholm, 1982................................"
               ".....A:M....................Little Hagfish............................"
               " bruja caribeña")


class TestOrderHeaders(unittest.TestCase):
    def test_plain(self):
        self.assertEqual(parse_order("ORDER MYXINIFORMES"), "Myxiniformes")

    def test_flagged(self):
        self.assertEqual(parse_order("*ORDER SILURIFORMES"), "Siluriformes")
        self.assertEqual(parse_order("*ORDER PERCIFORMES"), "Perciformes")

    def test_double_space(self):
        self.assertEqual(parse_order("ORDER  ACIPENSERIFORMES"), "Acipenseriformes")


class TestClassHeaders(unittest.TestCase):
    def test_class(self):
        self.assertEqual(parse_class("CLASS ACTINOPTERI–RAY-FINNED FISHES"),
                         ("Actinopteri", "RAY-FINNED FISHES"))


class TestFamilyHeaders(unittest.TestCase):
    def test_dash(self):
        self.assertEqual(parse_family("Petromyzontidae–En-lampreys, Sp-lampreas, "
                                      "Fr-lamproies"), "Petromyzontidae")

    def test_flagged(self):
        self.assertEqual(parse_family("*Myxinidae–En-hagfishes, Sp-brujas, Fr-myxines"),
                         "Myxinidae")

    def test_comma(self):
        self.assertEqual(parse_family("Gobiesocidae, En-clingfishes, Sp-chupapiedras, "
                                      "Fr-crampons"), "Gobiesocidae")

    def test_space_after_dash(self):
        self.assertEqual(parse_family("Scorpaenidae– En-scorpionfishes, Sp-escorpiones "
                                      "y rocotes, Fr-scorpènes"), "Scorpaenidae")


class TestSpeciesRowsAreNotHeaders(unittest.TestCase):
    def test_species_row(self):
        self.assertIsNone(parse_order(SPECIES_ROW.strip()))
        self.assertIsNone(parse_family(SPECIES_ROW.strip()))
        self.assertFalse(audit_header(SPECIES_ROW.strip()))
        entry = parse_species_line(SPECIES_ROW)
        self.assertEqual((entry["genus"], entry["species"]), ("Eptatretus", "caribbeaus"))


class TestHeaderAudit(unittest.TestCase):
    """The lines the old regexes skipped must be caught by the audit."""

    def test_flags_header_shaped_lines(self):
        self.assertTrue(audit_header("*ORDER SILURIFORMES"))
        self.assertTrue(audit_header("CLASS ACTINOPTERI–RAY-FINNED FISHES"))
        self.assertTrue(audit_header("Gobiesocidae, En-clingfishes, Sp-chupapiedras, "
                                     "Fr-crampons"))

    def test_ignores_author_continuations(self):
        # Long author strings wrap onto a line of their own.
        self.assertFalse(audit_header("& Verduzco-Martínez, 1977)"))
        self.assertFalse(audit_header("Pompa-Domínguez & Doadrio, 2007"))


class TestMissingOrderHeaders(unittest.TestCase):
    def test_characiformes(self):
        self.assertEqual(MISSING_ORDER_HEADERS, {"Characidae": "Characiformes"})
        # The injection is keyed on the family header that follows the gap.
        header = "*Characidae–En-tetras, Sp-pepescas y sardinitas, Fr-characins"
        self.assertIn(parse_family(header), MISSING_ORDER_HEADERS)


class TestFamilySpellings(unittest.TestCase):
    def test_platyrhinidae(self):
        # ICZN Art. 29.3: the stem of the type genus Platyrhina. Order names are
        # outside the Code, so the printed POLYMIXIFORMES is deliberately absent.
        self.assertEqual(FAMILY_SPELLINGS, {"Platyrhynidae": "Platyrhinidae"})
        header = "Platyrhynidae–En-thornbacks, Sp-guitarras espinudas, Fr-guitares de mer épineuses"
        self.assertIn(parse_family(header), FAMILY_SPELLINGS)


if __name__ == "__main__":
    unittest.main()
