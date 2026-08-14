/**
 * LocalLeaf VS Code Extension
 * Local sync for Overleaf LaTeX projects
 */

import * as vscode from 'vscode';
import { COMMANDS, EXTENSION_NAME, STATUS_BAR_PRIORITY, CONFIG_DIR, IGNORE_FILE } from './consts';
import { CredentialManager, ServerCredential, Identity } from './utils/credentialManager';
import { SettingsManager, createSettingsWatcher } from './utils/settingsManager';
import { BaseAPI, ProjectInfo } from './api/base';
import { SyncEngine, SyncStatus } from './sync/syncEngine';
import { IgnoreParser } from './sync/ignoreParser';
import { CursorTracker, TrackedUser } from './collaboration/cursorTracker';
import { setOutputChannel } from './api/socketio';
import { ProjectsWebviewProvider } from './views/projectsWebviewProvider';
import { MainWebviewProvider } from './views/mainWebviewProvider';
import { AccountPanel, AccountPanelAction, AccountPanelState } from './views/accountPanel';
import { LinkOperationGate, shouldConfirmProjectLink } from './utils/linkSafety';

/**
 * Auth state type
 */
type AuthState = 'valid' | 'expired' | 'none';

/**
 * Extension state
 */
let credentialManager: CredentialManager;
let syncEngine: SyncEngine | undefined;
let cursorTracker: CursorTracker | undefined;
let statusBarItem: vscode.StatusBarItem;
let loginStatusItem: vscode.StatusBarItem;
let collaboratorStatusItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let statusUpdateInterval: NodeJS.Timeout | undefined;
let authState: AuthState = 'none';
let projectsWebviewProvider: ProjectsWebviewProvider;
let mainWebviewProvider: MainWebviewProvider;
const linkOperationGate = new LinkOperationGate();
const panelConfirmation = Object.freeze({ source: 'localleaf-panel' });

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Extension activation
 */
export async function activate(context: vscode.ExtensionContext) {
    try {

    // Initialize output channel
    outputChannel = vscode.window.createOutputChannel(EXTENSION_NAME);
    context.subscriptions.push(outputChannel);

    // Share output channel with socketio module for logging
    setOutputChannel(outputChannel);

    // Initialize credential manager
    credentialManager = CredentialManager.initialize(context);

    // Register the Activity Bar views adapted from PR #3.
    projectsWebviewProvider = new ProjectsWebviewProvider(context.extensionUri, credentialManager);
    mainWebviewProvider = new MainWebviewProvider(
        context.extensionUri,
        credentialManager,
        async command => {
            if (command === COMMANDS.CLEAN_IGNORED_REMOTE) {
                await cmdCleanIgnoredRemoteFiles(panelConfirmation);
            } else if (command === COMMANDS.UNLINK_FOLDER) {
                await cmdUnlinkFolder(panelConfirmation);
            }
        },
    );
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            ProjectsWebviewProvider.viewType,
            projectsWebviewProvider,
            { webviewOptions: { retainContextWhenHidden: true } },
        ),
        vscode.window.registerWebviewViewProvider(
            MainWebviewProvider.viewType,
            mainWebviewProvider,
            { webviewOptions: { retainContextWhenHidden: true } },
        ),
    );

    // Resolve the view context before slower authentication and network work.
    let settingsManager = await SettingsManager.resolveCurrentInstance();
    const isLinked = Boolean(settingsManager && await settingsManager.isLinked());
    await vscode.commands.executeCommand('setContext', 'localleaf.isLinked', isLinked);

    // Create status bar items
    // Sync status (left side)
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, STATUS_BAR_PRIORITY);
    statusBarItem.name = `${EXTENSION_NAME} Sync`;
    context.subscriptions.push(statusBarItem);

    // Login status (left side, before sync)
    loginStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, STATUS_BAR_PRIORITY + 1);
    loginStatusItem.name = `${EXTENSION_NAME} Login`;
    loginStatusItem.command = COMMANDS.LOGIN;
    context.subscriptions.push(loginStatusItem);

    // Collaborator status (left side, next to sync)
    collaboratorStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, STATUS_BAR_PRIORITY - 1);
    collaboratorStatusItem.name = `${EXTENSION_NAME} Collaborators`;
    collaboratorStatusItem.command = COMMANDS.JUMP_TO_COLLABORATOR;
    context.subscriptions.push(collaboratorStatusItem);

    // Update login status
    await updateLoginStatus();

    // Register commands
    registerCommands(context);

    // Check if current workspace is linked
    if (settingsManager && isLinked) {
        await settingsManager.load();
        // Show status bar only when linked
        statusBarItem.show();
        await initializeSync(context, settingsManager);
    } else {
        // Hide sync status bar when not linked
        statusBarItem.hide();
        collaboratorStatusItem.hide();
    }

    // Watch for settings changes
    const workspaceFolder = settingsManager?.getWorkspaceFolder()
        ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    if (workspaceFolder) {
        const settingsWatcher = createSettingsWatcher(workspaceFolder, async () => {
            log('Settings changed, reloading...');
            settingsManager = await SettingsManager.resolveCurrentInstance();
            await settingsManager?.load();
            const linked = Boolean(settingsManager && await settingsManager.isLinked());
            await vscode.commands.executeCommand('setContext', 'localleaf.isLinked', linked);
            if (!linked) {
                statusBarItem.hide();
                collaboratorStatusItem.hide();
            }
            await refreshGui();
        });
        context.subscriptions.push(settingsWatcher);
    }

    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(async () => {
        SettingsManager.clearCurrentWorkspaceFolder();
        settingsManager = await SettingsManager.resolveCurrentInstance();
        const linked = Boolean(settingsManager && await settingsManager.isLinked());
        await vscode.commands.executeCommand('setContext', 'localleaf.isLinked', linked);
        await refreshGui();
    }));

    await refreshGui();
    log('LocalLeaf activated');

    } catch (error) {
        console.error('[LocalLeaf] Activation error:', error);
        vscode.window.showErrorMessage(`LocalLeaf failed to activate: ${error}`);
    }
}

/**
 * Register all commands
 */
function registerCommands(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.LOGIN, cmdLogin),
        vscode.commands.registerCommand(COMMANDS.LOGOUT, cmdLogout),
        vscode.commands.registerCommand(COMMANDS.SHOW_ACCOUNT_PANEL, () => cmdShowAccountPanel(context)),
        vscode.commands.registerCommand(COMMANDS.OPEN_PROJECT, (project: ProjectInfo) => cmdLinkFolder(context, project)),
        vscode.commands.registerCommand(COMMANDS.LINK_FOLDER, () => cmdLinkFolder(context)),
        vscode.commands.registerCommand(COMMANDS.UNLINK_FOLDER, cmdUnlinkFolder),
        vscode.commands.registerCommand(COMMANDS.SYNC_NOW, cmdSyncNow),
        vscode.commands.registerCommand(COMMANDS.PULL_FROM_OVERLEAF, cmdPullFromOverleaf),
        vscode.commands.registerCommand(COMMANDS.PUSH_TO_OVERLEAF, cmdPushToOverleaf),
        vscode.commands.registerCommand(COMMANDS.EDIT_IGNORE_PATTERNS, cmdEditIgnorePatterns),
        vscode.commands.registerCommand(COMMANDS.CLEAN_IGNORED_REMOTE, cmdCleanIgnoredRemoteFiles),
        vscode.commands.registerCommand(COMMANDS.SHOW_SYNC_STATUS, cmdShowSyncStatus),
        vscode.commands.registerCommand(COMMANDS.SET_MAIN_DOCUMENT, cmdSetMainDocument),
        vscode.commands.registerCommand(COMMANDS.CONFIGURE, cmdConfigure),
        vscode.commands.registerCommand(COMMANDS.JUMP_TO_COLLABORATOR, cmdJumpToCollaborator),
        vscode.commands.registerCommand(COMMANDS.VERIFY_CREDENTIALS, cmdVerifyCredentials),
        vscode.commands.registerCommand(COMMANDS.REFRESH_COOKIE, cmdRefreshCookie),
    );
}

/**
 * Initialize sync engine for linked folder
 */
async function initializeSync(context: vscode.ExtensionContext, settings: SettingsManager): Promise<void> {
    const projectSettings = settings.getSettings();
    if (!projectSettings) return;

    // Get credentials
    const credential = await credentialManager.getCredential(projectSettings.serverUrl);
    if (!credential) {
        updateStatusBar('disconnected', 'Not logged in');
        vscode.window.showWarningMessage('LocalLeaf: Please login to Overleaf first');
        return;
    }

    // Create API
    const api = new BaseAPI(projectSettings.serverUrl);
    api.setIdentity(credential.identity);

    // Create sync engine
    syncEngine = new SyncEngine(api, settings, log);

    // Listen to status changes
    syncEngine.onStatusChange(async event => {
        updateStatusBar(event.status, event.message);
        // Handle auth errors
        if (event.authError) {
            await setAuthState('expired');
            showSessionExpiredNotification();
        }
    });

    // Connect
    try {
        await syncEngine.connect();

        // Initialize cursor tracker
        const socket = syncEngine.getSocket();
        if (socket) {
            cursorTracker = new CursorTracker(socket, settings);
            await cursorTracker.initialize();
            context.subscriptions.push({ dispose: () => cursorTracker?.dispose() });
        }

        // Start periodic status updates for collaborators
        startStatusUpdates();

        log('Sync engine connected');

        // Auto-detect main document from project settings
        await syncEngine.detectMainDocument();

        // Auto-pull on project load
        try {
            log('Auto-pulling files from Overleaf...');
            await syncEngine.pullAll();
            log('Auto-pull complete');

            // Join all docs to receive real-time OT updates
            await syncEngine.joinAllDocsForWatching();
            log('Watching for remote changes');

            vscode.window.showInformationMessage(`LocalLeaf: Synced with "${projectSettings.projectName}"`);
        } catch (pullError) {
            log(`Auto-pull failed: ${pullError}`);
            // Don't show error for auto-pull, user can manually pull
        }
    } catch (error) {
        log(`Failed to connect: ${error}`);
        vscode.window.showErrorMessage(`LocalLeaf: Failed to connect - ${error}`);
    }
}

/**
 * Update sync status bar
 */
function updateStatusBar(status: SyncStatus, message?: string) {
    const icons: Record<SyncStatus, string> = {
        disconnected: '$(cloud-offline)',
        connecting: '$(sync~spin)',
        idle: '$(cloud)',
        syncing: '$(sync~spin)',
        pulling: '$(cloud-download)',
        pushing: '$(cloud-upload)',
        error: '$(warning)',
    };
    const labels: Record<SyncStatus, string> = {
        disconnected: 'Disconnected',
        connecting: 'Connecting',
        idle: 'Up to date',
        syncing: 'Syncing',
        pulling: 'Pulling',
        pushing: 'Pushing',
        error: 'Error',
    };

    statusBarItem.text = `${icons[status]} LocalLeaf: ${labels[status]}`;
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**LocalLeaf — ${labels[status]}**\n\n`);
    const settings = SettingsManager.getCurrentInstance()?.getSettings();
    if (settings?.projectName) {
        tooltip.appendText(`Project: ${settings.projectName}`);
        tooltip.appendMarkdown('\n\n');
    }
    tooltip.appendText(message || labels[status]);
    tooltip.appendMarkdown('\n\n_Click to show synchronization details_');
    statusBarItem.tooltip = tooltip;
    statusBarItem.command = COMMANDS.SHOW_SYNC_STATUS;
    statusBarItem.accessibilityInformation = {
        label: `LocalLeaf ${labels[status]}. ${message || labels[status]}`,
        role: 'button',
    };

    if (status === 'error') {
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (status === 'disconnected') {
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
        statusBarItem.backgroundColor = undefined;
    }

    statusBarItem.show();
    mainWebviewProvider?.setSyncStatus(status, message);

    // Update collaborator status bar based on connection
    if (status === 'disconnected' || status === 'error') {
        collaboratorStatusItem.hide();
    }
}

/**
 * Update auth state and refresh UI
 */
async function setAuthState(state: AuthState): Promise<void> {
    authState = state;
    await updateLoginStatus();
    await refreshGui();
}

/**
 * Update login status bar
 */
async function updateLoginStatus() {
    // Only show login status if folder is linked
    const settingsManager = SettingsManager.getCurrentInstance();
    const isLinked = settingsManager && await settingsManager.isLinked();

    if (!isLinked) {
        loginStatusItem.hide();
        return;
    }

    const serverUrl = credentialManager.getDefaultServer();
    const credential = await credentialManager.getCredential(serverUrl);

    if (credential && authState === 'valid') {
        // Logged in with valid session
        loginStatusItem.text = `$(account) ${credential.userEmail}`;
        loginStatusItem.tooltip = new vscode.MarkdownString(
            `**Logged in to Overleaf**\n\n` +
            `Email: ${credential.userEmail}\n\n` +
            `Server: ${credential.serverUrl}`
        );
        loginStatusItem.backgroundColor = undefined;
        loginStatusItem.command = COMMANDS.LOGOUT;
    } else if (credential && authState === 'expired') {
        // Session expired - show warning state
        loginStatusItem.text = `$(warning) ${credential.userEmail} (expired)`;
        loginStatusItem.tooltip = new vscode.MarkdownString(
            `**Session Expired**\n\n` +
            `Email: ${credential.userEmail}\n\n` +
            `Server: ${credential.serverUrl}\n\n` +
            `Click to refresh your cookie`
        );
        loginStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        loginStatusItem.command = COMMANDS.REFRESH_COOKIE;
    } else if (credential) {
        // Credential exists but auth state not confirmed yet (assume valid until proven otherwise)
        loginStatusItem.text = `$(account) ${credential.userEmail}`;
        loginStatusItem.tooltip = new vscode.MarkdownString(
            `**Logged in to Overleaf**\n\n` +
            `Email: ${credential.userEmail}\n\n` +
            `Server: ${credential.serverUrl}`
        );
        loginStatusItem.backgroundColor = undefined;
        loginStatusItem.command = COMMANDS.LOGOUT;
    } else {
        // Not logged in
        authState = 'none';
        loginStatusItem.text = '$(account) Not logged in';
        loginStatusItem.tooltip = 'Click to login to Overleaf';
        loginStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        loginStatusItem.command = COMMANDS.LOGIN;
    }

    loginStatusItem.show();
}

/**
 * Show session expired notification with action buttons
 */
async function showSessionExpiredNotification(): Promise<void> {
    const action = await vscode.window.showWarningMessage(
        'LocalLeaf: Your Overleaf session has expired.',
        'Refresh Cookie',
        'Dismiss'
    );

    if (action === 'Refresh Cookie') {
        await cmdRefreshCookie();
    }
}

/**
 * Update collaborator status bar
 */
function updateCollaboratorStatus() {
    if (!cursorTracker || !syncEngine || syncEngine.status === 'disconnected') {
        collaboratorStatusItem.hide();
        mainWebviewProvider?.setOnlineUsers([]);
        return;
    }

    const users = cursorTracker.getOnlineUsers();
    mainWebviewProvider?.setOnlineUsers(users.map(user => ({
        clientId: user.clientId,
        name: user.name,
        color: user.color,
        docPath: user.docPath,
        row: user.row,
    })));
    const count = users.length;

    if (count === 0) {
        collaboratorStatusItem.text = '$(person) 0';
        collaboratorStatusItem.tooltip = 'No collaborators online';
        collaboratorStatusItem.backgroundColor = undefined;
    } else {
        // Check if any user was recently active (within last 10 seconds)
        const now = Date.now();
        const recentlyActive = users.some(u => now - u.lastUpdated < 10000);

        collaboratorStatusItem.text = `$(organization) ${count}`;

        // Build tooltip with user list
        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown(`**${count} Collaborator${count > 1 ? 's' : ''} Online**\n\n`);

        for (const user of users) {
            const timeSince = formatTimeSince(now - user.lastUpdated);
            const location = user.docPath ? `at ${user.docPath}:${user.row + 1}` : '';
            tooltip.appendMarkdown('- ');
            tooltip.appendText(`${user.name} ${location} (${timeSince})`);
            tooltip.appendMarkdown('\n');
        }

        tooltip.appendMarkdown('\n*Click to jump to a collaborator*');
        collaboratorStatusItem.tooltip = tooltip;

        // Highlight if someone is active
        if (recentlyActive) {
            collaboratorStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
        } else {
            collaboratorStatusItem.backgroundColor = undefined;
        }
    }

    collaboratorStatusItem.show();
}

/**
 * Format time since last activity
 */
function formatTimeSince(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 10) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
}

/**
 * Start periodic status updates
 */
function startStatusUpdates() {
    if (statusUpdateInterval) {
        clearInterval(statusUpdateInterval);
    }
    statusUpdateInterval = setInterval(() => {
        updateCollaboratorStatus();
    }, 1000);
}

/**
 * Stop periodic status updates
 */
function stopStatusUpdates() {
    if (statusUpdateInterval) {
        clearInterval(statusUpdateInterval);
        statusUpdateInterval = undefined;
    }
}

/**
 * Log to output channel
 */
function log(message: string) {
    const timestamp = new Date().toISOString();
    outputChannel.appendLine(`[${timestamp}] ${message}`);
}

/** Refresh whichever Activity Bar view is currently relevant. */
async function refreshGui(): Promise<void> {
    const manager = SettingsManager.getCurrentInstance();
    const linked = Boolean(manager && await manager.isLinked());
    if (linked) {
        await mainWebviewProvider?.refresh();
    } else {
        await projectsWebviewProvider?.refresh();
    }
    if (credentialManager) {
        AccountPanel.updateIfOpen(await getAccountPanelState());
    }
}

async function getAccountPanelState(): Promise<AccountPanelState> {
    const manager = SettingsManager.getCurrentInstance();
    if (manager && await manager.isLinked() && !manager.getSettings()) {
        await manager.load();
    }
    const serverUrl = manager?.getSettings()?.serverUrl || credentialManager.getDefaultServer();
    const credential = await credentialManager.getCredential(serverUrl);
    return {
        serverUrl,
        loggedIn: Boolean(credential),
        authState: credential ? (authState === 'expired' ? 'expired' : 'valid') : 'none',
        userEmail: credential?.userEmail,
    };
}

async function cmdShowAccountPanel(context: vscode.ExtensionContext): Promise<void> {
    AccountPanel.createOrShow(
        context.extensionUri,
        await getAccountPanelState(),
        async action => {
            try {
                await handleAccountPanelAction(action);
            } catch (error) {
                vscode.window.showErrorMessage(`LocalLeaf: Account action failed - ${errorMessage(error)}`);
            } finally {
                await refreshGui();
            }
        },
    );
}

async function handleAccountPanelAction(action: AccountPanelAction): Promise<void> {
    switch (action.type) {
        case 'guidedLogin':
            await cmdLogin();
            await reconnectAfterLogin();
            break;
        case 'loginCookies':
            if (await loginWithCookies(action.serverUrl, action.cookies)) {
                await reconnectAfterLogin();
            }
            break;
        case 'logout':
            await cmdLogout();
            break;
        case 'openTutorial':
            await vscode.env.openExternal(vscode.Uri.parse(
                'https://github.com/overleaf-workshop/Overleaf-Workshop/blob/master/docs/wiki.md#login-with-cookies'
            ));
            break;
    }
}

async function reconnectAfterLogin(): Promise<void> {
    const manager = SettingsManager.getCurrentInstance();
    if (!manager || !(await manager.isLinked())) return;
    if (!manager.getSettings()) await manager.load();
    const settings = manager.getSettings();
    if (!settings || !(await credentialManager.hasCredential(settings.serverUrl))) return;
    await cmdReconnect();
}

async function loginWithCookies(serverUrl: string, cookies: string): Promise<boolean> {
    const normalizedServer = serverUrl.trim().replace(/\/+$/, '');
    const parsed = new URL(normalizedServer);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error('The Overleaf server must use HTTP or HTTPS.');
    }

    if (parsed.protocol === 'http:') {
        const continueAction = 'Continue with HTTP';
        const choice = await vscode.window.showWarningMessage(
            'LocalLeaf: This server uses unencrypted HTTP. Your Overleaf session cookie could be intercepted.',
            {
                modal: true,
                detail: `Server: ${parsed.origin}\n\nContinue only if you trust this server and network.`,
            },
            continueAction,
        );
        if (choice !== continueAction) {
            return false;
        }
    }

    const api = new BaseAPI(normalizedServer);
    const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'LocalLeaf: Validating Overleaf cookies...',
        cancellable: false,
    }, () => api.cookiesLogin(cookies));

    if (result.type !== 'success' || !result.userInfo || !result.identity) {
        throw new Error(result.message || 'Cookie validation failed.');
    }

    await credentialManager.storeCredential({
        serverUrl: normalizedServer,
        userId: result.userInfo.userId,
        userEmail: result.userInfo.userEmail,
        identity: result.identity,
    });
    await vscode.workspace.getConfiguration('localleaf').update(
        'defaultServer',
        normalizedServer,
        vscode.ConfigurationTarget.Global,
    );
    await setAuthState('valid');
    vscode.window.showInformationMessage(`LocalLeaf: Logged in as ${result.userInfo.userEmail}`);
    return true;
}

// === Command Implementations ===

/**
 * Login to Overleaf
 */
async function cmdLogin() {
    const serverUrl = await vscode.window.showInputBox({
        prompt: 'Enter Overleaf server URL',
        value: credentialManager.getDefaultServer(),
        placeHolder: 'https://www.overleaf.com',
    });

    if (!serverUrl) return;

    // For www.overleaf.com, use cookie-based login
    const isOfficialServer = serverUrl.includes('overleaf.com');

    if (isOfficialServer) {
        // Show help option before asking for cookies
        const helpChoice = await vscode.window.showInformationMessage(
            'You need to paste your Overleaf cookies to login.',
            'How to get cookies?',
            'Continue'
        );

        if (!helpChoice) return;

        if (helpChoice === 'How to get cookies?') {
            await vscode.env.openExternal(vscode.Uri.parse('https://github.com/overleaf-workshop/Overleaf-Workshop/blob/master/docs/wiki.md#login-with-cookies'));
            // Show input box after opening the tutorial
        }

        const cookies = await vscode.window.showInputBox({
            prompt: 'Paste your Overleaf cookies (see tutorial for help)',
            placeHolder: 'overleaf_session2=...',
            password: true,
        });

        if (!cookies) return;

        const api = new BaseAPI(serverUrl);
        const result = await api.cookiesLogin(cookies);

        if (result.type === 'success' && result.userInfo && result.identity) {
            const credential: ServerCredential = {
                serverUrl,
                userId: result.userInfo.userId,
                userEmail: result.userInfo.userEmail,
                identity: result.identity,
            };
            await credentialManager.storeCredential(credential);
            await vscode.workspace.getConfiguration('localleaf').update(
                'defaultServer', serverUrl, vscode.ConfigurationTarget.Global
            );
            await setAuthState('valid');
            vscode.window.showInformationMessage(`LocalLeaf: Logged in as ${result.userInfo.userEmail}`);
        } else {
            vscode.window.showErrorMessage(`LocalLeaf: Login failed - ${result.message}`);
        }
    } else {
        // For self-hosted, use email/password
        const email = await vscode.window.showInputBox({
            prompt: 'Enter your email',
            placeHolder: 'email@example.com',
        });

        if (!email) return;

        const password = await vscode.window.showInputBox({
            prompt: 'Enter your password',
            password: true,
        });

        if (!password) return;

        const api = new BaseAPI(serverUrl);
        const result = await api.passportLogin(email, password);

        if (result.type === 'success' && result.userInfo && result.identity) {
            const credential: ServerCredential = {
                serverUrl,
                userId: result.userInfo.userId,
                userEmail: result.userInfo.userEmail,
                identity: result.identity,
            };
            await credentialManager.storeCredential(credential);
            await vscode.workspace.getConfiguration('localleaf').update(
                'defaultServer', serverUrl, vscode.ConfigurationTarget.Global
            );
            await setAuthState('valid');
            vscode.window.showInformationMessage(`LocalLeaf: Logged in as ${result.userInfo.userEmail}`);
        } else {
            vscode.window.showErrorMessage(`LocalLeaf: Login failed - ${result.message}`);
        }
    }
}

/**
 * Logout from Overleaf
 */
async function cmdLogout() {
    const confirm = await vscode.window.showWarningMessage(
        'Are you sure you want to logout from Overleaf?',
        'Logout',
        'Cancel'
    );

    if (confirm !== 'Logout') return;

    const settingsManager = SettingsManager.getCurrentInstance();
    if (settingsManager && await settingsManager.isLinked() && !settingsManager.getSettings()) {
        await settingsManager.load();
    }
    const serverUrl = settingsManager?.getSettings()?.serverUrl || credentialManager.getDefaultServer();
    await credentialManager.deleteCredential(serverUrl);

    // Disconnect sync engine but keep settings
    if (syncEngine) {
        syncEngine.disconnect();
        syncEngine = undefined;
    }

    if (cursorTracker) {
        cursorTracker.dispose();
        cursorTracker = undefined;
    }

    stopStatusUpdates();
    updateStatusBar('disconnected', 'Logged out');
    await setAuthState('none');
    vscode.window.showInformationMessage('LocalLeaf: Logged out');
}

/**
 * Link current folder to an Overleaf project
 */
async function cmdLinkFolder(context: vscode.ExtensionContext, requestedProject?: ProjectInfo) {
    if (!linkOperationGate.tryEnter()) {
        vscode.window.showInformationMessage('LocalLeaf: A project link is already in progress');
        return;
    }

    try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('LocalLeaf: No workspace folder open');
            return;
        }

        const settingsManager = SettingsManager.getInstance(workspaceFolder);
        if (await settingsManager.isLinked()) {
            vscode.window.showWarningMessage(
                'LocalLeaf: This folder is already linked. Unlink it before choosing another project.'
            );
            return;
        }

        // Get server URL
        const serverUrl = credentialManager.getDefaultServer();

        // Check if logged in
        const credential = await credentialManager.getCredential(serverUrl);
        if (!credential) {
            vscode.window.showWarningMessage('LocalLeaf: Please login first');
            await cmdLogin();
            return;
        }

        let project = requestedProject;
        if (!project) {
            const api = new BaseAPI(serverUrl);
            api.setIdentity(credential.identity);

            const projectsResult = await api.getProjects();
            if (projectsResult.type !== 'success' || !projectsResult.projects) {
                vscode.window.showErrorMessage(`LocalLeaf: Failed to get projects - ${projectsResult.message}`);
                return;
            }

            const activeProjects = projectsResult.projects.filter(p => !p.archived && !p.trashed);
            const items = activeProjects.map(p => ({
                label: p.name,
                description: `${p.accessLevel}${p.lastUpdated ? ` - ${new Date(p.lastUpdated).toLocaleDateString()}` : ''}`,
                project: p,
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select an Overleaf project to link',
            });
            if (!selected) return;
            project = selected.project;
        }

        const workspaceEntries = await vscode.workspace.fs.readDirectory(workspaceFolder);
        if (shouldConfirmProjectLink(workspaceEntries.map(([name]) => name))) {
            const confirmation = await vscode.window.showWarningMessage(
                `Link this folder to "${project.name}"?`,
                {
                    modal: true,
                    detail: 'LocalLeaf will compare the existing files with Overleaf and ask before resolving conflicts.',
                },
                'Link and Synchronize',
            );
            if (confirmation !== 'Link and Synchronize') return;
        }

        // Create settings
        const settings = SettingsManager.createDefaultSettings(serverUrl, project.id, project.name);
        await settingsManager.save(settings);

        // Create default .leafignore
        const ignoreParser = new IgnoreParser(workspaceFolder);
        if (!(await ignoreParser.exists())) {
            await ignoreParser.createDefault();
        }

        vscode.window.showInformationMessage(`LocalLeaf: Linked to "${project.name}"`);

        // Show status bars now that we're linked
        await vscode.commands.executeCommand('setContext', 'localleaf.isLinked', true);
        statusBarItem.show();
        await updateLoginStatus();
        await mainWebviewProvider.refresh();

        // Initialize sync (this will auto-pull)
        await initializeSync(context, settingsManager);
        await refreshGui();
    } finally {
        linkOperationGate.leave();
    }
}

/**
 * Unlink current folder
 */
async function cmdUnlinkFolder(confirmation?: object) {
    const settingsManager = SettingsManager.getCurrentInstance();
    if (!settingsManager || !(await settingsManager.isLinked())) {
        vscode.window.showInformationMessage('LocalLeaf: This folder is not linked');
        return;
    }

    if (confirmation !== panelConfirmation) {
        const confirm = await vscode.window.showWarningMessage(
            'Are you sure you want to unlink this folder from Overleaf?',
            { modal: true },
            'Unlink'
        );

        if (confirm !== 'Unlink') return;
    }

    // Disconnect
    if (syncEngine) {
        syncEngine.disconnect();
        syncEngine = undefined;
    }

    if (cursorTracker) {
        cursorTracker.dispose();
        cursorTracker = undefined;
    }

    // Delete settings
    await settingsManager.delete();

    stopStatusUpdates();
    mainWebviewProvider.setOnlineUsers([]);
    await vscode.commands.executeCommand('setContext', 'localleaf.isLinked', false);
    statusBarItem.hide();
    collaboratorStatusItem.hide();
    await updateLoginStatus();
    await refreshGui();
    vscode.window.showInformationMessage('LocalLeaf: Folder unlinked');
}

/**
 * Sync now (bidirectional)
 */
async function cmdSyncNow() {
    if (!syncEngine) {
        vscode.window.showWarningMessage('LocalLeaf: Not connected. Please link a folder first.');
        return;
    }

    // For now, just pull
    await cmdPullFromOverleaf();
}

/**
 * Pull from Overleaf
 */
async function cmdPullFromOverleaf() {
    if (!syncEngine) {
        vscode.window.showWarningMessage('LocalLeaf: Not connected. Please link a folder first.');
        return;
    }

    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'LocalLeaf: Pulling from Overleaf...',
            cancellable: false,
        }, async () => {
            await syncEngine!.pullAll();
        });
        vscode.window.showInformationMessage('LocalLeaf: Pull complete');
    } catch (error) {
        vscode.window.showErrorMessage(`LocalLeaf: Pull failed - ${error}`);
    }
}

/**
 * Push to Overleaf
 */
async function cmdPushToOverleaf() {
    if (!syncEngine) {
        vscode.window.showWarningMessage('LocalLeaf: Not connected. Please link a folder first.');
        return;
    }

    vscode.window.showInformationMessage('LocalLeaf: Push is automatic via real-time sync');
}

/**
 * Edit ignore patterns
 */
async function cmdEditIgnorePatterns() {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('LocalLeaf: No workspace folder open');
        return;
    }

    const ignoreFile = vscode.Uri.joinPath(workspaceFolder, IGNORE_FILE);

    // Create default if doesn't exist
    const ignoreParser = new IgnoreParser(workspaceFolder);
    if (!(await ignoreParser.exists())) {
        await ignoreParser.createDefault();
    }

    await vscode.window.showTextDocument(ignoreFile);
}

/**
 * Remove stale remote files only after they match the current .leafignore
 * rules and the user explicitly confirms the operation.
 */
async function cmdCleanIgnoredRemoteFiles(confirmation?: object) {
    if (!syncEngine) {
        vscode.window.showWarningMessage('LocalLeaf: Not connected. Please link a folder first.');
        return;
    }

    try {
        const paths = await syncEngine.getIgnoredRemoteFiles();
        if (paths.length === 0) {
            vscode.window.showInformationMessage('LocalLeaf: No ignored files exist on Overleaf.');
            return;
        }

        const visiblePaths = paths.slice(0, 12);
        const remaining = paths.length - visiblePaths.length;
        const preview = visiblePaths.join('\n') +
            (remaining > 0 ? `\n... and ${remaining} more` : '');
        if (confirmation !== panelConfirmation) {
            const choice = await vscode.window.showWarningMessage(
                `Delete ${paths.length} ignored file(s) from Overleaf?\n\n${preview}`,
                { modal: true },
                'Delete Ignored Files'
            );
            if (choice !== 'Delete Ignored Files') {
                return;
            }
        }

        const result = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'LocalLeaf: Cleaning ignored files from Overleaf...',
            cancellable: false,
        }, () => syncEngine!.deleteIgnoredRemoteFiles(paths));

        if (result.failed.length > 0) {
            const failedPreview = result.failed
                .slice(0, 5)
                .map(item => item.path)
                .join(', ');
            vscode.window.showWarningMessage(
                `LocalLeaf: Deleted ${result.deleted} ignored file(s); ` +
                `${result.failed.length} failed: ${failedPreview}`
            );
        } else {
            vscode.window.showInformationMessage(
                `LocalLeaf: Deleted ${result.deleted} ignored file(s) from Overleaf.`
            );
        }
    } catch (error) {
        vscode.window.showErrorMessage(`LocalLeaf: Cleanup failed - ${errorMessage(error)}`);
    }
}

/**
 * Show sync status
 */
async function cmdShowSyncStatus() {
    const settingsManager = SettingsManager.getCurrentInstance();
    const settings = settingsManager?.getSettings();

    const items: vscode.QuickPickItem[] = [];
    const currentStatus = syncEngine?.status || 'disconnected';

    if (settings) {
        items.push({
            label: '$(project) Project',
            description: settings.projectName,
            detail: settings.projectId,
        });
        items.push({
            label: '$(globe) Server',
            description: settings.serverUrl,
        });
        items.push({
            label: '$(sync) Status',
            description: currentStatus,
        });
        if (cursorTracker) {
            items.push({
                label: '$(organization) Collaborators',
                description: `${cursorTracker.getUserCount()} online`,
            });
        }
        if (settings.lastSynced) {
            items.push({
                label: '$(clock) Last Synced',
                description: new Date(settings.lastSynced).toLocaleString(),
            });
        }
    } else {
        items.push({
            label: '$(info) Not linked',
            description: 'Use "LocalLeaf: Link Folder" to connect to Overleaf',
        });
    }

    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });

    // Show resync option when there's an error or when connected
    if (settings && (currentStatus === 'error' || currentStatus === 'idle')) {
        items.push({
            label: '$(sync) Resync with Overleaf',
            description: currentStatus === 'error' ? 'Retry after error' : 'Pull latest changes',
        });
    }

    // Show reconnect option when disconnected
    if (settings && currentStatus === 'disconnected') {
        items.push({
            label: '$(debug-disconnect) Reconnect',
            description: 'Reconnect to Overleaf',
        });
    }

    // Show refresh cookie option when auth is expired
    if (settings && authState === 'expired') {
        items.push({
            label: '$(key) Refresh Cookie',
            description: 'Session expired - click to enter new cookie',
        });
    }

    // Show verify credentials option when connected
    if (settings && authState !== 'expired') {
        items.push({
            label: '$(shield) Verify Credentials',
            description: 'Check if your session is still valid',
        });
    }

    if (cursorTracker && cursorTracker.getUserCount() > 0) {
        items.push({
            label: '$(person) Jump to collaborator...',
            description: '',
        });
    }

    if (settings) {
        items.push({
            label: '$(link-external) Unlink folder',
            description: 'Disconnect from Overleaf project',
        });
    }

    const selected = await vscode.window.showQuickPick(items, {
        title: 'LocalLeaf Status',
    });

    if (selected?.label.includes('Resync')) {
        await cmdPullFromOverleaf();
    } else if (selected?.label.includes('Reconnect')) {
        await cmdReconnect();
    } else if (selected?.label.includes('Refresh Cookie')) {
        await cmdRefreshCookie();
    } else if (selected?.label.includes('Verify Credentials')) {
        await cmdVerifyCredentials();
    } else if (selected?.label.includes('Jump to collaborator')) {
        await cursorTracker?.jumpToUser();
    } else if (selected?.label.includes('Unlink folder')) {
        await cmdUnlinkFolder();
    }
}

/**
 * Reconnect to Overleaf (after disconnect or error)
 */
async function cmdReconnect() {
    const settingsManager = SettingsManager.getCurrentInstance();
    if (!settingsManager || !(await settingsManager.isLinked())) {
        vscode.window.showWarningMessage('LocalLeaf: No linked project');
        return;
    }

    // Disconnect existing sync engine
    if (syncEngine) {
        syncEngine.disconnect();
        syncEngine = undefined;
    }

    if (cursorTracker) {
        cursorTracker.dispose();
        cursorTracker = undefined;
    }

    stopStatusUpdates();

    const projectSettings = settingsManager.getSettings();
    if (!projectSettings) return;

    const credential = await credentialManager.getCredential(projectSettings.serverUrl);
    if (!credential) {
        updateStatusBar('disconnected', 'Not logged in');
        vscode.window.showWarningMessage('LocalLeaf: Please login to Overleaf first');
        return;
    }

    const api = new BaseAPI(projectSettings.serverUrl);
    api.setIdentity(credential.identity);

    syncEngine = new SyncEngine(api, settingsManager);

    syncEngine.onStatusChange(async event => {
        updateStatusBar(event.status, event.message);
        // Handle auth errors
        if (event.authError) {
            await setAuthState('expired');
            showSessionExpiredNotification();
        }
    });

    try {
        updateStatusBar('connecting', 'Reconnecting...');
        await syncEngine.connect();

        const socket = syncEngine.getSocket();
        if (socket) {
            cursorTracker = new CursorTracker(socket, settingsManager);
            await cursorTracker.initialize();
        }

        startStatusUpdates();
        log('Reconnected to Overleaf');

        await syncEngine.pullAll();
        vscode.window.showInformationMessage(`LocalLeaf: Reconnected to "${projectSettings.projectName}"`);
    } catch (error) {
        log(`Failed to reconnect: ${error}`);
        vscode.window.showErrorMessage(`LocalLeaf: Failed to reconnect - ${error}`);
    }
}

/**
 * Set main document
 */
async function cmdSetMainDocument() {
    const settingsManager = SettingsManager.getCurrentInstance();
    if (!settingsManager || !(await settingsManager.isLinked())) {
        vscode.window.showErrorMessage('LocalLeaf: No linked project');
        return;
    }

    const mainTex = await vscode.window.showInputBox({
        prompt: 'Enter main TeX file name',
        value: settingsManager.getSettings()?.mainTex || '',
        placeHolder: 'path/to/document.tex',
    });

    if (!mainTex) return;

    const mainPdf = mainTex.replace(/\.tex$/, '.pdf');

    await settingsManager.update({ mainTex, mainPdf });
    await mainWebviewProvider.refresh();
    vscode.window.showInformationMessage(`LocalLeaf: Main document set to ${mainTex}`);
}

/**
 * Configure settings
 */
async function cmdConfigure() {
    const settingsManager = SettingsManager.getCurrentInstance();
    if (!settingsManager || !(await settingsManager.isLinked())) {
        vscode.window.showInformationMessage('LocalLeaf: No linked project');
        return;
    }

    const workspaceFolder = settingsManager.getWorkspaceFolder();
    const settingsFile = vscode.Uri.joinPath(workspaceFolder, CONFIG_DIR, 'settings.json');
    await vscode.window.showTextDocument(settingsFile);
}

/**
 * Jump to collaborator cursor
 */
async function cmdJumpToCollaborator(clientId?: string) {
    if (!cursorTracker) {
        vscode.window.showWarningMessage('LocalLeaf: Not connected');
        return;
    }

    await cursorTracker.jumpToUser(clientId);
}

/**
 * Verify credentials are still valid
 */
async function cmdVerifyCredentials() {
    const settingsManager = SettingsManager.getCurrentInstance();
    if (!settingsManager || !(await settingsManager.isLinked())) {
        vscode.window.showInformationMessage('LocalLeaf: No linked project');
        return;
    }

    const projectSettings = settingsManager.getSettings();
    if (!projectSettings) return;

    const credential = await credentialManager.getCredential(projectSettings.serverUrl);
    if (!credential) {
        await setAuthState('none');
        vscode.window.showWarningMessage('LocalLeaf: Not logged in');
        return;
    }

    const api = new BaseAPI(projectSettings.serverUrl);
    api.setIdentity(credential.identity);

    const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'LocalLeaf: Verifying credentials...',
    }, async () => {
        return api.verifyCredentials();
    });

    if (result.type === 'success') {
        await setAuthState('valid');
        vscode.window.showInformationMessage('LocalLeaf: Credentials are valid');
    } else {
        await setAuthState('expired');
        showSessionExpiredNotification();
    }
}

/**
 * Refresh cookie (re-login without clearing stored info)
 */
async function cmdRefreshCookie() {
    const settingsManager = SettingsManager.getCurrentInstance();
    if (!settingsManager || !(await settingsManager.isLinked())) {
        vscode.window.showWarningMessage('LocalLeaf: No linked project');
        return;
    }

    const projectSettings = settingsManager.getSettings();
    if (!projectSettings) return;

    const serverUrl = projectSettings.serverUrl;

    // Get existing credential to show user info
    const existingCredential = await credentialManager.getCredential(serverUrl);
    const userInfo = existingCredential
        ? `Refreshing session for ${existingCredential.userEmail}`
        : 'Enter your Overleaf cookie';

    // Show help option
    const helpChoice = await vscode.window.showInformationMessage(
        userInfo,
        'How to get cookies?',
        'Continue'
    );

    if (!helpChoice) return;

    if (helpChoice === 'How to get cookies?') {
        await vscode.env.openExternal(vscode.Uri.parse(
            'https://github.com/overleaf-workshop/Overleaf-Workshop/blob/master/docs/wiki.md#login-with-cookies'
        ));
    }

    const cookies = await vscode.window.showInputBox({
        prompt: 'Paste your fresh Overleaf cookie',
        placeHolder: 'overleaf_session2=...',
        password: true,
    });

    if (!cookies) return;

    const api = new BaseAPI(serverUrl);
    const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'LocalLeaf: Validating cookie...',
    }, async () => {
        return api.cookiesLogin(cookies);
    });

    if (result.type === 'success' && result.userInfo && result.identity) {
        const credential: ServerCredential = {
            serverUrl,
            userId: result.userInfo.userId,
            userEmail: result.userInfo.userEmail,
            identity: result.identity,
        };
        await credentialManager.storeCredential(credential);
        await setAuthState('valid');

        vscode.window.showInformationMessage(
            `LocalLeaf: Session refreshed for ${result.userInfo.userEmail}`
        );

        // Attempt to reconnect sync engine
        await cmdReconnect();
    } else {
        vscode.window.showErrorMessage(`LocalLeaf: Cookie validation failed - ${result.message}`);
    }
}

/**
 * Extension deactivation
 */
export function deactivate() {
    stopStatusUpdates();

    if (syncEngine) {
        syncEngine.disconnect();
    }
    if (cursorTracker) {
        cursorTracker.dispose();
    }
}
