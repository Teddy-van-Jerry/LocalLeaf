import * as vscode from 'vscode';
import { SyncMode } from '../sync/changeTracker';

export interface LocalLeafScmState {
    linked: boolean;
    connected: boolean;
    mode: SyncMode;
    hookEnabled: boolean;
    workspaceUri?: vscode.Uri;
}

/**
 * Lightweight SCM bridge: exposes LocalLeaf in the Source Control tab
 * without rendering file-level resource states there.
 */
export class LocalLeafScmBridge implements vscode.Disposable {
    private sourceControl?: vscode.SourceControl;
    private rootKey?: string;

    async refreshState(state: LocalLeafScmState): Promise<void> {
        await vscode.commands.executeCommand('setContext', 'localleaf.scmActive', state.linked);
        await vscode.commands.executeCommand('setContext', 'localleaf.gitCommitAutoPushEnabled', state.hookEnabled);

        if (!state.linked || !state.workspaceUri) {
            this.disposeSourceControl();
            return;
        }

        this.ensureSourceControl(state.workspaceUri);
        if (!this.sourceControl) {
            return;
        }

        this.sourceControl.count = 0;
        this.sourceControl.inputBox.visible = false;
        this.sourceControl.inputBox.enabled = false;
        this.sourceControl.inputBox.placeholder = this.buildPlaceholder(state);
    }

    dispose(): void {
        this.disposeSourceControl();
    }

    private ensureSourceControl(rootUri: vscode.Uri): void {
        const nextRootKey = rootUri.toString();
        if (this.sourceControl && this.rootKey === nextRootKey) {
            return;
        }

        this.disposeSourceControl();
        this.sourceControl = vscode.scm.createSourceControl('localleaf', 'LocalLeaf', rootUri);
        this.rootKey = nextRootKey;
        this.sourceControl.inputBox.visible = false;
        this.sourceControl.inputBox.enabled = false;
    }

    private disposeSourceControl(): void {
        this.sourceControl?.dispose();
        this.sourceControl = undefined;
        this.rootKey = undefined;
    }

    private buildPlaceholder(state: LocalLeafScmState): string {
        if (!state.connected) {
            return 'LocalLeaf disconnected';
        }
        const modeLabel = state.mode === 'manual' ? 'manual' : 'real-time';
        return state.hookEnabled
            ? `LocalLeaf listening (${modeLabel} mode)`
            : `LocalLeaf connected (${modeLabel} mode)`;
    }
}
