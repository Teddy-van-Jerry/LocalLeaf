/**
 * LocalLeaf VS Code Extension
 * Local sync for Overleaf LaTeX projects
 */

import * as vscode from 'vscode';
import { COMMANDS, EXTENSION_NAME, STATUS_BAR_PRIORITY, CONFIG_DIR, IGNORE_FILE } from './consts';
import { CredentialManager, ServerCredential, Identity } from './utils/credentialManager';
import { SettingsManager, createSettingsWatcher } from './utils/settingsManager';
import { BaseAPI, ProjectInfo } from './api/base';
import { SyncEngine, SyncEngineUi, SyncStatus } from './sync/syncEngine';
import { IgnoreParser } from './sync/ignoreParser';
import { PendingChange, SyncMode } from './sync/changeTracker';
import { CursorTracker, TrackedUser, getInitials } from './collaboration/cursorTracker';
import { setOutputChannel } from './api/socketio';
import { ChangesWebviewProvider } from './views/changesWebviewProvider';
import { cleanChangePath, createChangeDiffPlan, DiffSide, getChangePathCandidates } from './views/changeDiffPlan';
import { ProjectsWebviewProvider, ProjectSortField } from './views/projectsWebviewProvider';
import { PanelNotificationCenter, PanelNoticeType, PanelModalRequest } from './views/panelNotificationCenter';
import { LatexCompiler, CompilerType, CompilationResult } from './compilation/latexCompiler';
import * as path from 'path';
import { AutoCompiler } from './compilation/autoCompiler';
import { PdfPreviewPanel } from './views/pdfPreviewPanel';
import { BrowserPreference, captureCookiesViaBrowserLogin } from './auth/browserCookieLogin';
import { AccountPanel, AccountPanelAction, AccountPanelState } from './views/accountPanel';
import { LocalLeafScmBridge } from './scm/localLeafScmBridge';
import { GitCommitHook } from './integrations/gitCommitHook';
import {
    getManualPushPlan,
    getManualSyncCompletionState,
    shouldAutoPullOnProjectLoad,
    shouldPushAfterManualPull,
} from './sync/syncPolicy';
import { SyncOperationGate } from './sync/syncOperationGate';

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
let panelNotifications: PanelNotificationCenter;
let projectsWebviewProvider: ProjectsWebviewProvider;
let changesWebviewProvider: ChangesWebviewProvider;
let latexCompiler: LatexCompiler | undefined;
let autoCompiler: AutoCompiler | undefined;
let extensionContext: vscode.ExtensionContext;
let scmBridge: LocalLeafScmBridge;
let gitCommitHook: GitCommitHook | undefined;
let settingsWatcher: vscode.FileSystemWatcher | undefined;
let syncOperationGate: SyncOperationGate;

/**
 * Extension activation
 */
export async function activate(context: vscode.ExtensionContext) {
    try {

    extensionContext = context;

    // Initialize output channel
    outputChannel = vscode.window.createOutputChannel(EXTENSION_NAME);
    context.subscriptions.push(outputChannel);

    // Share output channel with socketio module for logging
    setOutputChannel(outputChannel);

    // Initialize credential manager
    credentialManager = CredentialManager.initialize(context);

    panelNotifications = new PanelNotificationCenter();

    // Initialize sidebar providers
    projectsWebviewProvider = new ProjectsWebviewProvider(context.extensionUri, credentialManager, panelNotifications);
    changesWebviewProvider = new ChangesWebviewProvider(context.extensionUri, panelNotifications, credentialManager);
    PdfPreviewPanel.setNotificationHandler(message => showPanelNotice(message, 'warning'));

    // Projects view is now a webview
    const projectsViewDisposable = vscode.window.registerWebviewViewProvider(
        ProjectsWebviewProvider.viewType,
        projectsWebviewProvider,
        { webviewOptions: { retainContextWhenHidden: true } },
    );
    const mainViewDisposable = vscode.window.registerWebviewViewProvider(
        ChangesWebviewProvider.viewType,
        changesWebviewProvider,
        { webviewOptions: { retainContextWhenHidden: true } },
    );
    context.subscriptions.push(projectsViewDisposable, mainViewDisposable);

    // Set context for viewsWelcome / toolbar conditionals
    const serverUrl = credentialManager.getDefaultServer();
    const hasCredential = !!(await credentialManager.getCredential(serverUrl));
    await vscode.commands.executeCommand('setContext', 'localleaf.loggedIn', hasCredential);

    const initSettingsManager = await SettingsManager.resolveCurrentInstance();
    const isInitLinked = initSettingsManager && await initSettingsManager.isLinked();
    await vscode.commands.executeCommand('setContext', 'localleaf.isLinked', !!isInitLinked);
    await vscode.commands.executeCommand('setContext', 'localleaf.scmActive', false);
    await vscode.commands.executeCommand('setContext', 'localleaf.gitCommitAutoPushEnabled', false);

    // Initialize SCM bridge and Git commit hook integration
    scmBridge = new LocalLeafScmBridge();
    syncOperationGate = new SyncOperationGate();
    gitCommitHook = new GitCommitHook(runCommitTriggeredOverleafPush, log);
    context.subscriptions.push(scmBridge, gitCommitHook);

    // Create status bar items
    // Sync status (left side)
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, STATUS_BAR_PRIORITY);
    statusBarItem.name = `${EXTENSION_NAME} Sync`;
    context.subscriptions.push(statusBarItem);

    // Login status (left side, before sync)
    loginStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, STATUS_BAR_PRIORITY + 1);
    loginStatusItem.name = `${EXTENSION_NAME} Login`;
    loginStatusItem.command = COMMANDS.SHOW_ACCOUNT_PANEL;
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

    // Watch for git-commit auto-push setting changes
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async event => {
        if (event.affectsConfiguration('localleaf.gitCommitAutoPush')) {
            await refreshScmAndHookState();
        }
    }));

    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(async () => {
        await refreshWorkspaceProjectState(context);
    }));

    // Check if current workspace is linked
    const settingsManager = initSettingsManager ?? await SettingsManager.resolveCurrentInstance();
    if (settingsManager && await settingsManager.isLinked()) {
        await settingsManager.load();
        // Show status bar only when linked
        statusBarItem.show();
        await initializeSync(context, settingsManager);
    } else {
        // Hide sync status bar when not linked
        statusBarItem.hide();
        collaboratorStatusItem.hide();
    }

    await refreshScmAndHookState();

    // Watch for settings changes
    updateSettingsWatcher(context, settingsManager);

    log('LocalLeaf activated');

    } catch (error) {
        console.error('[LocalLeaf] Activation error:', error);
        showPanelNotice(`LocalLeaf failed to activate: ${error}`, 'error');
    }
}

/**
 * Register all commands
 */
function registerCommands(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.LOGIN, cmdLogin),
        vscode.commands.registerCommand(COMMANDS.LOGOUT, cmdLogout),
        vscode.commands.registerCommand(COMMANDS.SHOW_ACCOUNT_PANEL, cmdShowAccountPanel),
        vscode.commands.registerCommand(COMMANDS.LINK_FOLDER, () => cmdLinkFolder(context)),
        vscode.commands.registerCommand(COMMANDS.UNLINK_FOLDER, cmdUnlinkFolder),
        vscode.commands.registerCommand(COMMANDS.SYNC_NOW, cmdSyncNow),
        vscode.commands.registerCommand(COMMANDS.PULL_FROM_OVERLEAF, cmdPullFromOverleaf),
        vscode.commands.registerCommand(COMMANDS.PUSH_TO_OVERLEAF, cmdPushToOverleaf),
        vscode.commands.registerCommand(COMMANDS.EDIT_IGNORE_PATTERNS, cmdEditIgnorePatterns),
        vscode.commands.registerCommand(COMMANDS.SHOW_SYNC_STATUS, cmdShowSyncStatus),
        vscode.commands.registerCommand(COMMANDS.SET_MAIN_DOCUMENT, cmdSetMainDocument),
        vscode.commands.registerCommand(COMMANDS.CONFIGURE, cmdConfigure),
        vscode.commands.registerCommand(COMMANDS.JUMP_TO_COLLABORATOR, cmdJumpToCollaborator),
        vscode.commands.registerCommand(COMMANDS.VERIFY_CREDENTIALS, cmdVerifyCredentials),
        vscode.commands.registerCommand(COMMANDS.REFRESH_COOKIE, cmdRefreshCookie),
        vscode.commands.registerCommand(COMMANDS.OPEN_PROJECT, (project: ProjectInfo) => cmdOpenProject(context, project)),
        vscode.commands.registerCommand(COMMANDS.OPEN_LOCAL_PROJECT, (workspaceUri: string) => cmdOpenLocalProject(context, workspaceUri)),
        vscode.commands.registerCommand(COMMANDS.REMOVE_COMMENTS, cmdRemoveComments),
        // Sync mode
        vscode.commands.registerCommand(COMMANDS.TOGGLE_SYNC_MODE, cmdToggleSyncMode),
        // Project sorting & filtering
        vscode.commands.registerCommand(COMMANDS.FILTER_PROJECTS, cmdFilterProjects),
        vscode.commands.registerCommand(COMMANDS.SORT_PROJECTS_BY_NAME, () => cmdSortProjects('name')),
        vscode.commands.registerCommand(COMMANDS.SORT_PROJECTS_BY_DATE, () => cmdSortProjects('lastUpdated')),
        vscode.commands.registerCommand(COMMANDS.SORT_PROJECTS_BY_ACCESS, () => cmdSortProjects('accessLevel')),
        // Compilation & PDF preview
        vscode.commands.registerCommand(COMMANDS.COMPILE_LATEX, cmdCompileLaTeX),
        vscode.commands.registerCommand(COMMANDS.SHOW_PDF_PREVIEW, cmdShowPdfPreview),
        vscode.commands.registerCommand(COMMANDS.SELECT_COMPILER, cmdSelectCompiler),
        vscode.commands.registerCommand(COMMANDS.TOGGLE_AUTO_COMPILE, cmdToggleAutoCompile),
        vscode.commands.registerCommand(COMMANDS.CANCEL_COMPILATION, cmdCancelCompilation),
        // Changes view context actions
        vscode.commands.registerCommand(COMMANDS.VIEW_DIFF, (path: string) => cmdViewDiff(path)),
        vscode.commands.registerCommand(COMMANDS.DISCARD_CHANGE, (path: string) => cmdDiscardChange(path)),
        vscode.commands.registerCommand(COMMANDS.RESOLVE_CONFLICT_REMOTE, (path: string) => cmdResolveConflict(path, 'remote')),
        vscode.commands.registerCommand(COMMANDS.RESOLVE_CONFLICT_LOCAL, (path: string) => cmdResolveConflict(path, 'local')),
        vscode.commands.registerCommand(COMMANDS.DISCARD_ALL_LOCAL_CHANGES, (paths?: string[]) => cmdDiscardAllLocalChanges(paths)),
    );
}

interface NoticeToken {
    id: string;
    revision?: number;
}

function panelUi(): SyncEngineUi {
    return {
        showModal: request => showPanelModal(request),
        showNotice: (message, type, autoDismissMs) => showPanelNotice(message, type, autoDismissMs),
    };
}

async function focusNotificationPanel(): Promise<void> {
    let isLinked = false;
    try {
        const settingsManager = SettingsManager.getCurrentInstance();
        isLinked = !!settingsManager && await settingsManager.isLinked();
    } catch {
        isLinked = false;
    }

    const command = isLinked ? `${ChangesWebviewProvider.viewType}.focus` : `${ProjectsWebviewProvider.viewType}.focus`;
    await vscode.commands.executeCommand(command).then(undefined, () => undefined);
}

async function showPanelModal(request: PanelModalRequest): Promise<string> {
    if (!panelNotifications) {
        return 'dismiss';
    }
    await focusNotificationPanel();
    return panelNotifications.showModal(request);
}

function showPanelNotice(
    message: string,
    type: PanelNoticeType = 'info',
    _autoDismissMs?: number,
    options?: { reveal?: boolean },
): NoticeToken | undefined {
    if (!panelNotifications) {
        return undefined;
    }
    if (options?.reveal ?? type !== 'info') {
        void focusNotificationPanel();
    }

    const id = panelNotifications.showNotice(message, type);
    const revision = panelNotifications.getState().notice?.revision;
    return { id, revision };
}

function dismissPanelNotice(token: NoticeToken | undefined): void {
    if (!token || !panelNotifications) {
        return;
    }
    panelNotifications.dismissNotice(token.id, token.revision);
}

async function withPanelProgress<T>(message: string, task: () => Promise<T>): Promise<T> {
    const token = showPanelNotice(message, 'info', undefined, { reveal: false });
    try {
        return await task();
    } finally {
        dismissPanelNotice(token);
    }
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
        await refreshScmAndHookState();
        showPanelNotice('LocalLeaf: Please login to Overleaf first', 'warning');
        return;
    }

    // Create API
    const api = new BaseAPI(projectSettings.serverUrl);
    api.setIdentity(credential.identity);

    // Create sync engine
    syncEngine = new SyncEngine(api, settings, log, panelUi());

    // Listen to status changes
    syncEngine.onStatusChange(async event => {
        updateStatusBar(event.status, event.message);
        await refreshScmAndHookState();
        // Handle auth errors
        if (event.authError) {
            await setAuthState('expired');
            showSessionExpiredNotification();
        }
    });

    // Wire up change tracker to changes view
    changesWebviewProvider.setChangeTracker(syncEngine.changeTracker);

    // Read sync mode from settings and apply
    const syncMode: SyncMode = projectSettings.syncMode === 'realtime' ? 'realtime' : 'manual';
    changesWebviewProvider.setSyncMode(syncMode);
    await vscode.commands.executeCommand('setContext', 'localleaf.syncMode', syncMode);
    updateSyncModeStatusBar(syncMode);
    await refreshScmAndHookState();

    // Connect
    try {
        await syncEngine.connect();

        // Initialize cursor tracker
        const socket = syncEngine.getSocket();
        if (socket) {
            cursorTracker = new CursorTracker(socket, settings, panelUi());
            await cursorTracker.initialize();
            cursorTracker.onDidChangeUsers(() => pushOnlineUsersToWebview());
            pushOnlineUsersToWebview();
            context.subscriptions.push({ dispose: () => cursorTracker?.dispose() });
        }

        // Start periodic status updates for collaborators
        startStatusUpdates();

        log('Sync engine connected');

        // Auto-detect main document from project settings
        await syncEngine.detectMainDocument();

        // On project load: pull only for never-synced projects or realtime catch-up.
        try {
            const hasBaseContent = syncEngine.hasBaseContent();
            const restoredLocalCount = syncMode === 'manual'
                ? await syncEngine.refreshLocalChangesFromDisk()
                : 0;
            if (syncMode === 'manual') {
                changesWebviewProvider.refresh();
            }
            const shouldAutoPull = shouldAutoPullOnProjectLoad({
                syncMode,
                hasBaseContent,
                lastSynced: projectSettings.lastSynced,
            });
            if (shouldAutoPull && !(syncMode === 'manual' && restoredLocalCount > 0)) {
                const isFirstSync = !hasBaseContent && !projectSettings.lastSynced;
                log(isFirstSync
                    ? 'First sync — downloading project files...'
                    : 'Auto-pulling files from Overleaf (realtime mode)...');
                void syncEngine.pullAll()
                    .then(() => {
                        log('Auto-pull complete');
                        changesWebviewProvider.showNotice('Auto-pull complete', 'info', 4000);
                    })
                    .catch(error => {
                        log(`Startup auto-pull failed: ${error}`);
                        changesWebviewProvider.showNotice(`Startup auto-pull failed: ${error}`, 'error');
                    });
            } else {
                log(syncMode === 'manual' && restoredLocalCount > 0
                    ? 'Manual mode — restored pending local changes; skipping auto-pull'
                    : 'Manual mode — skipping auto-pull (use Pull to sync)');
            }

            // Join all docs to receive real-time OT updates (both modes need this for change tracking)
            await syncEngine.joinAllDocsForWatching();
            log('Watching for remote changes');

            log(`Connected to "${projectSettings.projectName}"`);
        } catch (pullError) {
            log(`Startup sync failed: ${pullError}`);
        }

        // Initialize LaTeX compiler
        latexCompiler = new LatexCompiler();
        context.subscriptions.push(latexCompiler);

        autoCompiler = new AutoCompiler(latexCompiler);
        context.subscriptions.push(autoCompiler);

        // Auto-compile on save (always enabled — use setting to opt out)
        {
            const mainTex = projectSettings.mainTex || 'main.tex';
            const delay = vscode.workspace.getConfiguration('localleaf').get<number>('compileDelay', 1500);
            const compileOnSave = vscode.workspace.getConfiguration('localleaf').get<boolean>('compileOnSave', true);
            if (compileOnSave) {
                autoCompiler.enable(settings.getWorkspaceFolder(), mainTex, delay);
                autoCompiler.onWillCompile(() => handleCompilationStarted());
                autoCompiler.onDidCompile(result => handleCompilationResult(result));
            }
        }

        // Auto-compile and open PDF preview on project load
        const mainTex = projectSettings.mainTex || 'main.tex';
        let compiler: CompilerType | undefined;
        if (projectSettings.compiler && projectSettings.compiler !== 'auto') {
            compiler = projectSettings.compiler as CompilerType;
        }
        const workspaceFolder = settings.getWorkspaceFolder();
        log('Auto-compiling on project load...');
        latexCompiler.compile(workspaceFolder.fsPath, mainTex, compiler).then(result => {
            if (result.success && result.pdfPath) {
                log(`Auto-compile succeeded (${result.duration}ms), opening PDF preview`);
                PdfPreviewPanel.createOrShow(context.extensionUri, result.pdfPath, workspaceFolder.fsPath);
            } else {
                log(`Auto-compile failed: ${result.errors.map(e => e.message).join('; ')}`);
            }
        });
    } catch (error) {
        log(`Failed to connect: ${error}`);
        await refreshScmAndHookState();
        showPanelNotice(`LocalLeaf: Failed to connect - ${error}`, 'error');
    }
}

/**
 * Update sync status bar
 */
function updateStatusBar(status: SyncStatus, message?: string) {
    if (changesWebviewProvider) {
        const settingsManager = SettingsManager.getCurrentInstance();
        const lastSynced = settingsManager?.getSettings()?.lastSynced;
        changesWebviewProvider.setSyncStatus(status, lastSynced);
    }

    const icons: Record<SyncStatus, string> = {
        idle: '$(cloud)',
        syncing: '$(sync~spin)',
        pulling: '$(cloud-download)',
        pushing: '$(cloud-upload)',
        error: '$(warning)',
        disconnected: '$(cloud-offline)',
    };

    const modeLabel = syncEngine?.syncMode === 'realtime' ? 'Live' : 'Manual';
    statusBarItem.text = `${icons[status]} LocalLeaf [${modeLabel}]`;
    statusBarItem.tooltip = new vscode.MarkdownString(`**LocalLeaf** [${modeLabel}] - ${message || status}`);
    statusBarItem.command = COMMANDS.SHOW_SYNC_STATUS;

    if (status === 'error') {
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (status === 'disconnected') {
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
        statusBarItem.backgroundColor = undefined;
    }

    statusBarItem.show();

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
            `Server: ${credential.serverUrl}\n\n` +
            `Click to open account panel`
        );
        loginStatusItem.backgroundColor = undefined;
        loginStatusItem.command = COMMANDS.SHOW_ACCOUNT_PANEL;
    } else if (credential && authState === 'expired') {
        // Session expired - show warning state
        loginStatusItem.text = `$(warning) ${credential.userEmail} (expired)`;
        loginStatusItem.tooltip = new vscode.MarkdownString(
            `**Session Expired**\n\n` +
            `Email: ${credential.userEmail}\n\n` +
            `Server: ${credential.serverUrl}\n\n` +
            `Click to open account panel`
        );
        loginStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        loginStatusItem.command = COMMANDS.SHOW_ACCOUNT_PANEL;
    } else if (credential) {
        // Credential exists but auth state not confirmed yet (assume valid until proven otherwise)
        loginStatusItem.text = `$(account) ${credential.userEmail}`;
        loginStatusItem.tooltip = new vscode.MarkdownString(
            `**Logged in to Overleaf**\n\n` +
            `Email: ${credential.userEmail}\n\n` +
            `Server: ${credential.serverUrl}\n\n` +
            `Click to open account panel`
        );
        loginStatusItem.backgroundColor = undefined;
        loginStatusItem.command = COMMANDS.SHOW_ACCOUNT_PANEL;
    } else {
        // Not logged in
        authState = 'none';
        loginStatusItem.text = '$(account) Not logged in';
        loginStatusItem.tooltip = 'Click to open account panel';
        loginStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        loginStatusItem.command = COMMANDS.SHOW_ACCOUNT_PANEL;
    }

    const state = await getAccountPanelState(serverUrl);
    AccountPanel.updateIfOpen(state);

    loginStatusItem.show();
}

/**
 * Show session expired notification with action buttons
 */
async function showSessionExpiredNotification(): Promise<void> {
    const action = await showPanelModal({
        message: 'LocalLeaf: Your Overleaf session has expired.',
        type: 'warning',
        buttons: [
            { label: 'Open Account Panel', value: 'open', primary: true },
            { label: 'Dismiss', value: 'dismiss' },
        ],
    });

    if (action === 'open') {
        await cmdShowAccountPanel();
    }
}

/**
 * Update collaborator status bar
 */
function updateCollaboratorStatus() {
    if (!cursorTracker || !syncEngine || syncEngine.status === 'disconnected') {
        collaboratorStatusItem.hide();
        return;
    }

    const users = cursorTracker.getOnlineUsers();
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
        tooltip.isTrusted = true;
        tooltip.supportHtml = true;

        for (const user of users) {
            const timeSince = formatTimeSince(now - user.lastUpdated);
            const location = user.docPath ? `at ${user.docPath}:${user.row + 1}` : '';
            tooltip.appendMarkdown(`- <span style="color:${user.color};">**${user.name}**</span> ${location} (${timeSince})\n`);
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
 * Push online users from CursorTracker to the Changes webview
 */
function pushOnlineUsersToWebview(): void {
    if (!cursorTracker) {
        changesWebviewProvider.setOnlineUsers([]);
        return;
    }
    const users = cursorTracker.getOnlineUsers().map(u => ({
        clientId: u.clientId,
        name: u.name,
        color: u.color,
        initials: getInitials(u.name),
        docPath: u.docPath,
        row: u.row,
    }));
    changesWebviewProvider.setOnlineUsers(users);
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

/**
 * Refresh all sidebar providers
 */
function refreshSidebar(): void {
    projectsWebviewProvider.refresh();
    changesWebviewProvider.refresh();
}

/**
 * Stop the currently connected LocalLeaf project session.
 */
async function disconnectCurrentProjectSession(): Promise<void> {
    if (syncEngine) {
        await syncEngine.disconnect();
        syncEngine = undefined;
    }

    if (cursorTracker) {
        cursorTracker.dispose();
        cursorTracker = undefined;
    }

    stopStatusUpdates();
    autoCompiler?.disable();
    changesWebviewProvider?.setOnlineUsers([]);
}

/**
 * Install a watcher for the active LocalLeaf project's settings file.
 */
function updateSettingsWatcher(
    context: vscode.ExtensionContext,
    settingsManager?: SettingsManager,
): void {
    settingsWatcher?.dispose();
    settingsWatcher = undefined;

    if (!settingsManager) {
        return;
    }

    settingsWatcher = createSettingsWatcher(settingsManager.getWorkspaceFolder(), async () => {
        log('Settings changed, reloading...');
        const currentSettingsManager = await SettingsManager.resolveCurrentInstance();
        if (!currentSettingsManager || !(await currentSettingsManager.isLinked())) {
            await refreshWorkspaceProjectState(context);
            return;
        }

        await currentSettingsManager.load();
        await refreshScmAndHookState();
        refreshSidebar();
    });
    context.subscriptions.push(settingsWatcher);
}

/**
 * Activate a linked LocalLeaf project folder, including child folders discovered
 * under an opened parent workspace.
 */
async function activateLinkedProject(
    context: vscode.ExtensionContext,
    settingsManager: SettingsManager,
    message?: string,
): Promise<void> {
    await disconnectCurrentProjectSession();
    SettingsManager.setCurrentWorkspaceFolder(settingsManager.getWorkspaceFolder());

    const settings = await settingsManager.load();
    if (!settings) {
        showPanelNotice('LocalLeaf: Selected folder is missing .localleaf/settings.json', 'error');
        await vscode.commands.executeCommand('setContext', 'localleaf.isLinked', false);
        await refreshScmAndHookState();
        refreshSidebar();
        return;
    }

    if (message) {
        showPanelNotice(message, 'info', 4000);
    }

    statusBarItem.show();
    await updateLoginStatus();
    await vscode.commands.executeCommand('setContext', 'localleaf.isLinked', true);
    updateSettingsWatcher(context, settingsManager);
    await refreshScmAndHookState();
    refreshSidebar();

    await initializeSync(context, settingsManager);
}

/**
 * Re-evaluate which LocalLeaf project should be active for the current VS Code
 * workspace. A direct project folder wins; otherwise the only linked child
 * folder is auto-selected. Multiple child projects are shown in the Projects view.
 */
async function refreshWorkspaceProjectState(context: vscode.ExtensionContext): Promise<void> {
    await disconnectCurrentProjectSession();
    SettingsManager.clearCurrentWorkspaceFolder();

    const settingsManager = await SettingsManager.resolveCurrentInstance();
    if (settingsManager && await settingsManager.isLinked()) {
        await activateLinkedProject(context, settingsManager);
        return;
    }

    updateSettingsWatcher(context);
    statusBarItem.hide();
    collaboratorStatusItem.hide();
    changesWebviewProvider.clearChanges();
    await vscode.commands.executeCommand('setContext', 'localleaf.isLinked', false);
    await refreshScmAndHookState();
    await updateLoginStatus();
    refreshSidebar();
}

/**
 * Whether git-commit-triggered Overleaf push is enabled.
 */
function isGitCommitAutoPushEnabled(): boolean {
    return vscode.workspace.getConfiguration('localleaf').get<boolean>('gitCommitAutoPush', true);
}

/**
 * Whether sync engine is currently connected enough to serve push/pull operations.
 */
function isSyncEngineConnected(engine: SyncEngine | undefined): boolean {
    if (!engine) return false;
    return engine.status !== 'disconnected' && engine.status !== 'error';
}

function getPendingSyncCounts(engine: SyncEngine) {
    return {
        localChangeCount: engine.changeTracker.getLocalChangeCount(),
        remoteChangeCount: engine.changeTracker.getRemoteChangeCount(),
        conflictCount: engine.changeTracker.getConflictCount(),
    };
}

/**
 * Focus the LocalLeaf Changes view.
 */
async function focusChangesView(): Promise<void> {
    await vscode.commands.executeCommand(`${ChangesWebviewProvider.viewType}.focus`);
}

async function runExclusiveSyncOperation<T>(
    operationName: string,
    operation: () => Promise<T>,
    options?: { showBusyNotice?: boolean },
): Promise<T | undefined> {
    const result = await syncOperationGate.tryRun(operationName, operation);
    if (result.started) {
        return result.result;
    }

    const message = `LocalLeaf is busy with ${result.activeOperation}.`;
    log(`${operationName}: skipped because ${message}`);
    if (options?.showBusyNotice !== false) {
        changesWebviewProvider.showNotice(message, 'warning', 4000);
    }
    return undefined;
}

/**
 * Keep SCM provider state and git commit hook state in sync with current linkage/session.
 */
async function refreshScmAndHookState(): Promise<void> {
    if (!scmBridge) {
        return;
    }

    const settingsManager = SettingsManager.getCurrentInstance();
    const workspaceUri = settingsManager?.getWorkspaceFolder()
        ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    const isLinked = !!(settingsManager && await settingsManager.isLinked());
    const mode: SyncMode = syncEngine?.syncMode
        ?? (settingsManager?.getSettings()?.syncMode === 'realtime' ? 'realtime' : 'manual');
    const isConnected = isSyncEngineConnected(syncEngine);
    const settingEnabled = isGitCommitAutoPushEnabled();
    const hookEnabled = isLinked && isConnected && mode === 'manual' && settingEnabled && !!workspaceUri;

    await scmBridge.refreshState({
        linked: isLinked,
        connected: isConnected,
        mode,
        hookEnabled,
        workspaceUri,
    });

    if (hookEnabled && workspaceUri) {
        await gitCommitHook?.start(workspaceUri);
    } else {
        gitCommitHook?.stop();
    }
}

/**
 * Handle conflicts discovered during commit-triggered auto-push.
 */
async function handleCommitHookConflicts(conflicts: PendingChange[]): Promise<void> {
    const firstConflictPath = conflicts[0]?.path;

    await focusChangesView();
    const action = await showPanelModal({
        message: `LocalLeaf: Auto-push after Git commit was skipped because ${conflicts.length} conflict(s) need resolution.`,
        type: 'error',
        buttons: [
            { label: 'Open Changes', value: 'open', primary: true },
            { label: 'View First Diff', value: 'diff' },
            { label: 'Dismiss', value: 'dismiss' },
        ],
    });

    if (action === 'diff' && firstConflictPath) {
        await cmdViewDiff(firstConflictPath);
        return;
    }

    if (action === 'open') {
        await focusChangesView();
    }
}

/**
 * Push LocalLeaf pending changes after a successful VS Code Git commit.
 */
async function runCommitTriggeredOverleafPush(): Promise<void> {
    if (!syncEngine) {
        return;
    }
    if (syncEngine.syncMode !== 'manual') {
        return;
    }
    if (!isGitCommitAutoPushEnabled()) {
        return;
    }
    if (!isSyncEngineConnected(syncEngine)) {
        log(`Commit hook: skipped because LocalLeaf is not connected (status: ${syncEngine.status}).`);
        return;
    }
    if (syncEngine.status !== 'idle') {
        log(`Commit hook: skipped because LocalLeaf is busy (status: ${syncEngine.status}).`);
        return;
    }

    await runExclusiveSyncOperation('Git commit auto-push', async () => {
        if (!syncEngine) {
            return;
        }

        const localPendingCount = syncEngine.changeTracker.getLocalChangeCount();
        if (localPendingCount === 0) {
            log('Commit hook: no pending LocalLeaf changes to push.');
            return;
        }

        const conflicts = syncEngine.changeTracker.getConflicts();
        if (conflicts.length > 0) {
            log(`Commit hook: aborted due to ${conflicts.length} pending conflict(s).`);
            await handleCommitHookConflicts(conflicts);
            return;
        }

        try {
            await syncEngine.pushChanges();
            log(`Commit hook: pushed ${localPendingCount} LocalLeaf change(s) after Git commit.`);
        } catch (error) {
            log(`Commit hook: auto-push failed - ${error}`);
            const action = await showPanelModal({
                message: `LocalLeaf: Auto-push after Git commit failed - ${error}`,
                type: 'error',
                buttons: [
                    { label: 'Open Changes', value: 'open', primary: true },
                    { label: 'Dismiss', value: 'dismiss' },
                ],
            });
            if (action === 'open') {
                await focusChangesView();
            }
        }
    }, { showBusyNotice: false });
}

// === Command Implementations ===

const COOKIE_TUTORIAL_URL = 'https://github.com/overleaf-workshop/Overleaf-Workshop/blob/master/docs/wiki.md#login-with-cookies';

function normalizeServerUrlInput(input: string): string | undefined {
    const trimmed = input.trim();
    if (!trimmed) return undefined;

    const withProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)
        ? trimmed
        : `https://${trimmed}`;

    try {
        // Validate URL format
        new URL(withProtocol);
        return withProtocol.replace(/\/+$/, '');
    } catch {
        return undefined;
    }
}

async function updateDefaultServer(serverUrl: string): Promise<void> {
    const normalized = normalizeServerUrlInput(serverUrl);
    if (!normalized) return;
    await vscode.workspace.getConfiguration('localleaf').update(
        'defaultServer',
        normalized,
        vscode.ConfigurationTarget.Global,
    );
}

async function getAccountPanelState(preferredServerUrl?: string): Promise<AccountPanelState> {
    const serverUrl = preferredServerUrl || credentialManager.getDefaultServer();
    const credential = await credentialManager.getCredential(serverUrl);
    const effectiveAuthState = credential
        ? (authState === 'expired' ? 'expired' : 'valid')
        : 'none';

    return {
        serverUrl,
        loggedIn: !!credential,
        authState: effectiveAuthState,
        userEmail: credential?.userEmail,
    };
}

async function cmdShowAccountPanel() {
    const state = await getAccountPanelState();
    AccountPanel.createOrShow(
        extensionContext.extensionUri,
        state,
        handleAccountPanelAction,
    );
}

async function handleAccountPanelAction(action: AccountPanelAction): Promise<void> {
    if (action.type === 'openTutorial') {
        await vscode.env.openExternal(vscode.Uri.parse(COOKIE_TUTORIAL_URL));
        return;
    }

    if (action.type === 'logout') {
        await cmdLogout();
        return;
    }

    const normalizedServer = normalizeServerUrlInput(action.serverUrl);
    if (!normalizedServer) {
        showPanelNotice('LocalLeaf: Invalid Overleaf server URL', 'error');
        return;
    }

    if (action.type === 'loginCookies') {
        await loginWithCookiesAndStore(normalizedServer, action.cookies, {
            successMessage: 'LocalLeaf: Logged in successfully',
            reconnect: true,
        });
        return;
    }

    if (action.type === 'loginBrowser') {
        await loginViaBrowserAndStore(normalizedServer, action.browserPreference);
    }
}

async function loginViaBrowserAndStore(
    serverUrl: string,
    browserPreference: BrowserPreference,
): Promise<boolean> {
    const browserResult = await withPanelProgress('LocalLeaf: Waiting for browser login...', async () => {
        return captureCookiesViaBrowserLogin(
            serverUrl,
            browserPreference,
            log,
        );
    });

    if (browserResult.type === 'error') {
        showPanelNotice(`LocalLeaf: Browser login failed - ${browserResult.message}`, 'error');
        return false;
    }

    return loginWithCookiesAndStore(serverUrl, browserResult.cookies, {
        successMessage: 'LocalLeaf: Logged in successfully',
        reconnect: true,
    });
}

async function loginWithCookiesAndStore(
    serverUrl: string,
    cookies: string,
    options?: { successMessage?: string; reconnect?: boolean },
): Promise<boolean> {
    const api = new BaseAPI(serverUrl);
    const result = await withPanelProgress(
        'LocalLeaf: Validating session...',
        async () => api.cookiesLogin(cookies),
    );

    if (result.type !== 'success' || !result.userInfo || !result.identity) {
        showPanelNotice(`LocalLeaf: Login failed - ${result.message}`, 'error');
        return false;
    }

    const credential: ServerCredential = {
        serverUrl,
        userId: result.userInfo.userId,
        userEmail: result.userInfo.userEmail,
        identity: result.identity,
    };

    await credentialManager.storeCredential(credential);
    await updateDefaultServer(serverUrl);
    await setAuthState('valid');
    await vscode.commands.executeCommand('setContext', 'localleaf.loggedIn', true);
    refreshSidebar();

    const state = await getAccountPanelState(serverUrl);
    AccountPanel.updateIfOpen(state);

    showPanelNotice(options?.successMessage || `LocalLeaf: Logged in as ${result.userInfo.userEmail}`, 'info', 4000);

    if (options?.reconnect) {
        await cmdReconnect();
    }

    return true;
}


/**
 * Login to Overleaf
 */
async function cmdLogin() {
    await cmdShowAccountPanel();
}

/**
 * Logout from Overleaf
 */
async function cmdLogout() {
    const confirm = await showPanelModal({
        message: 'Are you sure you want to logout from Overleaf?',
        type: 'warning',
        buttons: [
            { label: 'Logout', value: 'logout', danger: true },
            { label: 'Cancel', value: 'cancel' },
        ],
    });

    if (confirm !== 'logout') return;

    const serverUrl = credentialManager.getDefaultServer();
    await credentialManager.deleteCredential(serverUrl);

    // Disconnect sync engine but keep settings
    if (syncEngine) {
        await syncEngine.disconnect();
        syncEngine = undefined;
    }

    if (cursorTracker) {
        cursorTracker.dispose();
        cursorTracker = undefined;
    }

    updateStatusBar('disconnected', 'Logged out');
    await refreshScmAndHookState();
    await updateLoginStatus();
    await vscode.commands.executeCommand('setContext', 'localleaf.loggedIn', false);
    refreshSidebar();
    showPanelNotice('LocalLeaf: Logged out', 'info', 4000);
}

/**
 * Link current folder to an Overleaf project
 */
async function cmdLinkFolder(context: vscode.ExtensionContext) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceFolder) {
        showPanelNotice('LocalLeaf: No workspace folder open', 'error');
        return;
    }

    // Get server URL
    const serverUrl = credentialManager.getDefaultServer();

    // Check if logged in
    const credential = await credentialManager.getCredential(serverUrl);
    if (!credential) {
        showPanelNotice('LocalLeaf: Please login first', 'warning');
        await cmdLogin();
        return;
    }

    // Get projects list
    const api = new BaseAPI(serverUrl);
    api.setIdentity(credential.identity);

    const projectsResult = await api.getProjects();
    if (projectsResult.type !== 'success' || !projectsResult.projects) {
        showPanelNotice(`LocalLeaf: Failed to get projects - ${projectsResult.message}`, 'error');
        return;
    }

    // Filter active projects
    const activeProjects = projectsResult.projects.filter(p => !p.archived && !p.trashed);

    // Show project picker
    const items = activeProjects.map(p => ({
        label: p.name,
        description: `${p.accessLevel}${p.lastUpdated ? ` - ${new Date(p.lastUpdated).toLocaleDateString()}` : ''}`,
        project: p,
    }));

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select an Overleaf project to link',
    });

    if (!selected) return;

    const project = selected.project;

    // Create settings
    SettingsManager.setCurrentWorkspaceFolder(workspaceFolder);
    const settingsManager = SettingsManager.getInstance(workspaceFolder);
    const settings = SettingsManager.createDefaultSettings(serverUrl, project.id, project.name);
    await settingsManager.save(settings);

    // Create default .leafignore
    const ignoreParser = new IgnoreParser(workspaceFolder);
    if (!(await ignoreParser.exists())) {
        await ignoreParser.createDefault();
    }

    await activateLinkedProject(context, settingsManager, `LocalLeaf: Linked to "${project.name}"`);
}

/**
 * Unlink current folder
 */
async function cmdUnlinkFolder() {
    const settingsManager = SettingsManager.getCurrentInstance();
    if (!settingsManager || !(await settingsManager.isLinked())) {
        showPanelNotice('LocalLeaf: This folder is not linked', 'info', 4000);
        return;
    }

    const confirm = await showPanelModal({
        message: 'Are you sure you want to unlink this folder from Overleaf?',
        type: 'warning',
        buttons: [
            { label: 'Unlink', value: 'unlink', danger: true },
            { label: 'Cancel', value: 'cancel' },
        ],
    });

    if (confirm !== 'unlink') return;

    // Disconnect
    if (syncEngine) {
        await syncEngine.disconnect();
        syncEngine = undefined;
    }

    if (cursorTracker) {
        cursorTracker.dispose();
        cursorTracker = undefined;
    }

    // Delete settings
    await settingsManager.delete();
    SettingsManager.clearCurrentWorkspaceFolder();
    updateSettingsWatcher(extensionContext);

    statusBarItem.hide();
    collaboratorStatusItem.hide();
    await vscode.commands.executeCommand('setContext', 'localleaf.isLinked', false);
    await refreshScmAndHookState();
    changesWebviewProvider.clearChanges();
    refreshSidebar();
    showPanelNotice('LocalLeaf: Folder unlinked', 'info', 4000);
}

/**
 * Sync now (bidirectional)
 */
async function cmdSyncNow() {
    if (!syncEngine) {
        showPanelNotice('LocalLeaf: Not connected. Please link a folder first.', 'warning');
        return;
    }

    await runExclusiveSyncOperation('Sync Now', async () => {
        if (!syncEngine) {
            return;
        }

        if (syncEngine.syncMode === 'manual') {
            // In manual mode: reconcile remote first, then push only when no remote/conflict work remains.
            try {
                await syncEngine.pullAll();

                let counts = getPendingSyncCounts(syncEngine);
                const completionAfterPull = getManualSyncCompletionState(counts);
                if (!completionAfterPull.canComplete && !shouldPushAfterManualPull(counts)) {
                    await focusChangesView();
                    const reason = completionAfterPull.reason === 'conflict'
                        ? 'conflicts need resolution'
                        : 'remote changes still need review';
                    changesWebviewProvider.showNotice(`Sync paused: ${reason}`, 'warning');
                    return;
                }

                if (shouldPushAfterManualPull(counts)) {
                    await syncEngine.pushChanges();
                }

                counts = getPendingSyncCounts(syncEngine);
                const finalCompletion = getManualSyncCompletionState(counts);
                if (!finalCompletion.canComplete) {
                    await focusChangesView();
                    changesWebviewProvider.showNotice('Sync paused: pending changes remain', 'warning');
                    return;
                }

                changesWebviewProvider.showNotice('Sync complete', 'info', 4000);
            } catch (error) {
                changesWebviewProvider.showNotice(`Sync failed: ${error}`, 'error');
            }
        } else {
            // In realtime mode: do a full pull to catch up.
            await pullFromOverleafInternal();
        }
    });
}

/**
 * Pull from Overleaf
 */
async function cmdPullFromOverleaf() {
    if (!syncEngine) {
        showPanelNotice('LocalLeaf: Not connected. Please link a folder first.', 'warning');
        return;
    }

    await runExclusiveSyncOperation('Pull from Overleaf', pullFromOverleafInternal);
}

async function pullFromOverleafInternal() {
    if (!syncEngine) {
        return;
    }

    try {
        const remoteWins = syncEngine.syncMode === 'manual';
        if (remoteWins) {
            const choice = await showPanelModal({
                message: 'Pull from Overleaf will overwrite local unpushed changes with the cloud version. Local-only new files will remain as local changes. Continue?',
                type: 'warning',
                buttons: [
                    { label: 'Pull from Overleaf', value: 'pull', danger: true },
                    { label: 'Cancel', value: 'cancel' },
                ],
            });
            if (choice !== 'pull') {
                changesWebviewProvider.showNotice('Pull canceled', 'info', 4000);
                return;
            }
        }

        // Always use pullAll for full reconciliation.
        // Manual user-initiated pull treats Overleaf as authoritative after confirmation.
        await syncEngine!.pullAll({ remoteWins });
        if (syncEngine.syncMode === 'manual') {
            const completion = getManualSyncCompletionState(getPendingSyncCounts(syncEngine));
            if (!completion.canComplete) {
                await focusChangesView();
                changesWebviewProvider.showNotice('Pull paused: pending changes need review', 'warning');
                return;
            }
        }
        changesWebviewProvider.showNotice('Pull complete', 'info', 4000);
    } catch (error) {
        changesWebviewProvider.showNotice(`Pull failed: ${error}`, 'error');
    }
}

/**
 * Push to Overleaf
 */
async function cmdPushToOverleaf() {
    if (!syncEngine) {
        showPanelNotice('LocalLeaf: Not connected. Please link a folder first.', 'warning');
        return;
    }

    if (syncEngine.syncMode === 'manual') {
        await runExclusiveSyncOperation('Push to Overleaf', async () => {
            if (!syncEngine) {
                return;
            }

            try {
                // Check for conflicts before pushing.
                const conflicts = syncEngine.changeTracker.getConflicts();
                let conflictChoice: 'pull' | 'force' | 'cancel' | undefined;
                if (conflicts.length > 0) {
                    const choice = await changesWebviewProvider.showConfirmation({
                        message: `${conflicts.length} file(s) have both local and remote changes. Pull first to resolve conflicts.`,
                        buttons: [
                            { label: 'Pull First', value: 'pull', primary: true },
                            { label: 'Force Push', value: 'force', danger: true },
                            { label: 'Cancel', value: 'cancel' },
                        ],
                    });
                    conflictChoice = choice === 'pull' || choice === 'force' ? choice : 'cancel';
                }

                const plan = getManualPushPlan({
                    conflictCount: conflicts.length,
                    conflictChoice,
                });

                if (plan.action === 'pull') {
                    await syncEngine.pullChanges();
                    return;
                }
                if (plan.action === 'cancel') {
                    return;
                }

                await syncEngine.pushChanges({ force: plan.force });
                changesWebviewProvider.showNotice('Push complete', 'info', 4000);
            } catch (error) {
                changesWebviewProvider.showNotice(`Push failed: ${error}`, 'error');
            }
        });
    } else {
        changesWebviewProvider.showNotice('Push is automatic in real-time mode', 'info', 4000);
    }
}

/**
 * Edit ignore patterns
 */
async function cmdEditIgnorePatterns() {
    const workspaceFolder = SettingsManager.getCurrentInstance()?.getWorkspaceFolder()
        ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceFolder) {
        showPanelNotice('LocalLeaf: No workspace folder open', 'error');
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
        showPanelNotice('LocalLeaf: No linked project', 'warning');
        return;
    }

    // Disconnect existing sync engine
    if (syncEngine) {
        await syncEngine.disconnect();
        syncEngine = undefined;
    }

    if (cursorTracker) {
        cursorTracker.dispose();
        cursorTracker = undefined;
    }

    stopStatusUpdates();
    await refreshScmAndHookState();

    const projectSettings = settingsManager.getSettings();
    if (!projectSettings) return;

    const credential = await credentialManager.getCredential(projectSettings.serverUrl);
    if (!credential) {
        updateStatusBar('disconnected', 'Not logged in');
        await refreshScmAndHookState();
        showPanelNotice('LocalLeaf: Please login to Overleaf first', 'warning');
        return;
    }

    const api = new BaseAPI(projectSettings.serverUrl);
    api.setIdentity(credential.identity);

    syncEngine = new SyncEngine(api, settingsManager, log, panelUi());

    // Wire up change tracker
    changesWebviewProvider.setChangeTracker(syncEngine.changeTracker);
    const syncMode: SyncMode = projectSettings.syncMode === 'realtime' ? 'realtime' : 'manual';
    changesWebviewProvider.setSyncMode(syncMode);
    await vscode.commands.executeCommand('setContext', 'localleaf.syncMode', syncMode);
    await refreshScmAndHookState();

    syncEngine.onStatusChange(async event => {
        updateStatusBar(event.status, event.message);
        await refreshScmAndHookState();
        // Handle auth errors
        if (event.authError) {
            await setAuthState('expired');
            showSessionExpiredNotification();
        }
    });

    try {
        updateStatusBar('syncing', 'Reconnecting...');
        await syncEngine.connect();

        const socket = syncEngine.getSocket();
        if (socket) {
            cursorTracker = new CursorTracker(socket, settingsManager, panelUi());
            await cursorTracker.initialize();
            cursorTracker.onDidChangeUsers(() => pushOnlineUsersToWebview());
            pushOnlineUsersToWebview();
        }

        startStatusUpdates();
        log('Reconnected to Overleaf');

        // Only auto-pull in realtime mode; manual mode waits for explicit user action
        if (syncMode === 'realtime') {
            await syncEngine.pullAll();
        }
        await syncEngine.joinAllDocsForWatching();
        changesWebviewProvider.showNotice(`Reconnected to "${projectSettings.projectName}"`, 'info', 4000);
    } catch (error) {
        log(`Failed to reconnect: ${error}`);
        changesWebviewProvider.showNotice(`Failed to reconnect: ${error}`, 'error');
    } finally {
        await refreshScmAndHookState();
    }
}

/**
 * Set main document
 */
async function cmdSetMainDocument() {
    const settingsManager = SettingsManager.getCurrentInstance();
    if (!settingsManager || !(await settingsManager.isLinked())) {
        showPanelNotice('LocalLeaf: No linked project', 'error');
        return;
    }

    const mainTex = await vscode.window.showInputBox({
        prompt: 'Enter main TeX file name',
        value: settingsManager.getSettings()?.mainTex || 'main.tex',
    });

    if (!mainTex) return;

    const mainPdf = mainTex.replace(/\.tex$/, '.pdf');

    await settingsManager.update({ mainTex, mainPdf });
    showPanelNotice(`LocalLeaf: Main document set to ${mainTex}`, 'info', 4000);
}

/**
 * Configure settings
 */
async function cmdConfigure() {
    const settingsManager = SettingsManager.getCurrentInstance();
    if (!settingsManager || !(await settingsManager.isLinked())) {
        showPanelNotice('LocalLeaf: No linked project', 'info', 4000);
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
        showPanelNotice('LocalLeaf: Not connected', 'warning');
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
        showPanelNotice('LocalLeaf: No linked project', 'info', 4000);
        return;
    }

    const projectSettings = settingsManager.getSettings();
    if (!projectSettings) return;

    const credential = await credentialManager.getCredential(projectSettings.serverUrl);
    if (!credential) {
        await setAuthState('none');
        showPanelNotice('LocalLeaf: Not logged in', 'warning');
        return;
    }

    const api = new BaseAPI(projectSettings.serverUrl);
    api.setIdentity(credential.identity);

    const result = await withPanelProgress('LocalLeaf: Verifying credentials...', async () => {
        return api.verifyCredentials();
    });

    if (result.type === 'success') {
        await setAuthState('valid');
        showPanelNotice('LocalLeaf: Credentials are valid', 'info', 4000);
    } else {
        await setAuthState('expired');
        showSessionExpiredNotification();
    }
}

/**
 * Refresh cookie (re-login without clearing stored info)
 */
async function cmdRefreshCookie() {
    await cmdShowAccountPanel();
}

/**
 * Remove LaTeX comments from all .tex files in the workspace
 */
async function cmdRemoveComments() {
    try {
        log('Remove Comments: starting...');

        const workspaceFolder = SettingsManager.getCurrentInstance()?.getWorkspaceFolder()
            ?? vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!workspaceFolder) {
            showPanelNotice('LocalLeaf: No workspace folder open', 'error');
            return;
        }

        // Find all .tex files
        log('Remove Comments: scanning for .tex files...');
        const texFiles = await vscode.workspace.findFiles(
            new vscode.RelativePattern(workspaceFolder, '**/*.tex'),
            new vscode.RelativePattern(workspaceFolder, '.localleaf/**'),
        );
        log(`Remove Comments: found ${texFiles.length} .tex files`);

        if (texFiles.length === 0) {
            showPanelNotice('LocalLeaf: No .tex files found in workspace', 'info', 4000);
            return;
        }

        // Dry-run: count how many comment lines would be removed
        let totalCommentLines = 0;
        const fileSummaries: { uri: vscode.Uri; name: string; commentLines: number }[] = [];

        for (const uri of texFiles) {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const content = new TextDecoder().decode(bytes);
            const commentLines = countCommentLines(content);
            if (commentLines > 0) {
                const relativePath = path.relative(workspaceFolder.fsPath, uri.fsPath)
                    .split(path.sep)
                    .join('/');
                fileSummaries.push({ uri, name: relativePath, commentLines });
                totalCommentLines += commentLines;
            }
        }

        log(`Remove Comments: ${totalCommentLines} comment lines in ${fileSummaries.length} files`);

        if (totalCommentLines === 0) {
            showPanelNotice('LocalLeaf: No comments found in any .tex files', 'info', 4000);
            return;
        }

        // Confirmation dialog
        const fileList = fileSummaries.map(f => `${f.name}: ${f.commentLines} lines`).join('\n');
        const confirm = await showPanelModal({
            message: `Remove ${totalCommentLines} comment lines from ${fileSummaries.length} file(s)?\n\nThis cannot be undone (except via sync/git).\n\n${fileList}`,
            type: 'warning',
            buttons: [
                { label: 'Remove All Comments', value: 'remove', danger: true },
                { label: 'Cancel', value: 'cancel' },
            ],
        });

        if (confirm !== 'remove') { return; }

        // Process each file
        let totalRemoved = 0;
        await withPanelProgress('LocalLeaf: Removing comments...', async () => {
            for (let i = 0; i < fileSummaries.length; i++) {
                const f = fileSummaries[i];

                const bytes = await vscode.workspace.fs.readFile(f.uri);
                const original = new TextDecoder().decode(bytes);
                const cleaned = removeLatexComments(original);

                const origLines = original.split('\n').length;
                const cleanLines = cleaned.split('\n').length;
                totalRemoved += origLines - cleanLines;

                await vscode.workspace.fs.writeFile(f.uri, new TextEncoder().encode(cleaned));
            }
        });

        showPanelNotice(
            `LocalLeaf: Removed ${totalRemoved} comment lines from ${fileSummaries.length} file(s)`,
            'info',
            4000,
        );
    } catch (error) {
        log(`Remove Comments error: ${error}`);
        showPanelNotice(`LocalLeaf: Remove comments failed - ${error}`, 'error');
    }
}

/**
 * Count comment lines in LaTeX content (for preview)
 */
function countCommentLines(content: string): number {
    const lines = content.split('\n');
    let count = 0;
    let inBlock = false;

    for (const line of lines) {
        const stripped = line.trim();
        if (stripped === '\\begin{comment}') { inBlock = true; count++; continue; }
        if (stripped === '\\end{comment}') { inBlock = false; count++; continue; }
        if (inBlock) { count++; continue; }
        if (/^\s*%/.test(line) && !/^\s*\\%/.test(line)) { count++; }
    }
    return count;
}

/**
 * Remove LaTeX comments from content
 * - Removes \begin{comment}...\end{comment} blocks
 * - Removes lines starting with % (but not \%)
 * - Collapses consecutive blank lines
 * - Strips trailing blank lines
 */
function removeLatexComments(content: string): string {
    const lines = content.split('\n');
    const result: string[] = [];
    let inBlock = false;

    for (const line of lines) {
        const stripped = line.trim();

        // Handle \begin{comment} ... \end{comment} blocks
        if (stripped === '\\begin{comment}') { inBlock = true; continue; }
        if (stripped === '\\end{comment}') { inBlock = false; continue; }
        if (inBlock) { continue; }

        // Remove lines starting with % (but not \%)
        if (/^\s*%/.test(line) && !/^\s*\\%/.test(line)) { continue; }

        result.push(line);
    }

    // Collapse consecutive blank lines into at most one
    const cleaned: string[] = [];
    for (const line of result) {
        const isBlank = line.trim() === '';
        if (isBlank && cleaned.length > 0 && cleaned[cleaned.length - 1].trim() === '') {
            continue;
        }
        cleaned.push(line);
    }

    // Strip trailing blank lines
    while (cleaned.length > 0 && cleaned[cleaned.length - 1].trim() === '') {
        cleaned.pop();
    }

    return cleaned.join('\n') + '\n';
}

// === Sync Mode Commands ===

/**
 * Toggle between manual and realtime sync modes
 */
async function cmdToggleSyncMode() {
    if (!syncEngine) {
        showPanelNotice('LocalLeaf: Not connected. Please link a folder first.', 'warning');
        return;
    }

    const currentMode = syncEngine.syncMode;
    const newMode: SyncMode = currentMode === 'manual' ? 'realtime' : 'manual';

    // Check pending changes before switching to realtime
    if (newMode === 'realtime') {
        const hasLocal = syncEngine.changeTracker.getLocalChangeCount() > 0;
        const hasRemote = syncEngine.changeTracker.getRemoteChangeCount() > 0;
        if (hasLocal || hasRemote) {
            const choice = await changesWebviewProvider.showConfirmation({
                message: 'You have pending changes. Apply them before switching to real-time mode?',
                buttons: [
                    { label: 'Apply & Switch', value: 'apply', primary: true },
                    { label: 'Discard & Switch', value: 'discard', danger: true },
                    { label: 'Cancel', value: 'cancel' },
                ],
            });
            if (choice === 'cancel') {
                return;
            }
            if (choice === 'apply') {
                const applied = await runExclusiveSyncOperation('Switch sync mode', async () => {
                    if (!syncEngine) {
                        return false;
                    }
                    if (hasRemote) { await syncEngine.pullChanges(); }
                    if (hasLocal) { await syncEngine.pushChanges(); }
                    const completion = getManualSyncCompletionState(getPendingSyncCounts(syncEngine));
                    if (!completion.canComplete) {
                        await focusChangesView();
                        changesWebviewProvider.showNotice('Resolve pending changes before switching to real-time mode', 'warning');
                        return false;
                    }
                    return true;
                });
                if (!applied) {
                    return;
                }
            } else {
                syncEngine.changeTracker.clearAll();
            }
        }
    }

    await syncEngine.setSyncMode(newMode, { skipConfirmation: true });
    changesWebviewProvider.setSyncMode(newMode);
    await vscode.commands.executeCommand('setContext', 'localleaf.syncMode', newMode);
    await refreshScmAndHookState();
    updateSyncModeStatusBar(newMode);
    refreshSidebar();

    const label = newMode === 'manual' ? 'Manual' : 'Real-time';
    changesWebviewProvider.showNotice(`Sync mode set to ${label}`, 'info', 4000);
}

/**
 * Update status bar to reflect current sync mode
 */
function updateSyncModeStatusBar(mode: SyncMode) {
    // The status bar text is updated in updateStatusBar, which reads syncEngine.syncMode
    // Just trigger a refresh
    if (syncEngine) {
        updateStatusBar(syncEngine.status);
    }
}

// === Project Sorting & Filtering Commands ===

async function cmdFilterProjects() {
    const current = projectsWebviewProvider.getFilter();
    const text = await vscode.window.showInputBox({
        prompt: 'Filter projects by name',
        value: current,
        placeHolder: 'Type to filter...',
    });

    if (text !== undefined) {
        projectsWebviewProvider.setFilter(text);
    }
}

function cmdSortProjects(field: ProjectSortField) {
    projectsWebviewProvider.setSortField(field);
}

// === Compilation Commands ===

async function cmdCompileLaTeX() {
    const settingsManager = SettingsManager.getCurrentInstance();
    const settings = settingsManager?.getSettings();
    if (!settingsManager || !settings) {
        showPanelNotice('LocalLeaf: No linked project', 'warning');
        return;
    }

    if (!latexCompiler) {
        latexCompiler = new LatexCompiler();
    }

    const mainTex = settings.mainTex || 'main.tex';
    const workspaceFolder = settingsManager.getWorkspaceFolder();

    // Determine compiler to use
    let compiler: CompilerType | undefined;
    if (settings.compiler && settings.compiler !== 'auto') {
        compiler = settings.compiler as CompilerType;
    }

    // Use the same compilation flow as auto-compile (Ctrl+S)
    handleCompilationStarted();
    const result = await latexCompiler.compile(workspaceFolder.fsPath, mainTex, compiler);
    handleCompilationResult(result);
}

/** Token for the current compilation notice */
let compilingNoticeToken: NoticeToken | undefined;

function handleCompilationStarted() {
    dismissPanelNotice(compilingNoticeToken);
    compilingNoticeToken = undefined;

    // Update PDF preview tab title
    PdfPreviewPanel.setCompiling(true);

    compilingNoticeToken = showPanelNotice('LaTeX: Compiling...', 'info');
}

function handleCompilationResult(result: CompilationResult) {
    dismissPanelNotice(compilingNoticeToken);
    compilingNoticeToken = undefined;

    // Restore PDF preview tab title
    PdfPreviewPanel.setCompiling(false);

    if (result.success) {
        const duration = (result.duration / 1000).toFixed(1);
        showPanelNotice(`LaTeX: Compiled successfully (${duration}s)`, 'info', 4000);

        // Auto-open / refresh PDF preview
        if (result.pdfPath) {
            const workspacePath = SettingsManager.getCurrentInstance()?.getWorkspaceFolder().fsPath;
            PdfPreviewPanel.createOrShow(extensionContext.extensionUri, result.pdfPath, workspacePath);
        }
    } else {
        const errorCount = result.errors.length;
        const warningCount = result.warnings.length;
        showPanelNotice(
            `LaTeX: Compilation failed (${errorCount} error(s), ${warningCount} warning(s))`,
            'warning',
        );
    }

    log(`Compilation ${result.success ? 'succeeded' : 'failed'} in ${result.duration}ms`);
}

async function cmdShowPdfPreview() {
    const settingsManager = SettingsManager.getCurrentInstance();
    const settings = settingsManager?.getSettings();
    if (!settingsManager || !settings) {
        showPanelNotice('LocalLeaf: No linked project', 'warning');
        return;
    }

    const mainPdf = settings.mainPdf || settings.mainTex?.replace(/\.tex$/, '.pdf') || 'main.pdf';
    const workspaceFolder = settingsManager.getWorkspaceFolder();
    const pdfPath = path.join(LatexCompiler.getBuildDir(workspaceFolder.fsPath), mainPdf);

    try {
        await vscode.workspace.fs.stat(vscode.Uri.file(pdfPath));
        PdfPreviewPanel.createOrShow(extensionContext.extensionUri, pdfPath, workspaceFolder.fsPath);
    } catch {
        // PDF not found — compile automatically then show preview
        await cmdCompileLaTeX();
    }
}

async function cmdSelectCompiler() {
    if (!latexCompiler) {
        latexCompiler = new LatexCompiler();
    }

    const available = await latexCompiler.detectCompilers();

    if (available.length === 0) {
        showPanelNotice('LocalLeaf: No LaTeX compilers found. Please install TeX Live or MiKTeX.', 'error');
        return;
    }

    const items: vscode.QuickPickItem[] = [
        { label: 'auto', description: 'Auto-detect (prefer latexmk)' },
        ...available.map(c => ({
            label: c,
            description: c === 'latexmk' ? 'Recommended (auto multi-pass)' : '',
        })),
    ];

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select LaTeX compiler',
    });

    if (selected) {
        const settingsManager = SettingsManager.getCurrentInstance();
        await settingsManager?.update({ compiler: selected.label as any });
        refreshSidebar();
        showPanelNotice(`LocalLeaf: Compiler set to ${selected.label}`, 'info', 4000);
    }
}

async function cmdToggleAutoCompile() {
    const settingsManager = SettingsManager.getCurrentInstance();
    const settings = settingsManager?.getSettings();
    if (!settingsManager || !settings) {
        showPanelNotice('LocalLeaf: No linked project', 'warning');
        return;
    }

    const config = vscode.workspace.getConfiguration('localleaf');
    const current = config.get<boolean>('compileOnSave', true);
    const newState = !current;
    await config.update('compileOnSave', newState, vscode.ConfigurationTarget.Global);

    if (newState) {
        if (!latexCompiler) {
            latexCompiler = new LatexCompiler();
        }
        if (!autoCompiler) {
            autoCompiler = new AutoCompiler(latexCompiler);
        }
        const mainTex = settings.mainTex || 'main.tex';
        const delay = config.get<number>('compileDelay', 1500);
        autoCompiler.enable(settingsManager.getWorkspaceFolder(), mainTex, delay);
        autoCompiler.onWillCompile(() => handleCompilationStarted());
        autoCompiler.onDidCompile(result => handleCompilationResult(result));
        showPanelNotice('Auto-compile enabled', 'info', 3000);
    } else {
        autoCompiler?.disable();
        showPanelNotice('Auto-compile disabled', 'info', 3000);
    }

    refreshSidebar();
}

function cmdCancelCompilation() {
    if (latexCompiler?.isCompiling) {
        latexCompiler.cancel();
        showPanelNotice('LocalLeaf: Compilation cancelled', 'info', 4000);
    } else {
        showPanelNotice('LocalLeaf: No compilation in progress', 'info', 4000);
    }
}

// === Changes View Context Actions ===

async function cmdViewDiff(filePath: string) {
    if (!filePath) {
        showPanelNotice('Cannot open diff: missing file path', 'error');
        return;
    }
    if (!syncEngine) {
        showPanelNotice('Cannot open diff: sync engine is not ready', 'warning');
        return;
    }
    const engine = syncEngine;

    const settingsManager = SettingsManager.getCurrentInstance();
    if (!settingsManager) {
        showPanelNotice('Cannot open diff: no linked LocalLeaf project is active', 'warning');
        return;
    }

    const localPath = cleanChangePath(filePath);
    const pathCandidates = getChangePathCandidates(filePath);
    const tracker = engine.changeTracker;
    const findForChangePath = <T>(lookup: (path: string) => T | undefined): T | undefined => {
        for (const candidate of pathCandidates) {
            const result = lookup(candidate);
            if (result !== undefined) {
                return result;
            }
        }
        return undefined;
    };
    const localChange = findForChangePath(path => tracker.getLocalChange(path));
    const remoteChange = findForChangePath(path => tracker.getRemoteChange(path));
    let remoteContent = remoteChange?.remoteContent;
    let baseContent = findForChangePath(path => engine.getBaseContent(path));
    const plan = createChangeDiffPlan({
        localChangeType: localChange?.type,
        remoteChangeType: remoteChange?.type,
        hasRemoteContent: !!remoteContent,
        hasBaseContent: baseContent !== undefined,
    });

    if (plan.requiresRemoteContent) {
        try {
            for (const candidate of pathCandidates) {
                remoteContent = await engine.getRemoteContent(candidate);
                if (remoteContent !== undefined) {
                    break;
                }
            }
        } catch (error) {
            changesWebviewProvider.showNotice(`Cannot fetch remote content for ${filePath}: ${error}`, 'error');
            return;
        }
        if (remoteContent === undefined) {
            changesWebviewProvider.showNotice(`Cannot fetch remote content for ${filePath}`, 'error');
            return;
        }
    }

    baseContent = baseContent ?? (!remoteChange ? remoteContent : undefined);
    const localUri = settingsManager.getFilePath(localPath);
    const disposables: vscode.Disposable[] = [];

    const virtualUri = (content: Uint8Array | undefined): vscode.Uri => {
        const scheme = `localleaf-diff-${Date.now()}-${disposables.length}`;
        const text = new TextDecoder().decode(content ?? new Uint8Array(0));
        const provider = new (class implements vscode.TextDocumentContentProvider {
            provideTextDocumentContent(): string {
                return text;
            }
        })();
        disposables.push(vscode.workspace.registerTextDocumentContentProvider(scheme, provider));
        return vscode.Uri.from({ scheme, path: '/content' });
    };

    const sideUri = (side: DiffSide): vscode.Uri => {
        switch (side) {
            case 'base':
                return virtualUri(baseContent);
            case 'local':
                return localUri;
            case 'remote':
                return virtualUri(remoteContent);
            case 'empty':
                return virtualUri(undefined);
        }
    };

    const title = `${localPath || filePath} (${plan.titleKind})`;

    try {
        await vscode.commands.executeCommand('vscode.diff',
            sideUri(plan.left),
            sideUri(plan.right),
            title
        );
    } catch (error) {
        changesWebviewProvider.showNotice(`Cannot open diff for ${localPath || filePath}: ${error}`, 'error');
    } finally {
        // Keep providers alive while diff editors resolve their content.
        setTimeout(() => {
            for (const disposable of disposables) {
                disposable.dispose();
            }
        }, 60000);
    }
}

async function cmdResolveConflict(filePath: string, resolution: 'remote' | 'local') {
    if (!syncEngine || !filePath) return;

    try {
        if (resolution === 'remote') {
            await syncEngine.resolveConflictWithRemote(filePath);
        } else {
            await syncEngine.resolveConflictWithLocal(filePath);
        }
    } catch (error) {
        changesWebviewProvider.showNotice(`Failed to resolve "${filePath}": ${error}`, 'error');
        return;
    }

    const label = resolution === 'remote' ? 'remote' : 'local';
    changesWebviewProvider.showNotice(`Resolved "${filePath}" using ${label} version`, 'info', 4000);
}

async function cmdDiscardChange(filePath: string) {
    if (!syncEngine || !filePath) return;

    try {
        const reverted = await syncEngine.revertLocalChange(filePath);
        if (reverted) {
            changesWebviewProvider.showNotice(`Reverted local change "${filePath}"`, 'info', 4000);
        }
    } catch (error) {
        changesWebviewProvider.showNotice(`Failed to revert "${filePath}": ${error}`, 'error');
    }
}

async function cmdDiscardAllLocalChanges(paths?: string[]) {
    if (!syncEngine) return;

    const tracker = syncEngine.changeTracker;
    const targetPaths = paths && paths.length > 0
        ? paths
        : tracker.getLocalChanges()
            .filter(change => !tracker.hasRemoteChange(change.path))
            .map(change => change.path);

    if (targetPaths.length === 0) {
        return;
    }

    const choice = await showPanelModal({
        message: `Revert ${targetPaths.length} local change${targetPaths.length === 1 ? '' : 's'}? This will modify files on disk back to the last synced version.`,
        type: 'warning',
        buttons: [
            { label: 'Revert All', value: 'revert', danger: true },
            { label: 'Cancel', value: 'cancel' },
        ],
    });

    if (choice !== 'revert') {
        return;
    }

    try {
        const revertedCount = await syncEngine.revertLocalChanges(targetPaths);
        changesWebviewProvider.showNotice(`Reverted ${revertedCount} local change${revertedCount === 1 ? '' : 's'}`, 'info', 4000);
    } catch (error) {
        changesWebviewProvider.showNotice(`Failed to revert all local changes: ${error}`, 'error');
    }
}

/**
 * Open an existing LocalLeaf project discovered under the current workspace.
 */
async function cmdOpenLocalProject(context: vscode.ExtensionContext, workspaceUri: string) {
    let projectUri: vscode.Uri;
    try {
        projectUri = vscode.Uri.parse(workspaceUri);
    } catch {
        showPanelNotice('LocalLeaf: Invalid project folder', 'error');
        return;
    }

    const settingsManager = SettingsManager.getInstance(projectUri);
    if (!(await settingsManager.isLinked())) {
        showPanelNotice('LocalLeaf: Selected folder is not a LocalLeaf project', 'error');
        return;
    }

    const settings = await settingsManager.load();
    await activateLinkedProject(
        context,
        settingsManager,
        `LocalLeaf: Opened "${settings?.projectName || projectUri.fsPath}"`
    );
}

/**
 * Open a project from the sidebar (link + download)
 */
async function cmdOpenProject(context: vscode.ExtensionContext, project: ProjectInfo) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceFolder) {
        showPanelNotice('LocalLeaf: No workspace folder open', 'error');
        return;
    }

    const serverUrl = credentialManager.getDefaultServer();
    const credential = await credentialManager.getCredential(serverUrl);
    if (!credential) {
        showPanelNotice('LocalLeaf: Please login first', 'warning');
        return;
    }

    // Create settings
    SettingsManager.setCurrentWorkspaceFolder(workspaceFolder);
    const settingsManager = SettingsManager.getInstance(workspaceFolder);
    const settings = SettingsManager.createDefaultSettings(serverUrl, project.id, project.name);
    await settingsManager.save(settings);

    // Create default .leafignore
    const ignoreParser = new IgnoreParser(workspaceFolder);
    if (!(await ignoreParser.exists())) {
        await ignoreParser.createDefault();
    }

    await activateLinkedProject(context, settingsManager, `LocalLeaf: Linked to "${project.name}"`);
}

/**
 * Extension deactivation
 */
export async function deactivate() {
    stopStatusUpdates();
    gitCommitHook?.dispose();
    scmBridge?.dispose();

    if (autoCompiler) {
        autoCompiler.dispose();
    }
    if (latexCompiler) {
        latexCompiler.dispose();
    }
    if (syncEngine) {
        await syncEngine.disconnect();
    }
    if (cursorTracker) {
        cursorTracker.dispose();
    }
}
