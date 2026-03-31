#!/usr/bin/env python3
"""
Step 5: Aggregate FISHFINDER analysis results into summary statistics.

Reads per-paper JSON results from cache/results/ and produces:
  - cache/summary.json (structured data)
  - cache/summary.md  (formatted report for manuscript insertion)

Papers where fewer than NA_SPECIES_RATIO_THRESHOLD of detected species
are in the AFS database are flagged as non-North-American studies and
excluded from the main statistics.
"""

import json
from collections import Counter
from config import (
    PAPERS_CACHE, RESULTS_DIR, SUMMARY_FILE, SUMMARY_MD,
    NA_SPECIES_RATIO_THRESHOLD,
)


def load_papers():
    """Load papers cache for metadata."""
    if not PAPERS_CACHE.exists():
        return {'papers': {}}
    with open(PAPERS_CACHE, 'r', encoding='utf-8') as f:
        return json.load(f)


def load_results():
    """Load all per-paper analysis results."""
    results = {}
    if not RESULTS_DIR.exists():
        return results
    for f in RESULTS_DIR.glob('*.json'):
        with open(f, 'r', encoding='utf-8') as fp:
            data = json.load(fp)
            results[f.stem] = data
    return results


def build_paper_lookup(cache):
    """Build a filename-hash -> paper metadata lookup."""
    lookup = {}
    for doi, paper in cache.get('papers', {}).items():
        pdf_file = paper.get('pdf_file', '')
        if pdf_file:
            lookup[pdf_file] = paper
    return lookup


def compute_na_ratio(classifications):
    """Fraction of classified species that are in the AFS database.

    AFS-recognized types: valid, changed, outdated, misspelled, common_name
    Non-AFS type: unknown (genus recognized, species not in database)
    """
    na_types = ('valid', 'changed', 'outdated', 'misspelled', 'common_name')
    na_count = sum(classifications.get(t, 0) for t in na_types)
    unknown = classifications.get('unknown', 0)
    total = na_count + unknown
    if total == 0:
        return 1.0  # no species found → don't exclude
    return na_count / total


def summarize():
    """Generate summary statistics from analysis results."""
    cache = load_papers()
    paper_lookup = build_paper_lookup(cache)
    results = load_results()

    if not results:
        print('No analysis results found. Run steps 1-4 first.')
        return

    print(f'Summarizing {len(results)} analyzed papers.\n')

    # ── Classify papers as NA or excluded ────────────────────────────────
    included_results = {}
    excluded_papers = []

    for file_hash, result in results.items():
        classifications = result.get('classifications', {})
        n_unknown = classifications.get('unknown', 0)
        ratio = compute_na_ratio(classifications)

        if ratio < NA_SPECIES_RATIO_THRESHOLD and n_unknown > 3:
            paper_meta = paper_lookup.get(file_hash, {})
            excluded_papers.append({
                'file_hash': file_hash,
                'doi': paper_meta.get('doi', ''),
                'title': paper_meta.get('title', 'Unknown'),
                'na_ratio': round(ratio, 2),
                'unknown_count': n_unknown,
                'reason': 'low_na_species_ratio',
            })
        else:
            included_results[file_hash] = result

    if excluded_papers:
        print(f'Excluded {len(excluded_papers)} non-North-American papers '
              f'(NA species ratio < {NA_SPECIES_RATIO_THRESHOLD}).')

    # ── Aggregate statistics (included papers only) ──────────────────────
    total_papers = len(included_results)
    papers_with_issues = 0
    papers_with_outdated = 0
    papers_with_misspelled = 0
    papers_with_changed = 0
    papers_with_unknown = 0

    total_species_found = 0
    total_by_type = Counter()
    outdated_names = Counter()
    misspelled_names = Counter()
    changed_names = Counter()
    all_species = Counter()     # every species by classification type
    journal_counts = Counter()

    paper_details = []

    for file_hash, result in included_results.items():
        paper_meta = paper_lookup.get(file_hash, {})

        n_unique = result.get('unique_binomials', 0)
        classifications = result.get('classifications', {})
        details = result.get('details', [])

        total_species_found += n_unique

        for dtype, count in classifications.items():
            total_by_type[dtype] += count

        n_outdated = classifications.get('outdated', 0)
        n_misspelled = classifications.get('misspelled', 0)
        n_changed = classifications.get('changed', 0)
        n_unknown = classifications.get('unknown', 0)

        # Issues = outdated + misspelled only (NOT unknown)
        has_issues = (n_outdated + n_misspelled) > 0

        if has_issues:
            papers_with_issues += 1
        if n_outdated > 0:
            papers_with_outdated += 1
        if n_misspelled > 0:
            papers_with_misspelled += 1
        if n_changed > 0:
            papers_with_changed += 1
        if n_unknown > 0:
            papers_with_unknown += 1

        # Track specific problematic names
        for d in details:
            binomial = d.get('binomial', '')
            dtype = d.get('type', '')
            if dtype == 'outdated':
                outdated_names[binomial] += 1
            elif dtype == 'misspelled':
                misspelled_names[binomial] += 1
            elif dtype == 'changed':
                changed_names[binomial] += 1

            # Track all species for frequency analysis
            if dtype in ('valid', 'changed', 'outdated', 'misspelled'):
                suggestion = d.get('suggestion')
                canonical = suggestion if suggestion else binomial
                all_species[canonical] += 1

        journal = paper_meta.get('journal', 'Unknown')
        journal_counts[journal] += 1

        paper_details.append({
            'file_hash': file_hash,
            'doi': paper_meta.get('doi', ''),
            'title': paper_meta.get('title', 'Unknown'),
            'year': paper_meta.get('year', 0),
            'journal': journal,
            'species_found': n_unique,
            'outdated': n_outdated,
            'misspelled': n_misspelled,
            'changed': n_changed,
            'unknown': n_unknown,
            'has_issues': has_issues,
        })

    # Sort by number of issues (descending)
    paper_details.sort(key=lambda p: p['outdated'] + p['misspelled'], reverse=True)

    # ── Build summary ────────────────────────────────────────────────────
    pct = lambda n: round(n / total_papers * 100, 1) if total_papers else 0

    summary = {
        'total_papers_analyzed': total_papers,
        'papers_excluded_non_na': len(excluded_papers),
        'papers_with_naming_errors': papers_with_issues,
        'papers_with_outdated_names': papers_with_outdated,
        'papers_with_misspelled_names': papers_with_misspelled,
        'papers_with_changed_names': papers_with_changed,
        'papers_with_unknown_names': papers_with_unknown,
        'pct_with_errors': pct(papers_with_issues),
        'pct_with_outdated': pct(papers_with_outdated),
        'pct_with_misspelled': pct(papers_with_misspelled),
        'pct_with_changed': pct(papers_with_changed),
        'pct_with_unknown': pct(papers_with_unknown),
        'total_species_mentions': total_species_found,
        'classification_totals': dict(total_by_type),
        'top_outdated_names': outdated_names.most_common(20),
        'top_misspelled_names': misspelled_names.most_common(20),
        'top_changed_names': changed_names.most_common(20),
        'top_species': all_species.most_common(30),
        'journals_represented': len(journal_counts),
        'top_journals': journal_counts.most_common(15),
        'top_issue_papers': paper_details[:10],
        'excluded_papers': excluded_papers,
    }

    # ── Write JSON ───────────────────────────────────────────────────────
    SUMMARY_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(SUMMARY_FILE, 'w', encoding='utf-8') as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)
    print(f'Summary JSON written to {SUMMARY_FILE}')

    # ── Write Markdown report ────────────────────────────────────────────
    md = generate_markdown_report(summary)
    SUMMARY_MD.write_text(md, encoding='utf-8')
    print(f'Summary report written to {SUMMARY_MD}')

    # ── Print highlights ─────────────────────────────────────────────────
    print(f'\n{"=" * 60}')
    print(f'FISHFINDER Meta-Analysis Summary')
    print(f'{"=" * 60}')
    print(f'Papers analyzed:             {total_papers}')
    print(f'Papers excluded (non-NA):    {len(excluded_papers)}')
    print(f'Papers with naming errors:   {papers_with_issues} ({pct(papers_with_issues)}%)')
    print(f'  - with outdated names:     {papers_with_outdated} ({pct(papers_with_outdated)}%)')
    print(f'  - with misspelled names:   {papers_with_misspelled} ({pct(papers_with_misspelled)}%)')
    print(f'Papers with changed names:   {papers_with_changed} ({pct(papers_with_changed)}%)')
    print(f'Papers with unknown names:   {papers_with_unknown} ({pct(papers_with_unknown)}%)')
    print(f'Total species found:         {total_species_found}')
    print(f'Journals represented:        {len(journal_counts)}')

    if outdated_names:
        print(f'\nTop 5 most common outdated names:')
        for name, count in outdated_names.most_common(5):
            print(f'  {name}: {count} papers')

    if misspelled_names:
        print(f'\nTop 5 most common misspellings:')
        for name, count in misspelled_names.most_common(5):
            print(f'  {name}: {count} papers')


def generate_markdown_report(summary):
    """Generate a formatted Markdown report for manuscript inclusion."""
    lines = [
        '# FISHFINDER Meta-Analysis: Fish Naming Errors in Recent Literature',
        '',
        '## Overview',
        '',
        f'We analyzed **{summary["total_papers_analyzed"]}** recent open-access '
        f'papers (published {2023}--present) involving North American fish species. '
        f'Papers were retrieved from OpenAlex and filtered to English-language, '
        f'open-access articles with at least one author at a US, Canadian, or '
        f'Mexican institution. Title keywords were used to select multi-species '
        f'field studies (e.g., community surveys, species checklists, assemblage '
        f'assessments).',
    ]

    if summary['papers_excluded_non_na']:
        lines.extend([
            '',
            f'An additional {summary["papers_excluded_non_na"]} papers were excluded '
            f'because fewer than {int(NA_SPECIES_RATIO_THRESHOLD * 100)}% of detected '
            f'species were in the AFS database, indicating the study focused on '
            f'non-North-American fauna.',
        ])

    lines.extend([
        '',
        '## Key Findings',
        '',
        f'- **{summary["pct_with_errors"]:.1f}%** of papers contained at least one '
        f'naming error (outdated synonym or misspelling)',
        f'- **{summary["pct_with_outdated"]:.1f}%** used at least one outdated '
        f'species name (pre-8th edition synonym)',
        f'- **{summary["pct_with_misspelled"]:.1f}%** contained at least one '
        f'misspelled species name',
        f'- **{summary["pct_with_changed"]:.1f}%** referenced species whose names '
        f'changed between the 7th and 8th editions (not errors, but worth verifying)',
        f'- A total of **{summary["total_species_mentions"]}** unique species names '
        f'were encountered across all papers',
        '',
        '## Classification Breakdown',
        '',
        '| Classification | Count | Description |',
        '|---------------|-------|-------------|',
    ])

    type_descriptions = {
        'valid': 'Exact match in AFS 8th edition',
        'changed': 'Valid but updated from 7th edition',
        'common_name': 'Matched via common name',
        'outdated': 'Pre-8th edition synonym',
        'misspelled': 'Levenshtein distance <= 2 from valid name',
        'unknown': 'Recognized genus, species not in AFS database',
    }

    for cls in ['valid', 'changed', 'common_name', 'outdated', 'misspelled', 'unknown']:
        count = summary['classification_totals'].get(cls, 0)
        desc = type_descriptions.get(cls, '')
        lines.append(f'| {cls.replace("_", " ").title()} | {count} | {desc} |')

    if summary['top_outdated_names']:
        lines.extend([
            '',
            '## Most Common Outdated Names',
            '',
            '| Outdated Name | Papers Using It |',
            '|---------------|----------------|',
        ])
        for name, count in summary['top_outdated_names'][:10]:
            lines.append(f'| *{name}* | {count} |')

    if summary['top_misspelled_names']:
        lines.extend([
            '',
            '## Most Common Misspellings',
            '',
            '| Misspelled Name | Papers |',
            '|-----------------|--------|',
        ])
        for name, count in summary['top_misspelled_names'][:10]:
            lines.append(f'| *{name}* | {count} |')

    if summary['top_changed_names']:
        lines.extend([
            '',
            '## Most Common Changed Names (7th → 8th Edition)',
            '',
            '| Species | Papers |',
            '|---------|--------|',
        ])
        for name, count in summary['top_changed_names'][:10]:
            lines.append(f'| *{name}* | {count} |')

    lines.extend([
        '',
        f'## Journals Represented',
        '',
        f'The analysis covered papers from **{summary["journals_represented"]}** '
        f'different journals.',
        '',
    ])

    return '\n'.join(lines)


if __name__ == '__main__':
    summarize()
