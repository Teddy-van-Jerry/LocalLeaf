/**
 * LocalLeaf Sync Engine
 * Handles real-time bidirectional sync between local files and Overleaf
 */

import * as vscode from 'vscode';
import { BaseAPI, ProjectEntity, FileEntity, FolderEntity } from '../api/base';
import { SocketIOAPI, DocumentUpdate } from '../api/socketio';
import { SettingsManager, ProjectSettings } from '../utils/settingsManager';
import { IgnoreParser } from './ignoreParser';
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

/**
 * Hash function for content comparison
 */
function hashContent(content: Uint8Array | undefined): number {
    if (!content) return -1;
    let hash = 0;
    for (const chr of content) {
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
    if (error && typeof error === 'object' && 'code' in error &&
        ['FileNotFound', 'EntryNotFound', 'ENOENT'].includes(String(error.code))) return true;
    if (error instanceof vscode.FileSystemError) {
        // VS Code FileSystemError has a 'code' property
        return error.code === 'FileNotFound' || error.code === 'EntryNotFound';
    }
    // Also check error message as fallback
    if (error && typeof error === 'object' && 'message' in error) {
        const msg = String(error.message).toLowerCase();
        return msg.includes('entrynotfound') || msg.includes('filenotfound') || msg.includes('enoent');
    }
    return false;
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

function ensureApiSuccess(result: { type: 'success' | 'error'; message?: string }, action: string): void {
    if (!result || result.type !== 'success') {
        throw new Error(`${action}: ${result?.message || 'unknown Overleaf API error'}`);
    }
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

/**
 * Sync Engine - manages real-time file synchronization
 */
export class SyncEngine {
    private socket?: SocketIOAPI;
    private disposed = false;
    private authExpired = false;
    private manualPushInProgress = false;
    private manualPullInProgress = false;
    private pendingRemoteDocuments = new Map<string, NodeJS.Timeout>();
    private pendingRemoteStructure = new Set<NodeJS.Timeout>();
    private deferredLocalChanges = new Map<string, () => Promise<void>>();
    private project?: ProjectEntity;
    private localWatcher?: vscode.FileSystemWatcher;
    private fileTree: Map<string, FileTreeEntry> = new Map();
    private fileTreeByPath: Map<string, FileTreeEntry> = new Map();
    private fileCache: Map<string, FileCache> = new Map();
    private baseContent: Map<string, Uint8Array> = new Map();
    private ignoreParser: IgnoreParser;
    private _status: SyncStatus = 'disconnected';
    private _onStatusChange = new vscode.EventEmitter<SyncStatusEvent>();
    private disposables: vscode.Disposable[] = [];
    private syncLock: Set<string> = new Set();
    private joinedDocs: Set<string> = new Set();
    private suppressedRemoteDeletes: Set<string> = new Set();
    private suppressedRemoteRenames: Map<string, Set<string>> = new Map();
    private logFn?: (message: string) => void;

    readonly onStatusChange = this._onStatusChange.event;

    constructor(
        private readonly api: BaseAPI,
        private readonly settings: SettingsManager,
        logFn?: (message: string) => void
    ) {
        const workspaceFolder = settings.getWorkspaceFolder();
        this.ignoreParser = new IgnoreParser(workspaceFolder, settings.getSettings());
        this.logFn = logFn;
    }

    private log(message: string): void {
        this.logFn?.(message);
    }

    /**
     * Get current sync status
     */
    get status(): SyncStatus {
        return this._status;
    }

    /**
     * Set status and emit event
     */
    private setStatus(status: SyncStatus, message?: string, file?: string, authError: boolean = false): void {
        this._status = status;
        this._onStatusChange.fire({ status, message, file, authError });
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
                onConnected: () => {
                    if (!this.disposed && !this.authExpired) this.setStatus('idle', 'Connected (real-time)');
                },
                onDisconnected: (isAuthError?: boolean) => {
                    if (this.disposed || this.authExpired) return;
                    if (isAuthError) {
                        this.authExpired = true;
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
            this.log(`Real-time connection failed: ${error}`);
            this.socket?.disconnect();
            this.socket = undefined;
            if (this.authExpired) throw new Error('Session expired');
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

                this.setStatus('disconnected', 'HTTP available; real-time connection unavailable');
            } catch (httpError) {
                const authErr = isAuthError(httpError);
                this.setStatus('error', authErr ? 'Session expired' : `Failed to connect: ${httpError}`, undefined, authErr);
                throw httpError;
            }
        }

        // Start the watcher only after the initial pull has resolved local conflicts.
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
    startLocalWatcher(): void {
        if (this.disposed || this.localWatcher || !this.socket?.isConnected) return;
        const workspaceFolder = this.settings.getWorkspaceFolder();
        const pattern = new vscode.RelativePattern(workspaceFolder, '**/*');

        this.localWatcher = vscode.workspace.createFileSystemWatcher(pattern);

        this.disposables.push(
            this.localWatcher.onDidChange(uri => this.handleLocalFileChange(uri)),
            this.localWatcher.onDidCreate(uri => this.handleLocalFileCreate(uri)),
            this.localWatcher.onDidDelete(uri => this.handleLocalFileDelete(uri)),
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
        return !this.ignoreParser.shouldIgnore(relativePath);
    }

    /**
     * Check if we should propagate a change (prevent echo)
     */
    private shouldPropagate(action: 'push' | 'pull', path: string, content?: Uint8Array): boolean {
        const cache = this.fileCache.get(path);
        const newHash = hashContent(content);

        // Only identical content is an echo. Editors often emit an empty
        // create/change event followed immediately by the actual contents.
        if (cache && cache.hash === newHash && contentEquals(this.baseContent.get(path), content)) {
            return false;
        }

        return true;
    }

    /**
     * Acquire sync lock for a path
     */
    private acquireLock(path: string): boolean {
        const normalized = path.replace(/\/$/, '');
        if ([...this.syncLock].some(locked => {
            const other = locked.replace(/\/$/, '');
            return other === normalized || normalized.startsWith(other + '/') || other.startsWith(normalized + '/');
        })) {
            return false;
        }
        this.syncLock.add(path);
        return true;
    }

    /**
     * Release sync lock for a path
     */
    private releaseLock(path: string): void {
        this.syncLock.delete(path);
    }

    private isLocalDirty(path: string): boolean {
        const uri = this.settings.getFilePath(path);
        return vscode.workspace.textDocuments?.some(doc => doc.isDirty &&
            doc.uri.scheme === uri.scheme &&
            (doc.uri.path === uri.path || (path.endsWith('/') && doc.uri.path.startsWith(uri.path)))) ?? false;
    }

    private async readLocal(path: string): Promise<Uint8Array | undefined> {
        try {
            return await vscode.workspace.fs.readFile(this.settings.getFilePath(path));
        } catch (error) {
            if (isFileNotFoundError(error)) return undefined;
            throw error;
        }
    }

    private async assertLocalPathSafe(path: string): Promise<void> {
        let prefix = '';
        for (const segment of path.split('/').filter(Boolean)) {
            prefix += '/' + segment;
            try {
                const stat = await vscode.workspace.fs.stat(this.settings.getFilePath(prefix));
                if (stat.type & vscode.FileType.SymbolicLink) {
                    throw new Error(`Sync stopped at symbolic link ${prefix}`);
                }
            } catch (error) {
                if (!isFileNotFoundError(error)) throw error;
            }
        }
    }

    private assertActive(): void {
        if (this.disposed || this.authExpired || !this.socket?.isConnected) {
            throw new Error('Sync stopped: no active Overleaf connection');
        }
    }

    private async writeLocalSnapshot(path: string, before: Uint8Array | undefined, remote: Uint8Array): Promise<void> {
        this.assertActive();
        await this.assertLocalPathSafe(path);
        const current = await this.readLocal(path);
        if (this.isLocalDirty(path) || !contentEquals(current, before)) {
            throw new Error(`Local contents changed in ${path}; pull again to review`);
        }
        this.assertActive();
        if (!contentEquals(current, remote)) {
            await vscode.workspace.fs.writeFile(this.settings.getFilePath(path), remote);
        }
        this.baseContent.set(path, remote);
        this.fileCache.set(path, { hash: hashContent(remote), timestamp: Date.now() });
    }

    private async readRemoteContent(entry: FileTreeEntry): Promise<Uint8Array> {
        this.assertActive();
        if (entry.type === 'doc') {
            const { lines } = await this.socket!.joinDoc(entry.id);
            this.joinedDocs.add(entry.id);
            return new TextEncoder().encode(lines.join('\n'));
        }
        const result = await this.api.getFile(this.settings.getSettings()!.projectId, entry.id);
        ensureApiSuccess(result, `Download ${entry.path}`);
        if (!result.content) throw new Error(`No file content returned for ${entry.path}`);
        return result.content;
    }

    private deferRemoteDocument(doc: string): void {
        if (this.pendingRemoteDocuments.has(doc) || this.disposed) return;
        this.pendingRemoteDocuments.set(doc, setTimeout(() => {
            this.pendingRemoteDocuments.delete(doc);
            void this.handleRemoteFileChanged({ doc, v: 0 });
        }, DEBOUNCE_DELAY));
    }

    private suppressRemoteRename(entityId: string, newName: string): void {
        const names = this.suppressedRemoteRenames.get(entityId) || new Set<string>();
        names.add(newName);
        this.suppressedRemoteRenames.set(entityId, names);
    }

    private consumeSuppressedRemoteRename(entityId: string, newName: string): boolean {
        const names = this.suppressedRemoteRenames.get(entityId);
        if (!names?.delete(newName)) {
            return false;
        }
        if (names.size === 0) {
            this.suppressedRemoteRenames.delete(entityId);
        }
        return true;
    }

    // === Local change handlers ===

    private deferAutomaticChange(uri: vscode.Uri, handler: () => Promise<void>): boolean {
        if (this.settings.getSettings()?.autoSync === false ||
            !vscode.workspace.getConfiguration('localleaf', this.settings.getWorkspaceFolder()).get('autoSync', true)) {
            return true;
        }
        if (!this.manualPushInProgress && !this.manualPullInProgress) return false;
        this.deferredLocalChanges.set(uri.path, handler);
        return true;
    }

    /**
     * Handle local file change
     */
    private async handleLocalFileChange(uri: vscode.Uri): Promise<void> {
        if (this.disposed || this.authExpired || !this.socket?.isConnected) return;
        if (this.getRelativePath(uri) === '/.leafignore') { await this.ignoreParser.load(); return; }
        if (this.deferAutomaticChange(uri, () => this.handleLocalFileChange(uri))) return;
        const relativePath = this.getRelativePath(uri);
        if (!this.shouldSync(relativePath)) return;
        if (!this.acquireLock(relativePath)) {
            setTimeout(() => void this.handleLocalFileChange(uri), DEBOUNCE_DELAY);
            return;
        }

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
            if (entry.type === 'doc') {
                if (!this.socket) {
                    throw new Error(`Cannot update ${relativePath}: real-time connection is unavailable`);
                }
                const baseline = this.baseContent.get(relativePath);
                if (!baseline) throw new Error('Pull to resolve unsynchronized local changes before enabling automatic uploads');
                const pushed = await this.pushDocumentChanges(entry.id, relativePath, content, baseline);
                if (pushed) {
                    this.log(`Pushed to Overleaf: ${relativePath}`);
                }
            } else {
                const remote = await this.api.getFile(this.settings.getSettings()!.projectId, entry.id);
                ensureApiSuccess(remote, `Read ${relativePath}`);
                if (!contentEquals(remote.content, this.baseContent.get(relativePath))) {
                    throw new Error('Overleaf contents changed; pull to resolve the conflict');
                }
                await this.replaceRemoteFile(entry, content);
                this.log(`Replaced on Overleaf: ${relativePath}`);
            }

            this.baseContent.set(relativePath, content);
            this.fileCache.set(relativePath, { hash: hashContent(content), timestamp: Date.now() });
            this.setStatus('idle');
        } catch (error) {
            // Don't show error for file-not-found during rapid operations
            if (isFileNotFoundError(error)) {
                debugLog(`File disappeared during sync: ${relativePath}`);
                this.setStatus('idle');
                return;
            }
            this.log(`Failed to sync ${relativePath}: ${error}`);
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
    private async pushDocumentChanges(docId: string, path: string, newContent: Uint8Array, expectedRemote?: Uint8Array): Promise<boolean> {
        this.assertActive();

        try {
            // Join document to get current version (even if already joined for watching)
            const { lines: remoteLines, version } = await this.socket!.joinDoc(docId);
            const remoteContent = remoteLines.join('\n');
            if (expectedRemote && !contentEquals(new TextEncoder().encode(remoteContent), expectedRemote)) {
                throw new Error('Overleaf contents changed; review and push again');
            }
            const localContent = new TextDecoder().decode(newContent);

            // Calculate diff and create OT operations
            const ops = this.calculateOps(remoteContent, localContent);

            if (ops.length > 0) {
                const update: DocumentUpdate = {
                    doc: docId,
                    op: ops,
                    v: version,
                };
                this.assertActive();
                await this.socket!.applyOtUpdate(docId, update);

                // Keep doc joined for watching
                this.joinedDocs.add(docId);
                return true;
            }

            // Keep doc joined for watching even if no changes
            this.joinedDocs.add(docId);
            return false;
        } catch (error) {
            console.error(`[LocalLeaf] OT update failed for ${path}:`, error);
            throw error;
        }
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

    private async refreshProjectFileTree(): Promise<void> {
        if (this.disposed || this.authExpired) throw new Error('Project refresh cancelled');
        const projectSettings = this.settings.getSettings()!;
        const status = this.status;
        const onWait = (delayMs: number, rateLimited = false) => {
            if (this.disposed || this.authExpired) throw new Error('Project refresh cancelled');
            const message = rateLimited
                ? `Overleaf is limiting requests; retrying project refresh in ${Math.ceil(delayMs / 1000)}s...`
                : `Waiting ${Math.ceil(delayMs / 1000)}s before refreshing project files...`;
            this.log(message);
            this.setStatus(status, message);
        };
        // Modern Overleaf HTML contains editor settings, not ol-rootFolder.
        // Read a new protocol-v2 join snapshot instead of scraping that page.
        if (this.socket?.isConnected) {
            const socket = this.socket;
            const project = await socket.refreshProject(onWait);
            if (this.disposed || this.authExpired || this.socket !== socket || !socket.isConnected) {
                throw new Error('Project refresh cancelled');
            }
            this.project = project;
            this.buildFileTree(project);
            return;
        }

        const result = await this.api.getProjectDetails(projectSettings.projectId, onWait);
        if (this.disposed || this.authExpired) throw new Error('Project refresh cancelled');
        ensureApiSuccess(result, 'Refresh project file tree');

        if (!result.projectData?.rootFolder) {
            throw new Error('Refresh project file tree: Overleaf returned no folder tree');
        }

        this.project = {
            ...(this.project || {}),
            _id: result.projectData.projectId || projectSettings.projectId,
            name: result.projectData.projectName || this.project?.name || 'Unknown',
            rootDoc_id: result.projectData.rootDocId || this.project?.rootDoc_id,
            rootFolder: result.projectData.rootFolder,
        } as ProjectEntity;
        this.buildFileTree(this.project);
    }

    private trackUploadedEntity(
        result: { file?: FileEntity },
        parentId: string,
        name: string,
        path: string
    ): FileTreeEntry | undefined {
        if (!result.file?._id) {
            return undefined;
        }

        const entry: FileTreeEntry = {
            id: result.file._id,
            type: result.file._type || 'file',
            name: result.file.name || name,
            path,
            parentId,
        };
        this.fileTree.set(entry.id, entry);
        this.fileTreeByPath.set(path, entry);
        debugLog('Tracked uploaded file:', path, entry.id);
        return entry;
    }

    private async createTextDocumentWithContent(
        projectId: string,
        parentId: string,
        relativePath: string,
        name: string,
        content: Uint8Array
    ): Promise<void> {
        this.assertActive();
        const result = await this.api.addDoc(projectId, parentId, name);
        ensureApiSuccess(result, `Create ${relativePath}`);

        let entry: FileTreeEntry | undefined;
        if (result.doc?._id) {
            entry = {
                id: result.doc._id,
                type: 'doc',
                name: result.doc.name || name,
                path: relativePath,
                parentId,
            };
            this.fileTree.set(entry.id, entry);
            this.fileTreeByPath.set(relativePath, entry);
        } else {
            await this.refreshProjectFileTree();
            entry = this.fileTreeByPath.get(relativePath);
        }

        if (!entry || entry.type !== 'doc') {
            throw new Error(`Create ${relativePath}: new document was not returned by Overleaf`);
        }
        if (!this.socket) {
            throw new Error(`Create ${relativePath}: real-time connection is required to write document content`);
        }

        await this.pushDocumentChanges(entry.id, relativePath, content, new Uint8Array(0));
    }

    private async deleteRemoteEntry(entry: FileTreeEntry, preserveLocal = false): Promise<void> {
        this.assertActive();
        if (entry.path === '/') throw new Error('Cannot delete the project root');
        const projectSettings = this.settings.getSettings()!;
        if (preserveLocal) {
            this.suppressedRemoteDeletes.add(entry.id);
        }

        const result = await this.api.deleteEntity(projectSettings.projectId, entry.type, entry.id);
        try {
            ensureApiSuccess(result, `Delete ${entry.path}`);
        } catch (error) {
            this.suppressedRemoteDeletes.delete(entry.id);
            throw error;
        }

        this.fileTree.delete(entry.id);
        this.suppressedRemoteRenames.delete(entry.id);
        if (this.fileTreeByPath.get(entry.path)?.id === entry.id) {
            this.fileTreeByPath.delete(entry.path);
        }
        if (!preserveLocal) {
            this.baseContent.delete(entry.path);
            this.fileCache.delete(entry.path);
        }
    }

    private async renameRemoteEntry(entry: FileTreeEntry, name: string, action: string): Promise<void> {
        this.assertActive();
        const projectSettings = this.settings.getSettings()!;
        this.suppressRemoteRename(entry.id, name);
        try {
            const result = await this.api.renameEntity(
                projectSettings.projectId,
                entry.type,
                entry.id,
                name
            );
            ensureApiSuccess(result, action);
        } catch (error) {
            this.consumeSuppressedRemoteRename(entry.id, name);
            throw error;
        }
    }

    private async replaceRemoteFile(entry: FileTreeEntry, content: Uint8Array): Promise<void> {
        if (!entry.parentId) {
            throw new Error(`Replace ${entry.path}: parent folder is unknown`);
        }

        const projectSettings = this.settings.getSettings()!;
        const previousContent = this.baseContent.get(entry.path);
        const suffix = `.localleaf-${entry.id.slice(-12)}-${Date.now().toString(36)}`;
        const temporaryName = `${entry.name.slice(0, Math.max(1, 150 - suffix.length))}${suffix}`;
        let renamedOriginal = false;
        let uploadedReplacement = false;

        try {
            // Overleaf rejects duplicate names. Move the original aside first,
            // then keep it as a rollback copy until the replacement is tracked.
            await this.renameRemoteEntry(
                entry,
                temporaryName,
                `Prepare replacement for ${entry.path}`
            );
            renamedOriginal = true;

            this.assertActive();
            const result = await this.api.uploadFile(
                projectSettings.projectId,
                entry.parentId,
                entry.name,
                content
            );
            ensureApiSuccess(result, `Upload ${entry.path}`);
            uploadedReplacement = true;
            this.baseContent.set(entry.path, content);

            if (!this.trackUploadedEntity(result, entry.parentId, entry.name, entry.path)) {
                await this.refreshProjectFileTree();
            }

            const originalEntry = this.fileTree.get(entry.id) || entry;
            await this.deleteRemoteEntry(originalEntry, true);
            this.fileCache.set(entry.path, { hash: hashContent(content), timestamp: Date.now() });
        } catch (error) {
            if (renamedOriginal && !uploadedReplacement) {
                try {
                    await this.renameRemoteEntry(
                        entry,
                        entry.name,
                        `Restore ${entry.path} after failed replacement`
                    );
                } catch (restoreError) {
                    const replacementMessage = error instanceof Error ? error.message : String(error);
                    const restoreMessage = restoreError instanceof Error
                        ? restoreError.message
                        : String(restoreError);
                    if (previousContent !== undefined) {
                        this.baseContent.set(entry.path, previousContent);
                    } else {
                        this.baseContent.delete(entry.path);
                    }
                    throw new Error(
                        `${replacementMessage}; the original file remains on Overleaf under ` +
                        `${temporaryName} because restoring its name failed: ${restoreMessage}`
                    );
                }
            }

            if (!uploadedReplacement) {
                if (previousContent !== undefined) {
                    this.baseContent.set(entry.path, previousContent);
                } else {
                    this.baseContent.delete(entry.path);
                }
            }
            throw error;
        }
    }

    /**
     * Handle local file creation
     */
    private async handleLocalFileCreate(uri: vscode.Uri): Promise<void> {
        if (this.disposed || this.authExpired || !this.socket?.isConnected) return;
        if (this.getRelativePath(uri) === '/.leafignore') { await this.ignoreParser.load(); return; }
        if (this.deferAutomaticChange(uri, () => this.handleLocalFileCreate(uri))) return;
        const relativePath = this.getRelativePath(uri);
        if (!this.shouldSync(relativePath)) return;
        if (!this.acquireLock(relativePath)) {
            setTimeout(() => void this.handleLocalFileCreate(uri), DEBOUNCE_DELAY);
            return;
        }

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

            const trackedPath = stat.type === vscode.FileType.Directory
                ? relativePath + '/'
                : relativePath;
            if (this.fileTreeByPath.has(trackedPath)) {
                // A create event can be the local echo of a remote write or an
                // editor's atomic replacement of an existing file. Folders
                // already exist remotely; files are re-evaluated as changes.
                if (stat.type !== vscode.FileType.Directory) {
                    setTimeout(() => void this.handleLocalFileChange(uri), DEBOUNCE_DELAY);
                }
                return;
            }

            const projectSettings = this.settings.getSettings()!;

            this.setStatus('pushing', `Creating ${relativePath}`, relativePath);

            // Ensure parent folders exist (creates them if needed)
            const parentId = await this.ensureParentFoldersExist(relativePath);
            const name = relativePath.split('/').pop()!;

            if (stat.type === vscode.FileType.Directory) {
                const folderPath = relativePath + '/';
                const result = await this.api.addFolder(projectSettings.projectId, parentId, name);
                ensureApiSuccess(result, `Create folder ${folderPath}`);

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
                this.baseContent.set(folderPath, new Uint8Array(0));
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

                if (isTextFile) {
                    await this.createTextDocumentWithContent(
                        projectSettings.projectId,
                        parentId,
                        relativePath,
                        name,
                        content
                    );
                } else {
                    this.assertActive();
                    const result = await this.api.uploadFile(
                        projectSettings.projectId,
                        parentId,
                        name,
                        content
                    );
                    ensureApiSuccess(result, `Upload ${relativePath}`);
                    if (!this.trackUploadedEntity(result, parentId, name, relativePath)) {
                        await this.refreshProjectFileTree();
                    }
                }

                this.baseContent.set(relativePath, content);
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
        if (this.disposed || this.authExpired || !this.socket?.isConnected) return;
        if (this.getRelativePath(uri) === '/.leafignore') { await this.ignoreParser.load(); return; }
        if (this.deferAutomaticChange(uri, () => this.handleLocalFileDelete(uri))) return;
        const relativePath = this.getRelativePath(uri);
        if (!relativePath || relativePath === '/') return;
        if (!this.shouldSync(relativePath)) return;
        if (!this.acquireLock(relativePath)) {
            setTimeout(() => void this.handleLocalFileDelete(uri), DEBOUNCE_DELAY);
            return;
        }

        try {
            // Editors often save by unlinking and recreating the same file.
            if (await this.localFileExists(uri)) return;
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
            if (!entry) {
                // Socket events can be missed while reconnecting. Refresh the
                // server tree before deciding there is nothing to delete.
                await this.refreshProjectFileTree();
                entry = this.fileTreeByPath.get(relativePath);
                if (!entry) {
                    const folderPath = relativePath + '/';
                    entry = this.fileTreeByPath.get(folderPath);
                    if (entry) {
                        pathToUse = folderPath;
                    }
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

            const expectedId = entry.id;
            await this.refreshProjectFileTree();
            entry = this.fileTreeByPath.get(pathToUse);
            if (!entry || entry.id !== expectedId) throw new Error('Overleaf file changed; review before deleting');
            const removed = this.subtreeEntries(entry);
            for (const child of removed) {
                if (!this.shouldSync(child.path) || !this.baseContent.has(child.path)) {
                    throw new Error(`Unsynchronized remote item ${child.path}; deletion stopped`);
                }
                if (child.type === 'folder') continue;
                if (!this.shouldSync(child.path) || !this.baseContent.has(child.path) ||
                    !contentEquals(await this.readRemoteContent(child), this.baseContent.get(child.path))) {
                    throw new Error(`Overleaf contents changed in ${child.path}; deletion stopped`);
                }
            }
            if (await this.localFileExists(uri)) return;
            this.assertActive();

            this.setStatus('pushing', `Deleting ${pathToUse}`, pathToUse);

            await this.deleteRemoteEntry(entry, true);
            for (const child of removed) {
                this.fileTree.delete(child.id);
                if (this.fileTreeByPath.get(child.path)?.id === child.id) this.fileTreeByPath.delete(child.path);
                this.baseContent.delete(child.path);
                this.fileCache.delete(child.path);
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
        if (this.disposed || this.authExpired || !this.socket?.isConnected) return;
        const parent = this.fileTree.get(parentId);
        const parentPath = parent?.path || '/';
        const path = type === 'folder' ? parentPath + entity.name + '/' : parentPath + entity.name;

        // Record the remote identity before taking the path lock. Local
        // uploads hold this lock while Overleaf emits the create event.
        const entry: FileTreeEntry = {
            id: entity._id,
            type,
            name: entity.name,
            path,
            parentId,
        };
        this.fileTree.set(entity._id, entry);
        this.fileTreeByPath.set(path, entry);

        if (!this.shouldSync(path)) return;
        if (this.manualPullInProgress || this.manualPushInProgress || !this.acquireLock(path)) {
            this.deferRemoteStructure(() => this.handleRemoteFileCreated(parentId, type, entity));
            return;
        }

        try {
            this.setStatus('pulling', `Downloading ${path}`, path);

            const localUri = this.settings.getFilePath(path);

            if (type === 'folder') {
                await this.assertLocalPathSafe(path);
                this.assertActive();
                await vscode.workspace.fs.createDirectory(localUri);
                // Track folders in baseContent with empty content
                this.baseContent.set(path, new Uint8Array(0));
            } else {
                // Download content - use correct API based on type
                const before = await this.readLocal(path);
                const content = await this.readRemoteContent(entry);

                if (content) {
                    // Prompt user for new remote files
                    // A new remote identity can collide with a local-only file.
                    // Treat that as a conflict, not permission to overwrite it.
                    const baseline = this.baseContent.get(path);
                    const resolution = contentEquals(before, content) ||
                        (baseline !== undefined && contentEquals(before, baseline))
                        ? 'useRemote'
                        : before !== undefined
                            ? await this.askConflictResolution(path, localUri, content)
                            : await this.askNewRemoteFileResolution(path, content);
                    if (resolution !== 'useRemote') {
                        debugLog(`Skipped new remote file (user choice): ${path}`);
                        this.log(`Skipped new file from Overleaf: ${path}`);
                        this.setStatus('idle');
                        return;
                    }

                    await this.writeLocalSnapshot(path, before, content);
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
            this.log(`Remote create deferred: ${path}: ${error}`);
            if (!this.disposed) this.setStatus('error', String(error));
        } finally {
            this.releaseLock(path);
        }
    }

    /**
     * Handle remote file renamed
     */
    private async handleRemoteFileRenamed(entityId: string, newName: string): Promise<void> {
        if (this.disposed || this.authExpired || !this.socket?.isConnected) return;
        if (this.consumeSuppressedRemoteRename(entityId, newName)) return;
        const entry = this.fileTree.get(entityId);
        if (!entry || entry.path === '/') return;
        const parent = this.fileTree.get(entry.parentId!);
        if (!parent) return;
        if (!newName || /[\\/\x00]/.test(newName) || newName === '.' || newName === '..') {
            this.setStatus('error', 'Invalid remote filename');
            return;
        }
        await this.relocateRemoteEntry(entry, parent.path + newName + (entry.type === 'folder' ? '/' : ''), parent.id, newName);
    }

    private async handleRemoteFileMoved(entityId: string, newParentId: string): Promise<void> {
        if (this.disposed || this.authExpired || !this.socket?.isConnected) return;
        const entry = this.fileTree.get(entityId);
        const parent = this.fileTree.get(newParentId);
        if (!entry || !parent || entry.path === '/') return;
        await this.relocateRemoteEntry(entry, parent.path + entry.name + (entry.type === 'folder' ? '/' : ''), parent.id, entry.name);
    }

    private subtreeEntries(entry: FileTreeEntry): FileTreeEntry[] {
        return [...this.fileTree.values()].filter(item => item.id === entry.id ||
            (entry.type === 'folder' && item.path.startsWith(entry.path)));
    }

    private deferRemoteStructure(handler: () => Promise<void>): void {
        if (this.disposed) return;
        const timer = setTimeout(() => {
            this.pendingRemoteStructure.delete(timer);
            void handler().catch(error => this.log(`Deferred remote change failed: ${error}`));
        }, DEBOUNCE_DELAY);
        this.pendingRemoteStructure.add(timer);
    }

    private async isLocalTreeClean(path: string, folder: boolean): Promise<boolean> {
        if (!this.shouldSync(path) || this.isLocalDirty(path)) return false;
        await this.assertLocalPathSafe(path);
        if (!folder) {
            const local = await this.readLocal(path);
            return local === undefined || (this.baseContent.has(path) && contentEquals(local, this.baseContent.get(path)));
        }
        let children: [string, vscode.FileType][];
        try {children = await vscode.workspace.fs.readDirectory(this.settings.getFilePath(path));}
        catch (error) {if (isFileNotFoundError(error)) return true; throw error;}
        for (const [name, type] of children) {
            if (type & vscode.FileType.SymbolicLink) return false;
            const directory = type === vscode.FileType.Directory;
            if (!await this.isLocalTreeClean(path + name + (directory ? '/' : ''), directory)) return false;
        }
        return true;
    }

    private async relocateRemoteEntry(entry: FileTreeEntry, newPath: string, parentId: string, name: string): Promise<void> {
        if (this.disposed || this.authExpired || !this.socket?.isConnected) return;
        const oldPath = entry.path;
        if (oldPath === newPath) return;
        if (!this.acquireLock(oldPath)) {
            this.deferRemoteStructure(() => this.relocateRemoteEntry(entry, newPath, parentId, name));
            return;
        }
        try {
            this.assertActive();
            const changes = this.subtreeEntries(entry).map(item => ({item, old: item.path,
                next: newPath + item.path.slice(oldPath.length)}));
            for (const {item, old, next} of changes) {
                if (this.fileTreeByPath.get(old)?.id === item.id) this.fileTreeByPath.delete(old);
                item.path = next;
                this.fileTreeByPath.set(next, item);
            }
            entry.parentId = parentId;
            entry.name = name;
            if (!this.shouldSync(newPath) || !await this.isLocalTreeClean(oldPath, entry.type === 'folder')) {
                throw new Error(`Local edits or ignored files preserved at ${oldPath}; pull to reconcile remote move`);
            }
            this.assertActive();
            if (this.isLocalDirty(oldPath)) throw new Error(`Unsaved edits preserved at ${oldPath}`);
            if (await this.localFileExists(this.settings.getFilePath(oldPath))) {
                await this.assertLocalPathSafe(newPath);
                await vscode.workspace.fs.rename(this.settings.getFilePath(oldPath), this.settings.getFilePath(newPath), {overwrite: false});
            }
            for (const {old, next} of changes) {
                const base = this.baseContent.get(old);
                const cache = this.fileCache.get(old);
                this.baseContent.delete(old);
                this.fileCache.delete(old);
                if (base !== undefined) this.baseContent.set(next, base);
                if (cache) this.fileCache.set(next, cache);
            }
        } catch (error) {
            this.log(`Remote move deferred: ${error}`);
            if (!this.disposed) this.setStatus('error', String(error));
        } finally {this.releaseLock(oldPath);}
    }

    private async deleteCleanLocalTree(path: string, folder: boolean): Promise<void> {
        this.assertActive();
        if (!await this.isLocalTreeClean(path, folder)) throw new Error(`Local edits preserved at ${path}`);
        if (folder) {
            for (const [name, type] of await vscode.workspace.fs.readDirectory(this.settings.getFilePath(path))) {
                const directory = type === vscode.FileType.Directory;
                await this.deleteCleanLocalTree(path + name + (directory ? '/' : ''), directory);
            }
        }
        this.assertActive();
        if (this.isLocalDirty(path)) throw new Error(`Unsaved edits preserved at ${path}`);
        // Never recursively remove a directory: a newly-created untracked file
        // must cause a nonempty-directory error, not be silently deleted.
        await vscode.workspace.fs.delete(this.settings.getFilePath(path), {recursive: false});
        this.baseContent.delete(path);
        this.fileCache.delete(path);
    }

    private async handleRemoteFileRemoved(entityId: string): Promise<void> {
        if (this.disposed || this.authExpired || !this.socket?.isConnected) return;
        const suppressed = this.suppressedRemoteDeletes.delete(entityId);
        const entry = this.fileTree.get(entityId);
        if (!entry || entry.path === '/') return;
        if (!suppressed && !this.acquireLock(entry.path)) {
            this.deferRemoteStructure(() => this.handleRemoteFileRemoved(entityId));
            return;
        }
        try {
            for (const item of this.subtreeEntries(entry)) {
                this.fileTree.delete(item.id);
                if (this.fileTreeByPath.get(item.path)?.id === item.id) this.fileTreeByPath.delete(item.path);
                this.joinedDocs.delete(item.id);
            }
            if (suppressed || !this.shouldSync(entry.path)) return;
            if (!await this.isLocalTreeClean(entry.path, entry.type === 'folder')) {
                throw new Error(`Local edits or ignored files preserved at ${entry.path}; remote file was deleted`);
            }
            if (await this.localFileExists(this.settings.getFilePath(entry.path))) {
                await this.deleteCleanLocalTree(entry.path, entry.type === 'folder');
            }
        } catch (error) {
            this.log(`Remote deletion deferred: ${error}`);
            if (!this.disposed) this.setStatus('error', String(error));
        } finally {if (!suppressed) this.releaseLock(entry.path);}
    }

    /**
     * Handle remote file content changed (OT update)
     */
    private async handleRemoteFileChanged(update: DocumentUpdate): Promise<void> {
        if (this.disposed || this.authExpired || !this.socket?.isConnected) return;
        const entry = this.fileTree.get(update.doc);
        if (!entry || entry.type !== 'doc' || !this.shouldSync(entry.path)) return;
        if (this.manualPullInProgress || this.manualPushInProgress || !this.acquireLock(entry.path)) {
            this.deferRemoteDocument(update.doc);
            return;
        }
        try {
            const before = await this.readLocal(entry.path);
            const baseline = this.baseContent.get(entry.path);
            if (baseline === undefined || this.isLocalDirty(entry.path) || !contentEquals(before, baseline)) {
                throw new Error(`Local edits in ${entry.path}; pull to resolve the conflict`);
            }
            // Notifications can be duplicated, delayed, or arrive during a local
            // write. Read a versioned snapshot instead of applying untracked OT
            // offsets to whatever happens to be on disk.
            const remote = await this.readRemoteContent(entry);
            if (this.fileTreeByPath.get(entry.path)?.id !== entry.id) return;
            await this.writeLocalSnapshot(entry.path, before, remote);
            this.setStatus('idle');
        } catch (error) {
            this.log(`Remote update deferred: ${error}`);
            if (!this.disposed) this.setStatus('error', String(error));
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
                } catch (error) {
                    throw new Error(`Failed to watch ${entry.path}: ${error}`);
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

    /** Upload user-selected saved files without downloading or deleting local files. */
    async pushAll(): Promise<{ uploaded: number; failed: string[]; cancelled: boolean }> {
        const requireConnection = () => {
            if (this.disposed || this.authExpired || !this.socket?.isConnected) {
                throw new Error('Not connected to Overleaf. Reconnect before pushing.');
            }
        };
        requireConnection();
        if (this.manualPushInProgress || this.manualPullInProgress) throw new Error('A sync is already in progress');
        this.manualPushInProgress = true;
        const previousStatus = this.status;
        const result = { uploaded: 0, failed: [] as string[], cancelled: false };
        try {
            await this.ignoreParser.load();
            const folder = this.settings.getWorkspaceFolder();
            const prefix = folder.path.replace(/\/$/, '') + '/';
            const dirty = vscode.workspace.textDocuments.find(doc =>
                doc.isDirty && doc.uri.scheme === folder.scheme && doc.uri.path.startsWith(prefix) &&
                this.shouldSync(this.getRelativePath(doc.uri)));
            if (dirty) throw new Error(`Save ${this.getRelativePath(dirty.uri)} before pushing to Overleaf.`);
            this.setStatus('pushing', 'Checking local changes...');
            await this.refreshProjectFileTree();
            const projectId = this.settings.getSettings()!.projectId;
            const readRemote = async (entry: FileTreeEntry): Promise<Uint8Array> => {
                requireConnection();
                if (entry.type === 'doc') {
                    const { lines } = await this.socket!.joinDoc(entry.id);
                    this.joinedDocs.add(entry.id);
                    return new TextEncoder().encode(lines.join('\n'));
                }
                if (entry.type !== 'file') throw new Error(`${entry.path} is a folder on Overleaf`);
                const response = await this.api.getFile(projectId, entry.id);
                ensureApiSuccess(response, `Read ${entry.path}`);
                if (!response.content) throw new Error(`No content returned for ${entry.path}`);
                return response.content;
            };
            const candidates: Array<vscode.QuickPickItem & {
                path: string; content: Uint8Array; remote?: Uint8Array; remoteId?: string;
            }> = [];
            const scan = async (directory: vscode.Uri, parent = '/'): Promise<void> => {
                for (const [name, type] of await vscode.workspace.fs.readDirectory(directory)) {
                    const path = parent + name + (type === vscode.FileType.Directory ? '/' : '');
                    if (!this.shouldSync(path) || (type & vscode.FileType.SymbolicLink)) continue;
                    const uri = vscode.Uri.joinPath(directory, name);
                    if (type === vscode.FileType.Directory) {
                        await scan(uri, path);
                    } else if (type === vscode.FileType.File) {
                        if (this.syncLock.has(path)) throw new Error(`Wait for the current sync of ${path}, then push again.`);
                        const content = await vscode.workspace.fs.readFile(uri);
                        const entry = this.fileTreeByPath.get(path);
                        const remote = entry ? await readRemote(entry) : undefined;
                        if (contentEquals(content, remote)) continue;
                        candidates.push({ label: path, path, content, remote, remoteId: entry?.id,
                            description: entry ? 'Update on Overleaf' : 'New file', picked: true });
                    }
                }
            };
            await scan(folder);
            if (candidates.length === 0) {
                this.setStatus('idle', 'Saved files already match Overleaf');
                return result;
            }
            const selected = await vscode.window.showQuickPick(candidates.sort((a, b) => a.path.localeCompare(b.path)), {
                canPickMany: true,
                title: 'Push local changes to Overleaf',
                placeHolder: 'Choose saved files to upload. Selected remote files will be replaced with local contents.',
                ignoreFocusOut: true,
            });
            if (!selected?.length) {
                result.cancelled = true;
                this.setStatus(previousStatus, 'Push cancelled');
                return result;
            }
            await this.ignoreParser.load();
            await this.refreshProjectFileTree();
            for (const candidate of selected) {
                const path = candidate.path;
                if (!this.acquireLock(path)) {
                    result.failed.push(`${path}: another sync is in progress`);
                    continue;
                }
                const previousBase = this.baseContent.get(path);
                const previousCache = this.fileCache.get(path);
                try {
                    requireConnection();
                    if (!this.shouldSync(path)) throw new Error('file is now ignored');
                    if (this.isLocalDirty(path)) throw new Error('Save local edits before pushing');
                    const current = await vscode.workspace.fs.readFile(this.settings.getFilePath(path));
                    if (!contentEquals(current, candidate.content)) throw new Error('local contents changed; review and push again');
                    const entry = this.fileTreeByPath.get(path);
                    const remote = entry ? await readRemote(entry) : undefined;
                    if (entry?.id !== candidate.remoteId || !contentEquals(remote, candidate.remote)) {
                        throw new Error('Overleaf contents changed; review and push again');
                    }
                    this.setStatus('pushing', `Uploading ${path}`, path);
                    if (!entry) await this.uploadLocalFile(path, current);
                    else if (entry.type === 'doc') await this.pushDocumentChanges(entry.id, path, current, remote);
                    else await this.replaceRemoteFile(entry, current);
                    this.baseContent.set(path, current);
                    this.fileCache.set(path, { hash: hashContent(current), timestamp: Date.now() });
                    this.log(`Manually pushed to Overleaf: ${path}`);
                    result.uploaded++;
                } catch (error) {
                    if (previousBase) this.baseContent.set(path, previousBase);
                    else this.baseContent.delete(path);
                    if (previousCache) this.fileCache.set(path, previousCache);
                    else this.fileCache.delete(path);
                    const message = error instanceof Error ? error.message : String(error);
                    result.failed.push(`${path}: ${message}`);
                    this.log(`Manual push failed: ${path}: ${message}`);
                    if (isAuthError(error)) {
                        this.authExpired = true;
                        this.setStatus('error', 'Session expired', undefined, true);
                        break;
                    }
                } finally {
                    this.releaseLock(path);
                }
            }
            if (result.uploaded > 0 && result.failed.length === 0) await this.settings.updateLastSynced();
            if (!this.authExpired) this.setStatus(result.failed.length ? 'error' : 'idle',
                `Push complete: ${result.uploaded} uploaded, ${result.failed.length} failed`);
            return result;
        } catch (error) {
            const authErr = isAuthError(error);
            if (authErr) this.authExpired = true;
            this.setStatus('error', `Push failed: ${error}`, undefined, authErr);
            throw error;
        } finally {
            this.manualPushInProgress = false;
            const deferred = [...this.deferredLocalChanges.values()];
            this.deferredLocalChanges.clear();
            for (const handler of deferred) void handler();
        }
    }

    /**
     * Conflict resolution options
     */
    private conflictResolution: 'ask' | 'useRemote' | 'useLocal' | 'skip' = 'ask';
    private applyToAll: boolean = false;
    private newRemoteFileResolution: 'ask' | 'useRemote' | 'skip' = 'ask';

    /**
     * Check if local file exists
     */
    private async localFileExists(uri: vscode.Uri): Promise<boolean> {
        try {
            await vscode.workspace.fs.stat(uri);
            return true;
        } catch (error) {
            if (isFileNotFoundError(error)) return false;
            throw error;
        }
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
                `${filePath} (Local ↔ Remote)`
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
        if (this.applyToAll && this.conflictResolution !== 'ask') {
            return this.conflictResolution as 'useRemote' | 'useLocal' | 'skip';
        }

        // First ask: show diff or choose action?
        const firstChoice = await vscode.window.showWarningMessage(
            `Conflict: "${filePath}"`,
            'Diff',
            'Remote',
            'Local',
            'All Remote',
            'All Local'
        );

        switch (firstChoice) {
            case 'Diff':
                await this.showDiff(filePath, localUri, remoteContent);
                return this.askConflictResolutionAfterDiff(filePath);
            case 'Remote':
                return 'useRemote';
            case 'Local':
                return 'useLocal';
            case 'All Remote':
                this.conflictResolution = 'useRemote';
                this.applyToAll = true;
                return 'useRemote';
            case 'All Local':
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
        const result = await vscode.window.showWarningMessage(
            `After reviewing diff for "${filePath}", what would you like to do?`,
            { modal: false },
            'Use Remote',
            'Keep Local',
            'Skip'
        );

        switch (result) {
            case 'Use Remote':
                return 'useRemote';
            case 'Keep Local':
                return 'useLocal';
            default:
                return 'skip';
        }
    }

    /**
     * Ask user how to handle a new file from Overleaf that doesn't exist locally
     */
    private async askNewRemoteFileResolution(filePath: string, remoteContent: Uint8Array): Promise<'useRemote' | 'skip'> {
        if (this.newRemoteFileResolution !== 'ask') return this.newRemoteFileResolution;

        const sizeStr = remoteContent.length < 1024
            ? `${remoteContent.length} bytes`
            : `${(remoteContent.length / 1024).toFixed(1)} KB`;

        const choice = await vscode.window.showInformationMessage(
            `New file on Overleaf: "${filePath}" (${sizeStr})`,
            'Download',
            'Skip',
            'Download All New',
            'Skip All New'
        );

        switch (choice) {
            case 'Download':
                return 'useRemote';
            case 'Download All New':
                this.newRemoteFileResolution = 'useRemote';
                return 'useRemote';
            case 'Skip All New':
                this.newRemoteFileResolution = 'skip';
                return 'skip';
            default:
                return 'skip';
        }
    }

    /**
     * Handle local files that were deleted on Overleaf.
     * These are files that exist locally, were previously synced (in baseContent),
     * but no longer exist on Overleaf.
     */
    private async handleOrphanedLocalFiles(orphanedPaths: string[]): Promise<void> {
        if (orphanedPaths.length === 0) return;

        const fileList = orphanedPaths.length <= 5
            ? orphanedPaths.join(', ')
            : `${orphanedPaths.slice(0, 5).join(', ')}... and ${orphanedPaths.length - 5} more`;

        const snapshots = new Map<string, Uint8Array | undefined>();
        for (const path of orphanedPaths) snapshots.set(path, await this.readLocal(path));
        const choice = await vscode.window.showWarningMessage(
            `${orphanedPaths.length} file(s) were deleted on Overleaf but exist locally: ${fileList}`,
            { modal: false },
            'Delete Locally',
            'Keep Locally',
            'Re-upload'
        );

        if (choice === 'Delete Locally') {
            for (const path of orphanedPaths) {
                try {
                    const localUri = this.settings.getFilePath(path);
                    this.assertActive();
                    if (this.isLocalDirty(path) || !contentEquals(await this.readLocal(path), snapshots.get(path))) {
                        throw new Error(`Local contents changed in ${path}; review again before deleting`);
                    }
                    await vscode.workspace.fs.delete(localUri, { recursive: false });
                    this.baseContent.delete(path);
                    this.fileCache.delete(path);
                    this.log(`Deleted local file (removed from Overleaf): ${path}`);
                } catch (error) {
                    console.error(`[LocalLeaf] Failed to delete local file: ${path}`, error);
                    throw error;
                }
            }
        } else if (choice === 'Re-upload') {
            for (const path of orphanedPaths) {
                try {
                    await this.uploadLocalFile(path);
                    this.log(`Re-uploaded to Overleaf: ${path}`);
                } catch (error) {
                    console.error(`[LocalLeaf] Failed to re-upload: ${path}`, error);
                    throw error;
                }
            }
        } else {
            // Keep Locally - clear from baseContent so it's not tracked as synced
            for (const path of orphanedPaths) {
                this.baseContent.delete(path);
                debugLog(`Keeping local file, removed from sync tracking: ${path}`);
            }
        }
    }

    /**
     * Handle files that exist only locally (not on Overleaf, never synced).
     * These could be new files the user wants to upload or files to ignore.
     */
    private async handleLocalOnlyFiles(localOnlyPaths: string[]): Promise<void> {
        if (localOnlyPaths.length === 0) return;

        const fileList = localOnlyPaths.length <= 5
            ? localOnlyPaths.join(', ')
            : `${localOnlyPaths.slice(0, 5).join(', ')}... and ${localOnlyPaths.length - 5} more`;

        const choice = await vscode.window.showInformationMessage(
            `${localOnlyPaths.length} local file(s) not on Overleaf: ${fileList}`,
            { modal: false },
            'Upload All',
            'Ignore'
        );

        if (choice === 'Upload All') {
            for (const path of localOnlyPaths) {
                try {
                    await this.uploadLocalFile(path);
                    this.log(`Uploaded new file: ${path}`);
                } catch (error) {
                    console.error(`[LocalLeaf] Failed to upload: ${path}`, error);
                    throw error;
                }
            }
        }
        // 'Ignore' - do nothing, files stay local only
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
            this.assertActive();
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
                this.baseContent.set(folderPath, new Uint8Array(0));

                this.log(`Created folder on Overleaf: ${folderPath}`);

                currentParentId = result.folder._id;
                currentPath = folderPath;
            }
        }

        return currentParentId;
    }

    /**
     * Upload a local file to Overleaf (create new entity).
     */
    private async uploadLocalFile(relativePath: string, snapshot?: Uint8Array): Promise<void> {
        this.assertActive();
        if (this.isLocalDirty(relativePath)) throw new Error(`Save ${relativePath} before uploading`);
        const projectSettings = this.settings.getSettings()!;
        const localUri = this.settings.getFilePath(relativePath);
        const content = snapshot ?? await vscode.workspace.fs.readFile(localUri);

        // Ensure all parent folders exist (creates them if needed)
        const parentId = await this.ensureParentFoldersExist(relativePath);

        const name = relativePath.split('/').pop()!;
        const isTextFile = this.isTextFile(name);

        this.setStatus('pushing', `Uploading ${relativePath}`, relativePath);

        if (isTextFile) {
            await this.createTextDocumentWithContent(
                projectSettings.projectId,
                parentId,
                relativePath,
                name,
                content
            );
        } else {
            this.assertActive();
            const result = await this.api.uploadFile(
                projectSettings.projectId,
                parentId,
                name,
                content
            );
            ensureApiSuccess(result, `Upload ${relativePath}`);
            if (!this.trackUploadedEntity(result, parentId, name, relativePath)) {
                await this.refreshProjectFileTree();
            }
        }

        this.baseContent.set(relativePath, content);
        this.fileCache.set(relativePath, { hash: hashContent(content), timestamp: Date.now() });
    }

    /**
     * Return remote files currently excluded by .leafignore.
     * Refreshing both sources also finds artifacts left by earlier sessions.
     */
    async getIgnoredRemoteFiles(): Promise<string[]> {
        await this.ignoreParser.load();
        await this.refreshProjectFileTree();

        return Array.from(this.fileTree.values())
            .filter(entry => entry.type !== 'folder' && this.ignoreParser.shouldIgnore(entry.path))
            .map(entry => entry.path)
            .sort((a, b) => a.localeCompare(b));
    }

    /**
     * Delete a user-confirmed list of ignored remote files.
     * Every path is revalidated immediately before deletion.
     */
    async deleteIgnoredRemoteFiles(
        paths: readonly string[]
    ): Promise<{ deleted: number; failed: Array<{ path: string; error: unknown }> }> {
        await this.ignoreParser.load();
        await this.refreshProjectFileTree();

        let deleted = 0;
        const failed: Array<{ path: string; error: unknown }> = [];
        this.setStatus('pushing', 'Cleaning ignored files from Overleaf...');

        for (const path of paths) {
            const entry = this.fileTreeByPath.get(path);
            if (!entry || entry.type === 'folder' || !this.ignoreParser.shouldIgnore(path)) {
                continue;
            }

            try {
                await this.deleteRemoteEntry(entry, true);
                this.baseContent.delete(path);
                this.fileCache.delete(path);
                this.log(`Deleted ignored file from Overleaf: ${path}`);
                deleted++;
            } catch (error) {
                failed.push({ path, error });
            }
        }

        if (failed.length > 0) {
            this.setStatus('error', `Cleanup completed with ${failed.length} failure(s)`);
        } else {
            this.setStatus('idle', `Deleted ${deleted} ignored file(s) from Overleaf`);
        }

        return { deleted, failed };
    }

    /**
     * Perform full sync (pull all files)
     */
    async pullAll(): Promise<void> {
        if (!this.project) throw new Error('Not connected');
        this.assertActive();
        if (this.manualPullInProgress || this.manualPushInProgress) throw new Error('A sync is already in progress');
        this.manualPullInProgress = true;
        this.conflictResolution = 'ask';
        this.applyToAll = false;
        this.newRemoteFileResolution = 'ask';
        let downloaded = 0;
        let skipped = 0;
        try {
            await this.ignoreParser.load();
            await this.refreshProjectFileTree();
            this.setStatus('pulling', 'Downloading all files...');
            for (const entry of [...this.fileTree.values()]) {
                this.assertActive();
                if (!this.shouldSync(entry.path)) continue;
                const uri = this.settings.getFilePath(entry.path);
                if (entry.type === 'folder') {
                    await this.assertLocalPathSafe(entry.path);
                    this.assertActive();
                    await vscode.workspace.fs.createDirectory(uri);
                    this.baseContent.set(entry.path, new Uint8Array(0));
                    continue;
                }
                if (!this.acquireLock(entry.path)) throw new Error(`Another sync is in progress for ${entry.path}`);
                try {
                    if (this.isLocalDirty(entry.path)) throw new Error(`Save ${entry.path} before pulling`);
                    const before = await this.readLocal(entry.path);
                    const remote = await this.readRemoteContent(entry);
                    let resolution: 'useRemote' | 'useLocal' | 'skip' = 'useRemote';
                    if (before !== undefined && !contentEquals(before, remote)) {
                        resolution = await this.askConflictResolution(entry.path, uri, remote);
                    } else if (before === undefined && !this.baseContent.has(entry.path)) {
                        resolution = await this.askNewRemoteFileResolution(entry.path, remote);
                    }
                    if (resolution === 'skip') { skipped++; continue; }
                    this.assertActive();
                    if (this.fileTreeByPath.get(entry.path)?.id !== entry.id) {
                        throw new Error(`Overleaf file changed: ${entry.path}; pull again`);
                    }
                    if (resolution === 'useLocal') {
                        if (this.isLocalDirty(entry.path) || !contentEquals(await this.readLocal(entry.path), before)) {
                            throw new Error(`Local contents changed in ${entry.path}; pull again to review`);
                        }
                        if (entry.type === 'doc') {
                            await this.pushDocumentChanges(entry.id, entry.path, before!, remote);
                        } else {
                            if (!contentEquals(await this.readRemoteContent(entry), remote)) {
                                throw new Error(`Overleaf contents changed in ${entry.path}; pull again to review`);
                            }
                            await this.replaceRemoteFile(entry, before!);
                        }
                        this.baseContent.set(entry.path, before!);
                        this.fileCache.set(entry.path, {hash: hashContent(before), timestamp: Date.now()});
                    } else {
                        await this.writeLocalSnapshot(entry.path, before, remote);
                        if (!contentEquals(before, remote)) downloaded++;
                    }
                } finally {
                    this.releaseLock(entry.path);
                }
            }
            const orphaned: string[] = [];
            for (const path of this.baseContent.keys()) {
                if (!path.endsWith('/') && !this.fileTreeByPath.has(path) && this.shouldSync(path) &&
                    await this.localFileExists(this.settings.getFilePath(path))) orphaned.push(path);
            }
            if (orphaned.length) await this.handleOrphanedLocalFiles(orphaned);
            const localOnly: string[] = [];
            const scan = async (directory: vscode.Uri, parent = '/') => {
                this.assertActive();
                for (const [name, type] of await vscode.workspace.fs.readDirectory(directory)) {
                    const path = parent + name + (type === vscode.FileType.Directory ? '/' : '');
                    if (!this.shouldSync(path) || (type & vscode.FileType.SymbolicLink)) continue;
                    if (type === vscode.FileType.Directory) await scan(vscode.Uri.joinPath(directory, name), path);
                    else if (!this.fileTreeByPath.has(path) && !this.baseContent.has(path) && !orphaned.includes(path)) localOnly.push(path);
                }
            };
            await scan(this.settings.getWorkspaceFolder());
            if (localOnly.length) await this.handleLocalOnlyFiles(localOnly);
            this.assertActive();
            await this.settings.updateLastSynced();
            this.setStatus('idle', `Pull complete: ${downloaded} downloaded, ${skipped} skipped`);
        } catch (error) {
            if (!this.disposed) this.setStatus('error', `Pull failed: ${error}`, undefined, isAuthError(error));
            throw error;
        } finally {
            this.manualPullInProgress = false;
            const deferred = [...this.deferredLocalChanges.values()];
            this.deferredLocalChanges.clear();
            for (const handler of deferred) void handler();
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
     * Get the socket instance
     */
    getSocket(): SocketIOAPI | undefined {
        return this.socket;
    }

    /**
     * Disconnect and cleanup
     */
    disconnect(): void {
        this.disposed = true;
        for (const timer of this.pendingRemoteDocuments.values()) clearTimeout(timer);
        this.pendingRemoteDocuments.clear();
        for (const timer of this.pendingRemoteStructure) clearTimeout(timer);
        this.pendingRemoteStructure.clear();
        this.socket?.disconnect();
        this.socket = undefined;
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
        this.setStatus('disconnected');
    }

    /**
     * Get file tree
     */
    getFileTree(): Map<string, FileTreeEntry> {
        return this.fileTree;
    }
}
