import { ChangeType, SyncMode } from './changeTracker';

export interface StartupSyncState {
    syncMode: SyncMode;
    hasBaseContent: boolean;
    lastSynced?: string;
}

export interface PendingSyncCounts {
    localChangeCount: number;
    remoteChangeCount: number;
    conflictCount: number;
}

export interface ManualSyncCompletionState {
    canComplete: boolean;
    reason?: 'conflict' | 'remote' | 'local';
}

export type ManualPushConflictChoice = 'pull' | 'force' | 'cancel';

export interface ManualPushPlanInput {
    conflictCount: number;
    conflictChoice?: ManualPushConflictChoice;
}

export interface ManualPushPlan {
    action: 'push' | 'pull' | 'cancel';
    force: boolean;
}

export interface LocalDeleteTrackingState {
    hasRemoteEntry: boolean;
    hasBaseContent: boolean;
    lastSynced?: string;
}

export interface LocalModificationTrackingState {
    currentContent: Uint8Array;
    baseContent?: Uint8Array;
}

export interface LocalCreateTrackingState {
    hasRemoteEntry: boolean;
    hasBaseContent: boolean;
    currentContent?: Uint8Array;
    baseContent?: Uint8Array;
    remoteContent?: Uint8Array;
}

export interface LocalChangeRestorationState {
    currentExists: boolean;
    hasRemoteEntry: boolean;
    hasBaseContent: boolean;
    currentContent?: Uint8Array;
    baseContent?: Uint8Array;
    remoteContent?: Uint8Array;
    lastSynced?: string;
}

export function shouldAutoPullOnProjectLoad(state: StartupSyncState): boolean {
    if (state.syncMode === 'realtime') {
        return true;
    }
    return !state.hasBaseContent && !state.lastSynced;
}

export function shouldPushAfterManualPull(counts: PendingSyncCounts): boolean {
    return counts.localChangeCount > 0 &&
        counts.remoteChangeCount === 0 &&
        counts.conflictCount === 0;
}

export function getManualSyncCompletionState(counts: PendingSyncCounts): ManualSyncCompletionState {
    if (counts.conflictCount > 0) {
        return { canComplete: false, reason: 'conflict' };
    }
    if (counts.remoteChangeCount > 0) {
        return { canComplete: false, reason: 'remote' };
    }
    if (counts.localChangeCount > 0) {
        return { canComplete: false, reason: 'local' };
    }
    return { canComplete: true };
}

export function getManualPushPlan(input: ManualPushPlanInput): ManualPushPlan {
    if (input.conflictCount === 0) {
        return { action: 'push', force: false };
    }

    if (input.conflictChoice === 'force') {
        return { action: 'push', force: true };
    }
    if (input.conflictChoice === 'pull') {
        return { action: 'pull', force: false };
    }
    return { action: 'cancel', force: false };
}

export function shouldTrackLocalDelete(state: LocalDeleteTrackingState): boolean {
    return state.hasRemoteEntry && (state.hasBaseContent || !!state.lastSynced);
}

export function shouldTrackLocalModification(state: LocalModificationTrackingState): boolean {
    if (!state.baseContent) {
        return true;
    }
    if (state.currentContent.length !== state.baseContent.length) {
        return true;
    }
    for (let i = 0; i < state.currentContent.length; i++) {
        if (state.currentContent[i] !== state.baseContent[i]) {
            return true;
        }
    }
    return false;
}

export function getLocalCreateChangeType(state: LocalCreateTrackingState): ChangeType | undefined {
    if (!state.hasRemoteEntry && !state.hasBaseContent) {
        return 'created';
    }

    const comparisonContent = state.baseContent ?? state.remoteContent;
    if (!state.currentContent || !comparisonContent) {
        return 'modified';
    }

    return shouldTrackLocalModification({
        currentContent: state.currentContent,
        baseContent: comparisonContent,
    }) ? 'modified' : undefined;
}

export function getRestoredLocalChangeType(state: LocalChangeRestorationState): ChangeType | undefined {
    if (!state.currentExists) {
        return shouldTrackLocalDelete({
            hasRemoteEntry: state.hasRemoteEntry,
            hasBaseContent: state.hasBaseContent,
            lastSynced: state.lastSynced,
        }) ? 'deleted' : undefined;
    }

    if (!state.hasRemoteEntry && !state.hasBaseContent) {
        return 'created';
    }

    const comparisonContent = state.baseContent ?? state.remoteContent;
    if (!state.currentContent || !comparisonContent) {
        return undefined;
    }

    return shouldTrackLocalModification({
        currentContent: state.currentContent,
        baseContent: comparisonContent,
    }) ? 'modified' : undefined;
}
