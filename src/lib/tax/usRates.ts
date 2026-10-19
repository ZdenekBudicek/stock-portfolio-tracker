import type { FilingStatus } from "./profile";

// IRS Rev. Proc. 2023-34 §3.01/.03, 2024-40 §2.01/.03, 2025-32 §4.01/.03.
// https://www.irs.gov/pub/irs-drop/rp-23-34.pdf
// https://www.irs.gov/pub/irs-drop/rp-24-40.pdf
// https://www.irs.gov/pub/irs-drop/rp-25-32.pdf
type Status = Exclude<FilingStatus, "qualifyingSurvivingSpouse">;
export const US_RATES: Record<number, { ordinary: Record<Status, number[]>; capital: Record<Status, [number, number]> }> = {
  2024: {
    ordinary: {
      single: [11600, 47150, 100525, 191950, 243725, 609350],
      marriedJoint: [23200, 94300, 201050, 383900, 487450, 731200],
      marriedSeparate: [11600, 47150, 100525, 191950, 243725, 365600],
      headOfHousehold: [16550, 63100, 100500, 191950, 243700, 609350],
    },
    capital: { single: [47025, 518900], marriedJoint: [94050, 583750], marriedSeparate: [47025, 291850], headOfHousehold: [63000, 551350] },
  },
  2025: {
    ordinary: {
      single: [11925, 48475, 103350, 197300, 250525, 626350],
      marriedJoint: [23850, 96950, 206700, 394600, 501050, 751600],
      marriedSeparate: [11925, 48475, 103350, 197300, 250525, 375800],
      headOfHousehold: [17000, 64850, 103350, 197300, 250500, 626350],
    },
    capital: { single: [48350, 533400], marriedJoint: [96700, 600050], marriedSeparate: [48350, 300000], headOfHousehold: [64750, 566700] },
  },
  2026: {
    ordinary: {
      single: [12400, 50400, 105700, 201775, 256225, 640600],
      marriedJoint: [24800, 100800, 211400, 403550, 512450, 768700],
      marriedSeparate: [12400, 50400, 105700, 201775, 256225, 384350],
      headOfHousehold: [17700, 67450, 105700, 201750, 256200, 640600],
    },
    capital: { single: [49450, 545500], marriedJoint: [98900, 613700], marriedSeparate: [49450, 306850], headOfHousehold: [66200, 579600] },
  },
};
export const ordinaryRates = [0.10, 0.12, 0.22, 0.24, 0.32, 0.35, 0.37];
export const rateStatus = (s: FilingStatus): Status => s === "qualifyingSurvivingSpouse" ? "marriedJoint" : s;
