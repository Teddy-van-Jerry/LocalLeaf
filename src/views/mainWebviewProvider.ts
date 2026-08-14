import * as vscode from 'vscode';
import { COMMANDS } from '../consts';
import { SyncStatus } from '../sync/syncEngine';
import { CredentialManager } from '../utils/credentialManager';
import { SettingsManager } from '../utils/settingsManager';
import { createNonce } from './webviewUtils';

export interface SidebarOnlineUser {
    clientId: string;
    name: string;
    color: string;
    docPath?: string;
    row?: number;
}

export type ConfirmedCommandRunner = (command: string) => Promise<void>;

interface SidebarDetail {
    label: string;
    value: string;
    icon: string;
}

interface SidebarNotice {
    kind: 'info' | 'warning' | 'error';
    message: string;
    actionLabel?: string;
    actionCommand?: string;
}

interface MainViewState {
    linked: boolean;
    projectName?: string;
    syncStatus: SyncStatus;
    statusText: string;
    syncMode: 'realtime' | 'manual';
    showChanges: boolean;
    details: SidebarDetail[];
    onlineUsers: SidebarOnlineUser[];
    signedIn: boolean;
    mainDocumentSelected: boolean;
    notice?: SidebarNotice;
}

type MainWebviewMessage =
    | { type: 'ready' }
    | { type: 'refresh' }
    | { type: 'runCommand'; command: string }
    | { type: 'runConfirmedCommand'; command: string }
    | { type: 'jumpToUser'; clientId: string };

const ALLOWED_COMMANDS = new Set<string>([
    COMMANDS.SYNC_NOW,
    COMMANDS.PULL_FROM_OVERLEAF,
    COMMANDS.EDIT_IGNORE_PATTERNS,
    COMMANDS.CLEAN_IGNORED_REMOTE,
    COMMANDS.SET_MAIN_DOCUMENT,
    COMMANDS.CONFIGURE,
    COMMANDS.SHOW_ACCOUNT_PANEL,
    COMMANDS.VERIFY_CREDENTIALS,
    COMMANDS.UNLINK_FOLDER,
]);

const PANEL_CONFIRMED_COMMANDS = new Set<string>([
    COMMANDS.CLEAN_IGNORED_REMOTE,
    COMMANDS.UNLINK_FOLDER,
]);

/**
 * Linked-project sidebar adapted from PR #3. The Changes tab is deliberately
 * a status surface for now; manual change tracking will be connected later.
 */
export class MainWebviewProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'localleaf.mainView';

    private view?: vscode.WebviewView;
    private syncStatus: SyncStatus = 'disconnected';
    private syncMessage?: string;
    private onlineUsers: SidebarOnlineUser[] = [];
    private state?: MainViewState;
    private refreshPromise?: Promise<void>;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly credentialManager: CredentialManager,
        private readonly runConfirmedCommand?: ConfirmedCommandRunner,
    ) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'images')],
        };
        webviewView.webview.onDidReceiveMessage((message: unknown) => {
            void this.handleMessage(message);
        });
        webviewView.webview.html = this.getHtml(webviewView.webview);
    }

    setSyncStatus(status: SyncStatus, message?: string): void {
        if (this.syncStatus === status && this.syncMessage === message) return;
        this.syncStatus = status;
        this.syncMessage = message;
        if (this.state) {
            const nextState: MainViewState = {
                ...this.state,
                syncStatus: status,
                statusText: message || statusDescription(status),
            };
            nextState.notice = buildNotice(nextState);
            this.publishState(nextState);
        } else {
            void this.refresh();
        }
    }

    setOnlineUsers(users: SidebarOnlineUser[]): void {
        const nextUsers = users.map(user => ({ ...user }));
        if (sameOnlineUsers(this.onlineUsers, nextUsers)) return;
        this.onlineUsers = nextUsers;
        if (this.state) {
            this.publishState({ ...this.state, onlineUsers: nextUsers });
        } else {
            void this.refresh();
        }
    }

    async refresh(): Promise<void> {
        if (!this.refreshPromise) {
            const pending = this.buildState()
                .then(state => this.publishState(state))
                .finally(() => {
                    if (this.refreshPromise === pending) this.refreshPromise = undefined;
                });
            this.refreshPromise = pending;
        }
        await this.refreshPromise;
    }

    private publishState(state: MainViewState): void {
        this.state = state;
        void this.view?.webview.postMessage({ type: 'state', state });
    }

    private async buildState(): Promise<MainViewState> {
        const manager = SettingsManager.getCurrentInstance();
        if (!manager || !(await manager.isLinked())) {
            return {
                linked: false,
                syncStatus: 'disconnected',
                statusText: 'Not linked',
                syncMode: 'realtime',
                showChanges: shouldShowChangesTab('realtime'),
                details: [],
                onlineUsers: [],
                signedIn: false,
                mainDocumentSelected: false,
            };
        }

        const settings = manager.getSettings() ?? await manager.load();
        if (!settings) {
            return {
                linked: false,
                syncStatus: 'disconnected',
                statusText: 'Project settings unavailable',
                syncMode: 'realtime',
                showChanges: shouldShowChangesTab('realtime'),
                details: [],
                onlineUsers: [],
                signedIn: false,
                mainDocumentSelected: false,
            };
        }

        const credential = await this.credentialManager.getCredential(settings.serverUrl);
        const details: SidebarDetail[] = [
            { label: 'Project', value: settings.projectName, icon: '◈' },
            { label: 'Server', value: settings.serverUrl, icon: '◎' },
            { label: 'Account', value: credential?.userEmail || 'Not signed in', icon: '●' },
            { label: 'Main document', value: settings.mainTex || 'Not selected', icon: '▤' },
            { label: 'Sync mode', value: 'Real-time', icon: '↻' },
        ];
        if (settings.lastSynced) {
            details.push({ label: 'Last synced', value: new Date(settings.lastSynced).toLocaleString(), icon: '◷' });
        }

        const state: MainViewState = {
            linked: true,
            projectName: settings.projectName,
            syncStatus: this.syncStatus,
            statusText: this.syncMessage || statusDescription(this.syncStatus),
            syncMode: 'realtime',
            showChanges: shouldShowChangesTab('realtime'),
            details,
            onlineUsers: this.onlineUsers,
            signedIn: Boolean(credential),
            mainDocumentSelected: Boolean(settings.mainTex),
        };
        state.notice = buildNotice(state);
        return state;
    }

    private async handleMessage(raw: unknown): Promise<void> {
        if (!raw || typeof raw !== 'object') return;
        const message = raw as Partial<MainWebviewMessage> & { command?: unknown; clientId?: unknown };

        if (message.type === 'ready' || message.type === 'refresh') {
            await this.refresh();
            return;
        }
        if (message.type === 'runCommand' && typeof message.command === 'string') {
            if (ALLOWED_COMMANDS.has(message.command)) {
                await vscode.commands.executeCommand(message.command);
            }
            return;
        }
        if (message.type === 'runConfirmedCommand' && typeof message.command === 'string') {
            if (PANEL_CONFIRMED_COMMANDS.has(message.command)) {
                await this.runConfirmedCommand?.(message.command);
            }
            return;
        }
        if (message.type === 'jumpToUser' && typeof message.clientId === 'string') {
            await vscode.commands.executeCommand(COMMANDS.JUMP_TO_COLLABORATOR, message.clientId);
        }
    }

    private getHtml(webview: vscode.Webview): string {
        const nonce = createNonce();
        const iconUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'images', 'icon.svg'));

        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>LocalLeaf</title>
    <style>
        *, *::before, *::after { box-sizing: border-box; }
        html, body { height: 100%; }
        body {
            margin: 0; color: var(--vscode-sideBar-foreground); background: var(--vscode-sideBar-background);
            font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); overflow: hidden;
        }
        button { font: inherit; }
        button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
        .shell { height: 100%; display: flex; flex-direction: column; }
        .header { padding: 12px 12px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
        .brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
        .brand img { width: 22px; height: 22px; flex: 0 0 auto; }
        .brand-copy { min-width: 0; flex: 1; }
        .project-name { font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .status { display: flex; align-items: center; gap: 7px; margin-top: 9px; padding: 7px 8px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: var(--vscode-list-inactiveSelectionBackground, transparent); }
        .status-dot { width: 8px; height: 8px; flex: 0 0 auto; border-radius: 50%; background: var(--vscode-descriptionForeground); }
        .status[data-status="idle"] .status-dot { background: var(--vscode-testing-iconPassed, #2ea043); }
        .status[data-status="connecting"] .status-dot, .status[data-status="syncing"] .status-dot, .status[data-status="pulling"] .status-dot, .status[data-status="pushing"] .status-dot { background: var(--vscode-progressBar-background); box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-progressBar-background) 20%, transparent); }
        .status[data-status="error"] .status-dot, .status[data-status="disconnected"] .status-dot { background: var(--vscode-editorWarning-foreground); }
        .status-copy { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .refresh { border: 0; color: var(--vscode-descriptionForeground); background: transparent; cursor: pointer; border-radius: 4px; padding: 2px 5px; }
        .refresh:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
        .notice { display: flex; align-items: flex-start; gap: 7px; margin-top: 8px; padding: 7px 8px; border: 1px solid var(--vscode-panel-border); border-left: 3px solid var(--vscode-editorInfo-foreground); border-radius: 5px; background: var(--vscode-editorWidget-background, transparent); }
        .notice.warning { border-left-color: var(--vscode-editorWarning-foreground); }
        .notice.error { border-left-color: var(--vscode-editorError-foreground); }
        .notice-copy { min-width: 0; flex: 1; line-height: 1.35; font-size: 11px; }
        .notice-action { flex: 0 0 auto; border: 0; border-radius: 4px; padding: 3px 6px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); cursor: pointer; }
        .notice-action:hover { background: var(--vscode-button-secondaryHoverBackground); }
        .tabs { display: flex; border-bottom: 1px solid var(--vscode-panel-border); }
        .tab { flex: 1; padding: 8px 4px 7px; border: 0; border-bottom: 2px solid transparent; color: var(--vscode-descriptionForeground); background: transparent; cursor: pointer; }
        .tab:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground); }
        .tab.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder); }
        .content { flex: 1; overflow-y: auto; padding: 10px 12px 16px; }
        .empty { padding: 24px 6px; text-align: center; color: var(--vscode-descriptionForeground); line-height: 1.5; }
        .empty-icon { font-size: 26px; margin-bottom: 8px; color: var(--vscode-testing-iconPassed, #2ea043); }
        .section-title { margin: 4px 0 8px; color: var(--vscode-descriptionForeground); font-size: 10px; font-weight: 650; text-transform: uppercase; letter-spacing: .06em; }
        .tools, .details, .users { display: grid; gap: 6px; }
        .tool {
            display: grid; grid-template-columns: 27px minmax(0, 1fr); gap: 8px; align-items: center; width: 100%;
            padding: 8px; border: 1px solid transparent; border-radius: 6px; color: inherit; background: transparent; text-align: left; cursor: pointer;
        }
        .tool:hover { border-color: var(--vscode-panel-border); background: var(--vscode-list-hoverBackground); }
        .tool.danger:hover { color: var(--vscode-errorForeground); }
        .tool-icon { display: grid; place-items: center; width: 27px; height: 27px; border-radius: 6px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
        .tool-label, .detail-value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
        .tool-copy, .detail-label { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 1px; }
        .detail { display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: 8px; align-items: center; padding: 7px 2px; border-bottom: 1px solid var(--vscode-panel-border); }
        .detail:last-child { border-bottom: 0; }
        .user { display: grid; grid-template-columns: 28px minmax(0, 1fr); align-items: center; gap: 8px; width: 100%; padding: 6px; border: 0; border-radius: 6px; color: inherit; background: transparent; text-align: left; cursor: pointer; }
        .user:hover { background: var(--vscode-list-hoverBackground); }
        .avatar { display: grid; place-items: center; width: 27px; height: 27px; border-radius: 50%; color: #fff; font-size: 10px; font-weight: 700; }
        .user-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .user-location { color: var(--vscode-descriptionForeground); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .dialog-backdrop { position: fixed; inset: 0; z-index: 10; display: grid; align-items: start; padding: 14px 10px; background: rgba(0, 0, 0, .38); }
        .dialog { width: 100%; padding: 12px; border: 1px solid var(--vscode-panel-border); border-top: 3px solid var(--vscode-editorWarning-foreground); border-radius: 7px; background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background)); box-shadow: 0 8px 24px rgba(0, 0, 0, .32); }
        .dialog-title { margin: 0 0 7px; font-size: 13px; }
        .dialog-copy { margin: 0 0 12px; color: var(--vscode-descriptionForeground); line-height: 1.45; }
        .dialog-actions { display: flex; justify-content: flex-end; gap: 7px; }
        .dialog-actions button { border: 0; border-radius: 4px; padding: 5px 9px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
        .dialog-actions .secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
        @media (prefers-reduced-motion: reduce) { .status-dot { box-shadow: none !important; } }
    </style>
</head>
<body>
    <main class="shell">
        <header id="header" class="header"></header>
        <nav id="tabs" class="tabs" role="tablist" aria-label="LocalLeaf sections"></nav>
        <section id="content" class="content" role="tabpanel" tabindex="0"></section>
    </main>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const header = document.getElementById('header');
        const tabs = document.getElementById('tabs');
        const content = document.getElementById('content');
        const saved = vscode.getState() || {};
        let activeTab = ['changes', 'tools', 'details'].includes(saved.activeTab) ? saved.activeTab : 'tools';
        let state = null;
        let restoreFocus = null;

        const tools = [
            { icon: '↻', label: 'Sync now', copy: 'Pull the latest Overleaf state', command: '${COMMANDS.SYNC_NOW}' },
            { icon: '↓', label: 'Pull from Overleaf', copy: 'Refresh all project files', command: '${COMMANDS.PULL_FROM_OVERLEAF}' },
            { icon: '≡', label: 'Edit ignore patterns', copy: 'Open .leafignore', command: '${COMMANDS.EDIT_IGNORE_PATTERNS}' },
            { icon: '⌫', label: 'Clean ignored remote files', copy: 'Remove ignored artifacts from Overleaf', command: '${COMMANDS.CLEAN_IGNORED_REMOTE}', confirm: 'Delete every remote file currently matched by .leafignore?' },
            { icon: 'T', label: 'Set main document', copy: 'Choose the primary .tex document', command: '${COMMANDS.SET_MAIN_DOCUMENT}' },
            { icon: '⚙', label: 'Project settings', copy: 'Open LocalLeaf settings', command: '${COMMANDS.CONFIGURE}' },
            { icon: '●', label: 'Account', copy: 'Manage the Overleaf session', command: '${COMMANDS.SHOW_ACCOUNT_PANEL}' },
            { icon: '✓', label: 'Verify credentials', copy: 'Validate the current session', command: '${COMMANDS.VERIFY_CREDENTIALS}' },
            { icon: '×', label: 'Unlink folder', copy: 'Disconnect this workspace', command: '${COMMANDS.UNLINK_FOLDER}', danger: true, confirm: 'Unlink this local folder from its Overleaf project?' },
        ];

        function element(tag, className, text) {
            const node = document.createElement(tag);
            if (className) node.className = className;
            if (text !== undefined) node.textContent = text;
            return node;
        }

        function initials(name) {
            return String(name || '?').split(/\\s+/).filter(Boolean).slice(0, 2).map(part => part[0].toUpperCase()).join('') || '?';
        }

        function renderHeader() {
            const brand = element('div', 'brand');
            const icon = document.createElement('img');
            icon.src = '${iconUri}';
            icon.alt = '';
            const copy = element('div', 'brand-copy');
            copy.append(element('div', 'project-name', state.projectName || 'LocalLeaf'));
            brand.append(icon, copy);

            const status = element('div', 'status');
            status.dataset.status = state.syncStatus;
            status.setAttribute('role', 'status');
            status.setAttribute('aria-live', 'polite');
            const refresh = element('button', 'refresh', 'Refresh');
            refresh.type = 'button';
            refresh.title = 'Refresh sidebar';
            refresh.setAttribute('aria-label', 'Refresh LocalLeaf status');
            refresh.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
            const dot = element('span', 'status-dot');
            dot.setAttribute('aria-hidden', 'true');
            status.append(dot, element('span', 'status-copy', state.statusText), refresh);

            const notice = state.notice ? element('div', 'notice ' + state.notice.kind) : null;
            if (notice) {
                notice.setAttribute('role', state.notice.kind === 'error' ? 'alert' : 'status');
                notice.append(element('span', 'notice-copy', state.notice.message));
                if (state.notice.actionLabel && state.notice.actionCommand) {
                    const action = element('button', 'notice-action', state.notice.actionLabel);
                    action.type = 'button';
                    action.addEventListener('click', () => vscode.postMessage({ type: 'runCommand', command: state.notice.actionCommand }));
                    notice.append(action);
                }
            }
            header.replaceChildren(...[brand, status, notice].filter(Boolean));
        }

        function tabDefinitions() {
            return state.showChanges
                ? [['changes', 'Changes'], ['tools', 'Tools'], ['details', 'Details']]
                : [['tools', 'Tools'], ['details', 'Details']];
        }

        function selectTab(id, focus) {
            activeTab = id;
            vscode.setState({ activeTab });
            renderTabs();
            renderContent();
            if (focus) document.getElementById('tab-' + id)?.focus();
        }

        function renderTabs() {
            const definitions = tabDefinitions();
            if (!definitions.some(([id]) => id === activeTab)) activeTab = definitions[0][0];
            tabs.replaceChildren(...definitions.map(([id, label]) => {
                const tab = element('button', 'tab' + (activeTab === id ? ' active' : ''), label);
                tab.type = 'button';
                tab.id = 'tab-' + id;
                tab.setAttribute('role', 'tab');
                tab.setAttribute('aria-selected', String(activeTab === id));
                tab.setAttribute('aria-controls', 'panel-' + id);
                tab.tabIndex = activeTab === id ? 0 : -1;
                tab.addEventListener('click', () => selectTab(id, false));
                tab.addEventListener('keydown', event => {
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                    const index = definitions.findIndex(([candidate]) => candidate === id);
                    let target = index;
                    if (event.key === 'Home') target = 0;
                    else if (event.key === 'End') target = definitions.length - 1;
                    else if (event.key === 'ArrowRight') target = (index + 1) % definitions.length;
                    else target = (index - 1 + definitions.length) % definitions.length;
                    event.preventDefault();
                    selectTab(definitions[target][0], true);
                });
                return tab;
            }));
        }

        function renderChanges() {
            const empty = element('div', 'empty');
            empty.append(
                element('div', 'empty-icon', state.syncStatus === 'idle' ? '✓' : '↻'),
                element('div', '', state.syncStatus === 'idle' ? 'Real-time sync is active.' : state.statusText),
                element('div', '', 'Manual local/remote change tracking will be connected in the next integration stage.'),
            );
            content.replaceChildren(empty);
        }

        function closeConfirmation(backdrop) {
            backdrop.remove();
            if (restoreFocus && typeof restoreFocus.focus === 'function') restoreFocus.focus();
            restoreFocus = null;
        }

        function showConfirmation(tool) {
            restoreFocus = document.activeElement;
            const backdrop = element('div', 'dialog-backdrop');
            const dialog = element('section', 'dialog');
            dialog.setAttribute('role', 'dialog');
            dialog.setAttribute('aria-modal', 'true');
            dialog.setAttribute('aria-labelledby', 'localleaf-dialog-title');
            const title = element('h2', 'dialog-title', tool.label);
            title.id = 'localleaf-dialog-title';
            const copy = element('p', 'dialog-copy', tool.confirm);
            const actions = element('div', 'dialog-actions');
            const cancel = element('button', 'secondary', 'Cancel');
            cancel.type = 'button';
            cancel.addEventListener('click', () => closeConfirmation(backdrop));
            const confirm = element('button', '', 'Continue');
            confirm.type = 'button';
            confirm.addEventListener('click', () => {
                closeConfirmation(backdrop);
                vscode.postMessage({ type: 'runConfirmedCommand', command: tool.command });
            });
            actions.append(cancel, confirm);
            dialog.append(title, copy, actions);
            backdrop.append(dialog);
            backdrop.addEventListener('click', event => {
                if (event.target === backdrop) closeConfirmation(backdrop);
            });
            backdrop.addEventListener('keydown', event => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    closeConfirmation(backdrop);
                    return;
                }
                if (event.key !== 'Tab') return;
                const focusable = [cancel, confirm];
                const index = focusable.indexOf(document.activeElement);
                const target = event.shiftKey
                    ? (index <= 0 ? focusable.length - 1 : index - 1)
                    : (index + 1) % focusable.length;
                event.preventDefault();
                focusable[target].focus();
            });
            document.body.append(backdrop);
            cancel.focus();
        }

        function renderTools() {
            const list = element('div', 'tools');
            tools.forEach(tool => {
                const button = element('button', 'tool' + (tool.danger ? ' danger' : ''));
                button.type = 'button';
                button.setAttribute('aria-label', tool.label + '. ' + tool.copy);
                button.addEventListener('click', () => {
                    if (tool.confirm) return showConfirmation(tool);
                    vscode.postMessage({ type: 'runCommand', command: tool.command });
                });
                const copy = element('span');
                copy.append(element('div', 'tool-label', tool.label), element('div', 'tool-copy', tool.copy));
                button.append(element('span', 'tool-icon', tool.icon), copy);
                list.append(button);
            });
            content.replaceChildren(list);
        }

        function safeColor(color) {
            return /^#[0-9a-fA-F]{6}$/.test(color || '') ? color : 'var(--vscode-button-background)';
        }

        function renderDetails() {
            const fragment = document.createDocumentFragment();
            if (state.onlineUsers.length > 0) {
                fragment.append(element('div', 'section-title', 'Online collaborators'));
                const users = element('div', 'users');
                state.onlineUsers.forEach(user => {
                    const button = element('button', 'user');
                    button.type = 'button';
                    button.setAttribute('aria-label', 'Jump to collaborator ' + user.name);
                    button.addEventListener('click', () => vscode.postMessage({ type: 'jumpToUser', clientId: user.clientId }));
                    const avatar = element('span', 'avatar', initials(user.name));
                    avatar.style.backgroundColor = safeColor(user.color);
                    const copy = element('span');
                    const location = user.docPath ? user.docPath + (Number.isInteger(user.row) ? ':' + (user.row + 1) : '') : 'Online';
                    copy.append(element('div', 'user-name', user.name), element('div', 'user-location', location));
                    button.append(avatar, copy);
                    users.append(button);
                });
                fragment.append(users);
            }
            fragment.append(element('div', 'section-title', 'Project details'));
            const list = element('div', 'details');
            state.details.forEach(item => {
                const row = element('div', 'detail');
                row.setAttribute('role', 'group');
                row.setAttribute('aria-label', item.label + ': ' + item.value);
                const copy = element('div');
                copy.append(element('div', 'detail-value', item.value), element('div', 'detail-label', item.label));
                const detailIcon = element('span', '', item.icon);
                detailIcon.setAttribute('aria-hidden', 'true');
                row.append(detailIcon, copy);
                list.append(row);
            });
            fragment.append(list);
            content.replaceChildren(fragment);
        }

        function renderContent() {
            if (!state || !state.linked) {
                tabs.hidden = true;
                content.removeAttribute('aria-labelledby');
                content.replaceChildren(element('div', 'empty', 'This workspace is not linked to an Overleaf project.'));
                return;
            }
            tabs.hidden = false;
            content.id = 'panel-' + activeTab;
            content.setAttribute('aria-labelledby', 'tab-' + activeTab);
            if (activeTab === 'tools') return renderTools();
            if (activeTab === 'details') return renderDetails();
            renderChanges();
        }

        function render() {
            if (!state) return;
            renderHeader();
            renderTabs();
            renderContent();
        }

        window.addEventListener('message', event => {
            if (event.data && event.data.type === 'state') {
                state = event.data.state;
                render();
            }
        });
        vscode.postMessage({ type: 'ready' });
    </script>
</body>
</html>`;
    }
}

function sameOnlineUsers(left: SidebarOnlineUser[], right: SidebarOnlineUser[]): boolean {
    return left.length === right.length && left.every((user, index) => {
        const candidate = right[index];
        return user.clientId === candidate.clientId
            && user.name === candidate.name
            && user.color === candidate.color
            && user.docPath === candidate.docPath
            && user.row === candidate.row;
    });
}

function buildNotice(state: MainViewState): SidebarNotice | undefined {
    if (state.syncStatus === 'error') {
        return {
            kind: 'error',
            message: state.statusText,
            actionLabel: state.signedIn ? 'Retry sync' : 'Open account',
            actionCommand: state.signedIn ? COMMANDS.SYNC_NOW : COMMANDS.SHOW_ACCOUNT_PANEL,
        };
    }
    if (!state.signedIn) {
        return {
            kind: 'warning',
            message: 'Sign in to Overleaf to restore project synchronization.',
            actionLabel: 'Open account',
            actionCommand: COMMANDS.SHOW_ACCOUNT_PANEL,
        };
    }
    if (state.syncStatus === 'disconnected') {
        return {
            kind: 'warning',
            message: state.statusText,
            actionLabel: 'Sync now',
            actionCommand: COMMANDS.SYNC_NOW,
        };
    }
    if (['connecting', 'syncing', 'pulling', 'pushing'].includes(state.syncStatus)) {
        return { kind: 'info', message: state.statusText };
    }
    if (!state.mainDocumentSelected) {
        return {
            kind: 'info',
            message: 'No main LaTeX document is selected yet.',
            actionLabel: 'Select document',
            actionCommand: COMMANDS.SET_MAIN_DOCUMENT,
        };
    }
    return undefined;
}

export function statusDescription(status: SyncStatus): string {
    const descriptions: Record<SyncStatus, string> = {
        disconnected: 'Disconnected',
        connecting: 'Connecting…',
        idle: 'Up to date',
        syncing: 'Synchronizing…',
        pulling: 'Pulling from Overleaf…',
        pushing: 'Pushing to Overleaf…',
        error: 'Synchronization error',
    };
    return descriptions[status];
}

export function shouldShowChangesTab(syncMode: 'realtime' | 'manual'): boolean {
    return syncMode === 'manual';
}
