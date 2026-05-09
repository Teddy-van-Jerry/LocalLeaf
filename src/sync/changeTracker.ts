/**
 * LocalLeaf Change Tracker
 * Tracks pending local and remote changes for manual sync mode
 */

import * as vscode from 'vscode';

export type ChangeType = 'modified' | 'created' | 'deleted' | 'renamed' | 'moved';
export type SyncMode = 'manual' | 'realtime';

export interface PendingChange {
    path: string;
    type: ChangeType;
    source: 'local' | 'remote';
    timestamp: number;
    entityId?: string;
    entityType?: 'doc' | 'file' | 'folder';
    /** For rename/move: the old path */
    oldPath?: string;
    /** For rename/move: the new parent id */
    newParentId?: string;
    /** Remote content snapshot (for applying later) */
    remoteContent?: Uint8Array;
}

/**
 * Tracks pending changes in manual sync mode.
 * Local changes accumulate until the user pushes.
 * Remote changes accumulate until the user pulls.
 */
export class ChangeTracker {
    private localChanges: Map<string, PendingChange> = new Map();
    private remoteChanges: Map<string, PendingChange> = new Map();

    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    addLocalChange(change: PendingChange): void {
        // Deduplicate: newer change for same path replaces older one
        const existing = this.localChanges.get(change.path);
        if (existing && existing.type === 'created' && change.type === 'modified') {
            // Keep as 'created' if file was just created then modified
            change.type = 'created';
        }
        if (existing && existing.type === 'created' && change.type === 'deleted') {
            // File was created then deleted — cancel both
            this.localChanges.delete(change.path);
            this._onDidChange.fire();
            return;
        }
        this.localChanges.set(change.path, change);
        this._onDidChange.fire();
    }

    addRemoteChange(change: PendingChange): void {
        const existing = this.remoteChanges.get(change.path);
        if (existing && existing.type === 'created' && change.type === 'modified') {
            change.type = 'created';
        }
        if (existing && existing.type === 'created' && change.type === 'deleted') {
            this.remoteChanges.delete(change.path);
            this._onDidChange.fire();
            return;
        }
        this.remoteChanges.set(change.path, change);
        this._onDidChange.fire();
    }

    getLocalChanges(): PendingChange[] {
        return Array.from(this.localChanges.values());
    }

    getRemoteChanges(): PendingChange[] {
        return Array.from(this.remoteChanges.values());
    }

    /**
     * Returns changes that exist in both local and remote maps (same path).
     * These represent potential conflicts that need resolution.
     */
    getConflicts(): PendingChange[] {
        const conflicts: PendingChange[] = [];
        for (const [path, localChange] of this.localChanges) {
            if (this.remoteChanges.has(path)) {
                conflicts.push(localChange);
            }
        }
        return conflicts;
    }

    getLocalChangeCount(): number {
        return this.localChanges.size;
    }

    getRemoteChangeCount(): number {
        return this.remoteChanges.size;
    }

    getConflictCount(): number {
        let count = 0;
        for (const path of this.localChanges.keys()) {
            if (this.remoteChanges.has(path)) {
                count++;
            }
        }
        return count;
    }

    hasLocalChange(path: string): boolean {
        return this.localChanges.has(path);
    }

    hasRemoteChange(path: string): boolean {
        return this.remoteChanges.has(path);
    }

    getLocalChange(path: string): PendingChange | undefined {
        return this.localChanges.get(path);
    }

    getRemoteChange(path: string): PendingChange | undefined {
        return this.remoteChanges.get(path);
    }

    clearLocal(path?: string): void {
        if (path) {
            this.localChanges.delete(path);
        } else {
            this.localChanges.clear();
        }
        this._onDidChange.fire();
    }

    clearRemote(path?: string): void {
        if (path) {
            this.remoteChanges.delete(path);
        } else {
            this.remoteChanges.clear();
        }
        this._onDidChange.fire();
    }

    clearAll(): void {
        this.localChanges.clear();
        this.remoteChanges.clear();
        this._onDidChange.fire();
    }

    dispose(): void {
        this._onDidChange.dispose();
    }
}
