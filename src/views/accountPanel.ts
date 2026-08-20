import * as vscode from 'vscode';
import { createNonce } from './webviewUtils';

export type AccountPanelAuthState = 'valid' | 'expired' | 'none';

export interface AccountPanelState {
    serverUrl: string;
    loggedIn: boolean;
    authState: AccountPanelAuthState;
    userEmail?: string;
}

export type AccountPanelAction =
    | { type: 'guidedLogin' }
    | { type: 'loginCookies'; serverUrl: string; cookies: string }
    | { type: 'logout' }
    | { type: 'openTutorial' };

/** Account management surface adapted from PR #3. */
export class AccountPanel {
    static readonly viewType = 'localleaf.accountPanel';
    private static instance: AccountPanel | undefined;

    private state: AccountPanelState;

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        initialState: AccountPanelState,
        private readonly onAction: (action: AccountPanelAction) => Promise<void>,
    ) {
        this.state = initialState;
        this.panel.onDidDispose(() => {
            AccountPanel.instance = undefined;
        });
        this.panel.webview.onDidReceiveMessage((message: unknown) => {
            if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'ready') {
                this.updateState(this.state);
                return;
            }
            const action = this.parseAction(message);
            if (action) {
                void this.onAction(action).catch(error => {
                    console.error('[LocalLeaf] Account action failed:', error);
                });
            }
        });
        this.panel.webview.html = this.getHtml(this.panel.webview);
    }

    static createOrShow(
        extensionUri: vscode.Uri,
        state: AccountPanelState,
        onAction: (action: AccountPanelAction) => Promise<void>,
    ): AccountPanel {
        if (AccountPanel.instance) {
            AccountPanel.instance.panel.reveal(vscode.ViewColumn.Active);
            AccountPanel.instance.updateState(state);
            return AccountPanel.instance;
        }

        const panel = vscode.window.createWebviewPanel(
            AccountPanel.viewType,
            'LocalLeaf Account',
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'images')],
            },
        );
        AccountPanel.instance = new AccountPanel(panel, state, onAction);
        return AccountPanel.instance;
    }

    static updateIfOpen(state: AccountPanelState): void {
        AccountPanel.instance?.updateState(state);
    }

    private updateState(state: AccountPanelState): void {
        this.state = state;
        void this.panel.webview.postMessage({ type: 'state', state }).then(undefined, error => {
            console.error('[LocalLeaf] Failed to update Account panel:', error);
        });
    }

    private parseAction(raw: unknown): AccountPanelAction | undefined {
        if (!raw || typeof raw !== 'object') return undefined;
        const message = raw as Record<string, unknown>;
        if (message.type === 'guidedLogin') return { type: 'guidedLogin' };
        if (message.type === 'logout') return { type: 'logout' };
        if (message.type === 'openTutorial') return { type: 'openTutorial' };
        if (message.type === 'loginCookies') {
            const serverUrl = String(message.serverUrl || '').trim();
            const cookies = String(message.cookies || '').trim();
            if (serverUrl && cookies) return { type: 'loginCookies', serverUrl, cookies };
        }
        return undefined;
    }

    private getHtml(webview: vscode.Webview): string {
        const nonce = createNonce();

        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>LocalLeaf Account</title>
    <style>
        *, *::before, *::after { box-sizing: border-box; }
        body {
            margin: 0; padding: 28px; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background);
            font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
        }
        .layout { max-width: 720px; margin: 0 auto; }
        .eyebrow { color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 650; text-transform: uppercase; letter-spacing: .08em; }
        h1 { margin: 5px 0 6px; font-size: 24px; font-weight: 650; }
        .lead { margin: 0 0 22px; color: var(--vscode-descriptionForeground); line-height: 1.5; }
        .card { padding: 18px; border: 1px solid var(--vscode-panel-border); border-radius: 10px; background: var(--vscode-editorWidget-background); }
        .status { display: grid; grid-template-columns: 12px minmax(0, 1fr); gap: 10px; align-items: start; padding: 11px; margin-bottom: 18px; border: 1px solid var(--vscode-panel-border); border-radius: 7px; background: var(--vscode-sideBar-background); }
        .status-dot { width: 9px; height: 9px; margin-top: 4px; border-radius: 50%; background: var(--vscode-descriptionForeground); }
        .status.valid .status-dot { background: var(--vscode-testing-iconPassed, #2ea043); }
        .status.expired .status-dot { background: var(--vscode-editorWarning-foreground); }
        .status-title { font-weight: 650; }
        .status-copy { margin-top: 2px; color: var(--vscode-descriptionForeground); }
        .field { margin-top: 14px; }
        label { display: block; margin-bottom: 6px; color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 600; }
        input, textarea {
            width: 100%; padding: 8px 10px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
            border-radius: 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); font: inherit;
        }
        textarea { min-height: 94px; resize: vertical; font-family: var(--vscode-editor-font-family); }
        input:focus-visible, textarea:focus-visible, button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
        .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
        button { padding: 8px 12px; border: 0; border-radius: 6px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); font: inherit; cursor: pointer; }
        button:hover { background: var(--vscode-button-secondaryHoverBackground); }
        button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
        button.primary:hover { background: var(--vscode-button-hoverBackground); }
        .separator { display: flex; align-items: center; gap: 10px; margin: 18px 0 4px; color: var(--vscode-descriptionForeground); font-size: 11px; }
        .separator::before, .separator::after { content: ''; flex: 1; height: 1px; background: var(--vscode-panel-border); }
        .hint { margin-top: 8px; color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.45; }
        [hidden] { display: none !important; }
    </style>
</head>
<body>
    <main class="layout">
        <div class="eyebrow">LocalLeaf</div>
        <h1>Overleaf account</h1>
        <p class="lead">Manage the account used to browse and synchronize your projects.</p>
        <section class="card">
            <div id="status" class="status">
                <span class="status-dot"></span>
                <span><span id="statusTitle" class="status-title"></span><span id="statusCopy" class="status-copy"></span></span>
            </div>

            <div id="signedOut">
                <button id="guidedLogin" type="button" class="primary">Guided Login</button>
                <p class="hint">Guided Login uses the current LocalLeaf login flow for official or self-hosted Overleaf servers.</p>

                <div class="separator">or use cookies directly</div>
                <div class="field">
                    <label for="serverUrl">Overleaf server</label>
                    <input id="serverUrl" type="url" autocomplete="url" placeholder="https://www.overleaf.com">
                </div>
                <div class="field">
                    <label for="cookies">Session cookies</label>
                    <textarea id="cookies" spellcheck="false" placeholder="overleaf_session2=..."></textarea>
                </div>
                <div class="actions">
                    <button id="loginCookies" type="button" class="primary">Login with Cookies</button>
                    <button id="tutorial" type="button">Cookie Tutorial</button>
                </div>
            </div>

            <div id="signedIn" hidden>
                <div class="actions">
                    <button id="logout" type="button">Log Out</button>
                </div>
            </div>
        </section>
    </main>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        let state = { serverUrl: '', loggedIn: false, authState: 'none' };
        const status = document.getElementById('status');
        const statusTitle = document.getElementById('statusTitle');
        const statusCopy = document.getElementById('statusCopy');
        const signedOut = document.getElementById('signedOut');
        const signedIn = document.getElementById('signedIn');
        const serverUrl = document.getElementById('serverUrl');
        const cookies = document.getElementById('cookies');
        const loginCookies = document.getElementById('loginCookies');

        function render() {
            const active = state.loggedIn && state.authState !== 'expired';
            serverUrl.value = state.serverUrl || '';
            status.className = 'status ' + (active ? 'valid' : state.authState === 'expired' ? 'expired' : 'none');
            if (active) {
                statusTitle.textContent = 'Connected';
                statusCopy.textContent = 'Signed in as ' + (state.userEmail || 'unknown account') + '.';
            } else if (state.authState === 'expired') {
                statusTitle.textContent = 'Session expired';
                statusCopy.textContent = 'Sign in again to continue synchronizing projects.';
            } else {
                statusTitle.textContent = 'Not connected';
                statusCopy.textContent = 'Sign in to browse and synchronize Overleaf projects.';
            }
            signedOut.hidden = active;
            signedIn.hidden = !active;
            loginCookies.disabled = false;
            if (active) cookies.value = '';
        }

        document.getElementById('guidedLogin').addEventListener('click', () => vscode.postMessage({ type: 'guidedLogin' }));
        document.getElementById('tutorial').addEventListener('click', () => vscode.postMessage({ type: 'openTutorial' }));
        document.getElementById('logout').addEventListener('click', () => vscode.postMessage({ type: 'logout' }));
        loginCookies.addEventListener('click', () => {
            const normalizedServer = serverUrl.value.trim();
            const normalizedCookies = cookies.value.trim();
            if (!normalizedServer || !normalizedCookies) {
                status.className = 'status expired';
                statusTitle.textContent = 'Missing information';
                statusCopy.textContent = 'Enter both the server URL and session cookies.';
                return;
            }
            cookies.value = '';
            loginCookies.disabled = true;
            vscode.postMessage({ type: 'loginCookies', serverUrl: normalizedServer, cookies: normalizedCookies });
        });
        window.addEventListener('message', event => {
            if (event.data && event.data.type === 'state') {
                state = event.data.state;
                render();
            }
        });
        render();
        vscode.postMessage({ type: 'ready' });
    </script>
</body>
</html>`;
    }
}
