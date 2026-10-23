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
export declare function primaryCandidate(entry: RegistryEntry): RegistryCandidate | undefined;
/** Every configuration discovered for a workspace; empty for a container-only entry. */
export declare function configCandidatesOf(entry: RegistryEntry): readonly ConfigCandidate[];
/** The configuration discovery selected, or undefined for a container-only entry. */
export declare function primaryConfigOf(entry: RegistryEntry): ConfigCandidate | undefined;
/** The configuration path to read for this workspace, or undefined when there is none. */
export declare function configPathOf(entry: RegistryEntry): string | undefined;
/** The container's observed state, or undefined when the workspace has no container. */
export declare function containerStateOf(entry: RegistryEntry): RegistryCandidate["state"] | undefined;
/**
 * The configuration that should drive mapping, presentation and the routing guard for a workspace.
 *
 * The operator's SELECTED configuration wins when it belongs to that workspace, else the workspace's
 * discovered primary. Before this rule existed in one place, a selected named configuration reached
 * only the CLI's argv while every derived view kept using the registry primary, so the two disagreed
 * (review finding L1-04). Shared by both entry points for the same reason.
 */
export declare function selectedConfigPathFor(selection: {
    readonly workspaceKey?: string | undefined;
    readonly configPath?: string | undefined;
}, workspaceKey: string, discovered: string): string;
//# sourceMappingURL=registry-entry.d.ts.map