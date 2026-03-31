#!/usr/bin/env python3
"""
Step 1: Discover candidate fish papers via the OpenAlex API.

Fetches the most recent open-access, English-language fish papers authored
at US/CA/MX institutions, sorted newest-first.  A lightweight title-keyword
filter keeps only multi-species field studies likely to contain AFS-listed
scientific names.  Pages through results until MAX_PAPERS are accepted (or
the API is exhausted).

Output: cache/papers.json
"""

import json
import time
import requests
from config import (
    OPENALEX_API, OPENALEX_EMAIL, OPENALEX_DELAY,
    MIN_YEAR, LANGUAGE, MAX_PAPERS, PER_PAGE, MAX_PAGES,
    PAPERS_CACHE, CACHE_DIR, USER_AGENT, FISH_CONCEPT_ID,
    INSTITUTION_COUNTRIES, TITLE_INCLUDE, TITLE_EXCLUDE,
)


def load_cache():
    """Load existing papers cache, or return empty structure."""
    if PAPERS_CACHE.exists():
        with open(PAPERS_CACHE, 'r', encoding='utf-8') as f:
            return json.load(f)
    return {'papers': {}, 'last_cursor': None}


def save_cache(cache):
    """Write papers cache to disk."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    with open(PAPERS_CACHE, 'w', encoding='utf-8') as f:
        json.dump(cache, f, indent=2, ensure_ascii=False)


def fetch_page(cursor='*'):
    """Fetch one page of results from OpenAlex, sorted newest-first.

    Returns (results_list, next_cursor_or_None).
    """
    params = {
        'filter': (
            f'publication_year:>{MIN_YEAR - 1},'
            f'language:{LANGUAGE},'
            f'is_oa:true,'
            f'type:article,'
            f'concepts.id:{FISH_CONCEPT_ID},'
            f'authorships.institutions.country_code:{INSTITUTION_COUNTRIES}'
        ),
        'sort': 'publication_date:desc',
        'per_page': PER_PAGE,
        'cursor': cursor,
        'mailto': OPENALEX_EMAIL,
        'select': ','.join([
            'id', 'doi', 'title', 'publication_year',
            'authorships', 'primary_location',
            'open_access', 'cited_by_count',
        ]),
    }

    headers = {'User-Agent': USER_AGENT}
    resp = requests.get(OPENALEX_API, params=params, headers=headers, timeout=30)
    resp.raise_for_status()
    data = resp.json()

    results = data.get('results', [])
    meta = data.get('meta', {})
    next_cursor = meta.get('next_cursor')

    return results, next_cursor


def title_is_relevant(title):
    """Return True if the title suggests a multi-species fish field study."""
    lower = title.lower()

    # Exclude first — quick reject
    for pattern in TITLE_EXCLUDE:
        if pattern in lower:
            return False

    # Must match at least one include keyword
    for pattern in TITLE_INCLUDE:
        if pattern in lower:
            return True

    return False


def extract_paper_info(work):
    """Extract relevant metadata from an OpenAlex work object."""
    doi = work.get('doi', '') or ''
    if doi.startswith('https://doi.org/'):
        doi = doi[len('https://doi.org/'):]
    if not doi:
        return None

    title = work.get('title', 'Untitled') or 'Untitled'
    if not title_is_relevant(title):
        return None

    # Authors
    authors = []
    for authorship in work.get('authorships', [])[:10]:
        author = authorship.get('author', {})
        name = author.get('display_name', '')
        if name:
            authors.append(name)

    # Journal / source
    primary_loc = work.get('primary_location', {}) or {}
    source = primary_loc.get('source', {}) or {}
    journal = source.get('display_name', 'Unknown')

    # OA URL
    oa = work.get('open_access', {}) or {}
    oa_url = oa.get('oa_url', '')

    return {
        'doi': doi,
        'title': title,
        'authors': authors,
        'year': work.get('publication_year', 0),
        'journal': journal,
        'oa_url': oa_url,
        'cited_by_count': work.get('cited_by_count', 0),
        'openalex_id': work.get('id', ''),
        'download_status': 'pending',
    }


def discover():
    """Page through OpenAlex newest-first until MAX_PAPERS are accepted."""
    cache = load_cache()
    papers = cache['papers']
    cursor = cache.get('last_cursor') or '*'
    initial_count = len(papers)

    print(f'Starting discovery. {len(papers)} papers already cached.')

    if len(papers) >= MAX_PAPERS:
        print(f'Already have {len(papers)} papers (target {MAX_PAPERS}). Nothing to do.')
        return

    pages_fetched = 0
    total_seen = 0
    accepted = 0

    while cursor and len(papers) < MAX_PAPERS and pages_fetched < MAX_PAGES:
        try:
            results, next_cursor = fetch_page(cursor)
        except requests.RequestException as e:
            print(f'  API error: {e}. Saving progress and stopping.')
            break

        if not results:
            print('  No more results from OpenAlex.')
            break

        page_accepted = 0
        for work in results:
            total_seen += 1
            info = extract_paper_info(work)
            if info and info['doi'] not in papers:
                papers[info['doi']] = info
                page_accepted += 1
                accepted += 1

        pages_fetched += 1
        cursor = next_cursor

        print(f'  Page {pages_fetched}: {page_accepted} accepted '
              f'(total {len(papers)}/{MAX_PAPERS}, '
              f'{total_seen} scanned)')

        # Save after each page for resumability
        cache['papers'] = papers
        cache['last_cursor'] = cursor
        save_cache(cache)

        time.sleep(OPENALEX_DELAY)

    new_papers = len(papers) - initial_count
    accept_rate = (accepted / total_seen * 100) if total_seen else 0
    print(f'\nDiscovery complete. {new_papers} new papers accepted '
          f'({total_seen} scanned, {accept_rate:.0f}% acceptance rate). '
          f'Total: {len(papers)} papers cached.')


if __name__ == '__main__':
    discover()
