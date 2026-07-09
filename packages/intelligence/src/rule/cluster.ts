import { asId, type RawSignal, type SignalClusterId } from "@idea-finder/core";

import { isDisconfirmingSignalType, isSupportingSignalType } from "./signal-to-claim.js";

export interface SignalCluster {
  readonly id: SignalClusterId;
  readonly signalType: string;
  readonly signals: readonly RawSignal[];
}

export interface ClusteredSignals {
  readonly supporting: readonly SignalCluster[];
  readonly disconfirming: readonly RawSignal[];
}

/** Group signals by type; synthesis cluster aggregates all supporting types. */
export function clusterSignals(
  signals: readonly RawSignal[],
  runKey: string,
): ClusteredSignals {
  const supportingSignals = signals.filter(
    (s) => isSupportingSignalType(s.signalType) && s.signalType !== "noise",
  );
  const disconfirming = signals.filter((s) => isDisconfirmingSignalType(s.signalType));

  const byType = new Map<string, RawSignal[]>();
  for (const signal of supportingSignals) {
    const bucket = byType.get(signal.signalType) ?? [];
    bucket.push(signal);
    byType.set(signal.signalType, bucket);
  }

  const supporting: SignalCluster[] = [...byType.entries()].map(([signalType, group]) => ({
    id: asId(`cluster_${runKey}_${signalType}`),
    signalType,
    signals: group,
  }));

  if (supportingSignals.length > 0) {
    supporting.unshift({
      id: asId(`cluster_${runKey}_synthesis`),
      signalType: "synthesis",
      signals: supportingSignals,
    });
  }

  return { supporting, disconfirming };
}
