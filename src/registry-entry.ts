/**
 * Accessors for the `RegistryEntry` discriminated union.
 *
 * The union makes the entry's state readable from `kind` (review finding L4-04), but consumers still
 * need the two questions that used to be answered by sentinel checks — "which container is the
 * target?" and "what configurations does this workspace have?" — without hand-rolling
 * `configPath.length === 0` again. These are the only sanctioned ways to ask.
 */
import type { ConfigCandidate, RegistryCandidate, RegistryEntry } from "./types.js";

/**
 * The primary container candidate, or undefined when the workspace has no container.
 *
 * The entry's collection is ordered by discovery preference, so the first element IS the target;
 * nothing else on the entry carries an identity that could disagree with it.
 */
export function primaryCandidate(entry: RegistryEntry): RegistryCandidate | undefined {
  return entry.containerCandidates[0];
}

/** Every configuration discovered for a workspace; empty for a container-only entry. */
export function configCandidatesOf(entry: RegistryEntry): readonly ConfigCandidate[] {
  return entry.kind === "config" ? entry.configCandidates : [];
}

/** The configuration discovery selected, or undefined for a container-only entry. */
export function primaryConfigOf(entry: RegistryEntry): ConfigCandidate | undefined {
  return entry.kind === "config" ? entry.primaryConfig : undefined;
}

/** The configuration path to read for this workspace, or undefined when there is none. */
export function configPathOf(entry: RegistryEntry): string | undefined {
  return entry.kind === "config" ? entry.primaryConfig.configPath : undefined;
}

/** The container's observed state, or undefined when the workspace has no container. */
export function containerStateOf(entry: RegistryEntry): RegistryCandidate["state"] | undefined {
  return primaryCandidate(entry)?.state;
}
