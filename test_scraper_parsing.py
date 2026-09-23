"""
Regression tests for the Eschmeyer page parser in scrape_eschmeyer.py.

Run: uv run --with requests --with beautifulsoup4 python -m unittest test_scraper_parsing -v

Four defects motivated these tests, all found in September 2026:

1. DECAPITATION. The pattern had no left anchor, so the scan could start in the
   middle of a capitalized word and read its tail as an epithet. Eschmeyer
   type-locality prose satisfies the whole pattern, lookahead included, so
   "Unalaska Island, Bering Sea [North Pacific]" produced the entry header
   ('sland', 'Bering') and the synonym map shipped 36 records like "Bering sland".
   One of them ("Isabela ove") was even rationalized as real during a review and
   pinned in addenda_changes.json.

2. TRINOMIAL BLINDNESS. The lookahead expected a capitalized author token right
   after the genus, so a subspecies header never matched. Its status line was then
   attributed to whatever entry preceded it — losing a real synonym and, worse,
   able to write a wrong one.

3. HYPHEN TRUNCATION. The binomial-capturing patterns used a bare [a-z]+ for the
   epithet, so "x-punctatus" was captured as "x". That produced phantom names
   ("Hybopsis x", "Erimystax x", "Astroscopus y") and truncated current_name.

4. ASCII-ONLY AUTHORS. The lookahead required [A-Z][a-z]+ for the author token,
   so headers by Lutken, Gunther or Lacepede never matched -- and the pages arrive
   with encoding damage on top. 324 pages had no matchable header at all; their
   synonyms were only ever harvested by accident, via a spurious header.

The SPURIOUS cases below are the ones that actually shipped bad data. Do not relax
the anchor to a bare \\b: it still admits hyphenated place names.
"""

import unittest

from scrape_eschmeyer import ENTRY_HEADER_RE, entry_header_re, parse_text


class TestRealHeaders(unittest.TestCase):
    """Genuine Eschmeyer entry headers must all be recognized."""

    def assert_header(self, text, epithet, genus, subspecies=None):
        matches = ENTRY_HEADER_RE.findall(text)
        self.assertEqual(len(matches), 1, f"expected exactly 1 header in {text!r}, got {matches}")
        self.assertEqual(matches[0][0], epithet)
        self.assertEqual(matches[0][1], genus)
        self.assertEqual(matches[0][2], subspecies or "")

    def test_binomial(self):
        self.assert_header(
            "sladeni, Argyropelecus Regan [C. T.] 1908", "sladeni", "Argyropelecus")

    def test_binomial_single_initial(self):
        self.assert_header(
            "ectenes, Careproctus Gilbert [C. H.] 1896", "ectenes", "Careproctus")

    def test_trinomial(self):
        # Defect 2. Previously returned no match at all.
        self.assert_header(
            "hawaiensis, Argyropelecus lynchus Schultz [L. P.] 1961",
            "hawaiensis", "Argyropelecus", "lynchus")

    def test_hyphenated_epithet(self):
        self.assert_header(
            "y-graecum, Astroscopus Cuvier [G.] 1829", "y-graecum", "Astroscopus")

    def test_subgenus_parenthetical(self):
        self.assert_header(
            "rhina, Raja (Beringraja) Jordan [D.] 1880", "rhina", "Raja")

    def test_epithet_that_is_an_english_word(self):
        # Hypanus say — Say's Stingray. Short, and a common English word.
        self.assert_header("say, Hypanus Lesueur [C.] 1817", "say", "Hypanus")


class TestSpuriousHeaders(unittest.TestCase):
    """Type-locality and citation prose must NOT be read as entry headers.

    Each string here is reconstructed from a junk record that actually shipped.
    """

    def assert_no_header(self, text):
        self.assertEqual(
            ENTRY_HEADER_RE.findall(text), [],
            f"{text!r} must not yield an entry header")

    def test_island_before_sea(self):
        # shipped as "Bering sland"
        self.assert_no_header("North of Unalaska Island, Bering Sea [North Pacific]")

    def test_town_before_lake(self):
        # shipped as "Lake aronga"
        self.assert_no_header("Karonga, Lake Malawi [ref. 1234]")

    def test_cove_before_island(self):
        # shipped as "Isabela ove", then pinned as a curated synonym
        self.assert_no_header("Sulphur Cove, Isabela Island [Albemarle]")

    def test_journal_citation(self):
        # shipped as "University ublications"
        self.assert_no_header("Publications, University Michigan [ref. 2]")

    def test_country_before_sea(self):
        # shipped as "Mediterranean taly"
        self.assert_no_header("Italy, Mediterranean Sea [ref. 9]")

    def test_hyphenated_place_name(self):
        # The case a bare \b does NOT catch, which is why the anchor is
        # (?<![A-Za-z-]) and not \b.
        self.assert_no_header("Ponta-delgada, Santa Maria [ref. 1]")


class TestPinnedEpithet(unittest.TestCase):
    """entry_header_re(epithet) is used by rescrape_transfers.py."""

    def test_matches_its_own_epithet(self):
        rx = entry_header_re("ectenes")
        self.assertEqual(
            rx.findall("ectenes, Careproctus Gilbert [C. H.] 1896"),
            [("ectenes", "Careproctus", "")])

    def test_ignores_other_epithets(self):
        rx = entry_header_re("ectenes")
        self.assertEqual(rx.findall("sladeni, Argyropelecus Regan [C. T.] 1908"), [])

    def test_does_not_match_mid_word(self):
        # "alia" must not match inside "Somalia".
        rx = entry_header_re("alia")
        self.assertEqual(rx.findall("Somalia, Raja Garman [S.] 1881"), [])


class TestHyphenatedEpithets(unittest.TestCase):
    """Defect 3: hyphenated epithets must survive intact, not truncate at the hyphen."""

    def test_synonym_chain_keeps_hyphen(self):
        text = ("x-punctata, Hybopsis Hubbs [C.] 1931:5 [ref. 1] Ohio. "
                "Synonym of Erimystax x-punctatus (Hubbs 1931). Leuciscidae.")
        r = parse_text(text, "Erimystax", "x-punctatus")
        self.assertIn("Hybopsis x-punctata", r["synonyms"])
        self.assertNotIn("Hybopsis x", r["synonyms"])
        self.assertNotIn("Erimystax x", r["synonyms"])

    def test_current_name_keeps_hyphen(self):
        text = "Current status: Valid as Erimystax x-punctatus (Hubbs 1931). Leuciscidae."
        r = parse_text(text, "Erimystax", "x-punctatus")
        self.assertEqual(r["current_name"], "Erimystax x-punctatus")

    def test_plain_epithet_unaffected(self):
        text = "Current status: Valid as Careproctus ectenes (Gilbert 1896). Liparidae."
        r = parse_text(text, "Careproctus", "ectenes")
        self.assertEqual(r["current_name"], "Careproctus ectenes")


class TestTrinomialRecovery(unittest.TestCase):
    """Defect 2, end to end: a subspecies entry must yield its Genus+epithet name."""

    def test_subspecies_entry_yields_synonym(self):
        text = ("hawaiensis, Argyropelecus lynchus Schultz [L. P.] 1961:12 [ref. 1] Hawaii. "
                "Synonym of Argyropelecus sladeni Regan 1908. Sternoptychidae.")
        r = parse_text(text, "Argyropelecus", "sladeni")
        self.assertIn("Argyropelecus hawaiensis", r["synonyms"])


class TestNonAsciiAuthors(unittest.TestCase):
    """The author token in the lookahead must tolerate non-ASCII and mojibake.

    Requiring [A-Z][a-z]+ there left 324 pages with no matchable header, so their
    synonyms were only ever picked up by accident via a spurious header.
    """

    def test_accented_author(self):
        self.assertEqual(
            ENTRY_HEADER_RE.findall("orstedii, Selene Lütken [C. F.] 1880:552"),
            [("orstedii", "Selene", "")])

    def test_mojibake_author(self):
        # Pages arrive with encoding damage; "G�nther" must still parse.
        self.assertEqual(
            ENTRY_HEADER_RE.findall("macracanthus, Pristipoma G�nther [A.] 1864:146"),
            [("macracanthus", "Pristipoma", "")])

    def test_anchor_still_rejects_prose(self):
        # Loosening the author token must not reopen the decapitation hole.
        for prose in ["Karonga, Lake Malawi [ref. 1234]",
                      "North of Unalaska Island, Bering Sea [North Pacific]",
                      "Sulphur Cove, Isabela Island [Albemarle]",
                      "Ponta-delgada, Santa Maria [ref. 1]"]:
            self.assertEqual(ENTRY_HEADER_RE.findall(prose), [], prose)


if __name__ == "__main__":
    unittest.main()
