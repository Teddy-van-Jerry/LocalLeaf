import * as vscode from 'vscode';
import { BaseAPI, ProjectInfo } from '../api/base';
import { COMMANDS } from '../consts';
import { CredentialManager } from '../utils/credentialManager';
import { createNonce } from './webviewUtils';

type ProjectsViewStatus = 'no-folder' | 'not-logged-in' | 'loading' | 'ready' | 'error';

interface ProjectsViewState {
    status: ProjectsViewStatus;
    projects: ProjectInfo[];
    message?: string;
    openingProjectId?: string;
}

type ProjectsWebviewMessage =
    | { type: 'ready' }
    | { type: 'refresh' }
    | { type: 'login' }
    | { type: 'openFolder' }
    | { type: 'openProject'; projectId: string };

/**
 * Project browser adapted from the UI in PR #3. The webview only renders
 * structured state; project data is never interpolated into executable HTML.
 */
export class ProjectsWebviewProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'localleaf.projectsView';

    private view?: vscode.WebviewView;
    private projects: ProjectInfo[] = [];
    private refreshVersion = 0;
    private state: ProjectsViewState = { status: 'loading', projects: [] };

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

    async refresh(): Promise<void> {
        const version = ++this.refreshVersion;
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!folder) {
            this.projects = [];
            this.updateState({ status: 'no-folder', projects: [] });
            return;
        }

        this.updateState({ status: 'loading', projects: [] });
        const serverUrl = this.credentialManager.getDefaultServer();
        const credential = await this.credentialManager.getCredential(serverUrl);
        if (version !== this.refreshVersion) return;

        if (!credential) {
            this.projects = [];
            this.updateState({ status: 'not-logged-in', projects: [] });
            return;
        }

        try {
            const api = new BaseAPI(credential.serverUrl);
            api.setIdentity(credential.identity);
            const result = await api.getProjects();
            if (version !== this.refreshVersion) return;

            if (result.type !== 'success' || !result.projects) {
                this.projects = [];
                this.updateState({
                    status: 'error',
                    projects: [],
                    message: result.message || 'Could not load Overleaf projects.',
                });
                return;
            }

            this.projects = result.projects.filter(project => !project.archived && !project.trashed);
            this.updateState({ status: 'ready', projects: this.projects });
        } catch (error) {
            if (version !== this.refreshVersion) return;
            this.projects = [];
            this.updateState({
                status: 'error',
                projects: [],
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }

    private updateState(state: ProjectsViewState): void {
        this.state = state;
        void this.view?.webview.postMessage({ type: 'state', state });
    }

    private async handleMessage(raw: unknown): Promise<void> {
        if (!raw || typeof raw !== 'object') return;
        const message = raw as Partial<ProjectsWebviewMessage> & { projectId?: unknown };

        switch (message.type) {
            case 'ready':
                await this.refresh();
                break;
            case 'refresh':
                await this.refresh();
                break;
            case 'login':
                await vscode.commands.executeCommand(COMMANDS.SHOW_ACCOUNT_PANEL);
                break;
            case 'openFolder':
                await vscode.commands.executeCommand('vscode.openFolder');
                break;
            case 'openProject': {
                if (typeof message.projectId !== 'string') return;
                const project = this.projects.find(candidate => candidate.id === message.projectId);
                if (project) {
                    if (this.state.openingProjectId) return;
                    this.updateState({ ...this.state, openingProjectId: project.id });
                    try {
                        await vscode.commands.executeCommand(COMMANDS.OPEN_PROJECT, project);
                    } finally {
                        if (this.state.openingProjectId === project.id) {
                            this.updateState({ ...this.state, openingProjectId: undefined });
                        }
                    }
                }
                break;
            }
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
    <title>LocalLeaf Projects</title>
    <style>
        *, *::before, *::after { box-sizing: border-box; }
        html, body { height: 100%; }
        body {
            margin: 0;
            color: var(--vscode-sideBar-foreground);
            background: var(--vscode-sideBar-background);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
        }
        button, input, select { font: inherit; }
        button:focus-visible, input:focus-visible, select:focus-visible {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: 2px;
        }
        .shell { min-height: 100%; padding: 12px; }
        .brand { display: flex; align-items: center; gap: 9px; margin-bottom: 14px; }
        .brand img { width: 24px; height: 24px; }
        .brand-copy { min-width: 0; }
        .brand-title { font-weight: 650; font-size: 14px; }
        .brand-subtitle { color: var(--vscode-descriptionForeground); font-size: 11px; }
        .toolbar { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 7px; margin-bottom: 8px; }
        .search, .sort {
            width: 100%; min-height: 28px; border: 1px solid var(--vscode-input-border, transparent);
            border-radius: 5px; color: var(--vscode-input-foreground); background: var(--vscode-input-background);
            padding: 4px 8px;
        }
        .meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 8px 1px; color: var(--vscode-descriptionForeground); font-size: 11px; }
        .refresh {
            border: 0; border-radius: 4px; padding: 3px 7px; color: var(--vscode-button-secondaryForeground);
            background: var(--vscode-button-secondaryBackground); cursor: pointer;
        }
        .refresh:hover { background: var(--vscode-button-secondaryHoverBackground); }
        .list { display: grid; gap: 6px; }
        .project {
            display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; align-items: center; gap: 8px;
            width: 100%; padding: 9px; border: 1px solid var(--vscode-panel-border, transparent);
            border-radius: 7px; color: inherit; background: var(--vscode-list-inactiveSelectionBackground, transparent);
            text-align: left; cursor: pointer;
        }
        .project:hover { color: var(--vscode-list-hoverForeground); background: var(--vscode-list-hoverBackground); }
        .project:disabled { opacity: .65; cursor: wait; }
        .project-icon {
            display: grid; place-items: center; width: 28px; height: 28px; border-radius: 7px;
            color: var(--vscode-button-foreground); background: var(--vscode-button-background); font-weight: 700;
        }
        .project-copy { min-width: 0; }
        .project-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
        .project-detail { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 2px; }
        .access { color: var(--vscode-descriptionForeground); font-size: 10px; text-transform: uppercase; }
        .state { min-height: 240px; display: grid; place-items: center; text-align: center; padding: 20px 8px; }
        .state-card { max-width: 260px; }
        .state-icon { font-size: 30px; margin-bottom: 10px; }
        .state-title { font-weight: 650; margin-bottom: 5px; }
        .state-copy { color: var(--vscode-descriptionForeground); line-height: 1.45; }
        .primary { margin-top: 12px; padding: 7px 11px; border: 0; border-radius: 5px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
        .primary:hover { background: var(--vscode-button-hoverBackground); }
        .spinner { width: 22px; height: 22px; margin: 0 auto 12px; border: 2px solid var(--vscode-panel-border); border-top-color: var(--vscode-progressBar-background); border-radius: 50%; animation: spin .8s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <main id="root" class="shell" aria-live="polite">
        <section class="state"><div class="state-card"><div class="spinner"></div><div class="state-title">Loading LocalLeaf…</div></div></section>
    </main>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const root = document.getElementById('root');
        const persisted = vscode.getState() || {};
        let state = null;
        let filterText = typeof persisted.filterText === 'string' ? persisted.filterText : '';
        let sortMode = typeof persisted.sortMode === 'string' ? persisted.sortMode : 'updated-desc';

        function element(tag, className, text) {
            const node = document.createElement(tag);
            if (className) node.className = className;
            if (text !== undefined) node.textContent = text;
            return node;
        }

        function actionButton(label, message) {
            const button = element('button', 'primary', label);
            button.type = 'button';
            button.addEventListener('click', () => vscode.postMessage(message));
            return button;
        }

        function renderState(icon, title, copy, action) {
            const wrapper = element('section', 'state');
            const card = element('div', 'state-card');
            card.append(element('div', 'state-icon', icon), element('div', 'state-title', title), element('div', 'state-copy', copy));
            if (action) card.append(actionButton(action.label, action.message));
            wrapper.append(card);
            root.replaceChildren(wrapper);
        }

        function initials(name) {
            return String(name || '?').split(/\\s+/).filter(Boolean).slice(0, 2).map(part => part[0].toUpperCase()).join('') || '?';
        }

        function sortedProjects() {
            const query = filterText.trim().toLocaleLowerCase();
            const projects = state.projects.filter(project => !query || project.name.toLocaleLowerCase().includes(query));
            return projects.sort((left, right) => {
                if (sortMode === 'name-asc') return left.name.localeCompare(right.name);
                if (sortMode === 'access-desc') {
                    const rank = { owner: 3, collaborator: 2, readOnly: 1 };
                    return (rank[right.accessLevel] || 0) - (rank[left.accessLevel] || 0) || left.name.localeCompare(right.name);
                }
                return new Date(right.lastUpdated || 0).getTime() - new Date(left.lastUpdated || 0).getTime();
            });
        }

        function renderProjects() {
            const brand = element('header', 'brand');
            const icon = document.createElement('img');
            icon.src = '${iconUri}';
            icon.alt = '';
            const brandCopy = element('div', 'brand-copy');
            brandCopy.append(element('div', 'brand-title', 'Overleaf Projects'), element('div', 'brand-subtitle', 'Choose a project to link this folder'));
            brand.append(icon, brandCopy);

            const toolbar = element('div', 'toolbar');
            const search = element('input', 'search');
            search.type = 'search';
            search.placeholder = 'Search projects';
            search.setAttribute('aria-label', 'Search projects');
            search.value = filterText;
            search.addEventListener('input', () => {
                filterText = search.value;
                vscode.setState({ filterText, sortMode });
                renderList();
            });
            const sort = element('select', 'sort');
            sort.setAttribute('aria-label', 'Sort projects');
            [['updated-desc', 'Recent'], ['name-asc', 'Name'], ['access-desc', 'Access']].forEach(([value, label]) => {
                const option = element('option', '', label);
                option.value = value;
                option.selected = value === sortMode;
                sort.append(option);
            });
            sort.addEventListener('change', () => {
                sortMode = sort.value;
                vscode.setState({ filterText, sortMode });
                renderList();
            });
            toolbar.append(search, sort);

            const meta = element('div', 'meta');
            const count = element('span', 'count');
            const refresh = element('button', 'refresh', 'Refresh');
            refresh.type = 'button';
            refresh.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
            meta.append(count, refresh);
            const list = element('section', 'list');
            list.setAttribute('aria-label', 'Overleaf projects');

            root.replaceChildren(brand, toolbar, meta, list);

            function renderList() {
                const visible = sortedProjects();
                count.textContent = visible.length + (visible.length === 1 ? ' project' : ' projects');
                const rows = visible.map(project => {
                    const row = element('button', 'project');
                    row.type = 'button';
                    row.disabled = Boolean(state.openingProjectId);
                    row.title = 'Link to ' + project.name;
                    row.addEventListener('click', () => vscode.postMessage({ type: 'openProject', projectId: project.id }));
                    const badge = element('span', 'project-icon', initials(project.name));
                    const copy = element('span', 'project-copy');
                    const date = state.openingProjectId === project.id
                        ? 'Preparing synchronization...'
                        : project.lastUpdated ? new Date(project.lastUpdated).toLocaleDateString() : 'No update date';
                    copy.append(element('div', 'project-name', project.name), element('div', 'project-detail', date));
                    row.append(badge, copy, element('span', 'access', project.accessLevel));
                    return row;
                });
                if (rows.length === 0) rows.push(element('div', 'state-copy', filterText ? 'No projects match this search.' : 'No active projects found.'));
                list.replaceChildren(...rows);
            }

            renderList();
        }

        function render() {
            if (!state) return;
            if (state.status === 'no-folder') return renderState('📂', 'Open a folder', 'LocalLeaf needs a workspace folder before it can link an Overleaf project.', { label: 'Open Folder', message: { type: 'openFolder' } });
            if (state.status === 'not-logged-in') return renderState('◉', 'Sign in to Overleaf', 'Connect your account to browse and link projects.', { label: 'Open Account', message: { type: 'login' } });
            if (state.status === 'loading') {
                const wrapper = element('section', 'state');
                const card = element('div', 'state-card');
                card.append(element('div', 'spinner'), element('div', 'state-title', 'Loading projects…'));
                wrapper.append(card);
                return root.replaceChildren(wrapper);
            }
            if (state.status === 'error') return renderState('⚠', 'Projects unavailable', state.message || 'Could not load projects.', { label: 'Try Again', message: { type: 'refresh' } });
            renderProjects();
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
