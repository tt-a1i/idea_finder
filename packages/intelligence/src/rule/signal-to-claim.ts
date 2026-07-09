import type { SignalType, SupportsClaim } from "@idea-finder/core";

const SUPPORTING_TYPES: ReadonlySet<SignalType> = new Set([
  "pain",
  "workaround",
  "alternative_seek",
  "willingness_to_pay",
  "competitor_dissatisfaction",
  "feature_request",
]);

export function isSupportingSignalType(signalType: SignalType): boolean {
  return SUPPORTING_TYPES.has(signalType);
}

export function isDisconfirmingSignalType(signalType: SignalType): boolean {
  return signalType === "validation_negative";
}

/** Map harvest signal types to evidence claim categories. */
export function signalTypeToSupportsClaim(signalType: SignalType): SupportsClaim | null {
  switch (signalType) {
    case "pain":
    case "feature_request":
    case "alternative_seek":
      return "pain";
    case "workaround":
      return "workaround";
    case "willingness_to_pay":
      return "wtp";
    case "competitor_dissatisfaction":
      return "competitor_gap";
    case "validation_negative":
      return "disconfirming";
    case "noise":
    case "trend":
      return null;
  }
}
