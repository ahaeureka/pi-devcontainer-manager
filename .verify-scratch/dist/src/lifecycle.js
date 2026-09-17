export function createLifecycleGuard() {
    let generation = 0;
    return {
        begin: () => (generation += 1),
        isCurrent: (candidate) => candidate === generation,
        invalidate: () => {
            generation += 1;
        },
        current: () => generation,
        ifCurrent: (candidate, apply) => {
            if (candidate !== generation)
                return false;
            apply();
            return true;
        },
    };
}
//# sourceMappingURL=lifecycle.js.map