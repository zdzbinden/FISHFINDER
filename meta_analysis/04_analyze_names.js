#!/usr/bin/env node
/**
 * Analyze text files for fish names using the FISHFINDER engine.
 *
 * Usage:
 *   node 04_analyze_names.js <input.txt> <output.json>      # single file
 *   node 04_analyze_names.js --batch <texts_dir> <results_dir>  # batch mode
 *
 * Follows the same engine-loading pattern as fishfinder/test/setup.js.
 */

const fs = require('fs');
const path = require('path');
const engine = require('../../fishfinder/js/engine.js');

// Load species database and build lookups (once)
const dbPath = path.join(__dirname, '..', '..', 'fishfinder', 'data', 'fish_names.json');
const db = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
const lookups = engine.buildLookups(db);

/**
 * Analyze a single text string and return structured results.
 */
function analyzeText(text) {
    // Extract candidate binomials
    const candidates = engine.extractCandidates(text);
    const binomialSpans = candidates.map(c => ({
        start: c.index,
        end: c.index + c.text.length
    }));

    // Extract common names
    const commonNames = engine.extractCommonNames(lookups, text, binomialSpans);

    // Classify each candidate
    const classified = [];
    const seen = new Set();

    for (const c of candidates) {
        const key = `${c.genus} ${c.species}`;
        if (seen.has(key.toLowerCase())) continue;
        seen.add(key.toLowerCase());

        const result = engine.classifyName(lookups, c.genus, c.species);
        if (result) {
            classified.push({
                binomial: key,
                type: result.type,
                suggestion: result.suggestion || null,
                commonName: result.commonName || null,
            });
        }
    }

    // Classify common names (deduplicated)
    for (const cn of commonNames) {
        const key = cn.text;
        if (!seen.has(key.toLowerCase())) {
            seen.add(key.toLowerCase());
            const result = engine.classifyName(lookups, cn.genus || '', cn.species || '');
            if (result) {
                classified.push({
                    binomial: result.suggestion || key,
                    type: 'common_name',
                    suggestion: result.suggestion || null,
                    commonName: key,
                });
            }
        }
    }

    // Tally by classification type
    const counts = {};
    for (const c of classified) {
        counts[c.type] = (counts[c.type] || 0) + 1;
    }

    return {
        candidates_found: candidates.length,
        unique_binomials: classified.length,
        classifications: counts,
        details: classified,
    };
}

/**
 * Process a single file.
 */
function processFile(inputPath, outputPath) {
    const text = fs.readFileSync(inputPath, 'utf-8');
    const result = analyzeText(text);
    result.source_file = path.basename(inputPath);
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');
}

/**
 * Batch process all .txt files in a directory.
 */
function processBatch(textsDir, resultsDir) {
    const files = fs.readdirSync(textsDir).filter(f => f.endsWith('.txt'));
    let processed = 0;
    let skipped = 0;

    for (const file of files) {
        const baseName = path.basename(file, '.txt');
        const outputPath = path.join(resultsDir, `${baseName}.json`);

        // Skip already-processed files (resume support)
        if (fs.existsSync(outputPath)) {
            skipped++;
            continue;
        }

        const inputPath = path.join(textsDir, file);
        try {
            processFile(inputPath, outputPath);
            processed++;
            if (processed % 10 === 0) {
                console.log(`  Analyzed ${processed} papers...`);
            }
        } catch (err) {
            console.error(`  Error analyzing ${file}: ${err.message}`);
        }
    }

    console.log(`Analysis complete: ${processed} processed, ${skipped} skipped (cached).`);
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args[0] === '--batch' && args.length === 3) {
    processBatch(args[1], args[2]);
} else if (args.length === 2) {
    processFile(args[0], args[1]);
} else {
    console.error('Usage:');
    console.error('  node 04_analyze_names.js <input.txt> <output.json>');
    console.error('  node 04_analyze_names.js --batch <texts_dir> <results_dir>');
    process.exit(1);
}
