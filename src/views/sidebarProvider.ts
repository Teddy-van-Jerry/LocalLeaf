/**
 * LocalLeaf Sidebar Providers
 *
 * TreeDataProviders for the sidebar:
 * - DetailsProvider: server/account/compiler info when linked (collapsed)
 * - ToolsProvider: utility actions
 *
 * ChangesProvider has been moved to changesWebviewProvider.ts (WebviewViewProvider).
 * ProjectsProvider has been moved to projectsWebviewProvider.ts (WebviewViewProvider).
 */

import * as vscode from 'vscode';
import { CredentialManager } from '../utils/credentialManager';
import { SettingsManager } from '../utils/settingsManager';
import { COMMANDS } from '../consts';
import { SyncStatus } from '../sync/syncEngine';

// ── Details Provider (linked state — collapsed bottom) ─────────────

export class DetailsProvider implements vscode.TreeDataProvider<SidebarItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private credentialManager: CredentialManager) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: SidebarItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: SidebarItem): Promise<SidebarItem[]> {
        if (element) { return []; }

        const settingsManager = SettingsManager.getCurrentInstance();
        const settings = settingsManager?.getSettings();
        if (!settings) { return []; }

        const serverUrl = this.credentialManager.getDefaultServer();
        const credential = await this.credentialManager.getCredential(serverUrl);

        const items: SidebarItem[] = [];

        items.push(new SidebarItem(settings.serverUrl, {
            icon: 'globe',
            description: 'Server',
        }));

        if (credential) {
            items.push(new SidebarItem(credential.userEmail, {
                icon: 'account',
                description: 'Account',
            }));
        }

        if (settings.mainTex) {
            items.push(new SidebarItem(settings.mainTex, {
                icon: 'file',
                description: 'Main document',
            }));
        }

        items.push(new SidebarItem(settings.projectId, {
            icon: 'key',
            description: 'Project ID',
        }));

        // Sync mode
        const syncModeLabel = settings.syncMode === 'realtime' ? 'Real-time' : 'Manual';
        items.push(new SidebarItem(syncModeLabel, {
            icon: settings.syncMode === 'realtime' ? 'zap' : 'git-pull-request',
            description: 'Sync mode',
        }));

        // Compiler info
        if (settings.compiler) {
            items.push(new SidebarItem(settings.compiler, {
                icon: 'gear',
                description: 'Compiler',
            }));
        }

        // Auto-compile status
        if (settings.compileOnSave !== undefined) {
            items.push(new SidebarItem(settings.compileOnSave ? 'Enabled' : 'Disabled', {
                icon: settings.compileOnSave ? 'check' : 'circle-slash',
                description: 'Auto-compile',
            }));
        }

        return items;
    }
}

// ── Tools Provider ────────────────────────────────────────────────

export class ToolsProvider implements vscode.TreeDataProvider<SidebarItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: SidebarItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: SidebarItem): Promise<SidebarItem[]> {
        if (element) { return []; }

        return [
            new SidebarItem('Remove LaTeX Comments', {
                icon: 'comment-unresolved',
                description: 'Strip % comments from .tex files',
                command: {
                    command: COMMANDS.REMOVE_COMMENTS,
                    title: 'Remove LaTeX Comments',
                },
            }),
        ];
    }
}

// ── Helpers ────────────────────────────────────────────────────────

/** Build a sync-status description string for the view title. */
export function syncStatusDescription(status: SyncStatus, lastSynced?: string): string {
    const icon: Record<SyncStatus, string> = {
        idle: '✓',
        syncing: '⟳',
        pulling: '↓',
        pushing: '↑',
        error: '⚠',
        disconnected: '✕',
    };
    const label: Record<SyncStatus, string> = {
        idle: 'Up to date',
        syncing: 'Syncing…',
        pulling: 'Pulling…',
        pushing: 'Pushing…',
        error: 'Error',
        disconnected: 'Disconnected',
    };
    let text = `${icon[status]} ${label[status]}`;
    if (status === 'idle' && lastSynced) {
        text += ` — ${formatTimeAgo(new Date(lastSynced).getTime())}`;
    }
    return text;
}

export function changeTypeIcon(type: string): string {
    switch (type) {
        case 'modified': return 'diff-modified';
        case 'created': return 'diff-added';
        case 'deleted': return 'diff-removed';
        case 'renamed': return 'diff-renamed';
        case 'moved': return 'diff-renamed';
        default: return 'file';
    }
}

export function formatTimeAgo(ts: number): string {
    const sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 5) { return 'just now'; }
    if (sec < 60) { return `${sec}s ago`; }
    const min = Math.floor(sec / 60);
    if (min < 60) { return `${min}m ago`; }
    const hr = Math.floor(min / 60);
    if (hr < 24) { return `${hr}h ago`; }
    return new Date(ts).toLocaleDateString();
}

/** Display the filename only (last segment of path) */
export function displayPath(relativePath: string): string {
    const clean = relativePath.replace(/^\/+/, '').replace(/\/+$/, '');
    return clean.split('/').pop() || clean;
}

// ── SidebarItem ────────────────────────────────────────────────────

interface SidebarItemOptions {
    icon?: string;
    description?: string;
    tooltip?: string;
    command?: vscode.Command;
    contextValue?: string;
    collapsibleState?: vscode.TreeItemCollapsibleState;
}

class SidebarItem extends vscode.TreeItem {
    groupId?: string;

    constructor(label: string, options: SidebarItemOptions = {}) {
        super(label, options.collapsibleState ?? vscode.TreeItemCollapsibleState.None);
        if (options.icon) {
            this.iconPath = new vscode.ThemeIcon(options.icon);
        }
        if (options.description !== undefined) {
            this.description = options.description;
        }
        if (options.tooltip) {
            this.tooltip = options.tooltip;
        }
        if (options.command) {
            this.command = options.command;
        }
        if (options.contextValue) {
            this.contextValue = options.contextValue;
        }
    }
}
