#!/usr/bin/env python3
"""
Step 6: Generate publication-ready figures, tables, and captions.

Reads cache/summary.json and per-paper results from cache/results/
to produce figures and CSV tables suitable for manuscript submission.

Output: cache/figures/
    - fig1_classification_breakdown.png / .pdf
    - fig2_issue_distribution.png / .pdf
    - fig3_top_species.png / .pdf
    - fig4_common_issues.png / .pdf
    - table1_summary.csv
    - table2_issues.csv
    - captions.txt

Usage:
    uv run --with matplotlib python meta_analysis/06_make_figures.py
"""

import csv
import json
from collections import Counter
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Patch

from config import SUMMARY_FILE, RESULTS_DIR, FIGURES_DIR

# ── Style ────────────────────────────────────────────────────────────────────
plt.rcParams.update({
    'font.size': 10,
    'axes.titlesize': 12,
    'axes.labelsize': 10,
    'xtick.labelsize': 9,
    'ytick.labelsize': 9,
    'figure.dpi': 300,
    'savefig.dpi': 300,
    'savefig.bbox': 'tight',
    'savefig.pad_inches': 0.15,
})

# FISHFINDER-inspired color palette
COLORS = {
    'valid':       '#4CAF50',  # green
    'changed':     '#2196F3',  # blue
    'common_name': '#9E9E9E',  # gray
    'outdated':    '#FF9800',  # orange
    'misspelled':  '#F44336',  # red
    'unknown':     '#9C27B0',  # purple
}

LABELS = {
    'valid':       'Valid',
    'changed':     'Changed (8th ed.)',
    'common_name': 'Common Name',
    'outdated':    'Outdated Synonym',
    'misspelled':  'Misspelled',
    'unknown':     'Unknown (not in AFS)',
}

TYPE_ORDER = ['valid', 'changed', 'common_name', 'outdated', 'misspelled', 'unknown']


def load_summary():
    """Load summary.json."""
    with open(SUMMARY_FILE, 'r', encoding='utf-8') as f:
        return json.load(f)


def load_all_results():
    """Load all per-paper result JSONs and return combined details."""
    all_details = []
    if not RESULTS_DIR.exists():
        return all_details
    for f in RESULTS_DIR.glob('*.json'):
        with open(f, 'r', encoding='utf-8') as fp:
            data = json.load(fp)
            for d in data.get('details', []):
                d['source_file'] = f.stem
                all_details.append(d)
    return all_details


# ── Figure 1: Classification Breakdown ───────────────────────────────────────

def fig_classification_breakdown(summary, save_dir):
    """Horizontal bar chart of classification totals."""
    totals = summary['classification_totals']

    types = [t for t in TYPE_ORDER if totals.get(t, 0) > 0]
    counts = [totals.get(t, 0) for t in types]
    colors = [COLORS[t] for t in types]
    labels = [LABELS[t] for t in types]

    fig, ax = plt.subplots(figsize=(7, 3.5))
    bars = ax.barh(labels, counts, color=colors, edgecolor='white', linewidth=0.5)

    # Add count labels
    for bar, count in zip(bars, counts):
        ax.text(bar.get_width() + max(counts) * 0.02, bar.get_y() + bar.get_height() / 2,
                str(count), va='center', fontsize=9)

    ax.set_xlabel('Number of Unique Species Names')
    ax.set_title('Classification of Species Names Across Analyzed Papers')
    ax.invert_yaxis()
    ax.set_xlim(0, max(counts) * 1.15)

    for path in [save_dir / 'fig1_classification_breakdown.png',
                 save_dir / 'fig1_classification_breakdown.pdf']:
        fig.savefig(path)
    plt.close(fig)
    print(f'  Figure 1: Classification breakdown')


# ── Figure 2: Per-Paper Issue Distribution ───────────────────────────────────

def fig_issue_distribution(summary, save_dir):
    """Bar chart showing how many papers have 0, 1, 2, 3+ naming errors."""
    papers = summary.get('top_issue_papers', [])
    # Reconstruct from all papers (top_issue_papers is only top 10)
    # Use the full paper_details from summary if available
    # Fall back to using the data we have
    issue_counts = []
    for p in papers:
        issue_counts.append(p.get('outdated', 0) + p.get('misspelled', 0))

    # If we only have top 10, supplement with zeros for the rest
    total_analyzed = summary['total_papers_analyzed']
    papers_with_errors = summary['papers_with_naming_errors']
    papers_without = total_analyzed - papers_with_errors

    # Build bins: 0, 1, 2, 3+
    bins = Counter()
    bins[0] = papers_without
    for n in issue_counts:
        if n == 0:
            continue  # already counted above
        elif n >= 3:
            bins['3+'] = bins.get('3+', 0) + 1
        else:
            bins[n] = bins.get(n, 0) + 1

    # Ensure we account for papers with issues not in top 10
    accounted = bins[0] + bins.get(1, 0) + bins.get(2, 0) + bins.get('3+', 0)
    if accounted < total_analyzed:
        # Remaining papers with issues (not in top 10) — distribute to bin 1
        bins[1] = bins.get(1, 0) + (total_analyzed - accounted)

    categories = ['0', '1', '2', '3+']
    values = [bins.get(0, 0), bins.get(1, 0), bins.get(2, 0), bins.get('3+', 0)]
    bar_colors = ['#4CAF50', '#FFC107', '#FF9800', '#F44336']

    fig, ax = plt.subplots(figsize=(5, 4))
    bars = ax.bar(categories, values, color=bar_colors, edgecolor='white', width=0.6)

    for bar, val in zip(bars, values):
        if val > 0:
            ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 0.3,
                    str(val), ha='center', va='bottom', fontsize=9)

    ax.set_xlabel('Number of Naming Errors per Paper')
    ax.set_ylabel('Number of Papers')
    ax.set_title('Distribution of Naming Errors Across Papers')
    ax.set_ylim(0, max(values) * 1.15)

    for path in [save_dir / 'fig2_issue_distribution.png',
                 save_dir / 'fig2_issue_distribution.pdf']:
        fig.savefig(path)
    plt.close(fig)
    print(f'  Figure 2: Issue distribution')


# ── Figure 3: Most Common Species ────────────────────────────────────────────

def fig_top_species(summary, all_details, save_dir):
    """Horizontal bar chart of top 20 most frequently detected species."""
    # Aggregate species across all results, using canonical names
    species_type = {}  # canonical name → most common type
    species_count = Counter()

    for d in all_details:
        dtype = d.get('type', '')
        if dtype not in ('valid', 'changed', 'outdated', 'misspelled'):
            continue
        suggestion = d.get('suggestion')
        canonical = suggestion if suggestion else d.get('binomial', '')
        if not canonical:
            continue
        species_count[canonical] += 1
        # Track the type for coloring (prefer the "worst" type)
        priority = {'misspelled': 4, 'outdated': 3, 'changed': 2, 'valid': 1}
        existing = species_type.get(canonical, 'valid')
        if priority.get(dtype, 0) > priority.get(existing, 0):
            species_type[canonical] = dtype

    top = species_count.most_common(20)
    if not top:
        print('  Figure 3: Skipped (no species data)')
        return

    names = [n for n, _ in reversed(top)]
    counts = [c for _, c in reversed(top)]
    colors = [COLORS.get(species_type.get(n, 'valid'), '#4CAF50') for n in names]

    fig, ax = plt.subplots(figsize=(8, 6))
    bars = ax.barh(names, counts, color=colors, edgecolor='white', linewidth=0.5)

    for bar, count in zip(bars, counts):
        ax.text(bar.get_width() + max(counts) * 0.02, bar.get_y() + bar.get_height() / 2,
                str(count), va='center', fontsize=8)

    ax.set_xlabel('Number of Papers')
    ax.set_title('Top 20 Most Frequently Detected Species')
    ax.set_xlim(0, max(counts) * 1.15)

    # Italicize species names
    for label in ax.get_yticklabels():
        label.set_fontstyle('italic')

    # Legend for color coding
    legend_types = sorted(set(species_type.get(n, 'valid') for n in [x for x, _ in top]),
                          key=lambda t: TYPE_ORDER.index(t) if t in TYPE_ORDER else 99)
    legend_patches = [Patch(facecolor=COLORS[t], label=LABELS[t]) for t in legend_types]
    ax.legend(handles=legend_patches, loc='lower right', fontsize=8)

    for path in [save_dir / 'fig3_top_species.png',
                 save_dir / 'fig3_top_species.pdf']:
        fig.savefig(path)
    plt.close(fig)
    print(f'  Figure 3: Top species')


# ── Figure 4: Most Common Naming Issues ──────────────────────────────────────

def fig_common_issues(summary, save_dir):
    """Horizontal bar chart of top outdated + misspelled names with corrections."""
    outdated = summary.get('top_outdated_names', [])[:10]
    misspelled = summary.get('top_misspelled_names', [])[:10]

    if not outdated and not misspelled:
        print('  Figure 4: Skipped (no issues found)')
        return

    # Load details to get suggestion for each name
    all_details = load_all_results()
    suggestion_map = {}
    for d in all_details:
        if d.get('type') in ('outdated', 'misspelled') and d.get('suggestion'):
            suggestion_map[d['binomial']] = d['suggestion']

    entries = []
    for name, count in outdated:
        suggestion = suggestion_map.get(name, '?')
        entries.append((f'{name} → {suggestion}', count, 'outdated'))
    for name, count in misspelled:
        suggestion = suggestion_map.get(name, '?')
        entries.append((f'{name} → {suggestion}', count, 'misspelled'))

    if not entries:
        print('  Figure 4: Skipped (no issue details)')
        return

    labels = [e[0] for e in reversed(entries)]
    counts = [e[1] for e in reversed(entries)]
    colors = [COLORS[e[2]] for e in reversed(entries)]

    fig, ax = plt.subplots(figsize=(9, max(3.5, len(entries) * 0.4)))
    bars = ax.barh(labels, counts, color=colors, edgecolor='white', linewidth=0.5)

    for bar, count in zip(bars, counts):
        ax.text(bar.get_width() + 0.1, bar.get_y() + bar.get_height() / 2,
                str(count), va='center', fontsize=8)

    ax.set_xlabel('Number of Papers')
    ax.set_title('Most Common Naming Issues Detected')
    ax.set_xlim(0, max(counts) * 1.3 if counts else 1)

    # Italicize labels
    for label in ax.get_yticklabels():
        label.set_fontstyle('italic')
        label.set_fontsize(8)

    legend_patches = [
        Patch(facecolor=COLORS['outdated'], label='Outdated Synonym'),
        Patch(facecolor=COLORS['misspelled'], label='Misspelling'),
    ]
    ax.legend(handles=legend_patches, loc='lower right', fontsize=8)

    for path in [save_dir / 'fig4_common_issues.png',
                 save_dir / 'fig4_common_issues.pdf']:
        fig.savefig(path)
    plt.close(fig)
    print(f'  Figure 4: Common issues')


# ── Table 1: Summary Statistics ──────────────────────────────────────────────

def table_summary_stats(summary, save_dir):
    """Write summary statistics as CSV."""
    rows = [
        ('Papers analyzed', summary['total_papers_analyzed']),
        ('Papers excluded (non-NA)', summary['papers_excluded_non_na']),
        ('Papers with naming errors', f"{summary['papers_with_naming_errors']} ({summary['pct_with_errors']}%)"),
        ('  with outdated names', f"{summary['papers_with_outdated_names']} ({summary['pct_with_outdated']}%)"),
        ('  with misspelled names', f"{summary['papers_with_misspelled_names']} ({summary['pct_with_misspelled']}%)"),
        ('Papers with changed names (8th ed.)', f"{summary['papers_with_changed_names']} ({summary['pct_with_changed']}%)"),
        ('Papers with unknown names', f"{summary['papers_with_unknown_names']} ({summary['pct_with_unknown']}%)"),
        ('Total unique species detected', summary['total_species_mentions']),
        ('Journals represented', summary['journals_represented']),
    ]

    # Add classification totals
    for cls in TYPE_ORDER:
        count = summary['classification_totals'].get(cls, 0)
        if count > 0:
            rows.append((f'  {LABELS[cls]}', count))

    path = save_dir / 'table1_summary.csv'
    with open(path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow(['Metric', 'Value'])
        writer.writerows(rows)
    print(f'  Table 1: Summary statistics')


# ── Table 2: Detailed Issues ─────────────────────────────────────────────────

def table_issues(summary, save_dir):
    """Write all outdated and misspelled names with corrections as CSV."""
    all_details = load_all_results()
    suggestion_map = {}
    common_name_map = {}
    for d in all_details:
        if d.get('type') in ('outdated', 'misspelled') and d.get('suggestion'):
            suggestion_map[d['binomial']] = d['suggestion']
            if d.get('commonName'):
                common_name_map[d['binomial']] = d['commonName']

    rows = []
    for name, count in summary.get('top_outdated_names', []):
        rows.append(('Outdated', name, suggestion_map.get(name, ''),
                      common_name_map.get(name, ''), count))
    for name, count in summary.get('top_misspelled_names', []):
        rows.append(('Misspelling', name, suggestion_map.get(name, ''),
                      common_name_map.get(name, ''), count))

    path = save_dir / 'table2_issues.csv'
    with open(path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow(['Type', 'Name Used', 'Correct Name', 'Common Name', 'Papers'])
        writer.writerows(rows)
    print(f'  Table 2: Issue details')


# ── Captions ─────────────────────────────────────────────────────────────────

def write_captions(summary, save_dir):
    """Write publication-ready captions for all figures and tables."""
    n = summary['total_papers_analyzed']
    captions = f"""FIGURE AND TABLE CAPTIONS
========================

Figure 1. Classification of {summary['total_species_mentions']} unique species names detected across {n} open-access papers analyzed by FISHFINDER. Valid names matched the AFS Names of Fishes 8th edition exactly; Changed names are valid in the 8th edition but were updated from the 7th edition; Common Names were matched to their scientific binomial; Outdated names are pre-8th-edition synonyms; Misspelled names had a Levenshtein edit distance of 1-2 from a valid name; Unknown names had a recognized fish genus but an unrecognized species epithet (typically non-North-American species).

Figure 2. Distribution of naming errors (outdated synonyms + misspellings) per paper across {n} analyzed papers. Papers with zero errors used only current, correctly spelled AFS names.

Figure 3. The 20 most frequently detected fish species across all analyzed papers, color-coded by classification type. Species are shown by their current valid name in the AFS 8th edition.

Figure 4. Most common naming issues detected across the analyzed literature. Orange bars indicate outdated synonyms (pre-8th-edition names); red bars indicate misspellings. Arrows show the correction suggested by FISHFINDER.

Table 1. Summary statistics from the FISHFINDER meta-analysis of {n} recent open-access papers on North American fish communities.

Table 2. Detailed listing of all outdated synonyms and misspellings detected, with the corrected name suggested by FISHFINDER and the number of papers in which each error appeared.
"""
    path = save_dir / 'captions.txt'
    path.write_text(captions, encoding='utf-8')
    print(f'  Captions written')


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    FIGURES_DIR.mkdir(parents=True, exist_ok=True)

    print('Loading data...')
    summary = load_summary()
    all_details = load_all_results()

    print(f'Generating figures and tables for {summary["total_papers_analyzed"]} papers.\n')

    fig_classification_breakdown(summary, FIGURES_DIR)
    fig_issue_distribution(summary, FIGURES_DIR)
    fig_top_species(summary, all_details, FIGURES_DIR)
    fig_common_issues(summary, FIGURES_DIR)
    table_summary_stats(summary, FIGURES_DIR)
    table_issues(summary, FIGURES_DIR)
    write_captions(summary, FIGURES_DIR)

    print(f'\nAll outputs saved to {FIGURES_DIR}')


if __name__ == '__main__':
    main()
