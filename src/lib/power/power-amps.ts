import { getVoltageTierIndex, getVoltageTierMaxEuT } from "@/lib/model/tiers";
import type { MachineTier } from "@/lib/model/types";

export type AmpTier = Exclude<MachineTier, "DEMO">;

/** EU/t of one amp at a tier (8 * 4^index; the repo's tier table is the source). */
export function tierVoltage(tier: AmpTier): number {
  return getVoltageTierMaxEuT(tier);
}

/** Amps an EU/t figure is at a tier. Negative stays negative. */
export function euToAmps(euT: number, tier: AmpTier): number {
  const volts = tierVoltage(tier);
  return Number.isFinite(euT) && volts > 0 ? euT / volts : 0;
}

/** Two decimals, no trailing noise: "1.5", "0.25", "12". */
export function formatAmps(amps: number): string {
  const rounded = Math.round(amps * 100) / 100;
  return (Object.is(rounded, -0) ? 0 : rounded).toLocaleString("en-US", {
    maximumFractionDigits: 2,
  });
}

/** The highest tier among the given ones; LV when there are none. */
export function highestTier(tiers: Array<AmpTier | undefined>): AmpTier {
  let best: AmpTier = "LV";
  let bestIndex = -1;
  for (const tier of tiers) {
    if (!tier) continue;
    const index = getVoltageTierIndex(tier);
    if (index > bestIndex) {
      best = tier;
      bestIndex = index;
    }
  }
  return best;
}

export interface PowerAmpsReadout {
  madeAmps: number;
  usedAmps: number;
  netAmps: number;
  /** Whole amps spare (net >= 0) or short (net < 0). */
  wholeAmps: number;
  deficit: boolean;
  /** "≈ 3 full amps spare" / "short by 1.5 A". */
  summary: string;
}

export function powerAmpsReadout(madeEuT: number, usedEuT: number, tier: AmpTier): PowerAmpsReadout {
  const netEuT = madeEuT - usedEuT;
  const netAmps = euToAmps(netEuT, tier);
  const deficit = netEuT < 0;
  const whole = Math.floor(Math.abs(netAmps) + 1e-9);
  return {
    madeAmps: euToAmps(madeEuT, tier),
    usedAmps: euToAmps(usedEuT, tier),
    netAmps,
    wholeAmps: whole,
    deficit,
    summary: deficit
      ? `short by ${formatAmps(-netAmps)} A`
      : `≈ ${whole.toLocaleString("en-US")} full ${whole === 1 ? "amp" : "amps"} spare`,
  };
}

/** How many more of a generator (EU/t each) cover a deficit; 0 when none is short. */
export function generatorsToCoverDeficit(netEuT: number, perGeneratorEuT: number): number {
  if (!(netEuT < 0) || !(perGeneratorEuT > 0)) return 0;
  return Math.ceil(-netEuT / perGeneratorEuT - 1e-9);
}
