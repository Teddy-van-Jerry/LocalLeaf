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
    private socket!: SocketIOClient.Socket;
    private projectRecord?: ProjectEntity;
    private projectRecordPromise?: Promise<ProjectEntity>;
    private handlers: SocketEventHandlers[] = [];
    private _publicId?: string;
    private _connected: boolean = false;
    private _handshakeComplete: boolean = false;
    private _handshakePromise!: Promise<void>;
    private _handshakeResolve!: () => void;

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
        const query = `?projectId=${encodeURIComponent(this.projectId)}&t=${Date.now()}`;
        this.socket = this.api.initSocket(this.identity, query);

        this.setupInternalHandlers();
    }

    private withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
            promise.then(
                value => {
                    clearTimeout(timer);
                    resolve(value);
                },
                error => {
                    clearTimeout(timer);
                    reject(error);
                },
            );
        });
    }

    private emit(event: string, ...args: unknown[]): Promise<unknown[]> {
        const response = new Promise<unknown[]>((resolve, reject) => {
            this.socket.emit(event, ...args, (error: unknown, ...data: unknown[]) => {
                if (error) {
                    reject(error instanceof Error ? error : new Error(String(error)));
                } else {
                    resolve(data);
                }
            });
        });
        return this.withTimeout(response, 5000, `Socket event "${event}" timed out`);
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
            this._connected = false;
        });

        this.socket.on('forceDisconnect', (message: string) => {
            log(`Force disconnected: ${message}`);
            this._connected = false;
            // Check if force disconnect is auth-related
            const isAuthError = this.isAuthRelatedMessage(message);
            this.handlers.forEach(h => h.onDisconnected?.(isAuthError));
        });

        this.socket.on('error', (err: unknown) => {
            log(`Socket error: ${err}`);
        });

        this.socket.on('disconnect', () => {
            log('Disconnected from Overleaf');
            this._connected = false;
            this.handlers.forEach(h => h.onDisconnected?.(false));
        });

        this.socket.on('connectionRejected', (err: unknown) => {
            const message = err instanceof Error
                ? err.message
                : typeof err === 'object' && err !== null && 'message' in err
                    ? String(err.message)
                    : String(err);
            log(`Connection rejected: ${message}`);
            this._connected = false;
            // Check if rejection is auth-related
            const isAuthError = this.isAuthRelatedMessage(message);
            this.handlers.forEach(h => h.onDisconnected?.(isAuthError));
        });

        this.socket.on('connectionAccepted', (_session: unknown, publicId: string) => {
            this._publicId = publicId;
            this._connected = true;
            this.handlers.forEach(h => h.onConnected?.(publicId));
        });

        // joinProjectResponse handler
        this.projectRecordPromise = new Promise((resolve, reject) => {
            this.socket.on('joinProjectResponse', (res: unknown) => {
                if (res === null || typeof res !== 'object') {
                    reject(new Error('Overleaf returned an invalid project response.'));
                    return;
                }
                const response = res as Record<string, unknown>;
                const publicId = response.publicId;
                const project = response.project;
                if (typeof publicId !== 'string' || project === null || typeof project !== 'object') {
                    reject(new Error('Overleaf returned incomplete project metadata.'));
                    return;
                }
                this._publicId = publicId;
                this._connected = true;
                this.projectRecord = project as ProjectEntity;
                this.handlers.forEach(h => h.onConnected?.(publicId));
                resolve(this.projectRecord);
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

        await this.withTimeout(this._handshakePromise, timeoutMs, 'Socket handshake timeout');
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
            const project = await this.withTimeout(this.projectRecordPromise, 5000, 'Join project timeout');
            log(`Connected to project (real-time)`);
            return project;
        }
        throw new Error('Socket not properly initialized');
    }

    /**
     * Join a document for editing
     */
    async joinDoc(docId: string): Promise<{ lines: string[]; version: number }> {
        const [docLinesAscii, version] = await this.emit('joinDoc', docId, {
            encodeRanges: true,
        }) as [string[], number];

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
        this.socket.disconnect();
        this.socket.removeAllListeners?.();
        this.handlers = [];
        this._connected = false;
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
