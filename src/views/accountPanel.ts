import * as vscode from 'vscode';

export type AccountPanelAuthState = 'valid' | 'expired' | 'none';
export type AccountPanelBrowserPreference = 'system' | 'chrome' | 'edge' | 'auto';

export interface AccountPanelState {
    serverUrl: string;
    loggedIn: boolean;
    authState: AccountPanelAuthState;
    userEmail?: string;
}

export type AccountPanelAction =
    | { type: 'loginBrowser'; serverUrl: string; browserPreference: AccountPanelBrowserPreference }
    | { type: 'loginCookies'; serverUrl: string; cookies: string }
    | { type: 'logout' }
    | { type: 'openTutorial' };

export class AccountPanel {
    static readonly viewType = 'localleaf.accountPanel';
    private static instance: AccountPanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private state: AccountPanelState;

    private constructor(
        extensionUri: vscode.Uri,
        initialState: AccountPanelState,
        private readonly onAction: (action: AccountPanelAction) => Promise<void>,
    ) {
        this.state = initialState;
        this.panel = vscode.window.createWebviewPanel(
            AccountPanel.viewType,
            'LocalLeaf Account',
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
            },
        );

        this.panel.onDidDispose(() => {
            AccountPanel.instance = undefined;
        });

        this.panel.webview.onDidReceiveMessage((message: unknown) => {
            const action = this.parseAction(message);
            if (!action) return;
            void this.onAction(action);
        });

        this.panel.webview.html = this.getWebviewContent(this.panel.webview, this.state);
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
        AccountPanel.instance = new AccountPanel(extensionUri, state, onAction);
        return AccountPanel.instance;
    }

    static updateIfOpen(state: AccountPanelState): void {
        AccountPanel.instance?.updateState(state);
    }

    private updateState(state: AccountPanelState): void {
        this.state = state;
        this.panel.webview.postMessage({ type: 'state', state: this.state });
    }

    private parseAction(raw: unknown): AccountPanelAction | null {
        if (!raw || typeof raw !== 'object') return null;
        const message = raw as Record<string, unknown>;
        const type = message.type;
        if (type === 'logout') {
            return { type: 'logout' };
        }
        if (type === 'openTutorial') {
            return { type: 'openTutorial' };
        }
        if (type === 'loginBrowser') {
            const serverUrl = String(message.serverUrl || '').trim();
            const browserPreference = String(message.browserPreference || 'system') as AccountPanelBrowserPreference;
            if (!serverUrl) return null;
            if (!['system', 'chrome', 'edge', 'auto'].includes(browserPreference)) {
                return null;
            }
            return {
                type: 'loginBrowser',
                serverUrl,
                browserPreference,
            };
        }
        if (type === 'loginCookies') {
            const serverUrl = String(message.serverUrl || '').trim();
            const cookies = String(message.cookies || '').trim();
            if (!serverUrl || !cookies) return null;
            return {
                type: 'loginCookies',
                serverUrl,
                cookies,
            };
        }
        return null;
    }

    private getWebviewContent(webview: vscode.Webview, state: AccountPanelState): string {
        const nonce = getNonce();
        const initialState = JSON.stringify(state).replace(/</g, '\\u003c');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>LocalLeaf Account</title>
    <style>
        :root {
            color-scheme: light dark;
        }
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-editor-foreground);
            background: var(--vscode-editor-background);
            margin: 0;
            padding: 20px;
        }
        .card {
            border: 1px solid var(--vscode-panel-border);
            border-radius: 10px;
            padding: 16px;
            background: var(--vscode-editorWidget-background);
            max-width: 720px;
        }
        h1 {
            margin: 0 0 8px;
            font-size: 18px;
        }
        .desc {
            margin: 0 0 16px;
            color: var(--vscode-descriptionForeground);
        }
        .row {
            margin-bottom: 12px;
        }
        label {
            display: block;
            margin-bottom: 6px;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        input, select, textarea {
            width: 100%;
            box-sizing: border-box;
            padding: 8px 10px;
            border-radius: 6px;
            border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
        }
        textarea {
            min-height: 96px;
            resize: vertical;
            font-family: var(--vscode-editor-font-family);
        }
        .actions {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-top: 8px;
        }
        button {
            border: none;
            border-radius: 6px;
            padding: 8px 12px;
            cursor: pointer;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        button.primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        button:hover {
            filter: brightness(1.05);
        }
        .status {
            margin-bottom: 12px;
            padding: 10px;
            border-radius: 6px;
            border: 1px solid var(--vscode-panel-border);
            background: var(--vscode-sideBar-background);
        }
        .status strong {
            display: block;
            margin-bottom: 4px;
        }
        .status.expired {
            border-color: var(--vscode-editorWarning-foreground);
        }
        .username-ok {
            color: var(--vscode-testing-iconPassed, #2ea043);
            font-weight: 600;
        }
    </style>
</head>
<body>
    <div class="card">
        <h1>LocalLeaf Account</h1>
        <p class="desc">Manage Overleaf login and session here.</p>

        <div id="status" class="status"></div>

        <div class="row">
            <label for="serverUrl">Overleaf Server</label>
            <input id="serverUrl" type="text" />
        </div>

        <div class="row">
            <label for="browserPreference">Browser for Login via Browser</label>
            <select id="browserPreference">
                <option value="auto">Auto (Recommended)</option>
                <option value="chrome">Google Chrome</option>
                <option value="edge">Microsoft Edge</option>
                <option value="system">System Default</option>
            </select>
        </div>

        <div id="loginActions" class="actions">
            <button id="loginBrowserBtn" class="primary">Login via Browser</button>
        </div>

        <div id="logoutActions" class="actions">
            <button id="logoutBtn">Log Out</button>
        </div>

        <div id="cookieSection" class="row" style="margin-top: 16px;">
            <label for="cookies">Cookie (manual)</label>
            <textarea id="cookies" placeholder="overleaf_session2=..."></textarea>
        </div>

        <div id="cookieActions" class="actions">
            <button id="loginCookiesBtn">Login via Cookies</button>
            <button id="tutorialBtn">Cookie Tutorial</button>
        </div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        let state = ${initialState};

        const statusEl = document.getElementById('status');
        const serverInput = document.getElementById('serverUrl');
        const browserSelect = document.getElementById('browserPreference');
        const cookiesInput = document.getElementById('cookies');
        const loginBrowserBtn = document.getElementById('loginBrowserBtn');
        const loginCookiesBtn = document.getElementById('loginCookiesBtn');
        const logoutBtn = document.getElementById('logoutBtn');
        const tutorialBtn = document.getElementById('tutorialBtn');
        const loginActions = document.getElementById('loginActions');
        const logoutActions = document.getElementById('logoutActions');
        const cookieSection = document.getElementById('cookieSection');
        const cookieActions = document.getElementById('cookieActions');

        function render() {
            serverInput.value = state.serverUrl || '';

            const loggedIn = !!state.loggedIn;
            const activeLoggedIn = loggedIn && state.authState !== 'expired';

            if (!activeLoggedIn) {
                statusEl.className = 'status';
                if (state.authState === 'expired') {
                    statusEl.className = 'status expired';
                    statusEl.innerHTML = '<strong>Session Expired</strong>' +
                        'Current account: ' + (state.userEmail || 'unknown') + '. Please login again.';
                } else {
                    statusEl.innerHTML = '<strong>Not Logged In</strong>Use Browser or Cookies to sign in.';
                }
                loginActions.style.display = '';
                cookieSection.style.display = '';
                cookieActions.style.display = '';
                logoutActions.style.display = 'none';
                logoutBtn.disabled = true;
                return;
            }

            statusEl.className = 'status';
            statusEl.innerHTML = '<strong>Logged In</strong>' +
                'Current account: <span class="username-ok">' + (state.userEmail || 'unknown') + '</span>';
            loginActions.style.display = 'none';
            cookieSection.style.display = 'none';
            cookieActions.style.display = 'none';
            logoutActions.style.display = '';
            logoutBtn.disabled = false;
        }

        loginBrowserBtn.addEventListener('click', () => {
            const serverUrl = serverInput.value.trim();
            if (!serverUrl) {
                statusEl.className = 'status expired';
                statusEl.innerHTML = '<strong>Error</strong>Please input Overleaf server URL.';
                return;
            }
            vscode.postMessage({
                type: 'loginBrowser',
                serverUrl,
                browserPreference: browserSelect.value,
            });
        });

        loginCookiesBtn.addEventListener('click', () => {
            const serverUrl = serverInput.value.trim();
            const cookies = cookiesInput.value.trim();
            if (!serverUrl || !cookies) {
                statusEl.className = 'status expired';
                statusEl.innerHTML = '<strong>Error</strong>Please input both server URL and cookies.';
                return;
            }
            vscode.postMessage({
                type: 'loginCookies',
                serverUrl,
                cookies,
            });
        });

        logoutBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'logout' });
        });

        tutorialBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'openTutorial' });
        });

        window.addEventListener('message', event => {
            const msg = event.data;
            if (msg && msg.type === 'state' && msg.state) {
                state = msg.state;
                render();
            }
        });

        render();
    </script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
