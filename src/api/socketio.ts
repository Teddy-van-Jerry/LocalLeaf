/**
 * LocalLeaf Socket.io API - Real-time sync with Overleaf
 * Adapted from Overleaf-Workshop
 */

import * as vscode from 'vscode';
import { BaseAPI, ProjectEntity, FileEntity } from './base';
import { Identity } from '../utils/credentialManager';

// Output channel for logging (visible to user)
let outputChannel: vscode.OutputChannel | undefined;

function log(message: string) {
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    const logMessage = `[${timestamp}] ${message}`;
    if (outputChannel) {
        outputChannel.appendLine(logMessage);
    }
}

export function setOutputChannel(channel: vscode.OutputChannel) {
    outputChannel = channel;
}

/**
 * Online user information
 */
export interface OnlineUser {
    clientId: string;
    userId: string;
    name: string;
    email: string;
    docId: string;
    row: number;
    column: number;
    lastUpdated: number;
}

/**
 * User cursor update from socket
 */
export interface UserCursorUpdate {
    id: string;
    user_id: string;
    name: string;
    email: string;
    doc_id: string;
    row: number;
    column: number;
}

/**
 * Document update (OT operations)
 */
export interface DocumentUpdate {
    doc: string; // doc id
    op?: Array<{
        p: number; // position
        i?: string; // insert
        d?: string; // delete
        u?: boolean; // isUndo
    }>;
    v: number; // version number
    lastV?: number;
    hash?: string;
    meta?: {
        source: string; // socketio client id
        ts: number; // timestamp
        user_id: string;
    };
}

/**
 * Event handlers for socket events
 */
export interface SocketEventHandlers {
    // File events
    onFileCreated?: (parentFolderId: string, type: 'doc' | 'file' | 'folder', entity: FileEntity) => void;
    onFileRenamed?: (entityId: string, newName: string) => void;
    onFileRemoved?: (entityId: string) => void;
    onFileMoved?: (entityId: string, newParentFolderId: string) => void;
    onFileChanged?: (update: DocumentUpdate) => void;
    // Connection events
    onConnected?: (publicId: string) => void;
    onDisconnected?: (isAuthError?: boolean) => void;
    // Collaboration events
    onUserCursorUpdated?: (user: UserCursorUpdate) => void;
    onUserDisconnected?: (clientId: string) => void;
    // Project events
    onRootDocUpdated?: (rootDocId: string) => void;
    onCompilerUpdated?: (compiler: string) => void;
}

/**
 * Socket.io API for real-time communication with Overleaf
 * Reference: Overleaf-Workshop/src/api/socketio.ts
 */
export class SocketIOAPI {
    private static refreshQueues = new Map<string, { tail: Promise<void>; nextRequestAt: number }>();
    private socket: any;
    private emit!: (event: string, ...args: any[]) => Promise<any[]>;
    private projectRecord?: ProjectEntity;
    private projectRecordPromise?: Promise<ProjectEntity>;
    private handlers: SocketEventHandlers[] = [];
    private _publicId?: string;
    private _connected: boolean = false;
    private _handshakeComplete: boolean = false;
    private _handshakePromise!: Promise<void>;
    private _handshakeResolve!: () => void;
    private pendingEmits = new Set<(error: Error) => void>();

    constructor(
        private readonly api: BaseAPI,
        private readonly identity: Identity,
        private readonly projectId: string
    ) {
        this.init();
    }

    /**
     * Initialize socket connection
     * Reference: Overleaf-Workshop socketio.ts init()
     */
    private init() {
        // Create handshake promise
        this._handshakeComplete = false;
        this._handshakePromise = new Promise((resolve) => {
            this._handshakeResolve = resolve;
        });

        // Connect with projectId and timestamp in query
        this.projectRecordPromise = undefined;
        const query = `?projectId=${this.projectId}&t=${Date.now()}`;
        this.socket = this.api.initSocket(this.identity, query);

        this.setupEmit();
        this.setupInternalHandlers();
    }

    /**
     * Setup promisified emit
     * Reference: Overleaf-Workshop socketio.ts
     */
    private setupEmit() {
        this.emit = (event: string, ...args: any[]) => {
            if (!this._connected) return Promise.reject(new Error('Socket disconnected'));
            return new Promise<any[]>((resolve, reject) => {
                const fail = (error: Error) => {
                    clearTimeout(timer);
                    this.pendingEmits.delete(fail);
                    reject(error);
                };
                const timer = setTimeout(() => {
                    fail(new Error(`Socket emit timeout: ${event}`));
                    // The acknowledgement may have been lost. Rejoin with a fresh
                    // document version before allowing any further OT updates.
                    log(`Socket emit timeout: ${event}`);
                    if (['joinDoc', 'leaveDoc', 'applyOtUpdate'].includes(event)) this.disconnect();
                }, 5000);
                this.pendingEmits.add(fail);
                try {
                    this.socket.emit(event, ...args, (err: any, ...data: any[]) => {
                        if (!this.pendingEmits.has(fail)) return;
                        clearTimeout(timer);
                        this.pendingEmits.delete(fail);
                        if (err) reject(new Error(String(err)));
                        else resolve(data);
                    });
                } catch (error) {
                    fail(error instanceof Error ? error : new Error(String(error)));
                }
            });
        };
    }

    private markDisconnected(authError = false): void {
        this._connected = false;
        for (const fail of [...this.pendingEmits]) fail(new Error('Socket disconnected'));
        this.handlers.forEach(h => h.onDisconnected?.(authError));
    }

    private async withTimeout<T>(promise: Promise<T>, message: string, delay = 5000): Promise<T> {
        let timer: NodeJS.Timeout | undefined;
        try {
            return await Promise.race([promise, new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(message)), delay);
            })]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    /**
     * Setup internal event handlers
     * Reference: Overleaf-Workshop socketio.ts initInternalHandlers()
     */
    private setupInternalHandlers() {
        this.socket.on('connect', () => {
            this._connected = true;
            this._handshakeComplete = true;
            this._handshakeResolve();
        });

        this.socket.on('connect_failed', () => {
            log('Connection failed');
            this.markDisconnected();
        });

        this.socket.on('forceDisconnect', (message: string, delay: number = 10) => {
            log(`Force disconnected: ${message}`);
            this._connected = false;
            // Check if force disconnect is auth-related
            const isAuthError = this.isAuthRelatedMessage(message);
            this.markDisconnected(isAuthError);
        });

        this.socket.on('error', (err: any) => {
            log(`Socket error: ${err}`);
        });

        this.socket.on('disconnect', () => {
            log('Disconnected from Overleaf');
            this.markDisconnected();
        });

        this.socket.on('connectionRejected', (err: any) => {
            log(`Connection rejected: ${err?.message}`);
            this._connected = false;
            // Check if rejection is auth-related
            const isAuthError = this.isAuthRelatedMessage(err?.message);
            this.markDisconnected(isAuthError);
        });

        this.socket.on('connectionAccepted', (_: any, publicId: string) => {
            this._publicId = publicId;
            this._connected = true;
            this.handlers.forEach(h => h.onConnected?.(publicId));
        });

        // joinProjectResponse handler
        this.projectRecordPromise = new Promise((resolve) => {
            this.socket.on('joinProjectResponse', (res: any) => {
                const publicId = res.publicId as string;
                const project = res.project as ProjectEntity;
                this._publicId = publicId;
                this._connected = true;
                this.projectRecord = project;
                this.handlers.forEach(h => h.onConnected?.(publicId));
                resolve(project);
            });
        });
    }

    /**
     * Register event handlers
     */
    registerHandlers(handlers: SocketEventHandlers) {
        this.handlers.push(handlers);

        // File events
        if (handlers.onFileCreated) {
            this.socket.on('reciveNewDoc', (parentFolderId: string, doc: FileEntity) => {
                handlers.onFileCreated!(parentFolderId, 'doc', doc);
            });
            this.socket.on('reciveNewFile', (parentFolderId: string, file: FileEntity) => {
                handlers.onFileCreated!(parentFolderId, 'file', file);
            });
            this.socket.on('reciveNewFolder', (parentFolderId: string, folder: FileEntity) => {
                handlers.onFileCreated!(parentFolderId, 'folder', folder);
            });
        }

        if (handlers.onFileRenamed) {
            this.socket.on('reciveEntityRename', (entityId: string, newName: string) => {
                handlers.onFileRenamed!(entityId, newName);
            });
        }

        if (handlers.onFileRemoved) {
            this.socket.on('removeEntity', (entityId: string) => {
                handlers.onFileRemoved!(entityId);
            });
        }

        if (handlers.onFileMoved) {
            this.socket.on('reciveEntityMove', (entityId: string, folderId: string) => {
                handlers.onFileMoved!(entityId, folderId);
            });
        }

        if (handlers.onFileChanged) {
            this.socket.on('otUpdateApplied', (update: DocumentUpdate) => {
                handlers.onFileChanged!(update);
            });
        }

        // Collaboration events
        if (handlers.onUserCursorUpdated) {
            this.socket.on('clientTracking.clientUpdated', (user: UserCursorUpdate) => {
                handlers.onUserCursorUpdated!(user);
            });
        }

        if (handlers.onUserDisconnected) {
            this.socket.on('clientTracking.clientDisconnected', (clientId: string) => {
                handlers.onUserDisconnected!(clientId);
            });
        }

        // Project settings events
        if (handlers.onRootDocUpdated) {
            this.socket.on('rootDocUpdated', (rootDocId: string) => {
                handlers.onRootDocUpdated!(rootDocId);
            });
        }

        if (handlers.onCompilerUpdated) {
            this.socket.on('compilerUpdated', (compiler: string) => {
                handlers.onCompilerUpdated!(compiler);
            });
        }
    }

    /**
     * Wait for socket handshake to complete
     */
    private async waitForHandshake(timeoutMs: number = 5000): Promise<void> {
        if (this._handshakeComplete) {
            return;
        }

        await this.withTimeout(this._handshakePromise, 'Socket handshake timeout', timeoutMs);
    }

    /**
     * Join a project
     * Reference: Overleaf-Workshop socketio.ts joinProject()
     */
    async joinProject(): Promise<ProjectEntity> {
        // Wait for handshake before emitting
        await this.waitForHandshake();

        // v2 uses joinProjectResponse event instead of callback
        if (this.projectRecordPromise) {
            const project = await this.withTimeout(this.projectRecordPromise, 'Join project timeout');
            log(`Connected to project (real-time)`);
            return project;
        }
        throw new Error('Socket not properly initialized');
    }

    /**
     * Get a fresh server snapshot without disturbing the editing connection.
     * Protocol v2 sends the tree only when a socket joins; joinProject() on an
     * existing socket returns its original snapshot, not the current tree.
     */
    async refreshProject(onWait?: (delayMs: number) => void): Promise<ProjectEntity> {
        const server = this.api.getUrl();
        let queue = SocketIOAPI.refreshQueues.get(server);
        if (!queue) {
            queue = { tail: Promise.resolve(), nextRequestAt: 0 };
            SocketIOAPI.refreshQueues.set(server, queue);
        }
        const schedule = queue;
        const pending = schedule.tail.then(async () => {
            if (!this.isConnected) throw new Error('Socket disconnected');
            const delay = Math.max(0, schedule.nextRequestAt - Date.now());
            if (delay > 0) {
                onWait?.(delay);
                await new Promise<void>(resolve => setTimeout(resolve, delay));
            }
            if (!this.isConnected) throw new Error('Socket disconnected');
            schedule.nextRequestAt = Date.now() + 5000;

            const snapshot = new SocketIOAPI(this.api, this.identity, this.projectId);
            try {
                const project = await snapshot.joinProject();
                if (!this.isConnected) throw new Error('Socket disconnected');
                if (project?._id !== this.projectId || !Array.isArray(project.rootFolder) ||
                    project.rootFolder.length === 0 || !project.rootFolder[0]?._id) {
                    throw new Error('Overleaf returned an invalid project folder tree');
                }
                return project;
            } finally {
                snapshot.disconnect();
            }
        });
        schedule.tail = pending.then(() => undefined, () => undefined);
        return pending;
    }

    /**
     * Join a document for editing
     */
    async joinDoc(docId: string): Promise<{ lines: string[]; version: number }> {
        const [docLinesAscii, version, _updates, _ranges] = await this.emit('joinDoc', docId, {
            encodeRanges: true,
        }) as [string[], number, any[], any];

        const lines = docLinesAscii.map(line => Buffer.from(line, 'ascii').toString('utf-8'));
        return { lines, version };
    }

    /**
     * Leave a document
     */
    async leaveDoc(docId: string): Promise<void> {
        await this.emit('leaveDoc', docId);
    }

    /**
     * Apply OT update to a document
     */
    async applyOtUpdate(docId: string, update: DocumentUpdate): Promise<void> {
        await this.emit('applyOtUpdate', docId, update);
    }

    /**
     * Get connected users
     */
    async getConnectedUsers(): Promise<OnlineUser[]> {
        const [users] = await this.emit('clientTracking.getConnectedUsers') as [Array<{
            client_id: string;
            user_id: string;
            first_name: string;
            last_name?: string;
            email: string;
            cursorData?: { doc_id: string; row: number; column: number };
            last_updated_at: string;
        }>];

        return users.map(u => ({
            clientId: u.client_id,
            userId: u.user_id,
            name: [u.first_name, u.last_name].filter(Boolean).join(' '),
            email: u.email,
            docId: u.cursorData?.doc_id || '',
            row: u.cursorData?.row || 0,
            column: u.cursorData?.column || 0,
            lastUpdated: Number(u.last_updated_at),
        }));
    }

    /**
     * Update cursor position
     */
    async updatePosition(docId: string, row: number, column: number): Promise<void> {
        await this.emit('clientTracking.updatePosition', { row, column, doc_id: docId });
    }

    /**
     * Get public ID (client ID assigned by server)
     */
    get publicId(): string | undefined {
        return this._publicId;
    }

    /**
     * Check if connected
     */
    get isConnected(): boolean {
        return this._connected;
    }

    /**
     * Get project record
     */
    get project(): ProjectEntity | undefined {
        return this.projectRecord;
    }

    /**
     * Disconnect from socket
     */
    disconnect() {
        this.markDisconnected();
        this.socket.removeAllListeners();
        this.socket.disconnect();
    }

    /**
     * Check if a message indicates an auth-related error
     */
    private isAuthRelatedMessage(message: string | undefined): boolean {
        if (!message) return false;
        const msg = message.toLowerCase();
        return msg.includes('unauthorized') ||
               msg.includes('not logged in') ||
               msg.includes('session expired') ||
               msg.includes('invalid session') ||
               msg.includes('403') ||
               msg.includes('401') ||
               msg.includes('authentication');
    }
}
