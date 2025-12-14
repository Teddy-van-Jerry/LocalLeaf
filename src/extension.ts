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

/**
 * Extension activation
 */
export async function activate(context: vscode.ExtensionContext) {
    console.log('[LocalLeaf] Extension activating...');

    try {

    // Initialize output channel
    outputChannel = vscode.window.createOutputChannel(EXTENSION_NAME);
    context.subscriptions.push(outputChannel);

    // Share output channel with socketio module for logging
    setOutputChannel(outputChannel);
    outputChannel.appendLine('[LocalLeaf] Extension activating...');
    outputChannel.show(true); // Show output panel

    // Initialize credential manager
    credentialManager = CredentialManager.initialize(context);

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
    const settingsManager = SettingsManager.getCurrentInstance();
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

    // Watch for settings changes
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (workspaceFolder) {
        const settingsWatcher = createSettingsWatcher(workspaceFolder, async () => {
            log('Settings changed, reloading...');
            await settingsManager?.load();
        });
        context.subscriptions.push(settingsWatcher);
    }

    log('LocalLeaf activated');
    console.log('[LocalLeaf] Extension activated successfully');

    } catch (error) {
        console.error('[LocalLeaf] Activation error:', error);
        vscode.window.showErrorMessage(`LocalLeaf failed to activate: ${error}`);
    }
}

/**
 * Register all commands
 */
function registerCommands(context: vscode.ExtensionContext) {
    console.log('[LocalLeaf] Registering commands...');
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.LOGIN, cmdLogin),
        vscode.commands.registerCommand(COMMANDS.LOGOUT, cmdLogout),
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
    );
    console.log('[LocalLeaf] Commands registered successfully');
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
    syncEngine = new SyncEngine(api, settings);

    // Listen to status changes
    syncEngine.onStatusChange(event => {
        updateStatusBar(event.status, event.message);
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

        // Auto-pull on project load
        try {
            log('Auto-pulling files from Overleaf...');
            await syncEngine.pullAll();
            log('Auto-pull complete');
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
        idle: '$(cloud)',
        syncing: '$(sync~spin)',
        pulling: '$(cloud-download)',
        pushing: '$(cloud-upload)',
        error: '$(warning)',
        disconnected: '$(cloud-offline)',
    };

    statusBarItem.text = `${icons[status]} LocalLeaf`;
    statusBarItem.tooltip = new vscode.MarkdownString(`**LocalLeaf** - ${message || status}`);
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

    if (credential) {
        loginStatusItem.text = `$(account) ${credential.userEmail}`;
        loginStatusItem.tooltip = new vscode.MarkdownString(
            `**Logged in to Overleaf**\n\n` +
            `Email: ${credential.userEmail}\n\n` +
            `Server: ${credential.serverUrl}`
        );
        loginStatusItem.backgroundColor = undefined;
        loginStatusItem.command = COMMANDS.LOGOUT;
    } else {
        loginStatusItem.text = '$(account) Not logged in';
        loginStatusItem.tooltip = 'Click to login to Overleaf';
        loginStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        loginStatusItem.command = COMMANDS.LOGIN;
    }

    loginStatusItem.show();
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
            await updateLoginStatus();
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
            await updateLoginStatus();
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

    const serverUrl = credentialManager.getDefaultServer();
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

    updateStatusBar('disconnected', 'Logged out');
    await updateLoginStatus();
    vscode.window.showInformationMessage('LocalLeaf: Logged out');
}

/**
 * Link current folder to an Overleaf project
 */
async function cmdLinkFolder(context: vscode.ExtensionContext) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('LocalLeaf: No workspace folder open');
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

    // Get projects list
    const api = new BaseAPI(serverUrl);
    api.setIdentity(credential.identity);

    const projectsResult = await api.getProjects();
    if (projectsResult.type !== 'success' || !projectsResult.projects) {
        vscode.window.showErrorMessage(`LocalLeaf: Failed to get projects - ${projectsResult.message}`);
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
    const settingsManager = SettingsManager.getInstance(workspaceFolder);
    const settings = SettingsManager.createDefaultSettings(serverUrl, project.id, project.name);
    await settingsManager.save(settings);

    // Create default .leafignore
    const ignoreParser = new IgnoreParser(workspaceFolder);
    if (!(await ignoreParser.exists())) {
        await ignoreParser.createDefault();
    }

    vscode.window.showInformationMessage(`LocalLeaf: Linked to "${project.name}"`);

    // Show status bars now that we're linked
    statusBarItem.show();
    await updateLoginStatus();

    // Initialize sync (this will auto-pull)
    await initializeSync(context, settingsManager);
}

/**
 * Unlink current folder
 */
async function cmdUnlinkFolder() {
    const settingsManager = SettingsManager.getCurrentInstance();
    if (!settingsManager || !(await settingsManager.isLinked())) {
        vscode.window.showInformationMessage('LocalLeaf: This folder is not linked');
        return;
    }

    const confirm = await vscode.window.showWarningMessage(
        'Are you sure you want to unlink this folder from Overleaf?',
        { modal: true },
        'Unlink'
    );

    if (confirm !== 'Unlink') return;

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

    updateStatusBar('disconnected');
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
 * Show sync status
 */
async function cmdShowSyncStatus() {
    const settingsManager = SettingsManager.getCurrentInstance();
    const settings = settingsManager?.getSettings();

    const items: vscode.QuickPickItem[] = [];

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
            description: syncEngine?.status || 'disconnected',
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

    if (selected?.label.includes('Jump to collaborator')) {
        await cursorTracker?.jumpToUser();
    } else if (selected?.label.includes('Unlink folder')) {
        await cmdUnlinkFolder();
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
        value: settingsManager.getSettings()?.mainTex || 'main.tex',
    });

    if (!mainTex) return;

    const mainPdf = mainTex.replace(/\.tex$/, '.pdf');

    await settingsManager.update({ mainTex, mainPdf });
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
async function cmdJumpToCollaborator() {
    if (!cursorTracker) {
        vscode.window.showWarningMessage('LocalLeaf: Not connected');
        return;
    }

    await cursorTracker.jumpToUser();
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
