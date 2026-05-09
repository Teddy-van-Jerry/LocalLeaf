/**
 * ProjectsWebviewProvider – replaces the old TreeDataProvider-based ProjectsProvider.
 *
 * State machine:
 *   no-folder          → "Please open a folder to use LocalLeaf"
 *   non-empty-folder   → "Please open an empty folder or an existing LocalLeaf project"
 *   not-logged-in      → Login button
 *   project-list       → Searchable, sortable project list
 */

import * as vscode from 'vscode';
import { BaseAPI, ProjectInfo } from '../api/base';
import { CredentialManager } from '../utils/credentialManager';
import { DetectedLocalLeafProject, SettingsManager } from '../utils/settingsManager';
import { CONFIG_DIR, COMMANDS } from '../consts';
import { PanelNotificationCenter } from './panelNotificationCenter';

export type ProjectSortField = 'name' | 'lastUpdated' | 'accessLevel';
export type SortOrder = 'asc' | 'desc';

type ViewState = 'no-folder' | 'non-empty-folder' | 'not-logged-in' | 'project-list' | 'local-project-list';

export class ProjectsWebviewProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'localleaf.projectsView';

    private _view?: vscode.WebviewView;
    private sortField: ProjectSortField = 'lastUpdated';
    private sortOrder: SortOrder = 'desc';
    private filterText = '';
    private cachedProjects: ProjectInfo[] = [];
    private cachedLocalProjects: DetectedLocalLeafProject[] = [];

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly credentialManager: CredentialManager,
        private readonly notifications: PanelNotificationCenter,
    ) {
        this.notifications.subscribe(() => this.postNotificationState());
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
            localResourceRoots: [this.extensionUri],
        };

        webviewView.webview.onDidReceiveMessage(msg => this.handleMessage(msg));

        this.updateView();
    }

    // ── Public API (called by extension commands) ──────────────────

    async refresh(): Promise<void> {
        this.cachedProjects = [];
        await this.updateView();
    }

    setFilter(text: string): void {
        this.filterText = text;
        this.updateView();
    }

    getFilter(): string {
        return this.filterText;
    }

    setSortField(field: ProjectSortField): void {
        if (this.sortField === field) {
            this.sortOrder = this.sortOrder === 'asc' ? 'desc' : 'asc';
        } else {
            this.sortField = field;
            this.sortOrder = field === 'name' ? 'asc' : 'desc';
        }
        this.updateView();
    }

    // ── State detection ────────────────────────────────────────────

    private async determineViewState(): Promise<ViewState> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return 'no-folder';
        }

        const rootUri = folders[0].uri;
        this.cachedLocalProjects = await SettingsManager.findLinkedProjectFolders();

        // Check for .localleaf directory
        const configUri = vscode.Uri.joinPath(rootUri, CONFIG_DIR);
        let hasConfig = false;
        try {
            await vscode.workspace.fs.stat(configUri);
            hasConfig = true;
        } catch {
            // does not exist
        }

        if (!hasConfig) {
            // Check if folder is empty
            let entries: [string, vscode.FileType][] = [];
            try {
                entries = await vscode.workspace.fs.readDirectory(rootUri);
            } catch {
                // can't read – treat as non-empty
            }
            if (this.cachedLocalProjects.length > 0) {
                return 'local-project-list';
            }
            if (entries.length > 0) {
                return 'non-empty-folder';
            }
        }

        // Folder is empty or has .localleaf → check login
        const serverUrl = this.credentialManager.getDefaultServer();
        const credential = await this.credentialManager.getCredential(serverUrl);
        if (!credential) {
            return 'not-logged-in';
        }

        return 'project-list';
    }

    // ── View update ────────────────────────────────────────────────

    private async updateView(): Promise<void> {
        if (!this._view) { return; }

        const state = await this.determineViewState();

        if (state === 'project-list') {
            if (this.cachedProjects.length === 0) {
                // Fetch projects
                const serverUrl = this.credentialManager.getDefaultServer();
                const credential = await this.credentialManager.getCredential(serverUrl);
                if (credential) {
                    const api = new BaseAPI(credential.serverUrl);
                    api.setIdentity(credential.identity);
                    const result = await api.getProjects();
                    if (result.type === 'success' && result.projects) {
                        this.cachedProjects = result.projects.filter(p => !p.archived && !p.trashed);
                    }
                }
            }
        }

        this._view.webview.html = this.getHtml(state, this.cachedProjects);
        this.postNotificationState();
    }

    // ── Message handling ───────────────────────────────────────────

    private handleMessage(msg: any): void {
        switch (msg.type) {
            case 'filterChanged':
                this.filterText = msg.text ?? '';
                break;

            case 'sortChanged':
                this.setSortField(msg.field);
                break;

            case 'openProject': {
                const project = this.cachedProjects.find(p => p.id === msg.projectId);
                if (project) {
                    vscode.commands.executeCommand(COMMANDS.OPEN_PROJECT, project);
                }
                break;
            }

            case 'selectLocalProject': {
                const project = this.cachedLocalProjects.find(p => p.uri.toString() === msg.uri);
                if (project) {
                    vscode.commands.executeCommand(COMMANDS.OPEN_LOCAL_PROJECT, project.uri.toString());
                }
                break;
            }

            case 'login':
                vscode.commands.executeCommand(COMMANDS.LOGIN);
                break;

            case 'refresh':
                this.refresh();
                break;

            case 'openFolder':
                vscode.commands.executeCommand('vscode.openFolder');
                break;

            case 'confirmationResponse':
                this.notifications.respondToModal(msg.id, msg.value);
                break;

            case 'dismissNotice':
                this.notifications.dismissNotice(msg.id);
                break;
        }
    }

    private postNotificationState(): void {
        this._view?.webview.postMessage({
            type: 'notificationState',
            state: this.notifications.getState(),
        });
    }

    // ── HTML generation ────────────────────────────────────────────

    private getHtml(state: ViewState, projects: ProjectInfo[]): string {
        switch (state) {
            case 'no-folder':
                return this.wrapHtml(/*html*/`
                    <div class="center-message">
                        <span class="codicon codicon-folder-opened icon-large"></span>
                        <p>Please open a folder to use LocalLeaf.</p>
                        <button class="primary-button" onclick="postMessage({type:'openFolder'})">Open Folder</button>
                    </div>
                `);

            case 'non-empty-folder':
                return this.wrapHtml(/*html*/`
                    <div class="center-message">
                        <span class="codicon codicon-warning icon-large"></span>
                        <p>The current folder is not empty and does not contain a LocalLeaf project.</p>
                        <p class="secondary">Please open an empty folder or an existing LocalLeaf project (with a <code>.localleaf</code> directory).</p>
                    </div>
                `);

            case 'not-logged-in':
                return this.wrapHtml(/*html*/`
                    <div class="center-message">
                        <span class="codicon codicon-account icon-large"></span>
                        <p>Login to Overleaf to see your projects.</p>
                        <button class="primary-button" onclick="postMessage({type:'login'})">Login to Overleaf</button>
                    </div>
                `);

            case 'project-list':
                return this.getProjectListHtml(projects);

            case 'local-project-list':
                return this.getLocalProjectListHtml(this.cachedLocalProjects);
        }
    }

    private getProjectListHtml(projects: ProjectInfo[]): string {
        // Apply sort
        const sortedProjects = [...projects].sort((a, b) => {
            let cmp = 0;
            switch (this.sortField) {
                case 'name':
                    cmp = a.name.localeCompare(b.name);
                    break;
                case 'lastUpdated': {
                    const ta = a.lastUpdated ? new Date(a.lastUpdated).getTime() : 0;
                    const tb = b.lastUpdated ? new Date(b.lastUpdated).getTime() : 0;
                    cmp = ta - tb;
                    break;
                }
                case 'accessLevel': {
                    const order: Record<string, number> = { owner: 3, collaborator: 2, readOnly: 1 };
                    cmp = (order[a.accessLevel] || 0) - (order[b.accessLevel] || 0);
                    break;
                }
            }
            return this.sortOrder === 'asc' ? cmp : -cmp;
        });

        const listItems = sortedProjects.length > 0
            ? sortedProjects.map(p => {
                const date = p.lastUpdated ? new Date(p.lastUpdated).toLocaleDateString() : '';
                const icon = accessIcon(p.accessLevel);
                const escapedName = escapeHtml(p.name);
                return /*html*/`
                    <div class="project-item remote-project" data-project-id="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name.toLowerCase())}">
                        <span class="codicon codicon-${icon} project-icon"></span>
                        <div class="project-info">
                            <span class="project-name">${escapedName}</span>
                            <span class="project-date">${date}</span>
                        </div>
                    </div>`;
            }).join('\n')
            : '';

        const sortIndicator = (field: ProjectSortField) => {
            if (this.sortField !== field) { return ''; }
            return this.sortOrder === 'asc' ? ' ↑' : ' ↓';
        };

        return this.wrapHtml(/*html*/`
            <div class="search-container">
                <span class="codicon codicon-search search-icon"></span>
                <input type="text" id="search" placeholder="Search projects..." value="${escapeHtml(this.filterText)}" />
            </div>
            <div class="sort-bar">
                <button class="sort-btn${this.sortField === 'name' ? ' active' : ''}" data-field="name">Name${sortIndicator('name')}</button>
                <button class="sort-btn${this.sortField === 'lastUpdated' ? ' active' : ''}" data-field="lastUpdated">Date${sortIndicator('lastUpdated')}</button>
                <button class="sort-btn${this.sortField === 'accessLevel' ? ' active' : ''}" data-field="accessLevel">Access${sortIndicator('accessLevel')}</button>
            </div>
            <div id="project-list">
                ${listItems}
                <div id="empty-message" class="center-message" hidden><p></p></div>
            </div>
        `);
    }

    private getLocalProjectListHtml(projects: DetectedLocalLeafProject[]): string {
        const listItems = projects.map(project => {
            const settings = project.settings;
            const title = escapeHtml(settings?.projectName || project.relativePath);
            const detail = escapeHtml(project.relativePath);
            const server = settings?.serverUrl ? escapeHtml(settings.serverUrl) : '';
            return /*html*/`
                <div class="project-item local-project" data-uri="${escapeHtml(project.uri.toString())}" data-name="${escapeHtml(`${settings?.projectName || ''} ${project.relativePath}`.toLowerCase())}">
                    <span class="codicon codicon-root-folder project-icon"></span>
                    <div class="project-info">
                        <span class="project-name">${title}</span>
                        <span class="project-date">${detail}${server ? ` • ${server}` : ''}</span>
                    </div>
                </div>`;
        }).join('\n');

        return this.wrapHtml(/*html*/`
            <div class="search-container">
                <span class="codicon codicon-search search-icon"></span>
                <input type="text" id="search" placeholder="Search local projects..." value="${escapeHtml(this.filterText)}" />
            </div>
            <div class="section-caption">${projects.length} LocalLeaf project${projects.length === 1 ? '' : 's'} found</div>
            <div id="project-list">
                ${listItems}
                <div id="empty-message" class="center-message" hidden><p></p></div>
            </div>
        `);
    }

    private wrapHtml(body: string): string {
        const initialNotificationState = escapeScriptJson(JSON.stringify(this.notifications.getState()));

        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
        /* Reset */
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        html, body { height: 100%; }

        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: transparent;
            padding: 0;
            overflow: hidden;
        }
        #root {
            height: 100vh;
            overflow-y: auto;
            overflow-x: hidden;
        }
        .top-status-region{
            position: sticky;
            top: 0;
            z-index: 15;
            background: var(--vscode-sideBar-background, var(--vscode-editor-background));
            box-shadow: 0 1px 0 var(--vscode-panel-border, var(--vscode-sideBar-border, transparent));
        }

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

        /* Centered message screens */
        .center-message {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            text-align: center;
            padding: 24px 16px;
            gap: 8px;
        }
        .center-message p { line-height: 1.5; }
        .center-message .secondary {
            color: var(--vscode-descriptionForeground);
            font-size: 0.9em;
        }
        .icon-large {
            font-size: 32px;
            margin-bottom: 8px;
            opacity: 0.7;
        }
        code {
            background: var(--vscode-textCodeBlock-background);
            padding: 1px 4px;
            border-radius: 3px;
            font-size: 0.9em;
        }

        /* Primary button */
        .primary-button {
            margin-top: 8px;
            padding: 6px 14px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 2px;
            cursor: pointer;
            font-size: var(--vscode-font-size);
        }
        .primary-button:hover {
            background: var(--vscode-button-hoverBackground);
        }

        /* Search bar */
        .search-container {
            position: relative;
            padding: 8px 8px 4px;
        }
        .search-icon {
            position: absolute;
            left: 16px;
            top: 50%;
            transform: translateY(-50%);
            opacity: 0.6;
            font-size: 14px;
            pointer-events: none;
        }
        #search {
            width: 100%;
            padding: 4px 8px 4px 26px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, transparent);
            border-radius: 2px;
            outline: none;
            font-size: var(--vscode-font-size);
            font-family: var(--vscode-font-family);
        }
        #search:focus {
            border-color: var(--vscode-focusBorder);
        }
        #search::placeholder {
            color: var(--vscode-input-placeholderForeground);
        }

        /* Sort bar */
        .sort-bar {
            display: flex;
            gap: 2px;
            padding: 4px 8px;
            border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border, transparent));
        }
        .sort-btn {
            flex: 1;
            padding: 3px 6px;
            background: transparent;
            color: var(--vscode-descriptionForeground);
            border: none;
            border-radius: 2px;
            cursor: pointer;
            font-size: 11px;
            font-family: var(--vscode-font-family);
            text-align: center;
        }
        .sort-btn:hover {
            background: var(--vscode-list-hoverBackground);
            color: var(--vscode-foreground);
        }
        .sort-btn.active {
            color: var(--vscode-foreground);
            font-weight: 600;
        }

        /* Project list */
        #project-list {
            padding: 4px 0;
        }
        .project-item {
            display: flex;
            align-items: center;
            padding: 4px 12px;
            cursor: pointer;
            gap: 8px;
        }
        .project-item:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .project-icon {
            flex-shrink: 0;
            opacity: 0.8;
        }
        .project-info {
            display: flex;
            flex-direction: column;
            min-width: 0;
        }
        .project-name {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .project-date {
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .section-caption {
            padding: 4px 12px;
            color: var(--vscode-descriptionForeground);
            border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border, transparent));
            font-size: 0.85em;
        }

        @keyframes fadeIn{from{opacity:0}to{opacity:1}}
        @keyframes noticeIn{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:translateY(0)}}
    </style>
</head>
<body>
    <div id="root">
        <div id="top-status-region" class="top-status-region">
            <div id="notification-root"></div>
        </div>
        ${body}
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        function postMessage(msg) { vscode.postMessage(msg); }
        const root = document.getElementById('root');
        function renderTopStatusRegion() { return document.getElementById('top-status-region'); }
        const notificationRoot = document.getElementById('notification-root');
        let notificationState = ${initialNotificationState};

        function h(tag, attrs, ...children) {
            const el = document.createElement(tag);
            if (attrs) {
                Object.entries(attrs).forEach(([key, value]) => {
                    if (key === 'className') el.className = value;
                    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
                    else if (key === 'title') el.title = value;
                    else el.setAttribute(key, value);
                });
            }
            children.forEach(child => {
                if (typeof child === 'string') el.appendChild(document.createTextNode(child));
                else if (child) el.appendChild(child);
            });
            return el;
        }

        function renderPanelNotice() {
            const n = notificationState && notificationState.notice;
            if (!n) return null;
            const count = n.count > 1 ? 'x' + n.count : '';
            const title = n.history && n.history.length > 1 ? n.history.join('\\n') : n.message;
            return h('div', {className:'notice-status-bar ' + n.type, title},
                h('span', {className:'notice-msg'}, n.message),
                count ? h('span', {className:'notice-count'}, count) : null,
                h('button', {
                    className:'notice-dismiss',
                    title:'Dismiss',
                    onClick:()=>postMessage({type:'dismissNotice', id:n.id}),
                }, '\u00d7'),
            );
        }

        function renderChoiceModal() {
            const c = notificationState && notificationState.modal;
            if (!c) return null;
            const buttons = c.buttons.map(button => {
                let cls = '';
                if (button.primary) cls = 'primary';
                if (button.danger) cls = 'danger';
                return h('button', {
                    className: cls,
                    onClick: () => postMessage({type:'confirmationResponse', id:c.id, value:button.value}),
                }, button.label);
            });
            return h('div', {className:'choice-modal-backdrop'},
                h('div', {className:'choice-modal ' + c.type},
                    h('div', {className:'choice-message'}, c.message),
                    h('div', {className:'choice-buttons'}, ...buttons),
                ),
            );
        }

        function renderNotifications() {
            notificationRoot.innerHTML = '';
            const notice = renderPanelNotice();
            if (notice) notificationRoot.appendChild(notice);
            const choice = renderChoiceModal();
            if (choice) notificationRoot.appendChild(choice);
        }

        window.addEventListener('message', event => {
            if (event.data && event.data.type === 'notificationState') {
                notificationState = event.data.state || { modal: null, notice: null };
                renderNotifications();
            }
        });
        renderNotifications();

        // Search input with debounce
        const searchInput = document.getElementById('search');
        const emptyMessage = document.getElementById('empty-message');

        function applyProjectFilter() {
            const query = (searchInput?.value || '').toLowerCase();
            const items = Array.from(document.querySelectorAll('#project-list .project-item'));
            let visibleCount = 0;
            items.forEach(item => {
                const isVisible = !query || (item.dataset.name || '').includes(query);
                item.hidden = !isVisible;
                if (isVisible) {
                    visibleCount++;
                }
            });

            if (emptyMessage) {
                emptyMessage.hidden = visibleCount > 0;
                const text = emptyMessage.querySelector('p');
                if (text) {
                    text.textContent = query ? 'No projects matching "' + searchInput.value + '"' : 'No projects found';
                }
            }
        }

        if (searchInput) {
            let debounceTimer;
            applyProjectFilter();
            searchInput.addEventListener('input', () => {
                applyProjectFilter();
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    postMessage({ type: 'filterChanged', text: searchInput.value });
                }, 250);
            });
        }

        // Sort buttons
        document.querySelectorAll('.sort-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                postMessage({ type: 'sortChanged', field: btn.dataset.field });
            });
        });

        document.querySelectorAll('.remote-project').forEach(item => {
            item.addEventListener('click', () => {
                postMessage({ type: 'openProject', projectId: item.dataset.projectId });
            });
        });

        document.querySelectorAll('.local-project').forEach(item => {
            item.addEventListener('click', () => {
                postMessage({ type: 'selectLocalProject', uri: item.dataset.uri });
            });
        });
    </script>
</body>
</html>`;
    }
}

// ── Helpers ────────────────────────────────────────────────────────

function accessIcon(level: ProjectInfo['accessLevel']): string {
    switch (level) {
        case 'owner': return 'person';
        case 'collaborator': return 'organization';
        case 'readOnly': return 'eye';
        default: return 'file';
    }
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeScriptJson(json: string): string {
    return json
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}
