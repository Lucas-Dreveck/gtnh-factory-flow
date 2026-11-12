"use client";

import { useMemo, useState } from "react";
import { GT_VOLTAGE_TIERS } from "@/lib/model/tiers";
import type { MachineListEntry } from "@/lib/model/machine-list";
import type { ThroughputResult } from "@/lib/model/types";
import {
  euToAmps,
  formatAmps,
  generatorsToCoverDeficit,
  highestTier,
  powerAmpsReadout,
  tierVoltage,
  type AmpTier,
} from "@/lib/power/power-amps";

const eu = (value: number) => Math.round(value).toLocaleString("en-US");
const num = (value: number) =>
  value.toLocaleString("en-US", { maximumFractionDigits: value >= 100 ? 0 : 2 });

/** Compact "surplus as amps of a tier" readout under the machine totals. */
export function PowerAmpsReadout({
  entries,
  result,
}: {
  entries: MachineListEntry[];
  result: ThroughputResult;
}) {
  const defaultTier = useMemo(() => highestTier(entries.map((entry) => entry.tier)), [entries]);
  const [picked, setPicked] = useState<AmpTier | null>(null);
  const tier = picked ?? defaultTier;
  const made = entries.reduce((sum, entry) => sum + (entry.madeEuT ?? 0), 0);
  const used = entries.reduce((sum, entry) => sum + (entry.euT ?? 0), 0);
  const readout = powerAmpsReadout(made, used, tier);
  const net = made - used;
  const generators = entries.filter((entry) => (entry.madeEuT ?? 0) > 0);
  const first = generators[0];
  const perUnit = first && first.count > 0 ? (first.madeEuT ?? 0) / first.count : 0;
  const more = generatorsToCoverDeficit(net, perUnit);
  const red = readout.deficit ? "text-red-400" : "";

  const row = (label: string, euT: number, amps: number, cls = "") => (
    <div className={`flex items-center gap-1.5 text-[12px] leading-5 ${cls}`}>
      <span className="flex-1 text-[11px] uppercase tracking-wider text-[var(--mc-ink-muted)]">
        {label}
      </span>
      <span>{eu(euT)} EU/t</span>
      <span className="w-16 text-right">{formatAmps(amps)} A</span>
    </div>
  );

  return (
    <div className="mt-1 border-t border-neutral-700 pt-1" data-testid="power-amps-readout">
      <div className="flex items-center gap-1.5 text-[11px]">
        <span className="uppercase tracking-wider text-[var(--mc-ink-muted)]">Power in amps at</span>
        <select
          aria-label="Amp tier"
          value={tier}
          onChange={(event) => setPicked(event.target.value as AmpTier)}
          className="rounded bg-neutral-800 px-1"
        >
          {GT_VOLTAGE_TIERS.map((entry) => (
            <option key={entry.tier} value={entry.tier}>
              {entry.tier} ({eu(tierVoltage(entry.tier))} EU/t)
            </option>
          ))}
        </select>
      </div>
      {row("Made", made, readout.madeAmps)}
      {row("Used", used, readout.usedAmps)}
      {row("Net", net, readout.netAmps, `font-bold ${red}`)}
      <div className={`text-[11px] ${red}`}>{readout.summary}</div>
      {readout.deficit && first && more > 0 ? (
        <div className="text-[11px] text-red-400">
          Add {more.toLocaleString("en-US")} more {first.label}
        </div>
      ) : null}
      {generators.map((entry) => {
        const made = entry.madeEuT ?? 0;
        const flows = Object.values(result.nodes[entry.nodeId]?.inputs ?? {}).filter(
          (flow) => flow.amountPerSecond > 0,
        );
        const own = entry.tier ?? tier;
        const fuel = flows.length === 1 ? flows[0] : undefined;
        return (
          <div key={entry.nodeId} className="mt-0.5 text-[11px] text-[var(--mc-ink-muted)]">
            <span className="text-[var(--mc-ink)]">{entry.label}</span> {eu(made)} EU/t,{" "}
            {formatAmps(euToAmps(made, own))} A at {own}
            {flows.length > 0 ? (
              <div>
                {flows.map((flow) => (
                  <span key={flow.key} className="mr-2">
                    {flow.displayName ?? flow.resourceId} {num(flow.amountPerSecond)}/s,{" "}
                    {num(flow.amountPerSecond * 3600)}/h
                  </span>
                ))}
                {fuel ? <span>{num((made * 20) / fuel.amountPerSecond)} EU per unit</span> : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
