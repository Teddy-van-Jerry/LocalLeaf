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

interface SidebarDetail {
    label: string;
    value: string;
    icon: string;
}

interface MainViewState {
    linked: boolean;
    projectName?: string;
    syncStatus: SyncStatus;
    statusText: string;
    details: SidebarDetail[];
    onlineUsers: SidebarOnlineUser[];
}

type MainWebviewMessage =
    | { type: 'ready' }
    | { type: 'refresh' }
    | { type: 'runCommand'; command: string }
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
            this.publishState({
                ...this.state,
                syncStatus: status,
                statusText: message || statusDescription(status),
            });
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
                details: [],
                onlineUsers: [],
            };
        }

        const settings = manager.getSettings() ?? await manager.load();
        if (!settings) {
            return {
                linked: false,
                syncStatus: 'disconnected',
                statusText: 'Project settings unavailable',
                details: [],
                onlineUsers: [],
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

        return {
            linked: true,
            projectName: settings.projectName,
            syncStatus: this.syncStatus,
            statusText: this.syncMessage || statusDescription(this.syncStatus),
            details,
            onlineUsers: this.onlineUsers,
        };
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
        .status[data-status="syncing"] .status-dot, .status[data-status="pulling"] .status-dot, .status[data-status="pushing"] .status-dot { background: var(--vscode-progressBar-background); box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-progressBar-background) 20%, transparent); }
        .status[data-status="error"] .status-dot, .status[data-status="disconnected"] .status-dot { background: var(--vscode-editorWarning-foreground); }
        .status-copy { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .refresh { border: 0; color: var(--vscode-descriptionForeground); background: transparent; cursor: pointer; border-radius: 4px; padding: 2px 5px; }
        .refresh:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
        .tabs { display: grid; grid-template-columns: repeat(3, 1fr); border-bottom: 1px solid var(--vscode-panel-border); }
        .tab { padding: 8px 4px 7px; border: 0; border-bottom: 2px solid transparent; color: var(--vscode-descriptionForeground); background: transparent; cursor: pointer; }
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
    </style>
</head>
<body>
    <main class="shell">
        <header id="header" class="header"></header>
        <nav id="tabs" class="tabs" aria-label="LocalLeaf sections"></nav>
        <section id="content" class="content" aria-live="polite"></section>
    </main>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const header = document.getElementById('header');
        const tabs = document.getElementById('tabs');
        const content = document.getElementById('content');
        const saved = vscode.getState() || {};
        let activeTab = ['changes', 'tools', 'details'].includes(saved.activeTab) ? saved.activeTab : 'changes';
        let state = null;

        const tools = [
            { icon: '↻', label: 'Sync now', copy: 'Pull the latest Overleaf state', command: '${COMMANDS.SYNC_NOW}' },
            { icon: '↓', label: 'Pull from Overleaf', copy: 'Refresh all project files', command: '${COMMANDS.PULL_FROM_OVERLEAF}' },
            { icon: '≡', label: 'Edit ignore patterns', copy: 'Open .leafignore', command: '${COMMANDS.EDIT_IGNORE_PATTERNS}' },
            { icon: '⌫', label: 'Clean ignored remote files', copy: 'Remove ignored artifacts from Overleaf', command: '${COMMANDS.CLEAN_IGNORED_REMOTE}' },
            { icon: 'T', label: 'Set main document', copy: 'Choose the primary .tex document', command: '${COMMANDS.SET_MAIN_DOCUMENT}' },
            { icon: '⚙', label: 'Project settings', copy: 'Open LocalLeaf settings', command: '${COMMANDS.CONFIGURE}' },
            { icon: '●', label: 'Account', copy: 'Manage the Overleaf session', command: '${COMMANDS.SHOW_ACCOUNT_PANEL}' },
            { icon: '✓', label: 'Verify credentials', copy: 'Validate the current session', command: '${COMMANDS.VERIFY_CREDENTIALS}' },
            { icon: '×', label: 'Unlink folder', copy: 'Disconnect this workspace', command: '${COMMANDS.UNLINK_FOLDER}', danger: true },
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
            const refresh = element('button', 'refresh', 'Refresh');
            refresh.type = 'button';
            refresh.title = 'Refresh sidebar';
            refresh.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
            status.append(element('span', 'status-dot'), element('span', 'status-copy', state.statusText), refresh);
            header.replaceChildren(brand, status);
        }

        function renderTabs() {
            const definitions = [['changes', 'Changes'], ['tools', 'Tools'], ['details', 'Details']];
            tabs.replaceChildren(...definitions.map(([id, label]) => {
                const tab = element('button', 'tab' + (activeTab === id ? ' active' : ''), label);
                tab.type = 'button';
                tab.setAttribute('role', 'tab');
                tab.setAttribute('aria-selected', String(activeTab === id));
                tab.addEventListener('click', () => {
                    activeTab = id;
                    vscode.setState({ activeTab });
                    renderTabs();
                    renderContent();
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

        function renderTools() {
            const list = element('div', 'tools');
            tools.forEach(tool => {
                const button = element('button', 'tool' + (tool.danger ? ' danger' : ''));
                button.type = 'button';
                button.addEventListener('click', () => vscode.postMessage({ type: 'runCommand', command: tool.command }));
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
                const copy = element('div');
                copy.append(element('div', 'detail-value', item.value), element('div', 'detail-label', item.label));
                row.append(element('span', '', item.icon), copy);
                list.append(row);
            });
            fragment.append(list);
            content.replaceChildren(fragment);
        }

        function renderContent() {
            if (!state || !state.linked) {
                content.replaceChildren(element('div', 'empty', 'This workspace is not linked to an Overleaf project.'));
                return;
            }
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

function statusDescription(status: SyncStatus): string {
    const descriptions: Record<SyncStatus, string> = {
        idle: 'Up to date',
        syncing: 'Synchronizing…',
        pulling: 'Pulling from Overleaf…',
        pushing: 'Pushing to Overleaf…',
        error: 'Synchronization error',
        disconnected: 'Disconnected',
    };
    return descriptions[status];
}
