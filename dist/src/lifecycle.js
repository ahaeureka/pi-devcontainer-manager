export function createLifecycleGuard() {
    let generation = 0;
    return {
        begin: () => (generation += 1),
        isCurrent: (candidate) => candidate === generation,
        invalidate: () => {
            generation += 1;
        },
        current: () => generation,
    };
}
//# sourceMappingURL=lifecycle.js.map