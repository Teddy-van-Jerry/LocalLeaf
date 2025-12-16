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
    private setStatus(status: SyncStatus, message?: string, file?: string): void {
        this._status = status;
        this._onStatusChange.fire({ status, message, file });
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
                onConnected: () => this.setStatus('idle', 'Connected (real-time)'),
                onDisconnected: () => this.setStatus('disconnected', 'Disconnected'),
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
                this.setStatus('error', `Failed to connect: ${httpError}`);
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
    private acquireLock(path: string): boolean {
        if (this.syncLock.has(path)) {
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

    // === Local change handlers ===

    /**
     * Handle local file change
     */
    private async handleLocalFileChange(uri: vscode.Uri): Promise<void> {
        const relativePath = this.getRelativePath(uri);
        if (!this.shouldSync(relativePath)) return;
        if (!this.acquireLock(relativePath)) return;

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

            this.baseContent.set(relativePath, content);
            this.setStatus('idle');
        } catch (error) {
            // Don't show error for file-not-found during rapid operations
            if (isFileNotFoundError(error)) {
                debugLog(`File disappeared during sync: ${relativePath}`);
                this.setStatus('idle');
                return;
            }
            console.error(`[LocalLeaf] Failed to sync ${relativePath}:`, error);
            this.setStatus('error', `Failed to sync: ${error}`);
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

        try {
            // Join document to get current version (even if already joined for watching)
            const { lines: remoteLines, version } = await this.socket.joinDoc(docId);
            const remoteContent = remoteLines.join('\n');
            const localContent = new TextDecoder().decode(newContent);

            // Calculate diff and create OT operations
            const ops = this.calculateOps(remoteContent, localContent);

            if (ops.length > 0) {
                const update: DocumentUpdate = {
                    doc: docId,
                    op: ops,
                    v: version,
                };
                await this.socket.applyOtUpdate(docId, update);

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

    /**
     * Handle local file creation
     */
    private async handleLocalFileCreate(uri: vscode.Uri): Promise<void> {
        const relativePath = this.getRelativePath(uri);
        if (!this.shouldSync(relativePath)) return;
        if (!this.acquireLock(relativePath)) return;

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

            // Determine parent folder
            const parentPath = relativePath.substring(0, relativePath.lastIndexOf('/') + 1) || '/';
            const parentEntry = this.fileTreeByPath.get(parentPath);
            const parentId = parentEntry?.id || this.project?.rootFolder[0]._id;

            const name = relativePath.split('/').pop()!;

            if (stat.type === vscode.FileType.Directory) {
                await this.api.addFolder(projectSettings.projectId, parentId!, name);
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
                    await this.api.addDoc(projectSettings.projectId, parentId!, name);
                } else {
                    await this.api.uploadFile(projectSettings.projectId, parentId!, name, content);
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
            this.setStatus('error', `Failed to create: ${error}`);
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
        if (!this.acquireLock(relativePath)) return;

        try {
            const entry = this.fileTreeByPath.get(relativePath);
            if (!entry) return;

            const projectSettings = this.settings.getSettings()!;
            this.setStatus('pushing', `Deleting ${relativePath}`, relativePath);

            await this.api.deleteEntity(projectSettings.projectId, entry.type, entry.id);

            this.fileTree.delete(entry.id);
            this.fileTreeByPath.delete(relativePath);
            this.baseContent.delete(relativePath);
            this.fileCache.delete(relativePath);

            this.setStatus('idle');
        } catch (error) {
            console.error(`[LocalLeaf] Failed to delete ${relativePath}:`, error);
            this.setStatus('error', `Failed to delete: ${error}`);
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
        if (!this.acquireLock(path)) return;

        try {
            this.setStatus('pulling', `Downloading ${path}`, path);

            // Add to tree
            const entry: FileTreeEntry = {
                id: entity._id,
                type,
                name: entity.name,
                path,
                parentId,
            };
            this.fileTree.set(entity._id, entry);
            this.fileTreeByPath.set(path, entry);

            const localUri = this.settings.getFilePath(path);

            if (type === 'folder') {
                await vscode.workspace.fs.createDirectory(localUri);
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
                    await vscode.workspace.fs.writeFile(localUri, content);
                    this.baseContent.set(path, content);
                    this.fileCache.set(path, { hash: hashContent(content), timestamp: Date.now() });
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

        if (!this.acquireLock(oldPath)) return;

        try {
            this.setStatus('pulling', `Renaming ${oldPath} to ${newPath}`, oldPath);

            // Update tree
            entry.name = newName;
            entry.path = newPath;
            this.fileTreeByPath.delete(oldPath);
            this.fileTreeByPath.set(newPath, entry);

            // Rename local file
            const oldUri = this.settings.getFilePath(oldPath);
            const newUri = this.settings.getFilePath(newPath);
            await vscode.workspace.fs.rename(oldUri, newUri);

            // Update caches
            const content = this.baseContent.get(oldPath);
            if (content) {
                this.baseContent.delete(oldPath);
                this.baseContent.set(newPath, content);
            }
            const cache = this.fileCache.get(oldPath);
            if (cache) {
                this.fileCache.delete(oldPath);
                this.fileCache.set(newPath, cache);
            }

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
        if (!this.acquireLock(entry.path)) return;

        try {
            this.setStatus('pulling', `Deleting ${entry.path}`, entry.path);

            // Leave doc if joined
            if (entry.type === 'doc' && this.joinedDocs.has(entityId)) {
                try {
                    await this.socket?.leaveDoc(entityId);
                } catch {
                    // Ignore leave errors
                }
                this.joinedDocs.delete(entityId);
            }

            // Remove from tree
            this.fileTree.delete(entityId);
            this.fileTreeByPath.delete(entry.path);

            // Delete local file
            const localUri = this.settings.getFilePath(entry.path);
            await vscode.workspace.fs.delete(localUri, { recursive: true });

            this.baseContent.delete(entry.path);
            this.fileCache.delete(entry.path);

            this.setStatus('idle');
        } catch (error) {
            console.error(`[LocalLeaf] Failed to sync remote delete:`, error);
        } finally {
            this.releaseLock(entry.path);
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

        if (!this.acquireLock(oldPath)) return;

        try {
            this.setStatus('pulling', `Moving ${oldPath} to ${newPath}`, oldPath);

            // Update tree
            entry.path = newPath;
            entry.parentId = newParentId;
            this.fileTreeByPath.delete(oldPath);
            this.fileTreeByPath.set(newPath, entry);

            // Move local file
            const oldUri = this.settings.getFilePath(oldPath);
            const newUri = this.settings.getFilePath(newPath);
            await vscode.workspace.fs.rename(oldUri, newUri);

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
        if (!this.acquireLock(entry.path)) return;

        try {
            // Get current local content
            const localUri = this.settings.getFilePath(entry.path);
            let localContent: string;
            let localBytes: Uint8Array | undefined;
            try {
                localBytes = await vscode.workspace.fs.readFile(localUri);
                localContent = new TextDecoder().decode(localBytes);
            } catch {
                localContent = '';
                localBytes = undefined;
            }

            // Apply OT operations
            let newContent = localContent;
            if (update.op) {
                for (const op of update.op) {
                    if (op.d !== undefined) {
                        // Delete operation
                        newContent = newContent.slice(0, op.p) + newContent.slice(op.p + op.d.length);
                    }
                    if (op.i !== undefined) {
                        // Insert operation
                        newContent = newContent.slice(0, op.p) + op.i + newContent.slice(op.p);
                    }
                }
            }

            // Only write if content actually changed (prevents file flashing)
            const contentBytes = new TextEncoder().encode(newContent);
            if (!contentEquals(localBytes, contentBytes)) {
                this.setStatus('pulling', `Updating ${entry.path}`, entry.path);
                await vscode.workspace.fs.writeFile(localUri, contentBytes);
                this.log(`Remote update: ${entry.path}`);
            }

            this.baseContent.set(entry.path, contentBytes);
            this.fileCache.set(entry.path, { hash: hashContent(contentBytes), timestamp: Date.now() });

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
     * Perform full sync (pull all files)
     */
    async pullAll(): Promise<void> {
        if (!this.project) {
            throw new Error('Not connected');
        }

        debugLog('pullAll: Starting pull');
        debugLog('pullAll: File tree size:', this.fileTree.size);
        debugLog('pullAll: Project name:', this.project.name);

        // Reset conflict resolution state
        this.conflictResolution = 'ask';
        this.applyToAll = false;

        this.setStatus('pulling', 'Downloading all files...');
        const projectSettings = this.settings.getSettings()!;

        let downloadedCount = 0;
        let skippedCount = 0;
        let conflictCount = 0;

        try {
            const downloadFile = async (entry: FileTreeEntry) => {
                debugLog('pullAll: Processing', entry.path, entry.type);

                if (entry.type === 'folder') {
                    const localUri = this.settings.getFilePath(entry.path);
                    await vscode.workspace.fs.createDirectory(localUri);
                    return;
                }

                if (this.ignoreParser.shouldIgnore(entry.path)) {
                    debugLog('pullAll: Ignored', entry.path);
                    return;
                }

                // Get remote content - docs use joinDoc via socket, files use HTTP
                let remoteContent: Uint8Array;

                if (entry.type === 'doc') {
                    // For docs, try socket first, fall back to HTTP
                    if (this.socket) {
                        try {
                            const { lines } = await this.socket.joinDoc(entry.id);
                            const content = lines.join('\n');
                            remoteContent = new TextEncoder().encode(content);
                            await this.socket.leaveDoc(entry.id);
                            debugLog('pullAll: Got doc via socket', entry.path,
                                'lines:', lines.length,
                                'contentLen:', content.length);
                        } catch (err) {
                            debugLog('pullAll: Failed to joinDoc', entry.path, err);
                            return;
                        }
                    } else {
                        // HTTP fallback for docs
                        const result = await this.api.getDocContent(projectSettings.projectId, entry.id);
                        if (result.type !== 'success' || !result.lines) {
                            debugLog('pullAll: Failed to get doc via HTTP', entry.path);
                            return;
                        }
                        const content = result.lines.join('\n');
                        remoteContent = new TextEncoder().encode(content);
                        debugLog('pullAll: Got doc via HTTP', entry.path,
                            'lines:', result.lines.length,
                            'contentLen:', content.length);
                    }
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

                // Check for conflicts
                if (exists) {
                    const hasConflict = await this.hasConflict(localUri, remoteContent);
                    if (hasConflict) {
                        conflictCount++;
                        const resolution = await this.askConflictResolution(entry.path, localUri, remoteContent);

                        if (resolution === 'skip') {
                            debugLog('pullAll: Skipped (user choice)', entry.path);
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

                            this.baseContent.set(entry.path, localContent);
                            this.fileCache.set(entry.path, { hash: hashContent(localContent), timestamp: Date.now() });
                            return;
                        }
                        // resolution === 'useRemote' - continue to download
                    }
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
                    this.baseContent.set(entry.path, remoteContent);
                    this.fileCache.set(entry.path, { hash: hashContent(remoteContent), timestamp: Date.now() });
                    return;
                }

                this.setStatus('pulling', `Downloading ${entry.path}`, entry.path);
                await vscode.workspace.fs.writeFile(localUri, remoteContent);
                this.baseContent.set(entry.path, remoteContent);
                this.fileCache.set(entry.path, { hash: hashContent(remoteContent), timestamp: Date.now() });
                downloadedCount++;
            };

            // Download all files
            for (const entry of this.fileTree.values()) {
                await downloadFile(entry);
            }

            await this.settings.updateLastSynced();

            const message = `Pull complete: ${downloadedCount} downloaded, ${skippedCount} skipped, ${conflictCount} conflicts`;
            debugLog('pullAll:', message);
            this.setStatus('idle', message);
        } catch (error) {
            this.setStatus('error', `Pull failed: ${error}`);
            throw error;
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
