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

export const calculatePercentSplit = (totalAmount: number, percentages: number[]): number[] => {
  const sum = percentages.reduce((acc, curr) => acc + (curr || 0), 0);
  if (Math.abs(sum - 100) > 0.01) {
    throw new Error('Percentages must sum to exactly 100%');
  }

  const totalCents = Math.round(totalAmount * 100);
  let remainingCents = totalCents;
  const shares = percentages.map((percent, index) => {
    if (index === percentages.length - 1) {
      return remainingCents; // Give all remaining cents to last person to avoid rounding leaks
    }
    const shareCents = Math.round((percent / 100) * totalCents);
    remainingCents -= shareCents;
    return shareCents;
  });

  return shares.map(cents => cents / 100);
};

export const validateExactSplit = (totalAmount: number, exactAmounts: number[]): boolean => {
  const sum = exactAmounts.reduce((acc, curr) => acc + (curr || 0), 0);
  return Math.abs(totalAmount - sum) < 0.01;
};
