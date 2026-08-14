/** Metadata created by LocalLeaf before a project is synchronized. */
const LOCALLEAF_METADATA = new Set(['.localleaf', '.leafignore']);

/**
 * A small synchronous gate used to prevent overlapping async link operations.
 * JavaScript executes tryEnter atomically before either operation can await.
 */
export class LinkOperationGate {
    private active = false;

    tryEnter(): boolean {
        if (this.active) return false;
        this.active = true;
        return true;
    }

    leave(): void {
        this.active = false;
    }

    get isActive(): boolean {
        return this.active;
    }
}

/** Return true when linking could affect content not created by LocalLeaf. */
export function shouldConfirmProjectLink(entryNames: readonly string[]): boolean {
    return entryNames.some(name => !LOCALLEAF_METADATA.has(name));
}
