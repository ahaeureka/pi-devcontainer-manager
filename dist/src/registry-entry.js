/**
 * The primary container candidate, or undefined when the workspace has no container.
 *
 * The entry's collection is ordered by discovery preference, so the first element IS the target;
 * nothing else on the entry carries an identity that could disagree with it.
 */
export function primaryCandidate(entry) {
    return entry.containerCandidates[0];
}
/** Every configuration discovered for a workspace; empty for a container-only entry. */
export function configCandidatesOf(entry) {
    return entry.kind === "config" ? entry.configCandidates : [];
}
/** The configuration discovery selected, or undefined for a container-only entry. */
export function primaryConfigOf(entry) {
    return entry.kind === "config" ? entry.primaryConfig : undefined;
}
/** The configuration path to read for this workspace, or undefined when there is none. */
export function configPathOf(entry) {
    return entry.kind === "config" ? entry.primaryConfig.configPath : undefined;
}
/** The container's observed state, or undefined when the workspace has no container. */
export function containerStateOf(entry) {
    return primaryCandidate(entry)?.state;
}
//# sourceMappingURL=registry-entry.js.map