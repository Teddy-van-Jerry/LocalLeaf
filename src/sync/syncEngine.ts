/**
 * LocalLeaf Sync Engine
 * Handles real-time bidirectional sync between local files and Overleaf
 */

import * as vscode from 'vscode';
import { BaseAPI, ProjectEntity, FileEntity, FolderEntity } from '../api/base';
import { SocketIOAPI, DocumentUpdate } from '../api/socketio';
import { SettingsManager } from '../utils/settingsManager';
import { IgnoreParser, createIgnoreWatcher } from './ignoreParser';
import { ChangeTracker, SyncMode, PendingChange } from './changeTracker';
import { BaselineReplacement, SyncBaselineStore } from './syncBaseline';
import {
    getLocalCreateChangeType,
    getManualSyncCompletionState,
    getRestoredLocalChangeType,
    shouldTrackLocalDelete,
    shouldTrackLocalModification,
} from './syncPolicy';
import { DEBOUNCE_DELAY } from '../consts';

/**
 * File cache entry for change detection
 */
interface FileCache {
    hash: number;
    timestamp: number;
}

/**
 * Sync status
 */
export type SyncStatus = 'idle' | 'syncing' | 'pulling' | 'pushing' | 'error' | 'disconnected';

/**
 * Sync status change event
 */
export interface SyncStatusEvent {
    status: SyncStatus;
    message?: string;
    file?: string;
    authError?: boolean;
}

export interface SyncEngineUiButton {
    label: string;
    value: string;
    primary?: boolean;
    danger?: boolean;
}

export interface SyncEngineUi {
    showModal(request: {
        message: string;
        type?: 'info' | 'warning' | 'error';
        buttons: SyncEngineUiButton[];
    }): Promise<string>;
    showNotice(message: string, type: 'info' | 'warning' | 'error', autoDismissMs?: number): void;
}

/**
 * Hash function for content comparison
 */
function hashContent(content: Uint8Array | undefined): number {
    if (!content) return -1;
    const str = new TextDecoder().decode(content);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const chr = str.charCodeAt(i);
        hash = (hash << 5) - hash + chr;
        hash |= 0;
    }
    return hash;
}

/**
 * Check if an error is a FileNotFound error (race condition safe)
 * This handles the case where a file is deleted between the watcher event and the read
 */
function isFileNotFoundError(error: unknown): boolean {
    if (error instanceof vscode.FileSystemError) {
        // VS Code FileSystemError has a 'code' property
        return error.code === 'FileNotFound' || error.code === 'EntryNotFound';
    }
    // Also check error message as fallback
    if (error instanceof Error) {
        const msg = error.message.toLowerCase();
        return msg.includes('entrynotfound') || msg.includes('filenotfound') || msg.includes('enoent');
    }
    return false;
}

function isFileAlreadyExistsError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();
    return normalized.includes('400') && normalized.includes('file already exists');
}

/**
 * Compare two Uint8Arrays for equality
 */
function contentEquals(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

/**
 * Debug logging - only logs in debug mode
 */
const DEBUG = false;
function debugLog(...args: unknown[]): void {
    if (DEBUG) {
        console.log('[LocalLeaf]', ...args);
    }
}

/**
 * Check if an error indicates session expiration
 */
function isAuthError(error: unknown): boolean {
    if (!error) return false;
    const errorStr = String(error).toLowerCase();
    return errorStr.includes('session expired') ||
           errorStr.includes('403') ||
           errorStr.includes('401') ||
           errorStr.includes('unauthorized');
}

/**
 * File entry in the project tree
 */
interface FileTreeEntry {
    id: string;
    type: 'doc' | 'file' | 'folder';
    name: string;
    path: string;
    parentId?: string;
}

interface LineEdit {
    start: number;
    end: number;
    newLines: string[];
}

interface PushChangesOptions {
    force?: boolean;
    paths?: string[];
    fileExistsRetry?: boolean;
}

interface PullAllOptions {
    remoteWins?: boolean;
}

/**
 * Sync Engine - manages real-time file synchronization
 */
export class SyncEngine {
    private socket?: SocketIOAPI;
    private project?: ProjectEntity;
    private localWatcher?: vscode.FileSystemWatcher;
    private fileTree: Map<string, FileTreeEntry> = new Map();
    private fileTreeByPath: Map<string, FileTreeEntry> = new Map();
    private fileCache: Map<string, FileCache> = new Map();
    private baseContent: Map<string, Uint8Array> = new Map();
    private readonly baselineStore: SyncBaselineStore;
    private baselineSaveTimer?: NodeJS.Timeout;
    private baselineSavePromise: Promise<void> = Promise.resolve();
    private pendingRemoteDocContent: Map<string, Uint8Array> = new Map();
    private docPushTimers: Map<string, NodeJS.Timeout> = new Map();
    private pendingRemoteApplyTimers: Map<string, NodeJS.Timeout> = new Map();
    private ignoreParser: IgnoreParser;
    private ignoreWatcher?: vscode.FileSystemWatcher;
    private _status: SyncStatus = 'disconnected';
    private _onStatusChange = new vscode.EventEmitter<SyncStatusEvent>();
    private disposables: vscode.Disposable[] = [];
    private syncLock: Set<string> = new Set();
    private lockQueues: Map<string, Array<() => void>> = new Map();
    private joinedDocs: Set<string> = new Set();
    private logFn?: (message: string) => void;

    /** Change tracker for manual sync mode */
    private _changeTracker: ChangeTracker = new ChangeTracker();
    /** Current sync mode */
    private _syncMode: SyncMode = 'manual';
    /** Paths recently pushed; used to suppress echo from server in manual mode */
    private _recentlyPushedPaths: Set<string> = new Set();
    /** Paths currently being updated from remote; suppresses echo in handleLocalFileChange */
    private _remoteUpdatingPaths: Set<string> = new Set();
    /** True while pullAll/pullChanges is writing files; suppresses watcher echo */
    private _isPulling: boolean = false;

    readonly onStatusChange = this._onStatusChange.event;

    constructor(
        private readonly api: BaseAPI,
        private readonly settings: SettingsManager,
        logFn?: (message: string) => void,
        private readonly ui?: SyncEngineUi,
    ) {
        const workspaceFolder = settings.getWorkspaceFolder();
        this.ignoreParser = new IgnoreParser(workspaceFolder, settings.getSettings());
        this.baselineStore = new SyncBaselineStore(workspaceFolder.fsPath);
        this.logFn = logFn;

        // Initialize sync mode from settings
        const projectSettings = settings.getSettings();
        if (projectSettings?.syncMode) {
            this._syncMode = projectSettings.syncMode;
        }
    }

    private log(message: string): void {
        this.logFn?.(message);
    }

    private async showModalChoice(request: {
        message: string;
        type?: 'info' | 'warning' | 'error';
        buttons: SyncEngineUiButton[];
    }, fallbackValue: string = 'cancel'): Promise<string> {
        if (!this.ui) {
            return fallbackValue;
        }
        return this.ui.showModal(request);
    }

    private setBaseContent(path: string, content: Uint8Array): void {
        this.baseContent.set(path, content);
        this.scheduleBaselineSave();
    }

    private deleteBaseContent(path: string): void {
        this.baseContent.delete(path);
        this.scheduleBaselineSave();
    }

    private scheduleBaselineSave(): void {
        if (this.baselineSaveTimer) {
            clearTimeout(this.baselineSaveTimer);
        }
        this.baselineSaveTimer = setTimeout(() => {
            this.baselineSaveTimer = undefined;
            void this.flushPersistedBaseline();
        }, DEBOUNCE_DELAY);
    }

    private async loadPersistedBaseline(): Promise<void> {
        const snapshot = await this.baselineStore.load();
        let loadedCount = 0;

        for (const entry of snapshot.entries) {
            const content = entry.entityType === 'folder'
                ? new Uint8Array(0)
                : await this.baselineStore.getContent(entry.path);
            if (!content) {
                continue;
            }
            this.baseContent.set(entry.path, content);
            this.fileCache.set(entry.path, {
                hash: entry.hash,
                timestamp: entry.timestamp,
            });
            loadedCount++;
        }

        if (loadedCount > 0) {
            this.log(`Loaded ${loadedCount} persisted sync baseline entr${loadedCount === 1 ? 'y' : 'ies'}`);
        }
    }

    private buildBaselineReplacements(): BaselineReplacement[] {
        const replacements: BaselineReplacement[] = [];
        const now = Date.now();

        for (const [path, content] of this.baseContent) {
            const entry = this.fileTreeByPath.get(path);
            const cache = this.fileCache.get(path);
            const entityType = entry?.type ?? (path.endsWith('/') ? 'folder' : undefined);

            replacements.push({
                entry: {
                    path,
                    entityId: entry?.id,
                    entityType,
                    hash: cache?.hash ?? hashContent(content),
                    timestamp: cache?.timestamp ?? now,
                },
                content: entityType === 'folder' ? undefined : content,
            });
        }

        return replacements;
    }

    private async flushPersistedBaseline(): Promise<void> {
        if (this.baselineSaveTimer) {
            clearTimeout(this.baselineSaveTimer);
            this.baselineSaveTimer = undefined;
        }

        const replacements = this.buildBaselineReplacements();
        this.baselineSavePromise = this.baselineSavePromise
            .catch(() => undefined)
            .then(() => this.baselineStore.replaceAll(replacements))
            .catch(error => {
                this.log(`Failed to persist sync baseline: ${error}`);
            });
        await this.baselineSavePromise;
    }

    private getPendingCounts(): { localChangeCount: number; remoteChangeCount: number; conflictCount: number } {
        return {
            localChangeCount: this._changeTracker.getLocalChangeCount(),
            remoteChangeCount: this._changeTracker.getRemoteChangeCount(),
            conflictCount: this._changeTracker.getConflictCount(),
        };
    }

    private getPendingSummary(): string {
        const counts = this.getPendingCounts();
        if (counts.conflictCount > 0) {
            return `${counts.conflictCount} conflict(s) need resolution`;
        }
        if (counts.remoteChangeCount > 0) {
            return `${counts.remoteChangeCount} remote change(s) still pending`;
        }
        if (counts.localChangeCount > 0) {
            return `${counts.localChangeCount} local change(s) ready to push`;
        }
        return '';
    }

    private async updateLastSyncedIfFullySynced(): Promise<boolean> {
        await this.flushPersistedBaseline();
        const completion = getManualSyncCompletionState(this.getPendingCounts());
        if (!completion.canComplete) {
            return false;
        }
        await this.settings.updateLastSynced();
        return true;
    }

    /**
     * Get current sync status
     */
    get status(): SyncStatus {
        return this._status;
    }

    /**
     * Check if any base content has been synced (false = first-time project setup)
     */
    hasBaseContent(): boolean {
        return this.baseContent.size > 0;
    }

    /**
     * Get the last synced baseline content for a file.
     */
    getBaseContent(relativePath: string): Uint8Array | undefined {
        const content = this.baseContent.get(relativePath);
        return content ? new Uint8Array(content) : undefined;
    }

    private getParentUri(uri: vscode.Uri): vscode.Uri {
        return vscode.Uri.joinPath(uri, '..');
    }

    /**
     * Set status and emit event
     */
    private setStatus(status: SyncStatus, message?: string, file?: string, authError: boolean = false): void {
        this._status = status;
        this._onStatusChange.fire({ status, message, file, authError });
    }

    /**
     * Get the change tracker instance
     */
    get changeTracker(): ChangeTracker {
        return this._changeTracker;
    }

    /**
     * Get current sync mode
     */
    get syncMode(): SyncMode {
        return this._syncMode;
    }

    /**
     * Set sync mode with transition logic
     */
    async setSyncMode(mode: SyncMode, options?: { skipConfirmation?: boolean }): Promise<void> {
        if (this._syncMode === mode) return;

        const oldMode = this._syncMode;
        this._syncMode = mode;
        this.log(`Sync mode changed: ${oldMode} -> ${mode}`);

        if (mode === 'realtime' && !options?.skipConfirmation) {
            // Switching to realtime: apply any pending changes first
            const hasLocal = this._changeTracker.getLocalChangeCount() > 0;
            const hasRemote = this._changeTracker.getRemoteChangeCount() > 0;

            if (hasLocal || hasRemote) {
                const choice = await this.showModalChoice({
                    message: 'You have pending changes. Apply them before switching to real-time mode?',
                    type: 'warning',
                    buttons: [
                        { label: 'Apply & Switch', value: 'apply', primary: true },
                        { label: 'Discard & Switch', value: 'discard', danger: true },
                        { label: 'Cancel', value: 'cancel' },
                    ],
                });

                if (choice === 'cancel') {
                    this._syncMode = oldMode;
                    return;
                }

                if (choice === 'apply') {
                    if (hasRemote) await this.pullChanges();
                    if (hasLocal) await this.pushChanges();
                } else {
                    this._changeTracker.clearAll();
                }
            }
        }

        // Save to settings
        await this.settings.update({ syncMode: mode });
    }

    /**
     * Initialize and connect to Overleaf
     */
    async connect(): Promise<void> {
        const projectSettings = this.settings.getSettings();
        if (!projectSettings) {
            throw new Error('Project not configured');
        }

        this.setStatus('syncing', 'Connecting...');

        // Load ignore patterns
        await this.ignoreParser.load();
        await this.loadPersistedBaseline();
        this.setupIgnoreWatcher();

        // Create socket connection
        const identity = this.api.getIdentity();
        if (!identity) {
            throw new Error('Not authenticated');
        }

        // Try socket.io first, fall back to HTTP-only mode
        let useHttpFallback = false;
        try {
            this.socket = new SocketIOAPI(this.api, identity, projectSettings.projectId);

            // Register socket event handlers
            this.socket.registerHandlers({
                onConnected: () => this.setStatus('idle', 'Connected (real-time)'),
                onDisconnected: (isAuthError?: boolean) => {
                    if (isAuthError) {
                        this.setStatus('error', 'Session expired', undefined, true);
                    } else {
                        this.setStatus('disconnected', 'Disconnected');
                    }
                },
                onFileCreated: (parentId, type, entity) => this.handleRemoteFileCreated(parentId, type, entity),
                onFileRenamed: (entityId, newName) => this.handleRemoteFileRenamed(entityId, newName),
                onFileRemoved: (entityId) => this.handleRemoteFileRemoved(entityId),
                onFileMoved: (entityId, newParentId) => this.handleRemoteFileMoved(entityId, newParentId),
                onFileChanged: (update) => this.handleRemoteFileChanged(update),
            });

            // Join project via socket.io
            this.project = await this.socket.joinProject();
            this.buildFileTree(this.project);
            this.setStatus('idle', 'Connected (real-time)');
        } catch (error) {
            debugLog('Socket.io failed, using HTTP fallback:', error);
            useHttpFallback = true;
        }

        // HTTP fallback - use REST API instead of socket.io
        if (useHttpFallback) {
            this.setStatus('syncing', 'Connecting via HTTP...');
            this.socket = undefined;

            try {
                // Get project details via HTTP
                const projectResult = await this.api.getProjectDetails(projectSettings.projectId);
                if (projectResult.type !== 'success' || !projectResult.projectData) {
                    throw new Error(projectResult.message || 'Failed to get project details');
                }

                const projectData = projectResult.projectData;
                debugLog('HTTP fallback - project data:', projectData.projectName);

                // Build file tree from rootFolder if available
                if (projectData.rootFolder && projectData.rootFolder.length > 0) {
                    this.project = {
                        _id: projectData.projectId,
                        name: projectData.projectName || 'Unknown',
                        rootDoc_id: projectData.rootDocId,
                        rootFolder: projectData.rootFolder,
                        compiler: projectData.compiler,
                        owner: { _id: projectData.userId || '', email: projectData.userEmail || '', first_name: 'Unknown' },
                        members: [],
                    };
                    this.buildFileTree(this.project);
                } else {
                    // Fallback: get entities list and build minimal tree
                    const entitiesResult = await this.api.getProjectEntities(projectSettings.projectId);
                    if (entitiesResult.type === 'success' && entitiesResult.entities) {
                        // Create minimal project object for HTTP-only mode
                        this.project = {
                            _id: projectSettings.projectId,
                            name: projectSettings.projectName || 'Unknown',
                            rootDoc_id: undefined,
                            rootFolder: [],
                            compiler: 'pdflatex',
                            owner: { _id: '', email: '', first_name: 'Unknown' },
                            members: [],
                        };
                        this.buildFileTreeFromEntities(entitiesResult.entities);
                    }
                }

                this.setStatus('idle', 'Connected (HTTP mode)');
            } catch (httpError) {
                const authErr = isAuthError(httpError);
                this.setStatus('error', authErr ? 'Session expired' : `Failed to connect: ${httpError}`, undefined, authErr);
                throw httpError;
            }
        }

        // Setup local file watcher
        this.setupLocalWatcher();
    }

    /**
     * Build file tree from entities list (HTTP fallback)
     */
    private buildFileTreeFromEntities(entities: Array<{ path: string; type: string }>): void {
        this.fileTree.clear();
        this.fileTreeByPath.clear();

        for (const entity of entities) {
            const path = '/' + entity.path;
            const name = path.split('/').pop() || '';
            const parentPath = path.substring(0, path.lastIndexOf('/') + 1) || '/';

            // Generate a pseudo-ID based on path (since we don't have real IDs)
            const id = Buffer.from(path).toString('base64').replace(/[^a-zA-Z0-9]/g, '').substring(0, 24);

            const entry: FileTreeEntry = {
                id,
                type: entity.type === 'folder' ? 'folder' : (entity.type === 'doc' ? 'doc' : 'file'),
                name,
                path: entity.type === 'folder' ? path + '/' : path,
                parentId: undefined, // We don't have parent IDs in this mode
            };

            this.fileTree.set(id, entry);
            this.fileTreeByPath.set(entry.path, entry);
        }
    }

    private async refreshProjectFileTree(): Promise<void> {
        const projectSettings = this.settings.getSettings();
        if (!projectSettings) {
            throw new Error('Project not configured');
        }

        const projectResult = await this.api.getProjectDetails(projectSettings.projectId);
        if (projectResult.type === 'success' && projectResult.projectData) {
            const projectData = projectResult.projectData;
            if (projectData.rootFolder && projectData.rootFolder.length > 0) {
                this.project = {
                    _id: projectData.projectId,
                    name: projectData.projectName || projectSettings.projectName || 'Unknown',
                    rootDoc_id: projectData.rootDocId,
                    rootFolder: projectData.rootFolder,
                    compiler: projectData.compiler,
                    owner: { _id: projectData.userId || '', email: projectData.userEmail || '', first_name: 'Unknown' },
                    members: [],
                };
                this.buildFileTree(this.project);
                return;
            }
        }

        if (this.socket) {
            this.project = await this.socket.joinProject();
            this.buildFileTree(this.project);
            return;
        }

        throw new Error(projectResult.message || 'Failed to refresh Overleaf file tree');
    }

    /**
     * Build file tree from project structure
     */
    private buildFileTree(project: ProjectEntity): void {
        debugLog('buildFileTree: Building tree for project', project.name);
        debugLog('buildFileTree: rootFolder count:', project.rootFolder?.length || 0);

        this.fileTree.clear();
        this.fileTreeByPath.clear();

        const traverse = (folder: FolderEntity, parentPath: string, parentId?: string, isRoot: boolean = false) => {
            // For root folder, don't add the folder itself, just its contents at /
            const folderPath = isRoot ? '/' : parentPath + folder.name + '/';

            // Add folder entry (skip for root folder)
            if (!isRoot) {
                const folderEntry: FileTreeEntry = {
                    id: folder._id,
                    type: 'folder',
                    name: folder.name,
                    path: folderPath,
                    parentId,
                };
                this.fileTree.set(folder._id, folderEntry);
                this.fileTreeByPath.set(folderPath, folderEntry);
            } else {
                // Store root folder ID for reference
                const rootEntry: FileTreeEntry = {
                    id: folder._id,
                    type: 'folder',
                    name: '',
                    path: '/',
                    parentId: undefined,
                };
                this.fileTree.set(folder._id, rootEntry);
                this.fileTreeByPath.set('/', rootEntry);
            }

            // Add docs
            for (const doc of folder.docs || []) {
                const docPath = folderPath + doc.name;
                const entry: FileTreeEntry = {
                    id: doc._id,
                    type: 'doc',
                    name: doc.name,
                    path: docPath,
                    parentId: folder._id,
                };
                this.fileTree.set(doc._id, entry);
                this.fileTreeByPath.set(docPath, entry);
                debugLog('buildFileTree: Added doc', docPath);
            }

            // Add file refs
            for (const file of folder.fileRefs || []) {
                const filePath = folderPath + file.name;
                const entry: FileTreeEntry = {
                    id: file._id,
                    type: 'file',
                    name: file.name,
                    path: filePath,
                    parentId: folder._id,
                };
                this.fileTree.set(file._id, entry);
                this.fileTreeByPath.set(filePath, entry);
                debugLog('buildFileTree: Added file', filePath);
            }

            // Recurse into subfolders
            for (const subfolder of folder.folders || []) {
                traverse(subfolder as FolderEntity, folderPath, folder._id, false);
            }
        };

        // Start from root folder - treat it as root (don't include its name in paths)
        if (project.rootFolder && project.rootFolder.length > 0) {
            traverse(project.rootFolder[0], '', undefined, true);
        }

        debugLog('buildFileTree: Total entries:', this.fileTree.size);
    }

    /**
     * Detect and update main document from project's rootDoc_id
     */
    async detectMainDocument(): Promise<void> {
        if (!this.project?.rootDoc_id) return;

        const rootDocEntry = this.fileTree.get(this.project.rootDoc_id);
        if (!rootDocEntry || rootDocEntry.type !== 'doc') return;

        const mainTex = rootDocEntry.path.startsWith('/')
            ? rootDocEntry.path.slice(1)  // Remove leading slash
            : rootDocEntry.path;
        const mainPdf = mainTex.replace(/\.tex$/, '.pdf');

        const currentSettings = this.settings.getSettings();
        if (currentSettings && (currentSettings.mainTex !== mainTex || currentSettings.mainPdf !== mainPdf)) {
            await this.settings.update({ mainTex, mainPdf });
            this.ignoreParser.updateSettings({ ...currentSettings, mainTex, mainPdf });
            debugLog('Updated main document:', mainTex, mainPdf);
        }
    }

    /**
     * Setup local file system watcher
     */
    private setupLocalWatcher(): void {
        const workspaceFolder = this.settings.getWorkspaceFolder();
        const pattern = new vscode.RelativePattern(workspaceFolder, '**/*');

        this.localWatcher = vscode.workspace.createFileSystemWatcher(pattern);

        this.disposables.push(
            this.localWatcher.onDidChange(uri => this.handleLocalFileChange(uri)),
            this.localWatcher.onDidCreate(uri => this.handleLocalFileCreate(uri)),
            this.localWatcher.onDidDelete(uri => this.handleLocalFileDelete(uri)),
            vscode.workspace.onDidChangeTextDocument(e => this.handleTextDocumentChange(e)),
            vscode.workspace.onDidSaveTextDocument(doc => this.handleTextDocumentSaved(doc)),
            vscode.workspace.onDidCloseTextDocument(doc => this.handleTextDocumentClosed(doc)),
            this.localWatcher
        );
    }

    /**
     * Get relative path from URI
     */
    private getRelativePath(uri: vscode.Uri): string {
        const workspacePath = this.settings.getWorkspaceFolder().path;
        return uri.path.slice(workspacePath.length);
    }

    /**
     * Check if path should be synced (not ignored)
     */
    private shouldSync(relativePath: string): boolean {
        if (this.isAlwaysIgnoredPath(relativePath)) {
            return false;
        }
        return !this.ignoreParser.shouldIgnore(relativePath);
    }

    private setupIgnoreWatcher(): void {
        this.ignoreWatcher?.dispose();
        const workspaceFolder = this.settings.getWorkspaceFolder();
        this.ignoreWatcher = createIgnoreWatcher(
            workspaceFolder,
            () => void this.reloadIgnorePatternsAndPruneChanges(),
        );
        this.disposables.push(this.ignoreWatcher);
    }

    private async reloadIgnorePatternsAndPruneChanges(): Promise<void> {
        await this.ignoreParser.load();
        const removedCount = this.pruneIgnoredTrackedChanges();
        if (removedCount > 0) {
            this.log(`Ignore patterns updated; removed ${removedCount} pending ignored change${removedCount === 1 ? '' : 's'}`);
        }
    }

    private pruneIgnoredTrackedChanges(): number {
        let removedCount = 0;

        for (const change of this._changeTracker.getLocalChanges()) {
            if (!this.shouldSync(change.path)) {
                this._changeTracker.clearLocal(change.path);
                removedCount++;
            }
        }

        for (const change of this._changeTracker.getRemoteChanges()) {
            if (!this.shouldSync(change.path)) {
                this._changeTracker.clearRemote(change.path);
                removedCount++;
            }
        }

        return removedCount;
    }

    /**
     * Internal hard ignore list for transient local files that should never be synced.
     * These are independent of user .leafignore content.
     */
    private isAlwaysIgnoredPath(relativePath: string): boolean {
        const name = relativePath.split('/').pop()?.toLowerCase() || '';
        return name.endsWith('.git');
    }

    /**
     * Get relative path if a URI belongs to current workspace.
     */
    private tryGetRelativePath(uri: vscode.Uri): string | undefined {
        const workspacePath = this.settings.getWorkspaceFolder().path;
        if (!uri.path.startsWith(workspacePath)) {
            return undefined;
        }
        return uri.path.slice(workspacePath.length);
    }

    /**
     * Get open text document by synced relative path.
     */
    private getOpenTextDocument(relativePath: string): vscode.TextDocument | undefined {
        const targetUri = this.settings.getFilePath(relativePath);
        return vscode.workspace.textDocuments.find(d => d.uri.toString() === targetUri.toString());
    }

    /**
     * Apply content to an open document buffer without touching on-disk file.
     * Returns true if the buffer update succeeded.
     */
    private async applyContentToOpenDocument(
        path: string,
        doc: vscode.TextDocument,
        content: Uint8Array
    ): Promise<boolean> {
        const text = new TextDecoder().decode(content);
        if (doc.getText() === text) {
            return true;
        }

        this._remoteUpdatingPaths.add(path);
        try {
            const fullRange = new vscode.Range(
                doc.positionAt(0),
                doc.positionAt(doc.getText().length)
            );

            const visibleEditor = vscode.window.visibleTextEditors.find(
                e => e.document.uri.toString() === doc.uri.toString()
            );

            if (visibleEditor) {
                return await visibleEditor.edit((editBuilder) => {
                    editBuilder.replace(fullRange, text);
                }, { undoStopBefore: false, undoStopAfter: false });
            }

            const edit = new vscode.WorkspaceEdit();
            edit.replace(doc.uri, fullRange, text);
            return await vscode.workspace.applyEdit(edit);
        } finally {
            this._remoteUpdatingPaths.delete(path);
        }
    }

    /**
     * Apply merged content to an active dirty editor via disk write + revert.
     * This keeps remote-applied content out of the editor undo stack.
     */
    private async applyDirtyDocViaDiskRevert(
        path: string,
        doc: vscode.TextDocument,
        content: Uint8Array
    ): Promise<boolean> {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor || activeEditor.document.uri.toString() !== doc.uri.toString()) {
            return false;
        }

        const beforeSelections = activeEditor.selections;
        const beforeVisible = activeEditor.visibleRanges;

        this._remoteUpdatingPaths.add(path);
        try {
            await vscode.workspace.fs.writeFile(doc.uri, content);
            await vscode.commands.executeCommand('workbench.action.files.revert');

            const afterEditor = vscode.window.activeTextEditor;
            if (afterEditor && afterEditor.document.uri.toString() === doc.uri.toString()) {
                afterEditor.selections = beforeSelections;
                if (beforeVisible.length > 0) {
                    afterEditor.revealRange(beforeVisible[0]);
                }
            }
            return true;
        } finally {
            this._remoteUpdatingPaths.delete(path);
        }
    }

    /**
     * Handle in-memory text edits for unsaved realtime doc syncing.
     */
    private handleTextDocumentChange(event: vscode.TextDocumentChangeEvent): void {
        if (this._syncMode !== 'realtime') {
            return;
        }
        if (!this.socket) {
            return;
        }

        if (event.contentChanges.length === 0) {
            return;
        }

        const doc = event.document;
        if (doc.uri.scheme !== 'file') {
            return;
        }

        const relativePath = this.tryGetRelativePath(doc.uri);
        if (!relativePath || !this.shouldSync(relativePath)) {
            return;
        }

        if (this._remoteUpdatingPaths.has(relativePath)) {
            return;
        }

        const entry = this.fileTreeByPath.get(relativePath);
        if (!entry || entry.type !== 'doc') {
            return;
        }

        const existingTimer = this.docPushTimers.get(relativePath);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        const timer = setTimeout(async () => {
            this.docPushTimers.delete(relativePath);

            const currentDoc = this.getOpenTextDocument(relativePath);
            if (!currentDoc) {
                return;
            }

            const content = new TextEncoder().encode(currentDoc.getText());
            if (!this.shouldPropagate('push', relativePath, content)) {
                return;
            }

            await this.acquireLock(relativePath);
            try {
                const currentEntry = this.fileTreeByPath.get(relativePath);
                if (!currentEntry || currentEntry.type !== 'doc') {
                    return;
                }

                this.setStatus('pushing', `Uploading ${relativePath}`, relativePath);
                const pushed = await this.pushDocumentChanges(currentEntry.id, relativePath, content);
                if (pushed) {
                    this.log(`Pushed to Overleaf: ${relativePath}`);
                }

                this.setBaseContent(relativePath, content);
                this.fileCache.set(relativePath, { hash: hashContent(content), timestamp: Date.now() });
                this.setStatus('idle');
            } catch (error) {
                console.error(`[LocalLeaf] Failed to sync in-memory doc ${relativePath}:`, error);
                const authErr = isAuthError(error);
                this.setStatus('error', authErr ? 'Session expired' : `Failed to sync: ${error}`, undefined, authErr);
            } finally {
                this.releaseLock(relativePath);
            }
        }, DEBOUNCE_DELAY);

        this.docPushTimers.set(relativePath, timer);
    }

    /**
     * Handle doc save event to reconcile queued remote updates.
     */
    private handleTextDocumentSaved(doc: vscode.TextDocument): void {
        if (doc.uri.scheme !== 'file') {
            return;
        }
        const relativePath = this.tryGetRelativePath(doc.uri);
        if (!relativePath) {
            return;
        }

        // Saved content is now on disk; clear immediate push debounce.
        const existingTimer = this.docPushTimers.get(relativePath);
        if (existingTimer) {
            clearTimeout(existingTimer);
            this.docPushTimers.delete(relativePath);
        }

        if (this.pendingRemoteDocContent.has(relativePath)) {
            // Give local save-triggered push time to settle before applying queued remote.
            this.schedulePendingRemoteApply(relativePath, DEBOUNCE_DELAY * 2);
        }
    }

    /**
     * Handle doc close event to apply queued remote content if needed.
     */
    private handleTextDocumentClosed(doc: vscode.TextDocument): void {
        if (doc.uri.scheme !== 'file') {
            return;
        }
        const relativePath = this.tryGetRelativePath(doc.uri);
        if (!relativePath) {
            return;
        }

        const existingTimer = this.docPushTimers.get(relativePath);
        if (existingTimer) {
            clearTimeout(existingTimer);
            this.docPushTimers.delete(relativePath);
        }

        if (this.pendingRemoteDocContent.has(relativePath)) {
            this.schedulePendingRemoteApply(relativePath, 0);
        }
    }

    /**
     * Schedule applying queued remote content for a path.
     */
    private schedulePendingRemoteApply(path: string, delayMs: number): void {
        const existing = this.pendingRemoteApplyTimers.get(path);
        if (existing) {
            clearTimeout(existing);
        }

        const timer = setTimeout(async () => {
            this.pendingRemoteApplyTimers.delete(path);
            await this.applyPendingRemoteUpdate(path);
        }, delayMs);
        this.pendingRemoteApplyTimers.set(path, timer);
    }

    /**
     * Apply queued remote doc snapshot once local editor buffer is no longer dirty.
     */
    private async applyPendingRemoteUpdate(path: string): Promise<void> {
        const queued = this.pendingRemoteDocContent.get(path);
        if (!queued) {
            return;
        }

        const entry = this.fileTreeByPath.get(path);
        if (!entry || entry.type !== 'doc') {
            this.pendingRemoteDocContent.delete(path);
            return;
        }

        const openDoc = this.getOpenTextDocument(path);
        if (openDoc?.isDirty) {
            return;
        }

        await this.acquireLock(path);
        try {
            const latest = await this.fetchDocContentBytes(entry.id, true) || queued;

            const latestOpenDoc = this.getOpenTextDocument(path);
            if (latestOpenDoc?.isDirty) {
                // Preserve local undo stack behavior for user edits: defer remote apply
                // until the doc is no longer dirty instead of editing the buffer now.
                this.pendingRemoteDocContent.set(path, latest);
                this.schedulePendingRemoteApply(path, DEBOUNCE_DELAY);
                return;
            }

            const localUri = this.settings.getFilePath(path);
            let localContent: Uint8Array | undefined;
            try {
                localContent = await vscode.workspace.fs.readFile(localUri);
            } catch {
                localContent = undefined;
            }

            if (!contentEquals(localContent, latest)) {
                this._remoteUpdatingPaths.add(path);
                try {
                    await vscode.workspace.fs.writeFile(localUri, latest);
                    this.log(`Applied queued remote update: ${path}`);
                } finally {
                    this._remoteUpdatingPaths.delete(path);
                }
            }

            this.setBaseContent(path, latest);
            this.fileCache.set(path, { hash: hashContent(latest), timestamp: Date.now() });
            this.pendingRemoteDocContent.delete(path);
        } catch (error) {
            console.error(`[LocalLeaf] Failed to apply queued remote update ${path}:`, error);
        } finally {
            this.releaseLock(path);
        }
    }

    /**
     * Check if we should propagate a change (prevent echo)
     */
    private shouldPropagate(action: 'push' | 'pull', path: string, content?: Uint8Array): boolean {
        const now = Date.now();
        const cache = this.fileCache.get(path);
        const newHash = hashContent(content);

        if (cache) {
            // Same content, skip
            if (cache.hash === newHash) {
                return false;
            }
            // Recent change, might be echo
            if (now - cache.timestamp < DEBOUNCE_DELAY) {
                this.fileCache.set(path, { hash: newHash, timestamp: now });
                return false;
            }
        }

        this.fileCache.set(path, { hash: newHash, timestamp: now });
        return true;
    }

    /**
     * Acquire sync lock for a path
     */
    private async acquireLock(path: string): Promise<void> {
        if (!this.syncLock.has(path)) {
            this.syncLock.add(path);
            return;
        }

        await new Promise<void>((resolve) => {
            const queue = this.lockQueues.get(path) || [];
            queue.push(resolve);
            this.lockQueues.set(path, queue);
        });

        // Lock ownership is effectively handed off by releaseLock.
        this.syncLock.add(path);
    }

    /**
     * Release sync lock for a path
     */
    private releaseLock(path: string): void {
        const queue = this.lockQueues.get(path);
        const next = queue?.shift();

        if (queue && queue.length === 0) {
            this.lockQueues.delete(path);
        }

        if (next) {
            // Keep the lock held while handing over to the next waiter.
            next();
            return;
        }

        this.syncLock.delete(path);
    }

    /**
     * Update paths in the in-memory file tree.
     */
    private moveTreePaths(oldPrefix: string, newPrefix: string, includeDescendants: boolean): void {
        type EntryMove = { entry: FileTreeEntry; oldPath: string; newPath: string };
        const entryMoves: EntryMove[] = [];

        for (const entry of this.fileTree.values()) {
            const matches = entry.path === oldPrefix ||
                (includeDescendants && entry.path.startsWith(oldPrefix));
            if (!matches) continue;

            const newPath = entry.path === oldPrefix
                ? newPrefix
                : newPrefix + entry.path.slice(oldPrefix.length);
            entryMoves.push({ entry, oldPath: entry.path, newPath });
        }

        for (const move of entryMoves) {
            this.fileTreeByPath.delete(move.oldPath);
        }
        for (const move of entryMoves) {
            move.entry.path = move.newPath;
            this.fileTreeByPath.set(move.newPath, move.entry);
        }
    }

    /**
     * Update file paths in tree and caches when a path prefix changes.
     * Used for rename/move operations, including recursive folder updates.
     */
    private movePathTracking(oldPrefix: string, newPrefix: string, includeDescendants: boolean): void {
        this.moveTreePaths(oldPrefix, newPrefix, includeDescendants);

        const contentMoves: Array<{ oldPath: string; newPath: string; content: Uint8Array }> = [];
        for (const [path, content] of this.baseContent.entries()) {
            const matches = path === oldPrefix || (includeDescendants && path.startsWith(oldPrefix));
            if (!matches) continue;
            const newPath = path === oldPrefix ? newPrefix : newPrefix + path.slice(oldPrefix.length);
            contentMoves.push({ oldPath: path, newPath, content });
        }
        for (const move of contentMoves) {
            this.deleteBaseContent(move.oldPath);
        }
        for (const move of contentMoves) {
            this.setBaseContent(move.newPath, move.content);
        }

        const cacheMoves: Array<{ oldPath: string; newPath: string; cache: FileCache }> = [];
        for (const [path, cache] of this.fileCache.entries()) {
            const matches = path === oldPrefix || (includeDescendants && path.startsWith(oldPrefix));
            if (!matches) continue;
            const newPath = path === oldPrefix ? newPrefix : newPrefix + path.slice(oldPrefix.length);
            cacheMoves.push({ oldPath: path, newPath, cache });
        }
        for (const move of cacheMoves) {
            this.fileCache.delete(move.oldPath);
        }
        for (const move of cacheMoves) {
            this.fileCache.set(move.newPath, move.cache);
        }

        const pendingRemoteMoves: Array<{ oldPath: string; newPath: string; content: Uint8Array }> = [];
        for (const [path, content] of this.pendingRemoteDocContent.entries()) {
            const matches = path === oldPrefix || (includeDescendants && path.startsWith(oldPrefix));
            if (!matches) continue;
            const newPath = path === oldPrefix ? newPrefix : newPrefix + path.slice(oldPrefix.length);
            pendingRemoteMoves.push({ oldPath: path, newPath, content });
        }
        for (const move of pendingRemoteMoves) {
            this.pendingRemoteDocContent.delete(move.oldPath);
        }
        for (const move of pendingRemoteMoves) {
            this.pendingRemoteDocContent.set(move.newPath, move.content);
        }

        const timerMaps: Array<Map<string, NodeJS.Timeout>> = [
            this.docPushTimers,
            this.pendingRemoteApplyTimers,
        ];
        for (const timers of timerMaps) {
            const keys = Array.from(timers.keys());
            for (const key of keys) {
                const matches = key === oldPrefix || (includeDescendants && key.startsWith(oldPrefix));
                if (!matches) continue;
                const timeout = timers.get(key);
                if (timeout) {
                    clearTimeout(timeout);
                }
                timers.delete(key);
            }
        }
    }

    /**
     * Remove file tree entries by path or path prefix.
     */
    private removeTreeEntries(pathPrefix: string, includeDescendants: boolean): FileTreeEntry[] {
        const removedEntries: FileTreeEntry[] = [];
        for (const entry of this.fileTree.values()) {
            const matches = entry.path === pathPrefix ||
                (includeDescendants && entry.path.startsWith(pathPrefix));
            if (!matches) continue;
            removedEntries.push(entry);
        }

        for (const entry of removedEntries) {
            this.fileTree.delete(entry.id);
            this.fileTreeByPath.delete(entry.path);
        }
        return removedEntries;
    }

    /**
     * Remove file tree entries and caches by path or path prefix.
     * Returns removed tree entries for additional cleanup (e.g. joined docs).
     */
    private removePathTracking(pathPrefix: string, includeDescendants: boolean): FileTreeEntry[] {
        const removedEntries = this.removeTreeEntries(pathPrefix, includeDescendants);

        const baseToDelete: string[] = [];
        for (const path of this.baseContent.keys()) {
            const matches = path === pathPrefix || (includeDescendants && path.startsWith(pathPrefix));
            if (matches) baseToDelete.push(path);
        }
        for (const p of baseToDelete) {
            this.deleteBaseContent(p);
        }

        const cacheToDelete: string[] = [];
        for (const path of this.fileCache.keys()) {
            const matches = path === pathPrefix || (includeDescendants && path.startsWith(pathPrefix));
            if (matches) cacheToDelete.push(path);
        }
        for (const p of cacheToDelete) {
            this.fileCache.delete(p);
        }

        const pendingToDelete: string[] = [];
        for (const path of this.pendingRemoteDocContent.keys()) {
            const matches = path === pathPrefix || (includeDescendants && path.startsWith(pathPrefix));
            if (matches) pendingToDelete.push(path);
        }
        for (const p of pendingToDelete) {
            this.pendingRemoteDocContent.delete(p);
        }

        const timerMaps: Array<Map<string, NodeJS.Timeout>> = [
            this.docPushTimers,
            this.pendingRemoteApplyTimers,
        ];
        for (const timers of timerMaps) {
            const keys = Array.from(timers.keys());
            for (const key of keys) {
                const matches = key === pathPrefix || (includeDescendants && key.startsWith(pathPrefix));
                if (!matches) continue;
                const timeout = timers.get(key);
                if (timeout) {
                    clearTimeout(timeout);
                }
                timers.delete(key);
            }
        }

        return removedEntries;
    }

    // === Local change handlers ===

    /**
     * Handle local file change
     */
    private async handleLocalFileChange(uri: vscode.Uri): Promise<void> {
        const relativePath = this.getRelativePath(uri);
        if (!this.shouldSync(relativePath)) return;

        // Suppress echo from remote-initiated save
        if (this._remoteUpdatingPaths.has(relativePath)) return;

        // Suppress echo from pull operations writing files to disk
        if (this._isPulling) return;

        // Manual mode: record change instead of pushing immediately
        if (this._syncMode === 'manual') {
            let content: Uint8Array;
            try {
                content = await vscode.workspace.fs.readFile(uri);
            } catch (readError) {
                if (isFileNotFoundError(readError)) {
                    debugLog(`File no longer exists (race condition): ${relativePath}`);
                    return;
                }
                throw readError;
            }

            const base = this.baseContent.get(relativePath);
            if (!shouldTrackLocalModification({ currentContent: content, baseContent: base })) {
                this._changeTracker.clearLocal(relativePath);
                this.fileCache.set(relativePath, { hash: hashContent(content), timestamp: Date.now() });
                return;
            }

            const entry = this.fileTreeByPath.get(relativePath);
            this._changeTracker.addLocalChange({
                path: relativePath,
                type: 'modified',
                source: 'local',
                timestamp: Date.now(),
                entityId: entry?.id,
                entityType: entry?.type,
            });
            return;
        }

        await this.acquireLock(relativePath);

        try {
            // Read file content - may throw if file was deleted between watcher event and now
            let content: Uint8Array;
            try {
                content = await vscode.workspace.fs.readFile(uri);
            } catch (readError) {
                // File was deleted between watcher event and read - this is normal during rapid operations
                if (isFileNotFoundError(readError)) {
                    debugLog(`File no longer exists (race condition): ${relativePath}`);
                    return;
                }
                throw readError;
            }

            if (!this.shouldPropagate('push', relativePath, content)) return;

            const entry = this.fileTreeByPath.get(relativePath);
            if (!entry) {
                debugLog(`File not in remote tree: ${relativePath}`);
                return;
            }

            this.setStatus('pushing', `Uploading ${relativePath}`, relativePath);

            // For documents, we need to use OT updates
            // For binary files, we upload directly
            if (entry.type === 'doc' && this.socket) {
                const pushed = await this.pushDocumentChanges(entry.id, relativePath, content);
                if (pushed) {
                    this.log(`Pushed to Overleaf: ${relativePath}`);
                }
            } else {
                // Upload binary file
                const projectSettings = this.settings.getSettings()!;
                await this.api.uploadFile(
                    projectSettings.projectId,
                    entry.parentId!,
                    entry.name,
                    content
                );
                this.log(`Uploaded to Overleaf: ${relativePath}`);
            }

            this.setBaseContent(relativePath, content);
            this.setStatus('idle');
        } catch (error) {
            // Don't show error for file-not-found during rapid operations
            if (isFileNotFoundError(error)) {
                debugLog(`File disappeared during sync: ${relativePath}`);
                this.setStatus('idle');
                return;
            }
            console.error(`[LocalLeaf] Failed to sync ${relativePath}:`, error);
            const authErr = isAuthError(error);
            this.setStatus('error', authErr ? 'Session expired' : `Failed to sync: ${error}`, undefined, authErr);
        } finally {
            this.releaseLock(relativePath);
        }
    }

    /**
     * Push document changes using OT
     * Returns true if changes were actually pushed
     */
    private async pushDocumentChanges(docId: string, path: string, newContent: Uint8Array): Promise<boolean> {
        if (!this.socket) return false;

        const localContent = new TextDecoder().decode(newContent);
        const maxAttempts = 4;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                // Join document to get current authoritative version.
                const { lines: remoteLines, version } = await this.socket.joinDoc(docId);
                const remoteContent = remoteLines.join('\n');

                // Keep doc joined for watching.
                this.joinedDocs.add(docId);

                if (remoteContent === localContent) {
                    return false;
                }

                const ops = this.calculateOps(remoteContent, localContent);
                const update: DocumentUpdate = {
                    doc: docId,
                    op: ops,
                    v: version,
                    lastV: version,
                };

                await this.socket.applyOtUpdate(docId, update);
                return true;
            } catch (error) {
                const isRetryable = this.isVersionConflictError(error);
                const isLastAttempt = attempt === maxAttempts;

                if (isRetryable && !isLastAttempt) {
                    // Another collaborator updated between join/apply; retry with fresh version.
                    await new Promise(resolve => setTimeout(resolve, 40 * attempt));
                    continue;
                }

                console.error(`[LocalLeaf] OT update failed for ${path}:`, error);
                throw error;
            }
        }

        return false;
    }

    /**
     * Detect OT version/conflict errors that are safe to retry.
     */
    private isVersionConflictError(error: unknown): boolean {
        const text = String(error).toLowerCase();
        return text.includes('version') ||
            text.includes('transform') ||
            text.includes('stale') ||
            text.includes('out of date') ||
            text.includes('conflict');
    }

    /**
     * Fetch full document content from remote.
     * Preserves existing joined-doc subscriptions by default.
     */
    private async fetchDocContentBytes(docId: string, preserveJoined: boolean = true): Promise<Uint8Array | undefined> {
        const projectSettings = this.settings.getSettings();
        if (!projectSettings) {
            return undefined;
        }

        if (this.socket) {
            try {
                const wasJoined = this.joinedDocs.has(docId);
                const { lines } = await this.socket.joinDoc(docId);
                if (!wasJoined && !preserveJoined) {
                    await this.socket.leaveDoc(docId);
                } else {
                    this.joinedDocs.add(docId);
                }
                return new TextEncoder().encode(lines.join('\n'));
            } catch {
                // Fall back to HTTP
            }
        }

        const result = await this.api.getDocContent(projectSettings.projectId, docId);
        if (result.type === 'success' && result.lines) {
            return new TextEncoder().encode(result.lines.join('\n'));
        }
        return undefined;
    }

    /**
     * Calculate OT operations for text diff
     * Simple implementation - for production, use diff-match-patch
     */
    private calculateOps(oldText: string, newText: string): Array<{ p: number; i?: string; d?: string }> {
        const ops: Array<{ p: number; i?: string; d?: string }> = [];

        // Simple diff: delete old, insert new
        // TODO: Use proper diff algorithm for better performance
        if (oldText !== newText) {
            if (oldText.length > 0) {
                ops.push({ p: 0, d: oldText });
            }
            if (newText.length > 0) {
                ops.push({ p: 0, i: newText });
            }
        }

        return ops;
    }

    /**
     * Handle local file creation
     */
    private async handleLocalFileCreate(uri: vscode.Uri): Promise<void> {
        const relativePath = this.getRelativePath(uri);
        if (!this.shouldSync(relativePath)) return;

        // Suppress echo from remote-initiated saves that surface as creates.
        if (this._remoteUpdatingPaths.has(relativePath)) return;

        // Suppress echo from pull operations writing files to disk
        if (this._isPulling) return;

        // Manual mode: record change instead of pushing immediately
        if (this._syncMode === 'manual') {
            let stat: vscode.FileStat;
            try {
                stat = await vscode.workspace.fs.stat(uri);
            } catch (statError) {
                if (isFileNotFoundError(statError)) {
                    debugLog(`File no longer exists (race condition): ${relativePath}`);
                    return;
                }
                throw statError;
            }

            const remotePath = stat.type === vscode.FileType.Directory
                ? (relativePath.endsWith('/') ? relativePath : relativePath + '/')
                : relativePath;
            const entry = this.fileTreeByPath.get(remotePath);
            const base = this.baseContent.get(remotePath);
            let currentContent: Uint8Array | undefined;
            let remoteContent: Uint8Array | undefined;

            if (stat.type !== vscode.FileType.Directory) {
                currentContent = await vscode.workspace.fs.readFile(uri);
                if (!base && entry) {
                    remoteContent = await this.getRemoteContent(remotePath);
                }
            } else {
                currentContent = new Uint8Array(0);
            }

            const type = getLocalCreateChangeType({
                hasRemoteEntry: !!entry,
                hasBaseContent: !!base,
                currentContent,
                baseContent: base,
                remoteContent,
            });
            if (!type) {
                this._changeTracker.clearLocal(remotePath);
                if (currentContent) {
                    this.fileCache.set(remotePath, { hash: hashContent(currentContent), timestamp: Date.now() });
                }
                return;
            }

            this._changeTracker.addLocalChange({
                path: type === 'modified' ? remotePath : relativePath,
                type,
                source: 'local',
                timestamp: Date.now(),
                entityId: entry?.id,
                entityType: entry?.type,
            });
            return;
        }

        await this.acquireLock(relativePath);

        try {
            // Stat the file - may throw if file was deleted between watcher event and now
            let stat: vscode.FileStat;
            try {
                stat = await vscode.workspace.fs.stat(uri);
            } catch (statError) {
                if (isFileNotFoundError(statError)) {
                    debugLog(`File no longer exists (race condition): ${relativePath}`);
                    return;
                }
                throw statError;
            }

            const projectSettings = this.settings.getSettings()!;

            this.setStatus('pushing', `Creating ${relativePath}`, relativePath);

            // Ensure parent folders exist (creates them if needed)
            const parentId = await this.ensureParentFoldersExist(relativePath);
            const name = relativePath.split('/').pop()!;

            if (stat.type === vscode.FileType.Directory) {
                const folderPath = relativePath + '/';
                const result = await this.api.addFolder(projectSettings.projectId, parentId, name);

                // Add folder to file tree immediately (don't wait for socket event)
                if (result.type === 'success' && result.folder) {
                    const folderEntry: FileTreeEntry = {
                        id: result.folder._id,
                        type: 'folder',
                        name: name,
                        path: folderPath,
                        parentId: parentId,
                    };
                    this.fileTree.set(result.folder._id, folderEntry);
                    this.fileTreeByPath.set(folderPath, folderEntry);
                    debugLog('Added folder to tree:', folderPath, result.folder._id);
                }

                // Track folder in baseContent so delete/rename operations work
                this.setBaseContent(folderPath, new Uint8Array(0));
                this.log(`Created folder on Overleaf: ${folderPath}`);
            } else {
                // Read file content - may throw if file was deleted
                let content: Uint8Array;
                try {
                    content = await vscode.workspace.fs.readFile(uri);
                } catch (readError) {
                    if (isFileNotFoundError(readError)) {
                        debugLog(`File no longer exists (race condition): ${relativePath}`);
                        return;
                    }
                    throw readError;
                }

                const isTextFile = this.isTextFile(name);

                if (isTextFile && this.socket) {
                    await this.createTextDocWithContent(
                        projectSettings.projectId,
                        parentId,
                        relativePath,
                        name,
                        content
                    );
                } else {
                    await this.api.uploadFile(projectSettings.projectId, parentId, name, content);
                }

                this.setBaseContent(relativePath, content);
                this.fileCache.set(relativePath, { hash: hashContent(content), timestamp: Date.now() });
            }

            this.setStatus('idle');
        } catch (error) {
            // Don't show error for file-not-found during rapid operations
            if (isFileNotFoundError(error)) {
                debugLog(`File disappeared during create: ${relativePath}`);
                this.setStatus('idle');
                return;
            }
            console.error(`[LocalLeaf] Failed to create ${relativePath}:`, error);
            const authErr = isAuthError(error);
            this.setStatus('error', authErr ? 'Session expired' : `Failed to create: ${error}`, undefined, authErr);
        } finally {
            this.releaseLock(relativePath);
        }
    }

    /**
     * Handle local file deletion
     */
    private async handleLocalFileDelete(uri: vscode.Uri): Promise<void> {
        const relativePath = this.getRelativePath(uri);
        if (!this.shouldSync(relativePath)) return;

        // Suppress echo from pull operations (e.g. orphan cleanup)
        if (this._isPulling) return;

        // Manual mode: record change instead of deleting immediately
        if (this._syncMode === 'manual') {
            const entry = this.fileTreeByPath.get(relativePath) || this.fileTreeByPath.get(relativePath + '/');
            if (!entry) return;
            // Only track if file was previously synced
            const pathToUse = entry.path;
            const projectSettings = this.settings.getSettings();
            if (!shouldTrackLocalDelete({
                hasRemoteEntry: true,
                hasBaseContent: this.baseContent.has(pathToUse),
                lastSynced: projectSettings?.lastSynced,
            })) {
                return;
            }
            this._changeTracker.addLocalChange({
                path: pathToUse,
                type: 'deleted',
                source: 'local',
                timestamp: Date.now(),
                entityId: entry.id,
                entityType: entry.type,
            });
            return;
        }

        await this.acquireLock(relativePath);

        try {
            // Try both file path and folder path (with trailing slash)
            let entry = this.fileTreeByPath.get(relativePath);
            let pathToUse = relativePath;
            if (!entry) {
                // Maybe it's a folder - try with trailing slash
                const folderPath = relativePath + '/';
                entry = this.fileTreeByPath.get(folderPath);
                if (entry) {
                    pathToUse = folderPath;
                }
            }
            if (!entry) return;

            // Only delete from Overleaf if the file was previously synced locally.
            // If baseContent doesn't have this path, the file was never downloaded/synced,
            // so we should NOT propagate this deletion to Overleaf (prevents deleting
            // new upstream files that haven't been pulled yet).
            if (!this.baseContent.has(pathToUse)) {
                debugLog(`Ignoring delete for never-synced file: ${pathToUse}`);
                return;
            }

            const projectSettings = this.settings.getSettings()!;
            this.setStatus('pushing', `Deleting ${pathToUse}`, pathToUse);

            await this.api.deleteEntity(projectSettings.projectId, entry.type, entry.id);

            const removedEntries = this.removePathTracking(pathToUse, entry.type === 'folder');
            for (const removed of removedEntries) {
                if (removed.type !== 'doc' || !this.joinedDocs.has(removed.id)) continue;
                try {
                    await this.socket?.leaveDoc(removed.id);
                } catch {
                    // Ignore leave errors
                }
                this.joinedDocs.delete(removed.id);
            }

            this.log(`Deleted from Overleaf: ${pathToUse}`);
            this.setStatus('idle');
        } catch (error) {
            console.error(`[LocalLeaf] Failed to delete ${relativePath}:`, error);
            const authErr = isAuthError(error);
            this.setStatus('error', authErr ? 'Session expired' : `Failed to delete: ${error}`, undefined, authErr);
        } finally {
            this.releaseLock(relativePath);
        }
    }

    // === Remote change handlers ===

    /**
     * Handle remote file created
     */
    private async handleRemoteFileCreated(parentId: string, type: 'doc' | 'file' | 'folder', entity: FileEntity): Promise<void> {
        const parent = this.fileTree.get(parentId);
        const parentPath = parent?.path || '/';
        const path = type === 'folder' ? parentPath + entity.name + '/' : parentPath + entity.name;

        if (!this.shouldSync(path)) return;

        // Always update the file tree (keeps remote state accurate)
        const treeEntry: FileTreeEntry = {
            id: entity._id,
            type,
            name: entity.name,
            path,
            parentId,
        };
        this.fileTree.set(entity._id, treeEntry);
        this.fileTreeByPath.set(path, treeEntry);

        // Manual mode: record change instead of applying immediately
        if (this._syncMode === 'manual') {
            if (this._recentlyPushedPaths.has(path)) {
                return; // Skip echo of our own push
            }
            this._changeTracker.addRemoteChange({
                path,
                type: 'created',
                source: 'remote',
                timestamp: Date.now(),
                entityId: entity._id,
                entityType: type,
            });
            return;
        }

        await this.acquireLock(path);

        try {
            this.setStatus('pulling', `Downloading ${path}`, path);

            const localUri = this.settings.getFilePath(path);

            // Check if this is an echo of our own creation (file already in baseContent)
            const alreadySynced = this.baseContent.has(path);
            if (alreadySynced) {
                debugLog(`Ignoring remote create echo for already-synced: ${path}`);
                this.setStatus('idle');
                return;
            }

            if (type === 'folder') {
                await vscode.workspace.fs.createDirectory(localUri);
                // Track folders in baseContent with empty content
                this.setBaseContent(path, new Uint8Array(0));
            } else {
                // Download content - use correct API based on type
                const projectSettings = this.settings.getSettings()!;
                let content: Uint8Array | undefined;

                if (type === 'doc') {
                    // For docs, use getDocContent
                    const result = await this.api.getDocContent(projectSettings.projectId, entity._id);
                    if (result.type === 'success' && result.lines) {
                        content = new TextEncoder().encode(result.lines.join('\n'));
                    }
                } else {
                    // For binary files, use getFile
                    const result = await this.api.getFile(projectSettings.projectId, entity._id);
                    if (result.type === 'success' && result.content) {
                        content = result.content;
                    }
                }

                if (content) {
                    // Prompt user for new remote files
                    const resolution = await this.askNewRemoteFileResolution(path, content);
                    if (resolution === 'skip') {
                        debugLog(`Skipped new remote file (user choice): ${path}`);
                        this.log(`Skipped new file from Overleaf: ${path}`);
                        this.setStatus('idle');
                        return;
                    }

                    await vscode.workspace.fs.writeFile(localUri, content);
                    this.setBaseContent(path, content);
                    this.fileCache.set(path, { hash: hashContent(content), timestamp: Date.now() });
                    this.log(`Downloaded new file from Overleaf: ${path}`);
                }

                // Join new docs to receive OT updates
                if (type === 'doc' && this.socket && !this.joinedDocs.has(entity._id)) {
                    try {
                        await this.socket.joinDoc(entity._id);
                        this.joinedDocs.add(entity._id);
                    } catch {
                        // Ignore join errors
                    }
                }
            }

            this.setStatus('idle');
        } catch (error) {
            console.error(`[LocalLeaf] Failed to sync remote create ${path}:`, error);
        } finally {
            this.releaseLock(path);
        }
    }

    /**
     * Handle remote file renamed
     */
    private async handleRemoteFileRenamed(entityId: string, newName: string): Promise<void> {
        const entry = this.fileTree.get(entityId);
        if (!entry) return;

        const oldPath = entry.path;
        const parentPath = oldPath.substring(0, oldPath.lastIndexOf('/') + 1);
        const newPath = entry.type === 'folder' ? parentPath + newName + '/' : parentPath + newName;

        // Always update file tree
        entry.name = newName;
        this.moveTreePaths(oldPath, newPath, entry.type === 'folder');

        // Manual mode: record change
        if (this._syncMode === 'manual') {
            if (this._recentlyPushedPaths.has(oldPath) || this._recentlyPushedPaths.has(newPath)) {
                return; // Skip echo of our own push
            }
            this._changeTracker.addRemoteChange({
                path: newPath,
                type: 'renamed',
                source: 'remote',
                timestamp: Date.now(),
                entityId,
                entityType: entry.type,
                oldPath,
            });
            return;
        }

        await this.acquireLock(oldPath);

        try {
            this.setStatus('pulling', `Renaming ${oldPath} to ${newPath}`, oldPath);

            // Rename local file
            const oldUri = this.settings.getFilePath(oldPath);
            const newUri = this.settings.getFilePath(newPath);
            await vscode.workspace.fs.rename(oldUri, newUri);

            // Keep caches aligned with the path transition.
            this.movePathTracking(oldPath, newPath, entry.type === 'folder');

            this.setStatus('idle');
        } catch (error) {
            console.error(`[LocalLeaf] Failed to sync remote rename:`, error);
        } finally {
            this.releaseLock(oldPath);
        }
    }

    /**
     * Handle remote file removed
     */
    private async handleRemoteFileRemoved(entityId: string): Promise<void> {
        const entry = this.fileTree.get(entityId);
        if (!entry) return;

        if (!this.shouldSync(entry.path)) return;

        const entryPath = entry.path;
        const entryType = entry.type;

        // Always update file tree (recursively for folders)
        const removedEntries = this.removeTreeEntries(entryPath, entryType === 'folder');

        // Manual mode: record change
        if (this._syncMode === 'manual') {
            if (this._recentlyPushedPaths.has(entryPath)) {
                return; // Skip echo of our own push
            }
            for (const removed of removedEntries) {
                if (removed.type !== 'doc') continue;
                this.joinedDocs.delete(removed.id);
            }
            this._changeTracker.addRemoteChange({
                path: entryPath,
                type: 'deleted',
                source: 'remote',
                timestamp: Date.now(),
                entityId,
                entityType: entryType,
            });
            return;
        }

        await this.acquireLock(entryPath);

        try {
            this.setStatus('pulling', `Deleting ${entryPath}`, entryPath);

            // Leave all removed docs if joined.
            for (const removed of removedEntries) {
                if (removed.type !== 'doc' || !this.joinedDocs.has(removed.id)) continue;
                try {
                    await this.socket?.leaveDoc(removed.id);
                } catch {
                    // Ignore leave errors
                }
                this.joinedDocs.delete(removed.id);
            }

            // Delete local file
            const localUri = this.settings.getFilePath(entryPath);
            await vscode.workspace.fs.delete(localUri, { recursive: true });

            this.removePathTracking(entryPath, entryType === 'folder');

            this.setStatus('idle');
        } catch (error) {
            console.error(`[LocalLeaf] Failed to sync remote delete:`, error);
        } finally {
            this.releaseLock(entryPath);
        }
    }

    /**
     * Handle remote file moved
     */
    private async handleRemoteFileMoved(entityId: string, newParentId: string): Promise<void> {
        const entry = this.fileTree.get(entityId);
        const newParent = this.fileTree.get(newParentId);
        if (!entry || !newParent) return;

        const oldPath = entry.path;
        const newPath = entry.type === 'folder'
            ? newParent.path + entry.name + '/'
            : newParent.path + entry.name;

        // Always update file tree
        entry.parentId = newParentId;
        this.moveTreePaths(oldPath, newPath, entry.type === 'folder');

        // Manual mode: record change
        if (this._syncMode === 'manual') {
            if (this._recentlyPushedPaths.has(oldPath) || this._recentlyPushedPaths.has(newPath)) {
                return; // Skip echo of our own push
            }
            this._changeTracker.addRemoteChange({
                path: newPath,
                type: 'moved',
                source: 'remote',
                timestamp: Date.now(),
                entityId,
                entityType: entry.type,
                oldPath,
                newParentId,
            });
            return;
        }

        await this.acquireLock(oldPath);

        try {
            this.setStatus('pulling', `Moving ${oldPath} to ${newPath}`, oldPath);

            // Move local file
            const oldUri = this.settings.getFilePath(oldPath);
            const newUri = this.settings.getFilePath(newPath);
            await vscode.workspace.fs.rename(oldUri, newUri);

            this.movePathTracking(oldPath, newPath, entry.type === 'folder');

            this.setStatus('idle');
        } catch (error) {
            console.error(`[LocalLeaf] Failed to sync remote move:`, error);
        } finally {
            this.releaseLock(oldPath);
        }
    }

    /**
     * Handle remote file content changed (OT update)
     */
    private async handleRemoteFileChanged(update: DocumentUpdate): Promise<void> {
        const entry = this.fileTree.get(update.doc);
        if (!entry || entry.type !== 'doc') {
            return;
        }

        if (!this.shouldSync(entry.path)) return;

        // Manual mode: record change but don't modify local files
        if (this._syncMode === 'manual') {
            if (this._recentlyPushedPaths.has(entry.path)) {
                return; // Skip echo of our own push
            }
            this._changeTracker.addRemoteChange({
                path: entry.path,
                type: 'modified',
                source: 'remote',
                timestamp: Date.now(),
                entityId: update.doc,
                entityType: 'doc',
            });
            return;
        }

        await this.acquireLock(entry.path);

        try {
            const localUri = this.settings.getFilePath(entry.path);
            let localBytes: Uint8Array | undefined;
            try {
                localBytes = await vscode.workspace.fs.readFile(localUri);
            } catch {
                localBytes = undefined;
            }

            // Avoid positional drift by always reconciling against an authoritative
            // snapshot, not incremental OT against potentially stale local text.
            const remoteBytes = await this.fetchDocContentBytes(update.doc, true);
            if (!remoteBytes) {
                return;
            }

            let appliedBytes = remoteBytes;
            const openDoc = this.getOpenTextDocument(entry.path);
            if (openDoc?.isDirty) {
                // Dirty editor: push in-memory local text first, then merge latest remote into buffer.
                const pendingPushTimer = this.docPushTimers.get(entry.path);
                if (pendingPushTimer) {
                    clearTimeout(pendingPushTimer);
                    this.docPushTimers.delete(entry.path);
                }

                const localDocBytes = new TextEncoder().encode(openDoc.getText());
                const localMatchesBase = contentEquals(this.baseContent.get(entry.path), localDocBytes);
                let localPushed = false;
                if (this.shouldPropagate('push', entry.path, localDocBytes)) {
                    try {
                        localPushed = await this.pushDocumentChanges(entry.id, entry.path, localDocBytes);
                        if (localPushed) {
                            this.setBaseContent(entry.path, localDocBytes);
                            this.fileCache.set(entry.path, { hash: hashContent(localDocBytes), timestamp: Date.now() });
                        }
                    } catch {
                        // Continue with remote reconciliation even if local push fails.
                    }
                }

                const mergedBytes = await this.fetchDocContentBytes(update.doc, true) || remoteBytes;
                let applied = false;

                // If local in-memory changes are confirmed synced (or there were none),
                // prefer disk+revert so remote apply does not enter undo history.
                if (localPushed || localMatchesBase) {
                    applied = await this.applyDirtyDocViaDiskRevert(entry.path, openDoc, mergedBytes);
                }

                if (!applied) {
                    applied = await this.applyContentToOpenDocument(entry.path, openDoc, mergedBytes);
                }

                if (!applied) {
                    this.pendingRemoteDocContent.set(entry.path, mergedBytes);
                    this.schedulePendingRemoteApply(entry.path, DEBOUNCE_DELAY);
                }

                appliedBytes = mergedBytes;
            } else if (!contentEquals(localBytes, remoteBytes)) {
                this.setStatus('pulling', `Updating ${entry.path}`, entry.path);
                this._remoteUpdatingPaths.add(entry.path);
                try {
                    await vscode.workspace.fs.writeFile(localUri, remoteBytes);
                    this.log(`Remote update: ${entry.path}`);
                } finally {
                    this._remoteUpdatingPaths.delete(entry.path);
                }
            }

            this.setBaseContent(entry.path, appliedBytes);
            this.fileCache.set(entry.path, { hash: hashContent(appliedBytes), timestamp: Date.now() });

            this.setStatus('idle');
        } catch (error) {
            console.error(`[LocalLeaf] Failed to apply OT update:`, error);
        } finally {
            this.releaseLock(entry.path);
        }
    }

    /**
     * Join all documents to receive real-time OT updates
     */
    async joinAllDocsForWatching(): Promise<void> {
        if (!this.socket) return;

        let joinedCount = 0;
        for (const [id, entry] of this.fileTree) {
            if (entry.type === 'doc' && !this.joinedDocs.has(id)) {
                if (!this.shouldSync(entry.path)) continue;
                try {
                    await this.socket.joinDoc(id);
                    this.joinedDocs.add(id);
                    joinedCount++;
                } catch {
                    // Ignore join errors for individual docs
                }
            }
        }
        if (joinedCount > 0) {
            this.log(`Watching ${joinedCount} documents for remote changes`);
        }
    }

    /**
     * Leave all joined documents
     */
    private async leaveAllDocs(): Promise<void> {
        if (!this.socket) return;

        for (const docId of this.joinedDocs) {
            try {
                await this.socket.leaveDoc(docId);
            } catch {
                // Ignore leave errors
            }
        }
        this.joinedDocs.clear();
    }

    // === Public methods ===

    /**
     * Conflict resolution options
     */
    private conflictResolution: 'ask' | 'useRemote' | 'useLocal' | 'skip' = 'ask';
    private applyToAll: boolean = false;

    /**
     * Check if local file exists
     */
    private async localFileExists(uri: vscode.Uri): Promise<boolean> {
        try {
            await vscode.workspace.fs.stat(uri);
            return true;
        } catch {
            return false;
        }
    }

    private async scanLocalFilePaths(dirUri: vscode.Uri, basePath: string = '/'): Promise<string[]> {
        const paths: string[] = [];
        try {
            const entries = await vscode.workspace.fs.readDirectory(dirUri);
            for (const [name, type] of entries) {
                const relativePath = basePath + name;
                const fullPath = type === vscode.FileType.Directory
                    ? relativePath + '/'
                    : relativePath;

                if (!this.shouldSync(fullPath)) {
                    continue;
                }

                if (type === vscode.FileType.Directory) {
                    paths.push(...await this.scanLocalFilePaths(vscode.Uri.joinPath(dirUri, name), fullPath));
                } else {
                    paths.push(fullPath);
                }
            }
        } catch (error) {
            debugLog(`Error scanning directory: ${basePath}`, error);
        }
        return paths;
    }

    /**
     * Rebuild pending local changes after a VS Code restart.
     * The tracker is in-memory, while local files and baseline content persist.
     */
    async refreshLocalChangesFromDisk(): Promise<number> {
        if (this._syncMode !== 'manual') {
            return 0;
        }

        const projectSettings = this.settings.getSettings();
        const now = Date.now();
        this._changeTracker.clearLocal();

        for (const [relativePath, baseContent] of this.baseContent) {
            if (!this.shouldSync(relativePath)) {
                continue;
            }

            const entry = this.fileTreeByPath.get(relativePath);
            const isFolder = entry?.type === 'folder' || relativePath.endsWith('/');
            const localUri = this.settings.getFilePath(relativePath);
            const currentExists = await this.localFileExists(localUri);
            let currentContent: Uint8Array | undefined;

            if (currentExists && !isFolder) {
                try {
                    currentContent = await vscode.workspace.fs.readFile(localUri);
                } catch (error) {
                    if (!isFileNotFoundError(error)) {
                        throw error;
                    }
                }
            }

            const type = getRestoredLocalChangeType({
                currentExists,
                hasRemoteEntry: !!entry,
                hasBaseContent: true,
                currentContent,
                baseContent,
                lastSynced: projectSettings?.lastSynced,
            });
            if (!type) {
                continue;
            }

            this._changeTracker.addLocalChange({
                path: relativePath,
                type,
                source: 'local',
                timestamp: now,
                entityId: entry?.id,
                entityType: entry?.type,
            });
        }

        for (const [relativePath, entry] of this.fileTreeByPath) {
            if (this.baseContent.has(relativePath) || !this.shouldSync(relativePath)) {
                continue;
            }
            const isFolder = entry.type === 'folder' || relativePath.endsWith('/');
            const localUri = this.settings.getFilePath(relativePath);
            const currentExists = await this.localFileExists(localUri);
            let currentContent: Uint8Array | undefined;
            let remoteContent: Uint8Array | undefined;

            if (currentExists && !isFolder) {
                try {
                    currentContent = await vscode.workspace.fs.readFile(localUri);
                    remoteContent = await this.getRemoteContent(relativePath);
                } catch (error) {
                    if (!isFileNotFoundError(error)) {
                        throw error;
                    }
                }
            }

            const type = getRestoredLocalChangeType({
                currentExists,
                hasRemoteEntry: true,
                hasBaseContent: false,
                currentContent,
                remoteContent,
                lastSynced: projectSettings?.lastSynced,
            });
            if (!type) {
                continue;
            }

            this._changeTracker.addLocalChange({
                path: relativePath,
                type,
                source: 'local',
                timestamp: now,
                entityId: entry.id,
                entityType: entry.type,
            });
        }

        const localPaths = await this.scanLocalFilePaths(this.settings.getWorkspaceFolder());
        for (const relativePath of localPaths) {
            if (this.fileTreeByPath.has(relativePath) || this.baseContent.has(relativePath)) {
                continue;
            }
            const type = getRestoredLocalChangeType({
                currentExists: true,
                hasRemoteEntry: false,
                hasBaseContent: false,
            });
            if (!type) {
                continue;
            }
            this._changeTracker.addLocalChange({
                path: relativePath,
                type,
                source: 'local',
                timestamp: now,
            });
        }

        const count = this._changeTracker.getLocalChangeCount();
        if (count > 0) {
            this.log(`Restored ${count} pending local change${count === 1 ? '' : 's'} from disk`);
        }
        return count;
    }

    /**
     * Compare local and remote content
     */
    private async hasConflict(localUri: vscode.Uri, remoteContent: Uint8Array): Promise<boolean> {
        try {
            const localContent = await vscode.workspace.fs.readFile(localUri);
            const isEqual = contentEquals(localContent, remoteContent);
            if (!isEqual) {
                debugLog('hasConflict: DIFFERENT', localUri.fsPath,
                    'local:', localContent.length, 'bytes',
                    'remote:', remoteContent.length, 'bytes');
            }
            return !isEqual;
        } catch {
            return false; // File doesn't exist locally, no conflict
        }
    }

    /**
     * Try to auto-merge text conflicts when local and remote edits do not overlap.
     * Returns merged bytes when successful, otherwise undefined.
     */
    private tryAutoMergeTextConflict(
        baseContent: Uint8Array | undefined,
        localContent: Uint8Array | undefined,
        remoteContent: Uint8Array
    ): Uint8Array | undefined {
        if (!baseContent || !localContent) {
            return undefined;
        }

        const decoder = new TextDecoder();
        const baseText = decoder.decode(baseContent).replace(/\r\n/g, '\n');
        const localText = decoder.decode(localContent).replace(/\r\n/g, '\n');
        const remoteText = decoder.decode(remoteContent).replace(/\r\n/g, '\n');

        // Skip potentially binary content.
        if (baseText.includes('\u0000') || localText.includes('\u0000') || remoteText.includes('\u0000')) {
            return undefined;
        }

        const baseLines = baseText.split('\n');
        const localLines = localText.split('\n');
        const remoteLines = remoteText.split('\n');

        const localEdits = this.computeLineEdits(baseLines, localLines);
        const remoteEdits = this.computeLineEdits(baseLines, remoteLines);
        if (!localEdits || !remoteEdits) {
            return undefined;
        }

        const mergedLines = this.mergeNonOverlappingLineEdits(baseLines, localEdits, remoteEdits);
        if (!mergedLines) {
            return undefined;
        }

        let mergedText = mergedLines.join('\n');
        if ((baseText.endsWith('\n') || localText.endsWith('\n') || remoteText.endsWith('\n')) && !mergedText.endsWith('\n')) {
            mergedText += '\n';
        }

        return new TextEncoder().encode(mergedText);
    }

    /**
     * Compute line-level edits from base -> target via LCS.
     * Returns undefined when file is too large for safe in-memory DP merge.
     */
    private computeLineEdits(baseLines: string[], targetLines: string[]): LineEdit[] | undefined {
        const n = baseLines.length;
        const m = targetLines.length;
        const maxCells = 4_000_000;
        const cells = (n + 1) * (m + 1);
        if (cells > maxCells) {
            return undefined;
        }

        const cols = m + 1;
        const dp = new Uint32Array(cells);

        for (let i = n - 1; i >= 0; i--) {
            const row = i * cols;
            const nextRow = (i + 1) * cols;
            const baseLine = baseLines[i];
            for (let j = m - 1; j >= 0; j--) {
                const idx = row + j;
                if (baseLine === targetLines[j]) {
                    dp[idx] = dp[nextRow + j + 1] + 1;
                } else {
                    const down = dp[nextRow + j];
                    const right = dp[idx + 1];
                    dp[idx] = down >= right ? down : right;
                }
            }
        }

        type DiffOp = { type: 'equal' | 'insert' | 'delete'; line?: string };
        const ops: DiffOp[] = [];
        let i = 0;
        let j = 0;
        while (i < n || j < m) {
            if (i < n && j < m && baseLines[i] === targetLines[j]) {
                ops.push({ type: 'equal' });
                i++;
                j++;
                continue;
            }

            const down = i < n ? dp[(i + 1) * cols + j] : 0;
            const right = j < m ? dp[i * cols + j + 1] : 0;

            if (j < m && (i === n || right >= down)) {
                ops.push({ type: 'insert', line: targetLines[j] });
                j++;
            } else if (i < n) {
                ops.push({ type: 'delete' });
                i++;
            }
        }

        const edits: LineEdit[] = [];
        let baseIndex = 0;
        let k = 0;
        while (k < ops.length) {
            if (ops[k].type === 'equal') {
                baseIndex++;
                k++;
                continue;
            }

            const start = baseIndex;
            const newLines: string[] = [];
            while (k < ops.length && ops[k].type !== 'equal') {
                const op = ops[k];
                if (op.type === 'delete') {
                    baseIndex++;
                } else if (op.type === 'insert') {
                    newLines.push(op.line || '');
                }
                k++;
            }
            edits.push({ start, end: baseIndex, newLines });
        }

        return edits;
    }

    /**
     * Merge two edit sets against the same base when they do not overlap.
     * Returns merged lines or undefined if edits overlap/conflict.
     */
    private mergeNonOverlappingLineEdits(
        baseLines: string[],
        localEdits: LineEdit[],
        remoteEdits: LineEdit[]
    ): string[] | undefined {
        const localSpans = localEdits.filter(e => e.end > e.start);
        const remoteSpans = remoteEdits.filter(e => e.end > e.start);
        const localInserts = localEdits.filter(e => e.end === e.start);
        const remoteInserts = remoteEdits.filter(e => e.end === e.start);

        // Replacement/deletion spans cannot overlap.
        for (const l of localSpans) {
            for (const r of remoteSpans) {
                if (l.start < r.end && r.start < l.end) {
                    return undefined;
                }
            }
        }

        // Insertion strictly inside opposite replacement span is ambiguous.
        for (const ins of localInserts) {
            for (const span of remoteSpans) {
                if (span.start < ins.start && ins.start < span.end) {
                    return undefined;
                }
            }
        }
        for (const ins of remoteInserts) {
            for (const span of localSpans) {
                if (span.start < ins.start && ins.start < span.end) {
                    return undefined;
                }
            }
        }

        const insertByPos = new Map<number, { local?: LineEdit; remote?: LineEdit }>();
        for (const ins of localInserts) {
            const slot = insertByPos.get(ins.start) || {};
            slot.local = ins;
            insertByPos.set(ins.start, slot);
        }
        for (const ins of remoteInserts) {
            const slot = insertByPos.get(ins.start) || {};
            slot.remote = ins;
            insertByPos.set(ins.start, slot);
        }

        const mergedInserts: LineEdit[] = [];
        for (const [pos, pair] of insertByPos) {
            if (pair.local && pair.remote) {
                if (!this.areLineArraysEqual(pair.local.newLines, pair.remote.newLines)) {
                    return undefined;
                }
                mergedInserts.push({ start: pos, end: pos, newLines: pair.local.newLines });
            } else if (pair.local) {
                mergedInserts.push(pair.local);
            } else if (pair.remote) {
                mergedInserts.push(pair.remote);
            }
        }

        const combined = [...localSpans, ...remoteSpans, ...mergedInserts]
            .sort((a, b) => (b.start - a.start) || (b.end - a.end));

        const merged = [...baseLines];
        for (const edit of combined) {
            merged.splice(edit.start, edit.end - edit.start, ...edit.newLines);
        }
        return merged;
    }

    private areLineArraysEqual(a: string[], b: string[]): boolean {
        if (a.length !== b.length) {
            return false;
        }
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) {
                return false;
            }
        }
        return true;
    }

    /**
     * Show diff between local and remote file
     */
    private async showDiff(filePath: string, localUri: vscode.Uri, remoteContent: Uint8Array): Promise<void> {
        // Create a temporary URI for the remote content
        const remoteUri = vscode.Uri.parse(`localleaf-remote:${filePath}`);

        // Register a content provider for the remote file
        const provider = new (class implements vscode.TextDocumentContentProvider {
            provideTextDocumentContent(): string {
                return new TextDecoder().decode(remoteContent);
            }
        })();

        const disposable = vscode.workspace.registerTextDocumentContentProvider('localleaf-remote', provider);

        try {
            // Open diff editor
            await vscode.commands.executeCommand('vscode.diff',
                localUri,
                remoteUri,
                `${filePath} (Local <-> Remote)`
            );
        } finally {
            // Keep provider registered while diff is open
            setTimeout(() => disposable.dispose(), 60000); // Dispose after 1 minute
        }
    }

    /**
     * Ask user how to resolve conflict
     */
    private async askConflictResolution(filePath: string, localUri: vscode.Uri, remoteContent: Uint8Array): Promise<'useRemote' | 'useLocal' | 'skip'> {
        // In manual mode, never block; record conflict and skip
        if (this._syncMode === 'manual') {
            this._changeTracker.addLocalChange({
                path: filePath,
                type: 'modified',
                source: 'local',
                timestamp: Date.now(),
            });
            this._changeTracker.addRemoteChange({
                path: filePath,
                type: 'modified',
                source: 'remote',
                timestamp: Date.now(),
            });
            debugLog('askConflictResolution: manual mode; recorded conflict for', filePath);
            return 'skip';
        }

        if (this.applyToAll && this.conflictResolution !== 'ask') {
            return this.conflictResolution as 'useRemote' | 'useLocal' | 'skip';
        }

        // Realtime mode: show interactive dialog
        const firstChoice = await this.showModalChoice({
            message: `Conflict: "${filePath}"`,
            type: 'warning',
            buttons: [
                { label: 'Diff', value: 'diff', primary: true },
                { label: 'Remote', value: 'remote' },
                { label: 'Local', value: 'local' },
                { label: 'All Remote', value: 'allRemote' },
                { label: 'All Local', value: 'allLocal' },
                { label: 'Skip', value: 'skip' },
            ],
        }, 'skip');

        switch (firstChoice) {
            case 'diff':
                await this.showDiff(filePath, localUri, remoteContent);
                return this.askConflictResolutionAfterDiff(filePath);
            case 'remote':
                return 'useRemote';
            case 'local':
                return 'useLocal';
            case 'allRemote':
                this.conflictResolution = 'useRemote';
                this.applyToAll = true;
                return 'useRemote';
            case 'allLocal':
                this.conflictResolution = 'useLocal';
                this.applyToAll = true;
                return 'useLocal';
            default:
                return 'skip';
        }
    }

    /**
     * Ask after viewing diff
     */
    private async askConflictResolutionAfterDiff(filePath: string): Promise<'useRemote' | 'useLocal' | 'skip'> {
        const result = await this.showModalChoice({
            message: `After reviewing diff for "${filePath}", what would you like to do?`,
            type: 'warning',
            buttons: [
                { label: 'Use Remote', value: 'remote', primary: true },
                { label: 'Keep Local', value: 'local' },
                { label: 'Skip', value: 'skip' },
            ],
        }, 'skip');

        switch (result) {
            case 'remote':
                return 'useRemote';
            case 'local':
                return 'useLocal';
            default:
                return 'skip';
        }
    }

    /**
     * Handle a new file from Overleaf that doesn't exist locally.
     * Auto-downloads without prompting.
     */
    private async askNewRemoteFileResolution(_filePath: string, _remoteContent: Uint8Array): Promise<'useRemote' | 'skip'> {
        return 'useRemote';
    }

    /**
     * Handle local files that were deleted on Overleaf.
     * Auto-keeps locally; the user can resolve via the Changes panel.
     */
    private async handleOrphanedLocalFiles(orphanedPaths: string[]): Promise<void> {
        if (orphanedPaths.length === 0) return;

        // Auto-keep: just clear from sync tracking so they aren't flagged again
        for (const p of orphanedPaths) {
            this.deleteBaseContent(p);
            debugLog(`Keeping local file (deleted on Overleaf): ${p}`);
        }
        this.log(`${orphanedPaths.length} file(s) deleted on Overleaf, kept locally`);
    }

    /**
     * Handle files that exist only locally (not on Overleaf, never synced).
     * Records them as outgoing changes so the user can push when ready.
     */
    private async handleLocalOnlyFiles(localOnlyPaths: string[]): Promise<void> {
        if (localOnlyPaths.length === 0) return;

        // In manual mode, record as outgoing changes
        if (this._syncMode === 'manual') {
            for (const p of localOnlyPaths) {
                this._changeTracker.addLocalChange({
                    path: p,
                    type: 'created',
                    source: 'local',
                    timestamp: Date.now(),
                });
            }
            this.log(`${localOnlyPaths.length} local-only file(s) marked as outgoing`);
            return;
        }

        // In realtime mode, auto-upload
        for (const p of localOnlyPaths) {
            try {
                await this.uploadLocalFile(p);
                this.log(`Uploaded new file: ${p}`);
            } catch (error) {
                console.error(`[LocalLeaf] Failed to upload: ${p}`, error);
            }
        }
    }

    /**
     * Ensure all parent folders exist for a given file path.
     * Creates missing folders recursively and adds them to the file tree.
     * Returns the parent folder ID for the file.
     */
    private async ensureParentFoldersExist(relativePath: string): Promise<string> {
        const projectSettings = this.settings.getSettings()!;
        const rootFolderId = this.project?.rootFolder[0]._id;

        if (!rootFolderId) {
            throw new Error('Project root folder not found');
        }

        // Get parent path (e.g., "/tex/chapters/" from "/tex/chapters/intro.tex")
        const parentPath = relativePath.substring(0, relativePath.lastIndexOf('/') + 1) || '/';

        // If parent exists, return its ID
        const existingParent = this.fileTreeByPath.get(parentPath);
        if (existingParent) {
            return existingParent.id;
        }

        // If parent is root, return root ID
        if (parentPath === '/') {
            return rootFolderId;
        }

        // Parse path into folder segments (e.g., ["tex", "chapters"])
        const segments = parentPath.split('/').filter(s => s.length > 0);

        let currentPath = '/';
        let currentParentId = rootFolderId;

        for (const segment of segments) {
            const folderPath = currentPath + segment + '/';
            const existingFolder = this.fileTreeByPath.get(folderPath);

            if (existingFolder) {
                // Folder exists, move to next level
                currentParentId = existingFolder.id;
                currentPath = folderPath;
            } else {
                // Folder doesn't exist, create it
                debugLog('Creating missing parent folder:', folderPath);
                const result = await this.api.addFolder(projectSettings.projectId, currentParentId, segment);

                if (result.type !== 'success' || !result.folder) {
                    throw new Error(`Failed to create folder ${folderPath}: ${result.message}`);
                }

                // Add to file tree
                const folderEntry: FileTreeEntry = {
                    id: result.folder._id,
                    type: 'folder',
                    name: segment,
                    path: folderPath,
                    parentId: currentParentId,
                };
                this.fileTree.set(result.folder._id, folderEntry);
                this.fileTreeByPath.set(folderPath, folderEntry);
                this.setBaseContent(folderPath, new Uint8Array(0));

                this.log(`Created folder on Overleaf: ${folderPath}`);

                currentParentId = result.folder._id;
                currentPath = folderPath;
            }
        }

        return currentParentId;
    }

    /**
     * Wait for a doc entry to appear in the file tree (typically via socket echo).
     */
    private async waitForDocEntry(path: string, timeoutMs: number = 2000): Promise<FileTreeEntry | undefined> {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            const entry = this.fileTreeByPath.get(path);
            if (entry && entry.type === 'doc') {
                return entry;
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        return undefined;
    }

    /**
     * Create a remote text doc and immediately push initial content.
     * This prevents empty-doc races when creating new text files.
     */
    private async createTextDocWithContent(
        projectId: string,
        parentId: string,
        path: string,
        name: string,
        content: Uint8Array
    ): Promise<void> {
        const result = await this.api.addDoc(projectId, parentId, name);
        if (result.type !== 'success') {
            throw new Error(result.message || `Failed to create doc ${path}`);
        }

        let entry: FileTreeEntry | undefined;
        if (result.doc?._id) {
            entry = {
                id: result.doc._id,
                type: 'doc',
                name,
                path,
                parentId,
            };
            this.fileTree.set(result.doc._id, entry);
            this.fileTreeByPath.set(path, entry);
        } else if (this.socket) {
            entry = await this.waitForDocEntry(path);
        }

        if (!entry) {
            throw new Error(`Created doc but could not resolve doc id for ${path}`);
        }

        if (content.length > 0) {
            await this.pushDocumentChanges(entry.id, path, content);
        }
    }

    /**
     * Upload a local file to Overleaf (create new entity).
     */
    private async uploadLocalFile(relativePath: string): Promise<void> {
        const projectSettings = this.settings.getSettings()!;
        const localUri = this.settings.getFilePath(relativePath);
        const content = await vscode.workspace.fs.readFile(localUri);

        // Ensure all parent folders exist (creates them if needed)
        const parentId = await this.ensureParentFoldersExist(relativePath);

        const name = relativePath.split('/').pop()!;
        const isTextFile = this.isTextFile(name);

        this.setStatus('pushing', `Uploading ${relativePath}`, relativePath);

        await this.createRemoteFileFromLocalContent(projectSettings.projectId, parentId, relativePath, name, content, isTextFile);
    }

    private assertApiSuccess(result: { type: 'success' | 'error'; message?: string }, fallbackMessage: string): void {
        if (result.type !== 'success') {
            throw new Error(result.message || fallbackMessage);
        }
    }

    private async createRemoteFileFromLocalContent(
        projectId: string,
        parentId: string,
        relativePath: string,
        name: string,
        content: Uint8Array,
        isTextFile: boolean = this.isTextFile(name),
    ): Promise<void> {
        if (isTextFile && this.socket) {
            await this.createTextDocWithContent(projectId, parentId, relativePath, name, content);
        } else {
            const result = await this.api.uploadFile(projectId, parentId, name, content);
            this.assertApiSuccess(result, `Failed to upload ${relativePath}`);
        }

        this.setBaseContent(relativePath, content);
        this.fileCache.set(relativePath, { hash: hashContent(content), timestamp: Date.now() });
    }

    private async forcePushCreatedChange(
        change: PendingChange,
        existingRemoteEntry: FileTreeEntry,
        localUri: vscode.Uri,
        stat: vscode.FileStat,
        projectId: string,
    ): Promise<void> {
        const name = change.path.split('/').pop()!;

        if (stat.type === vscode.FileType.Directory) {
            const folderPath = change.path.endsWith('/') ? change.path : change.path + '/';
            if (existingRemoteEntry.type !== 'folder') {
                const deleteResult = await this.api.deleteEntity(projectId, existingRemoteEntry.type, existingRemoteEntry.id);
                this.assertApiSuccess(deleteResult, `Failed to replace existing remote ${change.path}`);
                this.removePathTracking(existingRemoteEntry.path, false);

                const parentId = await this.ensureParentFoldersExist(change.path);
                const createResult = await this.api.addFolder(projectId, parentId, name);
                this.assertApiSuccess(createResult, `Failed to create folder ${folderPath}`);
                if (!createResult.folder) {
                    throw new Error(`Created folder but could not resolve folder id for ${folderPath}`);
                }

                const folderEntry: FileTreeEntry = {
                    id: createResult.folder._id,
                    type: 'folder',
                    name,
                    path: folderPath,
                    parentId,
                };
                this.fileTree.set(createResult.folder._id, folderEntry);
                this.fileTreeByPath.set(folderPath, folderEntry);
            }

            this.setBaseContent(folderPath, new Uint8Array(0));
            return;
        }

        const content = await vscode.workspace.fs.readFile(localUri);
        const isTextFile = this.isTextFile(name);

        if (existingRemoteEntry.type === 'doc' && isTextFile) {
            await this.pushDocumentChanges(existingRemoteEntry.id, change.path, content);
            this.setBaseContent(change.path, content);
            this.fileCache.set(change.path, { hash: hashContent(content), timestamp: Date.now() });
            return;
        }

        const deleteResult = await this.api.deleteEntity(projectId, existingRemoteEntry.type, existingRemoteEntry.id);
        this.assertApiSuccess(deleteResult, `Failed to replace existing remote ${change.path}`);
        this.removePathTracking(existingRemoteEntry.path, existingRemoteEntry.type === 'folder');

        const parentId = await this.ensureParentFoldersExist(change.path);
        await this.createRemoteFileFromLocalContent(projectId, parentId, change.path, name, content, isTextFile);
    }

    /**
     * Perform full sync (pull all files)
     */
    async pullAll(options: PullAllOptions = {}): Promise<void> {
        if (!this.project) {
            throw new Error('Not connected');
        }

        debugLog('pullAll: Starting pull');
        debugLog('pullAll: File tree size:', this.fileTree.size);
        debugLog('pullAll: Project name:', this.project.name);

        this._isPulling = true;

        // Reset conflict resolution state
        this.conflictResolution = 'ask';
        this.applyToAll = false;

        this.setStatus('pulling', 'Downloading all files...');
        const projectSettings = this.settings.getSettings()!;

        let downloadedCount = 0;
        let skippedCount = 0;
        let conflictCount = 0;
        const unresolvedManualConflictPaths = new Set<string>();

        try {
            const downloadFile = async (entry: FileTreeEntry) => {
                debugLog('pullAll: Processing', entry.path, entry.type);

                if (entry.type === 'folder') {
                    const localUri = this.settings.getFilePath(entry.path);
                    await vscode.workspace.fs.createDirectory(localUri);
                    // Track folders in baseContent with empty content
                    this.setBaseContent(entry.path, new Uint8Array(0));
                    if (options.remoteWins) {
                        this._changeTracker.clearLocal(entry.path);
                        this._changeTracker.clearRemote(entry.path);
                    }
                    return;
                }

                if (!this.shouldSync(entry.path)) {
                    debugLog('pullAll: Ignored', entry.path);
                    return;
                }

                // Get remote content - docs use joinDoc via socket, files use HTTP
                let remoteContent: Uint8Array;

                if (entry.type === 'doc') {
                    const content = await this.fetchDocContentBytes(entry.id, false);
                    if (!content) {
                        debugLog('pullAll: Failed to get doc', entry.path);
                        return;
                    }
                    remoteContent = content;
                } else {
                    // For binary files, use HTTP API
                    const result = await this.api.getFile(projectSettings.projectId, entry.id);
                    if (result.type !== 'success' || !result.content) {
                        debugLog('pullAll: Failed to get file', entry.path);
                        return;
                    }
                    remoteContent = result.content;
                    debugLog('pullAll: Got file via HTTP', entry.path, 'size:', result.content.length);
                }

                const localUri = this.settings.getFilePath(entry.path);
                const exists = await this.localFileExists(localUri);
                const wasSynced = this.baseContent.has(entry.path);

                // Check for conflicts or new remote files
                if (exists) {
                    const hasConflict = await this.hasConflict(localUri, remoteContent);
                    if (hasConflict && !options.remoteWins) {
                        // Try non-overlapping auto-merge for text docs in manual mode.
                        if (this._syncMode === 'manual' && entry.type === 'doc') {
                            let localContent: Uint8Array | undefined;
                            try {
                                localContent = await vscode.workspace.fs.readFile(localUri);
                            } catch {
                                localContent = undefined;
                            }
                            const base = this.baseContent.get(entry.path);
                            const merged = this.tryAutoMergeTextConflict(base, localContent, remoteContent);
                            if (merged && localContent) {
                                if (!contentEquals(localContent, merged)) {
                                    await vscode.workspace.fs.writeFile(localUri, merged);
                                }
                                // Remote baseline moved; keep local as pending delta for later push.
                                this.setBaseContent(entry.path, remoteContent);
                                this.fileCache.set(entry.path, { hash: hashContent(merged), timestamp: Date.now() });
                                if (!this._changeTracker.hasLocalChange(entry.path)) {
                                    this._changeTracker.addLocalChange({
                                        path: entry.path,
                                        type: 'modified',
                                        source: 'local',
                                        timestamp: Date.now(),
                                        entityId: entry.id,
                                        entityType: entry.type,
                                    });
                                }
                                downloadedCount++;
                                return;
                            }
                        }

                        conflictCount++;
                        const resolution = await this.askConflictResolution(entry.path, localUri, remoteContent);

                        if (resolution === 'skip') {
                            debugLog('pullAll: Skipped (user choice)', entry.path);
                            if (this._syncMode === 'manual') {
                                unresolvedManualConflictPaths.add(entry.path);
                            }
                            skippedCount++;
                            return;
                        }

                        if (resolution === 'useLocal') {
                            // Push local content to Overleaf
                            debugLog('pullAll: Using local, pushing to Overleaf', entry.path);
                            this.setStatus('pushing', `Uploading ${entry.path}`, entry.path);
                            const localContent = await vscode.workspace.fs.readFile(localUri);

                            if (entry.type === 'doc' && this.socket) {
                                await this.pushDocumentChanges(entry.id, entry.path, localContent);
                            } else {
                                await this.api.uploadFile(
                                    projectSettings.projectId,
                                    entry.parentId!,
                                    entry.name,
                                    localContent
                                );
                            }

                            this.setBaseContent(entry.path, localContent);
                            this.fileCache.set(entry.path, { hash: hashContent(localContent), timestamp: Date.now() });
                            return;
                        }
                        // resolution === 'useRemote' - continue to download
                    }
                } else if (!wasSynced) {
                    // New file on Overleaf that doesn't exist locally - prompt user
                    conflictCount++;
                    const resolution = await this.askNewRemoteFileResolution(entry.path, remoteContent);

                    if (resolution === 'skip') {
                        debugLog('pullAll: Skipped new remote file (user choice)', entry.path);
                        skippedCount++;
                        return;
                    }
                    // resolution === 'useRemote' - continue to download
                }

                // Download file only if content is different (prevents file flashing)
                let localContent: Uint8Array | undefined;
                if (exists) {
                    try {
                        localContent = await vscode.workspace.fs.readFile(localUri);
                    } catch {
                        localContent = undefined;
                    }
                }

                // Skip write if content is identical
                if (contentEquals(localContent, remoteContent)) {
                    // Content is the same, just update cache
                    this.setBaseContent(entry.path, remoteContent);
                    this.fileCache.set(entry.path, { hash: hashContent(remoteContent), timestamp: Date.now() });
                    if (options.remoteWins) {
                        this._changeTracker.clearLocal(entry.path);
                        this._changeTracker.clearRemote(entry.path);
                    }
                    return;
                }

                this.setStatus('pulling', `Downloading ${entry.path}`, entry.path);
                await vscode.workspace.fs.writeFile(localUri, remoteContent);
                this.setBaseContent(entry.path, remoteContent);
                this.fileCache.set(entry.path, { hash: hashContent(remoteContent), timestamp: Date.now() });
                if (options.remoteWins) {
                    this._changeTracker.clearLocal(entry.path);
                    this._changeTracker.clearRemote(entry.path);
                }
                downloadedCount++;
            };

            // Download all files
            for (const entry of this.fileTree.values()) {
                await downloadFile(entry);
            }

            // Detect files that were deleted on Overleaf but exist locally
            // (files in baseContent but not in fileTreeByPath)
            const orphanedPaths: string[] = [];
            for (const [syncedPath] of this.baseContent) {
                // Skip if still exists on Overleaf
                if (this.fileTreeByPath.has(syncedPath)) continue;
                // Skip folders
                if (syncedPath.endsWith('/')) continue;
                // Skip ignored files
                if (!this.shouldSync(syncedPath)) continue;
                // Check if local file actually exists
                const localUri = this.settings.getFilePath(syncedPath);
                if (await this.localFileExists(localUri)) {
                    orphanedPaths.push(syncedPath);
                }
            }
            if (orphanedPaths.length > 0) {
                if (options.remoteWins) {
                    for (const syncedPath of orphanedPaths) {
                        const localUri = this.settings.getFilePath(syncedPath);
                        try {
                            await vscode.workspace.fs.delete(localUri, { recursive: true, useTrash: false });
                        } catch (error) {
                            if (!isFileNotFoundError(error)) {
                                throw error;
                            }
                        }
                        this.deleteBaseContent(syncedPath);
                        this.fileCache.delete(syncedPath);
                        this._changeTracker.clearLocal(syncedPath);
                        this._changeTracker.clearRemote(syncedPath);
                    }
                } else {
                    await this.handleOrphanedLocalFiles(orphanedPaths);
                }
            }

            // Detect local-only files (exist locally but not on Overleaf or in baseContent)
            const localOnlyPaths: string[] = [];
            const workspaceFolder = this.settings.getWorkspaceFolder();
            const scanLocalFiles = async (dirUri: vscode.Uri, basePath: string = '/'): Promise<void> => {
                try {
                    const entries = await vscode.workspace.fs.readDirectory(dirUri);
                    for (const [name, type] of entries) {
                        const relativePath = basePath + name;
                        const fullPath = type === vscode.FileType.Directory
                            ? relativePath + '/'
                            : relativePath;

                        // Skip ignored files
                        if (!this.shouldSync(fullPath)) continue;

                        if (type === vscode.FileType.Directory) {
                            await scanLocalFiles(vscode.Uri.joinPath(dirUri, name), fullPath);
                        } else {
                            // Check if this file is known to Overleaf or baseContent
                            if (!this.fileTreeByPath.has(fullPath) && !this.baseContent.has(fullPath)) {
                                localOnlyPaths.push(fullPath);
                            }
                        }
                    }
                } catch (error) {
                    debugLog(`Error scanning directory: ${basePath}`, error);
                }
            };
            await scanLocalFiles(workspaceFolder);
            if (localOnlyPaths.length > 0) {
                await this.handleLocalOnlyFiles(localOnlyPaths);
            }

            if (this._syncMode === 'manual') {
                // In manual mode, clear remote changes; they've been reconciled by pullAll.
                // Local changes are kept since they still need to be pushed.
                this._changeTracker.clearRemote();
                // Keep unresolved remote conflicts visible in the Changes panel.
                for (const conflictPath of unresolvedManualConflictPaths) {
                    this._changeTracker.addRemoteChange({
                        path: conflictPath,
                        type: 'modified',
                        source: 'remote',
                        timestamp: Date.now(),
                    });
                }
            } else {
                // In realtime mode, everything was applied, so clear all.
                this._changeTracker.clearAll();
            }
            const fullySynced = await this.updateLastSyncedIfFullySynced();
            const message = fullySynced
                ? `Pull complete: ${downloadedCount} downloaded, ${skippedCount} skipped, ${conflictCount} conflicts`
                : `Pull paused: ${downloadedCount} downloaded, ${skippedCount} skipped, ${conflictCount} conflicts; ${this.getPendingSummary()}`;
            debugLog('pullAll:', message);
            this.setStatus('idle', message);
        } catch (error) {
            const authErr = isAuthError(error);
            this.setStatus('error', authErr ? 'Session expired' : `Pull failed: ${error}`, undefined, authErr);
            throw error;
        } finally {
            this._isPulling = false;
        }
    }

    /**
     * Determine if a file is a text file (doc) vs binary file
     */
    private isTextFile(filename: string): boolean {
        const textExtensions = [
            '.tex', '.bib', '.cls', '.sty', '.txt', '.md', '.rst',
            '.json', '.xml', '.yaml', '.yml', '.csv', '.tsv',
            '.gitignore', '.latexmkrc', 'makefile', '.leafignore',
        ];
        const lower = filename.toLowerCase();
        return textExtensions.some(ext => lower.endsWith(ext) || lower === ext.slice(1));
    }

    /**
     * Pull buffered remote changes in manual mode.
     * Uses three-way conflict detection: local vs remote vs base.
     */
    async pullChanges(): Promise<void> {
        if (!this.project) {
            throw new Error('Not connected');
        }

        const remoteChanges = this._changeTracker.getRemoteChanges();
        if (remoteChanges.length === 0) {
            this.log('Pull: No remote changes to apply');
            return;
        }

        // Reset conflict resolution state
        this.conflictResolution = 'ask';
        this.applyToAll = false;

        this.setStatus('pulling', `Applying ${remoteChanges.length} remote changes...`);
        this._isPulling = true;
        const projectSettings = this.settings.getSettings()!;

        let appliedCount = 0;
        let conflictCount = 0;
        let skippedCount = 0;

        try {
            for (const change of remoteChanges) {
                let keepRemoteChange = false;
                if (!this.shouldSync(change.path)) {
                    this._changeTracker.clearRemote(change.path);
                    continue;
                }
                switch (change.type) {
                    case 'created': {
                        const entry = this.fileTree.get(change.entityId || '');
                        if (!entry) { skippedCount++; break; }

                        const localUri = this.settings.getFilePath(change.path);

                        if (entry.type === 'folder') {
                            await vscode.workspace.fs.createDirectory(localUri);
                            this.setBaseContent(change.path, new Uint8Array(0));
                        } else {
                            // Download content
                            let remoteContent: Uint8Array | undefined;
                            if (entry.type === 'doc') {
                                remoteContent = await this.fetchDocContentBytes(entry.id, false);
                            } else {
                                const result = await this.api.getFile(projectSettings.projectId, entry.id);
                                if (result.type === 'success' && result.content) {
                                    remoteContent = result.content;
                                }
                            }

                            if (remoteContent) {
                                // Check if local file already exists (potential conflict)
                                const exists = await this.localFileExists(localUri);
                                if (exists) {
                                    const hasConflict = await this.hasConflict(localUri, remoteContent);
                                    if (hasConflict) {
                                        conflictCount++;
                                        const resolution = await this.askConflictResolution(change.path, localUri, remoteContent);
                                        if (resolution === 'skip') {
                                            if (this._syncMode === 'manual') {
                                                keepRemoteChange = true;
                                            }
                                            skippedCount++;
                                            break;
                                        }
                                        if (resolution === 'useLocal') { break; }
                                    }
                                }

                                await vscode.workspace.fs.writeFile(localUri, remoteContent);
                                this.setBaseContent(change.path, remoteContent);
                                this.fileCache.set(change.path, { hash: hashContent(remoteContent), timestamp: Date.now() });
                            }
                        }
                        appliedCount++;
                        break;
                    }

                    case 'modified': {
                        const entry = this.fileTree.get(change.entityId || '') || this.fileTreeByPath.get(change.path);
                        if (!entry) { skippedCount++; break; }

                        // Download latest remote content
                        let remoteContent: Uint8Array | undefined;
                        if (entry.type === 'doc') {
                            remoteContent = await this.fetchDocContentBytes(entry.id, false);
                        } else {
                            const result = await this.api.getFile(projectSettings.projectId, entry.id);
                            if (result.type === 'success' && result.content) {
                                remoteContent = result.content;
                            }
                        }

                        if (!remoteContent) { skippedCount++; break; }

                        const localUri = this.settings.getFilePath(change.path);
                        const base = this.baseContent.get(change.path);

                        // Three-way comparison
                        let localContent: Uint8Array | undefined;
                        try {
                            localContent = await vscode.workspace.fs.readFile(localUri);
                        } catch {
                            localContent = undefined;
                        }

                        const localChanged = localContent && base ? !contentEquals(localContent, base) : false;
                        const remoteChanged = base ? !contentEquals(remoteContent, base) : true;

                        if (!base && localContent && !contentEquals(localContent, remoteContent)) {
                            conflictCount++;
                            const resolution = await this.askConflictResolution(change.path, localUri, remoteContent);
                            if (resolution === 'useRemote') {
                                await vscode.workspace.fs.writeFile(localUri, remoteContent);
                                this.setBaseContent(change.path, remoteContent);
                                this.fileCache.set(change.path, { hash: hashContent(remoteContent), timestamp: Date.now() });
                                appliedCount++;
                            } else if (resolution === 'useLocal') {
                                // Keep local; user can push.
                            } else {
                                if (this._syncMode === 'manual') {
                                    keepRemoteChange = true;
                                }
                                skippedCount++;
                            }
                        } else if (!localChanged && !remoteChanged) {
                            // No changes; skip
                        } else if (!localChanged && remoteChanged) {
                            // Only remote changed; safe to pull
                            await vscode.workspace.fs.writeFile(localUri, remoteContent);
                            this.setBaseContent(change.path, remoteContent);
                            this.fileCache.set(change.path, { hash: hashContent(remoteContent), timestamp: Date.now() });
                            appliedCount++;
                        } else if (localChanged && !remoteChanged) {
                            // Only local changed; nothing to pull
                            skippedCount++;
                        } else if (localContent && contentEquals(localContent, remoteContent)) {
                            // Both changed to same content; update base
                            this.setBaseContent(change.path, remoteContent);
                            this.fileCache.set(change.path, { hash: hashContent(remoteContent), timestamp: Date.now() });
                        } else {
                            // Try non-overlapping auto-merge for text docs.
                            if (entry.type === 'doc' && localContent) {
                                const merged = this.tryAutoMergeTextConflict(base, localContent, remoteContent);
                                if (merged) {
                                    if (!contentEquals(localContent, merged)) {
                                        await vscode.workspace.fs.writeFile(localUri, merged);
                                    }
                                    // Remote baseline moved; keep local as pending delta for later push.
                                    this.setBaseContent(change.path, remoteContent);
                                    this.fileCache.set(change.path, { hash: hashContent(merged), timestamp: Date.now() });
                                    if (this._syncMode === 'manual' && !this._changeTracker.hasLocalChange(change.path)) {
                                        this._changeTracker.addLocalChange({
                                            path: change.path,
                                            type: 'modified',
                                            source: 'local',
                                            timestamp: Date.now(),
                                            entityId: entry.id,
                                            entityType: entry.type,
                                        });
                                    }
                                    appliedCount++;
                                    break;
                                }
                            }

                            // True conflict
                            conflictCount++;
                            const resolution = await this.askConflictResolution(change.path, localUri, remoteContent);
                            if (resolution === 'useRemote') {
                                await vscode.workspace.fs.writeFile(localUri, remoteContent);
                                this.setBaseContent(change.path, remoteContent);
                                this.fileCache.set(change.path, { hash: hashContent(remoteContent), timestamp: Date.now() });
                                appliedCount++;
                            } else if (resolution === 'useLocal') {
                                // Keep local; base stays as-is, user will push
                            } else {
                                if (this._syncMode === 'manual') {
                                    keepRemoteChange = true;
                                }
                                skippedCount++;
                            }
                        }
                        break;
                    }

                    case 'deleted': {
                        const localUri = this.settings.getFilePath(change.path);
                        try {
                            await vscode.workspace.fs.delete(localUri, { recursive: true });
                        } catch {
                            // File may already be gone
                        }
                        const includeDescendants = change.entityType === 'folder' || change.path.endsWith('/');
                        const removedEntries = this.removePathTracking(change.path, includeDescendants);
                        for (const removed of removedEntries) {
                            if (removed.type !== 'doc' || !this.joinedDocs.has(removed.id)) continue;
                            try {
                                await this.socket?.leaveDoc(removed.id);
                            } catch {
                                // Ignore leave errors
                            }
                            this.joinedDocs.delete(removed.id);
                        }
                        appliedCount++;
                        break;
                    }

                    case 'renamed': {
                        if (change.oldPath) {
                            const oldUri = this.settings.getFilePath(change.oldPath);
                            const newUri = this.settings.getFilePath(change.path);
                            try {
                                await vscode.workspace.fs.rename(oldUri, newUri);
                            } catch {
                                // May fail if old path doesn't exist locally
                            }
                            const includeDescendants = change.entityType === 'folder' || change.oldPath.endsWith('/');
                            this.movePathTracking(change.oldPath, change.path, includeDescendants);
                        }
                        appliedCount++;
                        break;
                    }

                    case 'moved': {
                        if (change.oldPath) {
                            const oldUri = this.settings.getFilePath(change.oldPath);
                            const newUri = this.settings.getFilePath(change.path);
                            try {
                                await vscode.workspace.fs.rename(oldUri, newUri);
                            } catch {
                                // May fail if old path doesn't exist locally
                            }
                            const includeDescendants = change.entityType === 'folder' || change.oldPath.endsWith('/');
                            this.movePathTracking(change.oldPath, change.path, includeDescendants);
                        }
                        appliedCount++;
                        break;
                    }
                }

                // Clear processed change
                if (!keepRemoteChange) {
                    this._changeTracker.clearRemote(change.path);
                }
            }

            const fullySynced = await this.updateLastSyncedIfFullySynced();
            const message = fullySynced
                ? `Pull complete: ${appliedCount} applied, ${skippedCount} skipped, ${conflictCount} conflicts`
                : `Pull paused: ${appliedCount} applied, ${skippedCount} skipped, ${conflictCount} conflicts; ${this.getPendingSummary()}`;
            this.log(message);
            this.setStatus('idle', message);
        } catch (error) {
            const authErr = isAuthError(error);
            this.setStatus('error', authErr ? 'Session expired' : `Pull failed: ${error}`, undefined, authErr);
            throw error;
        } finally {
            this._isPulling = false;
        }
    }

    /**
     * Push buffered local changes in manual mode.
     */
    async pushChanges(options?: PushChangesOptions): Promise<void> {
        if (!this.project) {
            throw new Error('Not connected');
        }

        const pathFilter = options?.paths ? new Set(options.paths) : undefined;
        const localChanges = pathFilter
            ? this._changeTracker.getLocalChanges().filter(change => pathFilter.has(change.path))
            : this._changeTracker.getLocalChanges();
        if (localChanges.length === 0) {
            this.log('Push: No local changes to push');
            return;
        }

        // Check for conflicts before pushing (skip if force)
        if (!options?.force) {
            const conflicts = this._changeTracker.getConflicts();
            if (conflicts.length > 0) {
                const choice = await this.showModalChoice({
                    message: `${conflicts.length} file(s) have both local and remote changes. Pull first to resolve conflicts.`,
                    type: 'warning',
                    buttons: [
                        { label: 'Pull First', value: 'pull', primary: true },
                        { label: 'Force Push', value: 'force', danger: true },
                        { label: 'Cancel', value: 'cancel' },
                    ],
                });
                if (choice === 'pull') {
                    await this.pullChanges();
                    return;
                }
                if (choice !== 'force') {
                    return;
                }
            }
        }

        this.setStatus('pushing', `Pushing ${localChanges.length} local changes...`);
        const projectSettings = this.settings.getSettings()!;

        let pushedCount = 0;

        // Mark all paths being pushed to suppress echoes from server
        for (const change of localChanges) {
            this._recentlyPushedPaths.add(change.path);
            if (change.oldPath) {
                this._recentlyPushedPaths.add(change.oldPath);
            }
        }

        try {
            for (const change of localChanges) {
                if (!this.shouldSync(change.path)) {
                    this._changeTracker.clearLocal(change.path);
                    continue;
                }
                let clearProcessedChange = false;
                switch (change.type) {
                    case 'modified': {
                        const entry = this.fileTreeByPath.get(change.path);
                        if (!entry) break;

                        const localUri = this.settings.getFilePath(change.path);
                        let content: Uint8Array;
                        try {
                            content = await vscode.workspace.fs.readFile(localUri);
                        } catch {
                            break; // File no longer exists
                        }

                        this.setStatus('pushing', `Uploading ${change.path}`, change.path);

                        if (entry.type === 'doc' && this.socket) {
                            await this.pushDocumentChanges(entry.id, change.path, content);
                        } else {
                            await this.api.uploadFile(
                                projectSettings.projectId,
                                entry.parentId!,
                                entry.name,
                                content
                            );
                        }

                        this.setBaseContent(change.path, content);
                        this.fileCache.set(change.path, { hash: hashContent(content), timestamp: Date.now() });
                        pushedCount++;
                        clearProcessedChange = true;
                        break;
                    }

                    case 'created': {
                        const localUri = this.settings.getFilePath(change.path);
                        let stat: vscode.FileStat;
                        try {
                            stat = await vscode.workspace.fs.stat(localUri);
                        } catch {
                            clearProcessedChange = true;
                            break; // File no longer exists
                        }

                        this.setStatus('pushing', `Creating ${change.path}`, change.path);
                        const name = change.path.split('/').pop()!;
                        const remotePath = stat.type === vscode.FileType.Directory
                            ? (change.path.endsWith('/') ? change.path : change.path + '/')
                            : change.path;
                        const existingRemoteEntry = this.fileTreeByPath.get(remotePath);

                        if (options?.force && existingRemoteEntry) {
                            await this.forcePushCreatedChange(change, existingRemoteEntry, localUri, stat, projectSettings.projectId);
                            pushedCount++;
                            clearProcessedChange = true;
                            break;
                        }

                        const parentId = await this.ensureParentFoldersExist(change.path);

                        if (stat.type === vscode.FileType.Directory) {
                            const result = await this.api.addFolder(projectSettings.projectId, parentId, name);
                            this.assertApiSuccess(result, `Failed to create folder ${change.path}`);
                            if (result.type === 'success' && result.folder) {
                                const folderPath = change.path + '/';
                                const folderEntry: FileTreeEntry = {
                                    id: result.folder._id,
                                    type: 'folder',
                                    name,
                                    path: folderPath,
                                    parentId,
                                };
                                this.fileTree.set(result.folder._id, folderEntry);
                                this.fileTreeByPath.set(folderPath, folderEntry);
                                this.setBaseContent(folderPath, new Uint8Array(0));
                            }
                        } else {
                            const content = await vscode.workspace.fs.readFile(localUri);
                            const isTextFile = this.isTextFile(name);

                            await this.createRemoteFileFromLocalContent(
                                projectSettings.projectId,
                                parentId,
                                change.path,
                                name,
                                content,
                                isTextFile
                            );
                        }
                        pushedCount++;
                        clearProcessedChange = true;
                        break;
                    }

                    case 'deleted': {
                        const entry = change.entityId ? this.fileTree.get(change.entityId) : this.fileTreeByPath.get(change.path);
                        if (!entry) {
                            clearProcessedChange = true;
                            break;
                        }

                        this.setStatus('pushing', `Deleting ${change.path}`, change.path);
                        await this.api.deleteEntity(projectSettings.projectId, entry.type, entry.id);

                        const removedEntries = this.removePathTracking(entry.path, entry.type === 'folder');
                        for (const removed of removedEntries) {
                            if (removed.type !== 'doc' || !this.joinedDocs.has(removed.id)) continue;
                            try {
                                await this.socket?.leaveDoc(removed.id);
                            } catch {
                                // Ignore leave errors
                            }
                            this.joinedDocs.delete(removed.id);
                        }
                        pushedCount++;
                        clearProcessedChange = true;
                        break;
                    }
                }

                // Clear processed change
                if (clearProcessedChange) {
                    this._changeTracker.clearLocal(change.path);
                }
            }

            const fullySynced = await this.updateLastSyncedIfFullySynced();
            const message = fullySynced
                ? `Push complete: ${pushedCount} files pushed`
                : `Push finished: ${pushedCount} files pushed; ${this.getPendingSummary()}`;
            this.log(message);
            this.setStatus('idle', message);
        } catch (error) {
            if (isFileAlreadyExistsError(error) && !options?.fileExistsRetry) {
                const choice = options?.force
                    ? 'force'
                    : await this.showModalChoice({
                        message: `Overleaf reports that a file already exists while pushing. Force push will refresh the remote tree and overwrite the existing remote file with your local copy.\n\n${error}`,
                        type: 'warning',
                        buttons: [
                            { label: 'Force Push', value: 'force', danger: true },
                            { label: 'Cancel', value: 'cancel' },
                        ],
                    });

                if (choice === 'force') {
                    await this.refreshProjectFileTree();
                    await this.pushChanges({ ...options, force: true, fileExistsRetry: true });
                    return;
                }

                this.setStatus('idle', 'Push canceled');
                return;
            }

            const authErr = isAuthError(error);
            this.setStatus('error', authErr ? 'Session expired' : `Push failed: ${error}`, undefined, authErr);
            throw error;
        } finally {
            // Clear echo suppression after a delay to cover socket round-trip
            const pushedPaths = new Set(this._recentlyPushedPaths);
            setTimeout(() => {
                for (const p of pushedPaths) {
                    this._recentlyPushedPaths.delete(p);
                }
            }, DEBOUNCE_DELAY * 2);
        }
    }

    /**
     * Get remote file content by relative path.
     * Returns undefined if the file is not found or content cannot be fetched.
     */
    async getRemoteContent(relativePath: string): Promise<Uint8Array | undefined> {
        const entry = this.fileTreeByPath.get(relativePath);
        if (!entry || entry.type === 'folder') { return undefined; }

        const projectSettings = this.settings.getSettings();
        if (!projectSettings) { return undefined; }

        if (entry.type === 'doc') {
            if (this.socket) {
                try {
                    const wasJoined = this.joinedDocs.has(entry.id);
                    const { lines } = await this.socket.joinDoc(entry.id);
                    const content = new TextEncoder().encode(lines.join('\n'));
                    if (!wasJoined) {
                        await this.socket.leaveDoc(entry.id);
                    } else {
                        this.joinedDocs.add(entry.id);
                    }
                    return content;
                } catch { /* fall through to HTTP */ }
            }
            const result = await this.api.getDocContent(projectSettings.projectId, entry.id);
            if (result.type === 'success' && result.lines) {
                return new TextEncoder().encode(result.lines.join('\n'));
            }
        } else {
            const result = await this.api.getFile(projectSettings.projectId, entry.id);
            if (result.type === 'success' && result.content) {
                return result.content;
            }
        }

        return undefined;
    }

    /**
     * Resolve a tracked conflict by applying the current remote version locally.
     */
    async resolveConflictWithRemote(relativePath: string): Promise<void> {
        const remoteChange = this._changeTracker.getRemoteChange(relativePath);
        if (!remoteChange && !this.fileTreeByPath.has(relativePath)) {
            throw new Error(`No remote change found for ${relativePath}`);
        }

        this._isPulling = true;
        try {
            if (remoteChange?.type === 'deleted') {
                const localUri = this.settings.getFilePath(relativePath);
                try {
                    await vscode.workspace.fs.delete(localUri, { recursive: true });
                } catch {
                    // File may already be gone.
                }
                const includeDescendants = remoteChange.entityType === 'folder' || relativePath.endsWith('/');
                this.removePathTracking(relativePath, includeDescendants);
            } else if (remoteChange?.entityType === 'folder' || relativePath.endsWith('/')) {
                const localUri = this.settings.getFilePath(relativePath);
                await vscode.workspace.fs.createDirectory(localUri);
                this.setBaseContent(relativePath, new Uint8Array(0));
            } else {
                const remoteContent = await this.getRemoteContent(relativePath);
                if (!remoteContent) {
                    throw new Error(`Cannot fetch remote content for ${relativePath}`);
                }

                const localUri = this.settings.getFilePath(relativePath);
                this._remoteUpdatingPaths.add(relativePath);
                try {
                    await vscode.workspace.fs.writeFile(localUri, remoteContent);
                } finally {
                    this._remoteUpdatingPaths.delete(relativePath);
                }

                this.setBaseContent(relativePath, remoteContent);
                this.fileCache.set(relativePath, {
                    hash: hashContent(remoteContent),
                    timestamp: Date.now(),
                });
            }

            this._changeTracker.clearLocal(relativePath);
            this._changeTracker.clearRemote(relativePath);
            await this.updateLastSyncedIfFullySynced();
        } finally {
            this._isPulling = false;
        }
    }

    /**
     * Revert one pending local change back to the last synced baseline.
     */
    async revertLocalChange(relativePath: string): Promise<boolean> {
        const change = this._changeTracker.getLocalChange(relativePath);
        if (!change) {
            return false;
        }

        const localUri = this.settings.getFilePath(change.path);
        const isFolder = change.entityType === 'folder' || change.path.endsWith('/');
        const wasPulling = this._isPulling;
        this._isPulling = true;

        try {
            switch (change.type) {
                case 'created':
                    try {
                        await vscode.workspace.fs.delete(localUri, { recursive: true, useTrash: false });
                    } catch (error) {
                        if (!isFileNotFoundError(error)) {
                            throw error;
                        }
                    }
                    this.fileCache.delete(change.path);
                    break;

                case 'modified':
                case 'deleted': {
                    const baseContent = this.baseContent.get(change.path);
                    if (!baseContent) {
                        throw new Error(`Cannot revert ${change.path}: no synced baseline is available`);
                    }

                    if (isFolder) {
                        await vscode.workspace.fs.createDirectory(localUri);
                    } else {
                        await vscode.workspace.fs.createDirectory(this.getParentUri(localUri));
                        await vscode.workspace.fs.writeFile(localUri, baseContent);
                    }
                    this.fileCache.set(change.path, { hash: hashContent(baseContent), timestamp: Date.now() });
                    break;
                }

                default:
                    throw new Error(`Cannot revert unsupported local change type "${change.type}" for ${change.path}`);
            }

            this._changeTracker.clearLocal(change.path);
            await this.updateLastSyncedIfFullySynced();
            return true;
        } finally {
            this._isPulling = wasPulling;
        }
    }

    /**
     * Revert multiple pending local changes.
     */
    async revertLocalChanges(paths: string[]): Promise<number> {
        let revertedCount = 0;
        const errors: string[] = [];

        for (const path of paths) {
            try {
                if (await this.revertLocalChange(path)) {
                    revertedCount++;
                }
            } catch (error) {
                errors.push(`${path}: ${error}`);
            }
        }

        if (errors.length > 0) {
            throw new Error(errors.join('\n'));
        }

        return revertedCount;
    }

    /**
     * Resolve a tracked conflict by pushing the current local version remotely.
     */
    async resolveConflictWithLocal(relativePath: string): Promise<void> {
        if (!this._changeTracker.hasLocalChange(relativePath)) {
            throw new Error(`No local change found for ${relativePath}`);
        }

        const remoteChange = this._changeTracker.getRemoteChange(relativePath);
        if (remoteChange?.type === 'deleted' && !this.fileTreeByPath.has(relativePath)) {
            this._changeTracker.addLocalChange({
                path: relativePath,
                type: 'created',
                source: 'local',
                timestamp: Date.now(),
            });
        }

        await this.pushChanges({ force: true, paths: [relativePath] });
        if (!this._changeTracker.hasLocalChange(relativePath)) {
            this._changeTracker.clearRemote(relativePath);
            await this.updateLastSyncedIfFullySynced();
        }
    }

    /**
     * Get the socket instance
     */
    getSocket(): SocketIOAPI | undefined {
        return this.socket;
    }

    /**
     * Disconnect and cleanup
     */
    async disconnect(): Promise<void> {
        this._changeTracker.dispose();
        await this.flushPersistedBaseline();
        this.socket?.disconnect();
        this.socket = undefined;
        for (const timer of this.docPushTimers.values()) {
            clearTimeout(timer);
        }
        this.docPushTimers.clear();
        for (const timer of this.pendingRemoteApplyTimers.values()) {
            clearTimeout(timer);
        }
        this.pendingRemoteApplyTimers.clear();
        this.pendingRemoteDocContent.clear();
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
        this.localWatcher = undefined;
        this.ignoreWatcher = undefined;
        this.setStatus('disconnected');
    }

    /**
     * Get file tree
     */
    getFileTree(): Map<string, FileTreeEntry> {
        return this.fileTree;
    }
}
