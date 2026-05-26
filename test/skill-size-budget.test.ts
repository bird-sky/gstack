/**
 * Per-skill SKILL.md size budget regression (v1.45.0.0 T5).
 *
 * Asserts that no skill's generated SKILL.md grew beyond the v1.44.1
 * baseline. Catches preamble/resolver changes that bloat skills back to
 * the pre-compression size. Free — pure file IO + JSON diff.
 *
 * Why a separate test from skill-budget-regression.test.ts: that one
 * compares LIVE eval runs (tool calls, turns, cost); this one compares
 * static SKILL.md sizes. Both gate-tier.
 *
 * The baseline lives at test/fixtures/parity-baseline-v1.44.1.json,
 * captured by scripts/capture-baseline.ts before any Phase A work landed.
 *
 * Override:
 * - GSTACK_SIZE_BUDGET_RATIO=<n> changes the per-skill regression ratio.
 *   Default 1.0 (no growth allowed). Set to 1.10 to permit 10% growth
 *   (e.g., during deliberate feature additions that the catalog trim
 *   doesn't offset).
 * - GSTACK_SIZE_BUDGET_OVERRIDE_REASON="text" allows a regression to
 *   pass and logs the reason to ~/.gstack/analytics/spend-overrides.jsonl
 *   for audit. Use sparingly; the next baseline should bake in the new
 *   size.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { captureBaseline, type ParityBaseline } from './helpers/capture-parity-baseline';
import { logBudgetOverride } from './helpers/budget-override';

const REPO_ROOT = path.resolve(import.meta.dir, '..');
const BASELINE_PATH = path.join(REPO_ROOT, 'test', 'fixtures', 'parity-baseline-v1.44.1.json');

// Default per-skill ratio is 1.05 (5% growth tolerance). T4 catalog trim
// MOVES text from frontmatter (always-loaded catalog) to a body section
// ("## When to invoke"), so small skills with already-short descriptions
// see a tiny body growth from the section header itself (~20 bytes). The
// 5% per-skill tolerance accommodates that while still catching real bloat;
// the always-loaded catalog cost is enforced separately with a hard ceiling.
const DEFAULT_RATIO = 1.05;
const RATIO = Number(process.env.GSTACK_SIZE_BUDGET_RATIO) || DEFAULT_RATIO;

interface Regression {
  skill: string;
  beforeBytes: number;
  afterBytes: number;
  growth: number;
}

describe('SKILL.md size budget regression (gate, free)', () => {
  test('parity-baseline-v1.44.1.json exists', () => {
    expect(fs.existsSync(BASELINE_PATH)).toBe(true);
  });

  test('no skill exceeds v1.44.1 baseline size × ratio', () => {
    const baseline: ParityBaseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
    const current = captureBaseline({ repoRoot: REPO_ROOT });

    const regressions: Regression[] = [];
    for (const [skill, before] of Object.entries(baseline.skills)) {
      const after = current.skills[skill];
      if (!after) continue; // skill removed since v1.44 — not a regression
      if (after.skillMdBytes <= before.skillMdBytes * RATIO) continue;
      regressions.push({
        skill,
        beforeBytes: before.skillMdBytes,
        afterBytes: after.skillMdBytes,
        growth: after.skillMdBytes / before.skillMdBytes,
      });
    }

    if (regressions.length === 0) return;

    const overrideReason = process.env.GSTACK_SIZE_BUDGET_OVERRIDE_REASON?.trim();
    if (overrideReason) {
      logBudgetOverride({
        scope: 'skill-size-budget',
        reason: overrideReason,
        details: { ratio: RATIO, regressions },
      });
      // eslint-disable-next-line no-console
      console.warn(
        `[skill-size-budget] OVERRIDE APPLIED (${overrideReason}) — ${regressions.length} regression(s) allowed:`,
      );
      for (const r of regressions) {
        // eslint-disable-next-line no-console
        console.warn(`  ${r.skill}: ${r.beforeBytes} → ${r.afterBytes} bytes (×${r.growth.toFixed(2)})`);
      }
      return;
    }

    const msg = regressions.map(r =>
      `  ${r.skill}: ${r.beforeBytes} → ${r.afterBytes} bytes (×${r.growth.toFixed(2)})`,
    ).join('\n');
    throw new Error(
      `${regressions.length} skill(s) regressed past v1.44.1 baseline × ${RATIO}:\n${msg}\n` +
      `Override: set GSTACK_SIZE_BUDGET_OVERRIDE_REASON="why this is OK" to allow and audit-log.`,
    );
  });

  test('total corpus byte count does not regress past baseline × ratio', () => {
    const baseline: ParityBaseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
    const current = captureBaseline({ repoRoot: REPO_ROOT });
    const ratio = current.totalCorpusBytes / baseline.totalCorpusBytes;
    if (current.totalCorpusBytes <= baseline.totalCorpusBytes * RATIO) {
      // eslint-disable-next-line no-console
      console.log(
        `[skill-size-budget] corpus OK: ${baseline.totalCorpusBytes} → ${current.totalCorpusBytes} bytes (×${ratio.toFixed(3)})`,
      );
      return;
    }
    const overrideReason = process.env.GSTACK_SIZE_BUDGET_OVERRIDE_REASON?.trim();
    if (overrideReason) {
      logBudgetOverride({
        scope: 'skill-size-budget-corpus',
        reason: overrideReason,
        details: { ratio: RATIO, observed: ratio, before: baseline.totalCorpusBytes, after: current.totalCorpusBytes },
      });
      return;
    }
    throw new Error(
      `Total corpus regressed past v1.44.1 baseline × ${RATIO}: ` +
      `${baseline.totalCorpusBytes} → ${current.totalCorpusBytes} bytes (×${ratio.toFixed(3)}). ` +
      `Override: set GSTACK_SIZE_BUDGET_OVERRIDE_REASON to allow.`,
    );
  });

  test('catalog token estimate stays compressed (v1.45 target ≤ 7000)', () => {
    const current = captureBaseline({ repoRoot: REPO_ROOT });
    const v145Target = 7000;
    if (current.estTotalCatalogTokens <= v145Target) {
      // eslint-disable-next-line no-console
      console.log(`[skill-size-budget] catalog OK: ~${current.estTotalCatalogTokens} tokens (target ≤${v145Target})`);
      return;
    }
    const overrideReason = process.env.GSTACK_SIZE_BUDGET_OVERRIDE_REASON?.trim();
    if (overrideReason) {
      logBudgetOverride({
        scope: 'skill-size-budget-catalog',
        reason: overrideReason,
        details: { target: v145Target, observed: current.estTotalCatalogTokens },
      });
      return;
    }
    throw new Error(
      `Catalog token estimate regressed past v1.45 target: ${current.estTotalCatalogTokens} tokens > ${v145Target}. ` +
      `T4 catalog trim should keep this under control. Override: set GSTACK_SIZE_BUDGET_OVERRIDE_REASON to allow.`,
    );
  });
});
