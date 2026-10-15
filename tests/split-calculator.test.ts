/**
 * Acceptance tests — split arithmetic (§6, §7, §4.3 of the Master Specification)
 *
 * Run with:
 *
 *   npx tsx --test tests/split-calculator.test.ts
 *
 * No test framework is installed deliberately. This project's runtime version
 * uses the `fingerprint` policy, so adding a devDependency can change the
 * fingerprint and orphan the installed APK from over-the-air updates. Node 24
 * ships `node:test`, and `tsx` runs from npx without touching package.json, so
 * the suite costs nothing in delivery risk.
 *
 * SCOPE
 *
 * These cover the pure calculation layer only — the part that can be tested
 * without a database. Acceptance tests D through I (multiple payers, partial
 * settlement, deletion, edit, group conservation, simplification) all exercise
 * Postgres functions and need a scratch database to run against. They are
 * listed at the bottom as todos rather than silently omitted; running them
 * against production is not an option.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateEqualSplit,
  calculatePercentSplit,
  calculateSharesSplit,
  validateExactSplit,
} from '../lib/splitCalculator';

/** Sum a list of rupee amounts in paise, so the assertion itself cannot drift. */
const sumPaise = (shares: number[]) =>
  shares.reduce((total, share) => total + Math.round(share * 100), 0);

const paise = (rupees: number) => Math.round(rupees * 100);


// ---------------------------------------------------------------------------
// Test A — equal split
// ---------------------------------------------------------------------------

test('A: ₹1,000 split three ways sums to exactly ₹1,000', () => {
  const shares = calculateEqualSplit(1000, 3);

  assert.equal(shares.length, 3);
  assert.equal(sumPaise(shares), paise(1000));

  // Two participants pay ₹333.33 and one pays ₹333.34. Which one receives the
  // extra paisa is an ordering decision (§7 permits stable participant order as
  // the tie-break); that it is exactly one paisa is not.
  const sorted = [...shares].sort();
  assert.deepEqual(sorted, [333.33, 333.33, 333.34]);
});

test('A: equal split conserves the total for every size and amount', () => {
  // §4.3 — after rounding, the shares must sum to the expense total. No
  // exception. This sweeps the awkward cases rather than trusting one example.
  for (let people = 1; people <= 25; people++) {
    for (const amount of [0.01, 0.03, 1, 9.99, 100, 100.01, 1000, 1256, 4088, 99999.99]) {
      const shares = calculateEqualSplit(amount, people);
      assert.equal(
        sumPaise(shares),
        paise(amount),
        `${people} people splitting ₹${amount} did not conserve the total`,
      );
    }
  }
});

test('A: no participant is more than one paisa from an even share', () => {
  // The remainder must be spread one paisa at a time, never concentrated.
  for (let people = 2; people <= 25; people++) {
    for (const amount of [0.07, 1, 9.99, 100, 100.01, 1256, 4088]) {
      const shares = calculateEqualSplit(amount, people);
      const ideal = paise(amount) / people;
      for (const share of shares) {
        assert.ok(
          Math.abs(paise(share) - ideal) <= 1,
          `${people} people splitting ₹${amount}: a share was ` +
            `${Math.abs(paise(share) - ideal)} paise from even`,
        );
      }
    }
  }
});

test('A: equal split is deterministic', () => {
  // §7 — the allocation must not vary between runs.
  const first = calculateEqualSplit(100, 3);
  for (let i = 0; i < 50; i++) {
    assert.deepEqual(calculateEqualSplit(100, 3), first);
  }
});

test('A: degenerate inputs return no shares rather than nonsense', () => {
  assert.deepEqual(calculateEqualSplit(100, 0), []);
  assert.deepEqual(calculateEqualSplit(0, 3), []);
  assert.deepEqual(calculateEqualSplit(-5, 3), []);
});


// ---------------------------------------------------------------------------
// Tests B and C — exact split
// ---------------------------------------------------------------------------

test('B: an exact split that reconciles is accepted', () => {
  assert.equal(validateExactSplit(1000, [500, 300, 200]), true);
});

test('C: an exact split that does not reconcile is rejected', () => {
  // ₹500 + ₹300 + ₹100 = ₹900 against a ₹1,000 expense.
  assert.equal(validateExactSplit(1000, [500, 300, 100]), false);
});

test('C: a one-paisa discrepancy is still a discrepancy', () => {
  assert.equal(validateExactSplit(1000, [500, 300, 199.99]), false);
  assert.equal(validateExactSplit(1000, [500, 300, 200.01]), false);
});

test('B: floating-point representation does not cause a false rejection', () => {
  // 0.1 + 0.2 !== 0.3 in binary floating point. A validator comparing raw sums
  // must not reject a split the user entered correctly.
  assert.equal(validateExactSplit(0.3, [0.1, 0.2]), true);
  assert.equal(validateExactSplit(1256, [418.67, 418.67, 418.66]), true);
});


// ---------------------------------------------------------------------------
// Percentage split (§6.3) and the rounding rule (§7)
// ---------------------------------------------------------------------------

test('percent: 50 / 30 / 20 of ₹1,000 gives ₹500 / ₹300 / ₹200', () => {
  assert.deepEqual(calculatePercentSplit(1000, [50, 30, 20]), [500, 300, 200]);
});

test('percent: percentages that do not total 100 are rejected', () => {
  assert.throws(() => calculatePercentSplit(1000, [50, 30, 10]));
  assert.throws(() => calculatePercentSplit(1000, [50, 30, 30]));
});

test('percent: the shares always sum to the expense total', () => {
  const cases: Array<[number, number[]]> = [
    [1000, [50, 30, 20]],
    [99.99, [33.33, 33.33, 33.34]],
    [100.01, [10, 10, 10, 10, 10, 10, 10, 10, 10, 10]],
    [100.1, Array(20).fill(5)],
    [1256, [33.33, 33.33, 33.34]],
  ];

  for (const [total, percentages] of cases) {
    const shares = calculatePercentSplit(total, percentages);
    assert.equal(
      sumPaise(shares),
      paise(total),
      `₹${total} at ${percentages.join('/')}% did not conserve the total`,
    );
  }
});

test('percent: no participant absorbs more than one paisa of rounding error', () => {
  // §7 requires the leftover minor units to go to the participants with the
  // largest fractional remainders — one paisa each. The current implementation
  // hands the entire accumulated remainder to whoever happens to be last:
  //
  //   if (index === percentages.length - 1) return remainingCents;
  //
  // With twenty participants at 5% of ₹100.10, each ideal share is 500.5 paise.
  // Math.round takes all nineteen up to 501, and the twentieth absorbs the
  // whole 9-paisa shortfall.
  //
  // This test states the specification. It is expected to fail until H4 is
  // fixed, and it is the proof that H4 is real rather than theoretical.
  const total = 100.1;
  const percentages = Array(20).fill(5);
  const shares = calculatePercentSplit(total, percentages);
  const ideal = paise(total) / percentages.length;

  for (const [index, share] of shares.entries()) {
    const drift = Math.abs(paise(share) - ideal);
    assert.ok(
      drift <= 1,
      `participant ${index + 1} is ${drift} paise from their ideal share ` +
        `(expected at most 1) — the remainder is being concentrated, not distributed`,
    );
  }
});


// ---------------------------------------------------------------------------
// Shares split (§6.4)
// ---------------------------------------------------------------------------

test('shares: ₹1,000 at 1 : 2 : 2 gives ₹200 / ₹400 / ₹400', () => {
  // The specification's worked example.
  assert.deepEqual(calculateSharesSplit(1000, [1, 2, 2]), [200, 400, 400]);
});

test('shares: the ratio is what matters, not the magnitude', () => {
  // 1:2:2 and 2:4:4 and 5:10:10 describe the same split.
  const expected = calculateSharesSplit(1000, [1, 2, 2]);
  assert.deepEqual(calculateSharesSplit(1000, [2, 4, 4]), expected);
  assert.deepEqual(calculateSharesSplit(1000, [5, 10, 10]), expected);
});

test('shares: equal share counts match an equal split', () => {
  for (const people of [2, 3, 7, 11]) {
    for (const amount of [100, 999.99, 1256]) {
      assert.deepEqual(
        calculateSharesSplit(amount, Array(people).fill(1)),
        calculateEqualSplit(amount, people),
        `${people} people at 1 share each should equal an even split of ₹${amount}`,
      );
    }
  }
});

test('shares: the total is always conserved', () => {
  const cases: Array<[number, number[]]> = [
    [1000, [1, 2, 2]],
    [100, [1, 1, 1]],
    [99.99, [1, 2, 3]],
    [100.01, [3, 1]],
    [1256, [1, 1, 1]],
    [0.05, [1, 1, 1, 1, 1, 1, 1]],
    [4088, [2, 3, 5, 7, 11]],
  ];

  for (const [total, units] of cases) {
    assert.equal(
      sumPaise(calculateSharesSplit(total, units)),
      paise(total),
      `₹${total} at ${units.join(':')} did not conserve the total`,
    );
  }
});

test('shares: no participant absorbs more than one paisa of rounding error', () => {
  const total = 100.01;
  const units = [1, 1, 1];
  const shares = calculateSharesSplit(total, units);
  const ideal = paise(total) / 3;

  for (const share of shares) {
    assert.ok(
      Math.abs(paise(share) - ideal) <= 1,
      'the remainder is being concentrated rather than distributed',
    );
  }
});

test('shares: someone with zero shares pays nothing', () => {
  assert.deepEqual(calculateSharesSplit(900, [1, 2, 0]), [300, 600, 0]);
});

test('shares: no shares at all is rejected rather than dividing by zero', () => {
  assert.throws(() => calculateSharesSplit(1000, [0, 0, 0]));
  assert.throws(() => calculateSharesSplit(1000, []));
});

test('shares: allocation is deterministic', () => {
  const first = calculateSharesSplit(100.01, [1, 1, 1]);
  for (let i = 0; i < 50; i++) {
    assert.deepEqual(calculateSharesSplit(100.01, [1, 1, 1]), first);
  }
});


// ---------------------------------------------------------------------------
// Not runnable without a database
// ---------------------------------------------------------------------------

test('D: multiple payers', { todo: 'H1 — not implemented; the model holds one payer' }, () => {});

test('E: partial settlement leaves the correct remainder',
  { todo: 'needs a scratch database — exercises record_settlement()' }, () => {});

test('F: voiding an expense clears both counterparties',
  { todo: 'needs a scratch database — exercises void_transaction()' }, () => {});

test('G: editing an expense rebuilds removed participants',
  { todo: 'needs a scratch database — exercises record_expense()' }, () => {});

test('H: group member net positions sum to zero',
  { todo: 'needs a scratch database — exercises recalculate_group_settlements()' }, () => {});

test('I: debt simplification conserves every net position',
  { todo: 'needs a scratch database — exercises recalculate_group_settlements()' }, () => {});

test('J: mixed currencies are never summed',
  { todo: 'M5 — single-currency system; cannot be satisfied or violated yet' }, () => {});
