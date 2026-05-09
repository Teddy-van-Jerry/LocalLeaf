/**
 * ChangesWebviewProvider — WebviewViewProvider for the Changes sidebar panel.
 *
 * Uses a state-push model: the extension sends a JSON state object via
 * `postMessage` and the webview JS renders it.  Replaces the old
 * TreeDataProvider-based ChangesProvider and moves all sync-related
 * notifications (confirmations / notices) inline.
 */

import * as vscode from 'vscode';
import { ChangeTracker, SyncMode, PendingChange } from '../sync/changeTracker';
import { SyncStatus } from '../sync/syncEngine';
import { changeTypeIcon, displayPath, formatTimeAgo, syncStatusDescription } from './sidebarProvider';
import { SettingsManager } from '../utils/settingsManager';
import { PanelNotificationCenter, PanelNotificationState } from './panelNotificationCenter';
import { CredentialManager } from '../utils/credentialManager';
import { COMMANDS } from '../consts';

// ── State & message types ──────────────────────────────────────────

export interface ChangeItem {
    path: string;
    type: string;
    source: 'local' | 'remote';
    entityId?: string;
}

export interface ConfirmationRequest {
    id: string;
    message: string;
    buttons: { label: string; value: string; primary?: boolean; danger?: boolean }[];
}

export interface OnlineUserInfo {
    clientId: string;
    name: string;
    color: string;
    initials: string;
    docPath?: string;
    row?: number;
}

interface DetailItem {
    label: string;
    description: string;
    icon: string;
}

interface ChangesViewState {
    syncMode: SyncMode;
    syncStatus: SyncStatus;
    statusText: string;
    conflicts: ChangeItem[];
    remoteChanges: ChangeItem[];
    localChanges: ChangeItem[];
    notifications: PanelNotificationState;
    onlineUsers: OnlineUserInfo[];
    details: DetailItem[];
}

// Messages from webview → extension
type WebviewMessage =
    | { command: 'openFile'; path: string }
    | { command: 'viewDiff'; path: string }
    | { command: 'discardChange'; path: string }
    | { command: 'discardAllLocalChanges'; paths: string[] }
    | { command: 'resolveConflictRemote'; path: string }
    | { command: 'resolveConflictLocal'; path: string }
    | { command: 'confirmationResponse'; id: string; value: string }
    | { command: 'jumpToUser'; clientId: string }
    | { command: 'toggleSyncMode' }
    | { command: 'removeComments' }
    | { command: 'editIgnorePatterns' }
    | { command: 'setMainDocument' }
    | { command: 'configure' }
    | { command: 'selectCompiler' }
    | { command: 'toggleAutoCompile' };

// ── Provider ───────────────────────────────────────────────────────

export class ChangesWebviewProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'localleaf.mainView';

    private _view?: vscode.WebviewView;
    private changeTracker?: ChangeTracker;
    private trackerDisposable?: vscode.Disposable;
    private syncMode: SyncMode = 'manual';
    private syncStatus: SyncStatus = 'disconnected';
    private lastSynced?: string;
    private onlineUsers: OnlineUserInfo[] = [];

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly notifications: PanelNotificationCenter,
        private readonly credentialManager: CredentialManager,
    ) {
        this.notifications.subscribe(() => this.pushState());
    }

    // ── WebviewViewProvider ────────────────────────────────────────

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            enableCommandUris: true,
            localResourceRoots: [this.extensionUri],
        };

        webviewView.webview.onDidReceiveMessage((msg: WebviewMessage) =>
            this.handleMessage(msg),
        );

        webviewView.webview.html = this.getHtml();
        this.pushState();
    }

    // ── Public API ─────────────────────────────────────────────────

    setChangeTracker(tracker: ChangeTracker): void {
        this.trackerDisposable?.dispose();
        this.changeTracker = tracker;
        this.trackerDisposable = tracker.onDidChange(() => this.pushState());
    }

    setSyncMode(mode: SyncMode): void {
        this.syncMode = mode;
        this.pushState();
    }

    setSyncStatus(status: SyncStatus, lastSynced?: string): void {
        this.syncStatus = status;
        if (lastSynced !== undefined) {
            this.lastSynced = lastSynced;
        }
        this.pushState();
    }

    clearChanges(): void {
        this.changeTracker?.clearAll();
        this.pushState();
    }

    refresh(): void {
        this.pushState();
    }

    /**
     * Show a choice modal and wait for the user's choice.
     * Resolves with the `value` of the button the user clicked.
     */
    showConfirmation(request: Omit<ConfirmationRequest, 'id'>): Promise<string> {
        // Auto-reveal the sidebar when a confirmation is needed
        if (this._view) {
            this._view.show?.(true);
        }

        return this.notifications.showModal({ ...request, type: 'warning' });
    }

    /**
     * Show a coalesced notice in the sidebar.
     */
    showNotice(message: string, type: 'info' | 'warning' | 'error', _autoDismissMs?: number): void {
        this.notifications.showNotice(message, type);
    }

    /**
     * Update the online users displayed in the sidebar.
     */
    setOnlineUsers(users: OnlineUserInfo[]): void {
        this.onlineUsers = users;
        this.pushState();
    }

    // ── Private ────────────────────────────────────────────────────

    private runCommand(command: string, ...args: unknown[]): void {
        void vscode.commands.executeCommand(command, ...args).then(undefined, error => {
            this.notifications.showNotice(`Command failed: ${error}`, 'error');
        });
    }

    private handleMessage(msg: WebviewMessage): void {
        switch (msg.command) {
            case 'openFile':
                this.runCommand('vscode.open', this.fileUri(msg.path));
                break;
            case 'viewDiff':
                this.runCommand('localleaf.viewDiff', msg.path);
                break;
            case 'discardChange':
                this.runCommand('localleaf.discardChange', msg.path);
                break;
            case 'discardAllLocalChanges':
                this.runCommand(COMMANDS.DISCARD_ALL_LOCAL_CHANGES, msg.paths);
                break;
            case 'resolveConflictRemote':
                this.runCommand('localleaf.resolveConflictRemote', msg.path);
                break;
            case 'resolveConflictLocal':
                this.runCommand('localleaf.resolveConflictLocal', msg.path);
                break;
            case 'confirmationResponse':
                this.notifications.respondToModal(msg.id, msg.value);
                break;
            case 'jumpToUser':
                this.runCommand('localleaf.jumpToCollaborator', msg.clientId);
                break;
            case 'toggleSyncMode':
                this.runCommand(COMMANDS.TOGGLE_SYNC_MODE);
                break;
            case 'removeComments':
                this.runCommand(COMMANDS.REMOVE_COMMENTS);
                break;
            case 'editIgnorePatterns':
                this.runCommand(COMMANDS.EDIT_IGNORE_PATTERNS);
                break;
            case 'setMainDocument':
                this.runCommand(COMMANDS.SET_MAIN_DOCUMENT);
                break;
            case 'configure':
                this.runCommand(COMMANDS.CONFIGURE);
                break;
            case 'selectCompiler':
                this.runCommand(COMMANDS.SELECT_COMPILER);
                break;
            case 'toggleAutoCompile':
                this.runCommand(COMMANDS.TOGGLE_AUTO_COMPILE);
                break;
        }
    }

    private async buildState(): Promise<ChangesViewState> {
        const conflicts: ChangeItem[] = [];
        const remoteChanges: ChangeItem[] = [];
        const localChanges: ChangeItem[] = [];

        if (this.changeTracker && this.syncMode === 'manual') {
            for (const c of this.changeTracker.getConflicts()) {
                conflicts.push({ path: c.path, type: c.type, source: 'local', entityId: c.entityId });
            }
            for (const c of this.changeTracker.getRemoteChanges()) {
                if (!this.changeTracker.hasLocalChange(c.path)) {
                    remoteChanges.push({ path: c.path, type: c.type, source: 'remote', entityId: c.entityId });
                }
            }
            for (const c of this.changeTracker.getLocalChanges()) {
                if (!this.changeTracker.hasRemoteChange(c.path)) {
                    localChanges.push({ path: c.path, type: c.type, source: 'local', entityId: c.entityId });
                }
            }
        }

        const details = await this.buildDetails();

        return {
            syncMode: this.syncMode,
            syncStatus: this.syncStatus,
            statusText: syncStatusDescription(this.syncStatus, this.lastSynced),
            conflicts,
            remoteChanges,
            localChanges,
            notifications: this.notifications.getState(),
            onlineUsers: this.onlineUsers,
            details,
        };
    }

    private pushState(): void {
        if (!this._view) { return; }
        void this.buildState().then(state => {
            this._view?.webview.postMessage({ type: 'state', state });
        });
    }

    private async buildDetails(): Promise<DetailItem[]> {
        const settingsManager = SettingsManager.getCurrentInstance();
        const settings = settingsManager?.getSettings();
        if (!settings) { return []; }

        const details: DetailItem[] = [
            { label: settings.serverUrl, description: 'Server', icon: '🌐' },
        ];

        const serverUrl = this.credentialManager.getDefaultServer();
        const credential = await this.credentialManager.getCredential(serverUrl);
        if (credential) {
            details.push({ label: credential.userEmail, description: 'Account', icon: '👤' });
        }

        if (settings.mainTex) {
            details.push({ label: settings.mainTex, description: 'Main document', icon: '📄' });
        }

        details.push({ label: settings.projectId, description: 'Project ID', icon: '🔑' });

        details.push({
            label: settings.syncMode === 'realtime' ? 'Real-time' : 'Manual',
            description: 'Sync mode',
            icon: settings.syncMode === 'realtime' ? '⚡' : '⇄',
        });

        if (settings.compiler) {
            details.push({ label: settings.compiler, description: 'Compiler', icon: '⚙' });
        }

        if (settings.compileOnSave !== undefined) {
            details.push({
                label: settings.compileOnSave ? 'Enabled' : 'Disabled',
                description: 'Auto-compile',
                icon: settings.compileOnSave ? '✓' : '○',
            });
        }

        return details;
    }

    private fileUri(relativePath: string): vscode.Uri | undefined {
        const folder = SettingsManager.getCurrentInstance()?.getWorkspaceFolder()
            ?? vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!folder) { return undefined; }
        const clean = relativePath.replace(/^\/+/, '');
        return vscode.Uri.joinPath(folder, clean);
    }

    // ── HTML ───────────────────────────────────────────────────────

    private getHtml(): string {
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
/* ── Reset ─────────────────────────────────────────── */
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: transparent;
    line-height: 1.4;
    overflow: hidden;
}
#root{
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    overflow-x: hidden;
}
.top-status-region{
    position: sticky;
    top: 0;
    z-index: 15;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    box-shadow: 0 1px 0 var(--vscode-panel-border, var(--vscode-sideBar-border, transparent));
}

/* ── Status strip ──────────────────────────────────── */
.status-strip{
    padding: 6px 12px;
    font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border, transparent));
    border-left: 3px solid transparent;
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 8px;
}
.status-strip.info{ border-left-color: var(--vscode-editorInfo-foreground, #3794ff); }
.status-strip.warning{ border-left-color: var(--vscode-editorWarning-foreground, #cca700); }
.status-strip.error{ border-left-color: var(--vscode-editorError-foreground, #f14c4c); }
.realtime-control{
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
    font-size: 0.95em;
}
.status-left{
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.sync-mode-label{
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
}
.sync-toggle{
    background: none;
    border: none;
    cursor: pointer;
    font-size: 1em;
    font-weight: 600;
    padding: 1px 4px;
    border-radius: 3px;
}
.sync-toggle.on{
    color: var(--vscode-charts-green, #89d185);
}
.sync-toggle.off{
    color: var(--vscode-descriptionForeground);
    opacity: 0.7;
}
.sync-toggle:hover{
    background: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,.31));
}

/* ── Notifications ─────────────────────────────────── */
.notice-status-bar{
    margin: 0;
    min-height: 34px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 7px 10px;
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border, transparent));
    border-left: 3px solid transparent;
    border-radius: 0;
    background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    animation: noticeIn 0.14s ease-out;
    contain: layout paint;
}
.notice-status-bar.info{ border-left-color: var(--vscode-editorInfo-foreground, #3794ff); }
.notice-status-bar.warning{ border-left-color: var(--vscode-editorWarning-foreground, #cca700); }
.notice-status-bar.error{ border-left-color: var(--vscode-editorError-foreground, #f14c4c); }
.notice-msg{
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.86em;
}
.notice-count{
    color: var(--vscode-descriptionForeground);
    font-size: 0.78em;
    flex-shrink: 0;
}
.notice-dismiss{
    background: none;
    border: none;
    color: var(--vscode-foreground);
    cursor: pointer;
    opacity: 0.65;
    padding: 1px 4px;
    border-radius: 3px;
}
.notice-dismiss:hover{ opacity:1; background: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,.31)); }
.choice-modal-backdrop{
    position: fixed;
    inset: 0;
    z-index: 20;
    display: flex;
    align-items: flex-start;
    padding: 12px 8px;
    background: rgba(0,0,0,.28);
    animation: fadeIn 0.12s ease-out;
}
.choice-modal{
    width: 100%;
    border: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border, transparent));
    border-top: 3px solid transparent;
    border-radius: 6px;
    background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    box-shadow: 0 8px 24px rgba(0,0,0,.32);
    overflow: hidden;
}
.choice-modal.info{ border-top-color: var(--vscode-editorInfo-foreground, #3794ff); }
.choice-modal.warning{ border-top-color: var(--vscode-editorWarning-foreground, #cca700); }
.choice-modal.error{ border-top-color: var(--vscode-editorError-foreground, #f14c4c); }
.choice-message{
    padding: 12px;
    line-height: 1.45;
    font-size: 0.9em;
    white-space: pre-wrap;
    word-break: break-word;
}
.choice-buttons{
    display: flex;
    gap: 6px;
    padding: 0 12px 12px;
    flex-wrap: wrap;
}
.choice-buttons button{
    padding: 4px 10px;
    font-size: 0.82em;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
}
.choice-buttons button:hover{ background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground)); }
.choice-buttons button.primary{ background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.choice-buttons button.primary:hover{ background: var(--vscode-button-hoverBackground); }
.choice-buttons button.danger{ background: var(--vscode-inputValidation-errorBackground, #c53030); color: var(--vscode-inputValidation-errorForeground, #fff); }

.notice-history{
    display: none;
}

/* ── Tabs ──────────────────────────────────────────── */
.tab-bar{
    display: flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
    min-height: 35px;
    padding: 6px 8px 0;
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border, transparent));
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
}
.tab-button{
    flex: 1 1 0;
    min-width: 0;
    height: 29px;
    padding: 0 8px;
    border: 0;
    border-bottom: 2px solid transparent;
    border-radius: 6px 6px 0 0;
    color: var(--vscode-descriptionForeground);
    background: transparent;
    font: inherit;
    font-size: 0.82em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.tab-button:hover{
    color: var(--vscode-foreground);
    background: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,.31));
}
.tab-button.active{
    color: var(--vscode-foreground);
    background: var(--vscode-tab-activeBackground, rgba(127,127,127,.08));
    border-bottom-color: var(--vscode-focusBorder, #007acc);
}
.tab-button:focus-visible{
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -2px;
}
.tab-content{
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 6px 0 8px;
}
.tab-panel{
    min-height: 100%;
}
.tool-list,
.detail-list{
    padding: 4px 0;
}
.tool-item,
.detail-item{
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 28px;
    padding: 4px 12px;
}
.tool-item{
    width: 100%;
    border: 0;
    color: var(--vscode-foreground);
    background: transparent;
    font: inherit;
    text-align: left;
    cursor: pointer;
}
.tool-item:hover{
    background: var(--vscode-list-hoverBackground);
}
.tool-icon,
.detail-icon{
    width: 18px;
    text-align: center;
    flex-shrink: 0;
}
.detail-text{
    min-width: 0;
    display: flex;
    flex-direction: column;
}
.detail-label{
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.detail-desc{
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.group{
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border, transparent));
}
.group-header{
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    cursor: pointer;
    user-select: none;
    font-size: 0.82em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
    background: var(--vscode-sideBarSectionHeader-background, transparent);
}
.group-header:hover{
    background: var(--vscode-list-hoverBackground);
}
.group-header .chevron{
    font-size: 0.9em;
    transition: transform 0.15s;
}
.group-label{
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.group-action{
    border: 0;
    border-radius: 3px;
    padding: 2px 5px;
    color: var(--vscode-foreground);
    background: transparent;
    font: inherit;
    font-size: 0.9em;
    text-transform: none;
    letter-spacing: 0;
    cursor: pointer;
    opacity: 0.75;
}
.group-action:hover{
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,.31));
}
.group-header.collapsed .chevron{
    transform: rotate(-90deg);
}
.group-body.hidden{
    display: none;
}

/* ── Change items ──────────────────────────────────── */
.change-item{
    display: flex;
    align-items: center;
    padding: 3px 12px 3px 24px;
    font-size: 0.9em;
    cursor: pointer;
    position: relative;
}
.change-item:hover{
    background: var(--vscode-list-hoverBackground);
}
.change-item .icon{
    width: 16px;
    text-align: center;
    margin-right: 6px;
    flex-shrink: 0;
    font-size: 0.9em;
}
.change-item .name{
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.change-item .actions{
    display: flex;
    gap: 2px;
    margin-left: 6px;
    flex-shrink: 0;
}
.change-item:hover .actions{
    display: flex;
}
.action-btn{
    background: none;
    border: none;
    color: var(--vscode-foreground);
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 3px;
    font-size: 0.85em;
    opacity: 0.7;
}
.action-btn:hover{
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,.31));
}
.context-menu{
    position: fixed;
    z-index: 40;
    min-width: 120px;
    padding: 4px;
    border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border, transparent));
    border-radius: 4px;
    background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
    color: var(--vscode-menu-foreground, var(--vscode-foreground));
    box-shadow: 0 4px 12px rgba(0,0,0,.28);
}
.context-menu button{
    width: 100%;
    border: 0;
    border-radius: 3px;
    padding: 5px 8px;
    color: inherit;
    background: transparent;
    font: inherit;
    text-align: left;
    cursor: pointer;
}
.context-menu button:hover{
    background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
    color: var(--vscode-menu-selectionForeground, var(--vscode-foreground));
}

/* ── Empty state ───────────────────────────────────── */
.empty{
    padding: 20px 12px;
    text-align: center;
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
}

/* ── Online users ──────────────────────────────────── */
.online-users{
    padding: 8px 12px;
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border, transparent));
}
.online-users-label{
    font-size: 0.75em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--vscode-descriptionForeground);
    margin-right: 2px;
}
.avatar{
    width: 26px;
    height: 26px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.7em;
    font-weight: 700;
    color: #000;
    cursor: pointer;
    flex-shrink: 0;
    transition: transform 0.1s;
    position: relative;
}
.avatar:hover{
    transform: scale(1.15);
}
.avatar-tooltip{
    display: none;
    position: absolute;
    bottom: calc(100% + 4px);
    left: 50%;
    transform: translateX(-50%);
    background: var(--vscode-editorWidget-background, #252526);
    color: var(--vscode-foreground);
    padding: 3px 8px;
    border-radius: 3px;
    font-size: 0.8em;
    font-weight: 400;
    white-space: nowrap;
    z-index: 10;
    pointer-events: none;
    box-shadow: 0 2px 6px rgba(0,0,0,.3);
}
.avatar:hover .avatar-tooltip{
    display: block;
}

/* ── Animations ────────────────────────────────────── */
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes noticeIn{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:translateY(0)}}
</style>
</head>
<body>
    <div id="root"></div>
    <script>
    (function(){
        const vscode = acquireVsCodeApi();
        const root = document.getElementById('root');
        let state = null;
        let collapsedGroups = {};
        let activeTab = null;
        let contextMenu = null;

        window.addEventListener('message', e => {
            if (e.data.type === 'state') {
                state = e.data.state;
                render();
            }
        });

        function h(tag, attrs, ...children) {
            const el = document.createElement(tag);
            if (attrs) {
                for (const [k, v] of Object.entries(attrs)) {
                    if (k === 'className') el.className = v;
                    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
                    else if (k === 'title') el.title = v;
                    else el.setAttribute(k, v);
                }
            }
            for (const c of children) {
                if (typeof c === 'string') el.appendChild(document.createTextNode(c));
                else if (c) el.appendChild(c);
            }
            return el;
        }

        root.addEventListener('click', event => {
            const target = event.target.closest('[data-command]');
            if (!target || !root.contains(target)) return;
            event.preventDefault();
            event.stopPropagation();
            vscode.postMessage({
                command: target.dataset.command,
                path: target.dataset.path,
            });
        });

        root.addEventListener('contextmenu', event => {
            const item = event.target.closest('.change-item[data-group="local"]');
            if (!item || !root.contains(item)) {
                hideChangeContextMenu();
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            showChangeContextMenu(event.clientX, event.clientY, item.dataset.path);
        });

        window.addEventListener('click', hideChangeContextMenu);
        window.addEventListener('blur', hideChangeContextMenu);

        root.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                hideChangeContextMenu();
                return;
            }
            if (event.key !== 'Enter' && event.key !== ' ') return;
            const target = event.target.closest('.change-item[data-command]');
            if (!target || !root.contains(target)) return;
            event.preventDefault();
            vscode.postMessage({
                command: target.dataset.command,
                path: target.dataset.path,
            });
        });

        function hideChangeContextMenu() {
            if (!contextMenu) return;
            contextMenu.remove();
            contextMenu = null;
        }

        function showChangeContextMenu(x, y, itemPath) {
            hideChangeContextMenu();
            contextMenu = h('div', {className:'context-menu'},
                h('button', {
                    title:'Revert local change',
                    onClick: () => {
                        hideChangeContextMenu();
                        vscode.postMessage({command:'discardChange', path:itemPath});
                    },
                }, 'Revert Change'),
            );
            document.body.appendChild(contextMenu);
            const rect = contextMenu.getBoundingClientRect();
            const left = Math.min(x, window.innerWidth - rect.width - 4);
            const top = Math.min(y, window.innerHeight - rect.height - 4);
            contextMenu.style.left = Math.max(4, left) + 'px';
            contextMenu.style.top = Math.max(4, top) + 'px';
        }

        function changeIcon(type) {
            const map = {modified:'M', created:'+', deleted:'-', renamed:'R', moved:'V'};
            return map[type] || '?';
        }
        function changeIconColor(type) {
            const map = {
                modified: 'var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d)',
                created: 'var(--vscode-gitDecoration-untrackedResourceForeground, #73c991)',
                deleted: 'var(--vscode-gitDecoration-deletedResourceForeground, #c74e39)',
                renamed: 'var(--vscode-gitDecoration-renamedResourceForeground, #73c991)',
                moved: 'var(--vscode-gitDecoration-renamedResourceForeground, #73c991)',
            };
            return map[type] || 'inherit';
        }

        function fileName(p) {
            const clean = p.replace(/^\\/+/, '').replace(/\\/+$/, '');
            return clean.split('/').pop() || clean;
        }

        function renderOnlineUsers() {
            if (!state.onlineUsers || state.onlineUsers.length === 0) return null;
            const avatars = state.onlineUsers.map(u => {
                const tip = u.docPath
                    ? u.name + ' — ' + u.docPath + ':' + ((u.row || 0) + 1)
                    : u.name;
                return h('div', {
                    className: 'avatar',
                    style: 'background:' + u.color,
                    title: '',
                    onClick: () => vscode.postMessage({ command: 'jumpToUser', clientId: u.clientId }),
                },
                    u.initials,
                    h('span', { className: 'avatar-tooltip' }, tip),
                );
            });
            return h('div', { className: 'online-users' },
                h('span', { className: 'online-users-label' }, 'Online'),
                ...avatars,
            );
        }

        function renderPrimaryStatusBar() {
            const isRealtime = state.syncMode === 'realtime';
            const toggleLabel = isRealtime ? 'ON' : 'OFF';
            const toggleCls = 'sync-toggle ' + (isRealtime ? 'on' : 'off');
            const notice = state.notifications && state.notifications.notice;
            const message = notice ? notice.message : state.statusText;
            const count = notice && notice.count > 1 ? 'x' + notice.count : '';
            const title = notice && notice.history && notice.history.length > 1
                ? notice.history.join('\\n')
                : message;
            const statusClass = 'status-strip ' + (notice ? notice.type : 'default');

            return h('div', {className:statusClass, title},
                h('span', {className:'realtime-control'},
                    h('span', {className:'sync-mode-label'}, 'Real-time'),
                    h('button', {
                        className: toggleCls,
                        title: isRealtime ? 'Switch to manual sync' : 'Switch to real-time sync',
                        onClick: () => vscode.postMessage({command:'toggleSyncMode'}),
                    }, toggleLabel),
                ),
                h('span', {className:'status-left'}, message),
                count ? h('span', {className:'notice-count'}, count) : null,
            );
        }

        function renderChoiceModal() {
            const c = state.notifications && state.notifications.modal;
            if (!c) return null;
            const btns = c.buttons.map(b => {
                let cls = '';
                if (b.primary) cls = 'primary';
                if (b.danger) cls = 'danger';
                return h('button', {
                    className: cls,
                    onClick: () => vscode.postMessage({command:'confirmationResponse', id:c.id, value:b.value}),
                }, b.label);
            });
            return h('div', {className:'choice-modal-backdrop'},
                h('div', {className:'choice-modal ' + c.type},
                    h('div', {className:'choice-message'}, c.message),
                    h('div', {className:'choice-buttons'}, ...btns),
                ),
            );
        }

        function renderChangeItem(item, groupType) {
            const actions = [];
            if (groupType === 'conflict') {
                actions.push(
                    h('button', {className:'action-btn', title:'Use Remote', 'data-command':'resolveConflictRemote', 'data-path':item.path}, 'Remote'),
                    h('button', {className:'action-btn', title:'Use Local', 'data-command':'resolveConflictLocal', 'data-path':item.path}, 'Local'),
                );
            }

            return h('div', {className:'change-item', title: item.path, role:'button', tabindex:'0', 'data-command':'viewDiff', 'data-path':item.path, 'data-group':groupType},
                h('span', {className:'icon', style:'color:'+changeIconColor(item.type)}, changeIcon(item.type)),
                h('span', {className:'name'}, fileName(item.path)),
                actions.length ? h('span', {className:'actions'}, ...actions) : null,
            );
        }

        function renderGroup(id, label, icon, items, groupType) {
            if (items.length === 0) return null;
            const isCollapsed = !!collapsedGroups[id];
            const localGroupAction = groupType === 'local'
                ? h('button', {
                    className:'group-action',
                    title:'Revert all local changes in this group',
                    onClick: event => {
                        event.preventDefault();
                        event.stopPropagation();
                        vscode.postMessage({command:'discardAllLocalChanges', paths:items.map(item => item.path)});
                    },
                }, 'Revert All')
                : null;
            const header = h('div', {
                className: 'group-header' + (isCollapsed ? ' collapsed' : ''),
                onClick: () => { collapsedGroups[id] = !collapsedGroups[id]; render(); },
            },
                h('span', {className:'chevron'}, isCollapsed ? '\u25B8' : '\u25BE'),
                h('span', {className:'group-label'}, icon + ' ' + label + ' (' + items.length + ')'),
                localGroupAction,
            );
            const body = h('div', {className: 'group-body' + (isCollapsed ? ' hidden' : '')},
                ...items.map(it => renderChangeItem(it, groupType)),
            );
            return h('div', {className:'group'}, header, body);
        }

        function renderChangesContent() {
            const conflictsEl = renderGroup('conflicts', 'Conflicts', '\u26A0', state.conflicts, 'conflict');
            const remoteEl = renderGroup('remote', 'Remote Changes', '\u2193', state.remoteChanges, 'remote');
            const localEl = renderGroup('local', 'Local Changes', '\u2191', state.localChanges, 'local');
            const children = [conflictsEl, remoteEl, localEl].filter(Boolean);

            if (children.length === 0) {
                children.push(h('div', {className:'empty'}, 'No file changes yet.\\nChanges will appear here as files are synced.'));
            }

            return h('div', {className:'tab-panel changes-panel'}, ...children);
        }

        function renderToolsContent() {
            const tools = [
                ['Remove LaTeX Comments', '%', 'removeComments'],
                ['Edit Ignore Patterns', '≡', 'editIgnorePatterns'],
                ['Set Main Document', '📄', 'setMainDocument'],
                ['Select Compiler', '⚙', 'selectCompiler'],
                ['Toggle Auto-Compile', '↻', 'toggleAutoCompile'],
                ['Configure Settings', '⚙', 'configure'],
            ];
            const items = tools.map(([label, icon, command]) =>
                h('button', {className:'tool-item', 'data-command':command, title:label},
                    h('span', {className:'tool-icon'}, icon),
                    h('span', {className:'tool-label'}, label),
                ),
            );
            return h('div', {className:'tab-panel tools-panel'},
                h('div', {className:'tool-list'}, ...items),
            );
        }

        function renderDetailsContent() {
            const items = (state.details || []).map(item =>
                h('div', {className:'detail-item', title:item.description + ': ' + item.label},
                    h('span', {className:'detail-icon'}, item.icon),
                    h('span', {className:'detail-text'},
                        h('span', {className:'detail-label'}, item.label),
                        h('span', {className:'detail-desc'}, item.description),
                    ),
                ),
            );

            const usersEl = renderOnlineUsers();
            return h('div', {className:'tab-panel details-panel'},
                usersEl,
                h('div', {className:'detail-list'}, ...items),
            );
        }

        function renderTopStatusRegion() {
            return h('div', {className:'top-status-region'},
                renderPrimaryStatusBar(),
            );
        }

        function getAvailableTabs() {
            const tabs = [];
            if (state.syncMode !== 'realtime') {
                tabs.push({id:'changes', label:'Changes'});
            }
            tabs.push({id:'tools', label:'Tools'});
            tabs.push({id:'details', label:'Details'});
            return tabs;
        }

        function ensureActiveTab(tabs) {
            if (!tabs.some(tab => tab.id === activeTab)) {
                activeTab = tabs[0].id;
            }
        }

        function renderTabBar(tabs) {
            return h('div', {className:'tab-bar', role:'tablist'},
                ...tabs.map(tab => h('button', {
                    className:'tab-button' + (tab.id === activeTab ? ' active' : ''),
                    role:'tab',
                    'aria-selected': tab.id === activeTab ? 'true' : 'false',
                    'data-tab':tab.id,
                    title:tab.label,
                    onClick: () => {
                        activeTab = tab.id;
                        render();
                    },
                }, tab.label)),
            );
        }

        function renderTabContent() {
            if (activeTab === 'changes') return renderChangesContent();
            if (activeTab === 'details') return renderDetailsContent();
            return renderToolsContent();
        }

        function render() {
            if (!state) { root.innerHTML = ''; return; }
            root.innerHTML = '';

            root.appendChild(renderTopStatusRegion());

            const tabs = getAvailableTabs();
            ensureActiveTab(tabs);
            root.appendChild(renderTabBar(tabs));
            root.appendChild(h('div', {className:'tab-content'}, renderTabContent()));

            const choiceEl = renderChoiceModal();
            if (choiceEl) root.appendChild(choiceEl);
        }
    })();
    </script>
</body>
</html>`;
    }
}
