/**
 * Distributes a total amount into N shares, handling cents precision.
 */
export const calculateEqualSplit = (totalAmount: number, participantsCount: number): number[] => {
  if (participantsCount <= 0 || totalAmount <= 0) return [];
  
  const totalCents = Math.round(totalAmount * 100);
  const baseShareCents = Math.floor(totalCents / participantsCount);
  const remainderCents = totalCents % participantsCount;

  const shares: number[] = new Array(participantsCount).fill(baseShareCents);
  for (let i = 0; i < remainderCents; i++) {
    shares[i] += 1;
  }

  return shares.map(cents => cents / 100);
};

/**
 * Largest-remainder allocation in whole numbers.
 *
 * Gives each weight its floor share of `totalCents` out of `denominator`, then
 * hands the leftover paise out one at a time, largest remainder first, ties
 * broken by participant order (§7: deterministic).
 *
 * The earlier version worked the ideal share out in floating point and sorted
 * on the fractional part. When two remainders were exactly equal, float noise
 * could put the later participant first, so the written tie rule (lower index
 * wins) was not always what happened: 1072 paise split 27/52/21 gave
 * [289, 558, 225] where the rule says [290, 557, 225]. Remainders here are
 * integers (weight * total) % denominator, so a tie is a true tie.
 *
 * Every product stays under 2^53 for any amount up to about ₹1 crore and any
 * weight up to 10^6.
 */
const allocateByRatio = (totalCents: number, weights: number[], denominator: number): number[] => {
  const remainders = weights.map(weight => (weight * totalCents) % denominator);
  // (product - remainder) divides exactly, so no floating-point rounding can nudge the floor.
  const shares = weights.map((weight, i) => (weight * totalCents - remainders[i]) / denominator);
  const leftover = totalCents - shares.reduce((acc, cents) => acc + cents, 0);

  const order = weights
    .map((_, index) => index)
    .sort((a, b) => (remainders[b] - remainders[a]) || (a - b));

  for (let i = 0; i < leftover && order.length > 0; i++) {
    shares[order[i % order.length]] += 1;
  }

  return shares;
};

export const calculatePercentSplit = (totalAmount: number, percentages: number[]): number[] => {
  const sum = percentages.reduce((acc, curr) => acc + (curr || 0), 0);
  if (Math.abs(sum - 100) > 0.01) {
    throw new Error('Percentages must sum to exactly 100%');
  }

  const totalCents = Math.round(totalAmount * 100);

  // Largest-remainder allocation (§7).
  //
  // This used to round each share to the nearest paisa and hand whatever was
  // left to the last participant:
  //
  //   if (index === percentages.length - 1) return remainingCents;
  //
  // The total came out right, so nothing was lost — but the entire accumulated
  // rounding error landed on one arbitrary person. Twenty participants at 5% of
  // ₹100.10 left the twentieth 9 paise short of an even share.
  //
  // Instead: floor every share, then hand out the leftover paise one at a time
  // to whoever has the largest fractional part. Nobody can end up more than a
  // single paisa from their exact entitlement.
  // Whole-number maths (see allocateByRatio). A percentage is held in basis
  // points (hundredths of a percent), so 33.33% is 3333 and the denominator is
  // always 10000.
  const shares = allocateByRatio(
    totalCents,
    percentages.map(percent => Math.round((percent || 0) * 100)),
    10000,
  );

  return shares.map(cents => cents / 100);
};

/**
 * Splits by proportional shares (§6.4) — "A gets one share, B and C get two each".
 *
 * Shares are a ratio, not a total, so unlike percentages they need not add to
 * any particular number: [1, 2, 2] and [2, 4, 4] describe the same split. Only
 * the proportions matter, which is what makes this easier to use than
 * percentages for the cases it suits — two people sharing a room against one
 * person in a single, a couple counted as two against individuals.
 *
 * Uses the same largest-remainder allocation as calculatePercentSplit, so the
 * leftover paise are spread one at a time rather than landing on whoever
 * happens to be last, and the result is deterministic.
 */
export const calculateSharesSplit = (totalAmount: number, shareUnits: number[]): number[] => {
  const totalUnits = shareUnits.reduce((acc, units) => acc + (units || 0), 0);
  if (totalUnits <= 0) {
    throw new Error('Total shares must be greater than zero');
  }

  const totalCents = Math.round(totalAmount * 100);
  // Units are held in thousandths so a fractional share such as 1.5 stays exact.
  const weights = shareUnits.map(units => Math.round((units || 0) * 1000));
  const shares = allocateByRatio(totalCents, weights, weights.reduce((acc, w) => acc + w, 0));

  return shares.map(cents => cents / 100);
};

export const validateExactSplit = (totalAmount: number, exactAmounts: number[]): boolean => {
  // Compared in paise, exactly. The previous version summed rupees as floats
  // and allowed a tolerance of `< 0.01`, which let a genuine one-paisa shortfall
  // through: 1000 - 999.99 evaluates to 0.00999999999999091 in binary floating
  // point, which is under the threshold. §4.3 admits no tolerance — the shares
  // must sum to the total — and working in minor units means none is needed.
  const totalPaise = Math.round(totalAmount * 100);
  const sumPaise = exactAmounts.reduce(
    (acc, amount) => acc + Math.round((amount || 0) * 100),
    0,
  );
  return totalPaise === sumPaise;
};
