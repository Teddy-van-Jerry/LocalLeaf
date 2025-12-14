/**
 * LocalLeaf Socket.io API - Real-time sync with Overleaf
 * Adapted from Overleaf-Workshop
 */

import { promisify } from 'util';
import * as vscode from 'vscode';
import { BaseAPI, ProjectEntity, FileEntity } from './base';
import { Identity } from '../utils/credentialManager';

// Output channel for logging (visible to user)
let outputChannel: vscode.OutputChannel | undefined;

function log(message: string) {
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    const logMessage = `[${timestamp}] ${message}`;
    console.log('[LocalLeaf]', message);
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
    onDisconnected?: () => void;
    // Collaboration events
    onUserCursorUpdated?: (user: UserCursorUpdate) => void;
    onUserDisconnected?: (clientId: string) => void;
    // Project events
    onRootDocUpdated?: (rootDocId: string) => void;
    onCompilerUpdated?: (compiler: string) => void;
}

type ConnectionScheme = 'v1' | 'v2';

/**
 * Socket.io API for real-time communication with Overleaf
 * Reference: Overleaf-Workshop/src/api/socketio.ts
 */
export class SocketIOAPI {
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
    private scheme: ConnectionScheme = 'v1';

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
        log(`Initializing socket with scheme: ${this.scheme}`);

        // Create handshake promise
        this._handshakeComplete = false;
        this._handshakePromise = new Promise((resolve) => {
            this._handshakeResolve = resolve;
        });

        switch (this.scheme) {
            case 'v1':
                // v1: Connect without query parameters
                this.projectRecordPromise = undefined;
                this.socket = this.api.initSocket(this.identity);
                log('Socket created (v1 scheme, no query params)');
                break;
            case 'v2':
                // v2: Connect with projectId and timestamp in query
                this.projectRecordPromise = undefined;
                const query = `?projectId=${this.projectId}&t=${Date.now()}`;
                this.socket = this.api.initSocket(this.identity, query);
                log(`Socket created (v2 scheme, query: ${query})`);
                break;
        }

        this.setupEmit();
        this.setupInternalHandlers();
    }

    /**
     * Reinitialize with different scheme
     */
    private reinit(newScheme: ConnectionScheme) {
        log(`Switching from ${this.scheme} to ${newScheme} scheme`);
        if (this.socket) {
            try {
                this.socket.disconnect();
            } catch (e) {
                // Ignore disconnect errors
            }
        }
        this.scheme = newScheme;
        this.init();

        // Re-register handlers
        const existingHandlers = [...this.handlers];
        this.handlers = [];
        existingHandlers.forEach(h => this.registerHandlers(h));
    }

    /**
     * Setup promisified emit
     * Reference: Overleaf-Workshop socketio.ts
     */
    private setupEmit() {
        (this.socket.emit)[promisify.custom] = (event: string, ...args: any[]) => {
            const timeoutPromise = new Promise<any[]>((_, reject) => {
                setTimeout(() => {
                    log(`Emit timeout for event: ${event}`);
                    reject(new Error('Socket emit timeout'));
                }, 5000);
            });
            const waitPromise = new Promise<any[]>((resolve, reject) => {
                log(`Emitting event: ${event}`);
                this.socket.emit(event, ...args, (err: any, ...data: any[]) => {
                    if (err) {
                        log(`Emit error for ${event}: ${err}`);
                        reject(new Error(err));
                    } else {
                        log(`Emit success for ${event}`);
                        resolve(data);
                    }
                });
            });
            return Promise.race([waitPromise, timeoutPromise]);
        };
        this.emit = promisify(this.socket.emit).bind(this.socket);
    }

    /**
     * Setup internal event handlers
     * Reference: Overleaf-Workshop socketio.ts initInternalHandlers()
     */
    private setupInternalHandlers() {
        this.socket.on('connect', () => {
            log('Socket event: connect (handshake complete)');
            this._connected = true;
            this._handshakeComplete = true;
            this._handshakeResolve();
        });

        this.socket.on('connect_failed', () => {
            log('Socket event: connect_failed');
            this._connected = false;
        });

        this.socket.on('forceDisconnect', (message: string, delay: number = 10) => {
            log(`Socket event: forceDisconnect - ${message}`);
            this._connected = false;
        });

        this.socket.on('error', (err: any) => {
            log(`Socket event: error - ${err}`);
        });

        this.socket.on('disconnect', () => {
            log('Socket event: disconnect');
            this._connected = false;
            this.handlers.forEach(h => h.onDisconnected?.());
        });

        this.socket.on('connectionRejected', (err: any) => {
            log(`Socket event: connectionRejected - ${err?.message}`);
            this._connected = false;
        });

        this.socket.on('connectionAccepted', (_: any, publicId: string) => {
            log(`Socket event: connectionAccepted - publicId: ${publicId}`);
            this._publicId = publicId;
            this._connected = true;
            this.handlers.forEach(h => h.onConnected?.(publicId));
        });

        // v2 scheme handler - joinProjectResponse
        if (this.scheme === 'v2') {
            this.projectRecordPromise = new Promise((resolve) => {
                this.socket.on('joinProjectResponse', (res: any) => {
                    log('Socket event: joinProjectResponse received');
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

        log('Waiting for socket handshake...');
        const timeoutPromise = new Promise<void>((_, reject) => {
            setTimeout(() => {
                log('Handshake timeout');
                reject(new Error('Socket handshake timeout'));
            }, timeoutMs);
        });

        await Promise.race([this._handshakePromise, timeoutPromise]);
        log('Handshake complete, ready to emit');
    }

    /**
     * Join a project
     * Reference: Overleaf-Workshop socketio.ts joinProject()
     */
    async joinProject(): Promise<ProjectEntity> {
        log(`Joining project: ${this.projectId} (scheme: ${this.scheme})`);

        // Wait for handshake before emitting
        try {
            await this.waitForHandshake();
        } catch (error) {
            // Handshake timeout - try v2 scheme
            if (this.scheme === 'v1') {
                log('Handshake failed in v1, switching to v2 scheme');
                this.reinit('v2');
                return this.joinProject();
            }
            throw error;
        }

        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => {
                log('Join project timeout');
                reject(new Error('Join project timeout'));
            }, 5000);
        });

        switch (this.scheme) {
            case 'v1': {
                const joinPromise = this.emit('joinProject', { project_id: this.projectId })
                    .then((returns: any) => {
                        const [project, permissionsLevel, protocolVersion] = returns as [ProjectEntity, string, number];
                        log(`Joined project successfully (permissions: ${permissionsLevel}, protocol: ${protocolVersion})`);
                        this.projectRecord = project;
                        this._connected = true;
                        return project;
                    });

                // Listen for connection rejection and switch to v2
                const rejectPromise = new Promise<never>((_, reject) => {
                    this.socket.on('connectionRejected', (err: any) => {
                        log(`Connection rejected in v1, will try v2: ${err?.message}`);
                        reject(new Error(err?.message || 'Connection rejected'));
                    });
                });

                try {
                    return await Promise.race([joinPromise, rejectPromise, timeoutPromise]);
                } catch (error: any) {
                    // If rejected or timed out, try v2 scheme
                    if (this.scheme === 'v1') {
                        log('v1 failed, switching to v2 scheme');
                        this.reinit('v2');
                        return this.joinProject(); // Retry with v2
                    }
                    throw error;
                }
            }

            case 'v2': {
                // v2 uses joinProjectResponse event instead of callback
                if (this.projectRecordPromise) {
                    try {
                        return await Promise.race([this.projectRecordPromise, timeoutPromise]);
                    } catch (error) {
                        log(`v2 scheme also failed: ${error}`);
                        throw error;
                    }
                }
                throw new Error('v2 scheme not properly initialized');
            }
        }
    }

    /**
     * Join a document for editing
     */
    async joinDoc(docId: string): Promise<{ lines: string[]; version: number }> {
        log(`Joining doc: ${docId}`);
        const [docLinesAscii, version, _updates, _ranges] = await this.emit('joinDoc', docId, {
            encodeRanges: true,
        }) as [string[], number, any[], any];

        const lines = docLinesAscii.map(line => Buffer.from(line, 'ascii').toString('utf-8'));
        log(`Joined doc successfully (version: ${version}, lines: ${lines.length})`);
        return { lines, version };
    }

    /**
     * Leave a document
     */
    async leaveDoc(docId: string): Promise<void> {
        log(`Leaving doc: ${docId}`);
        await this.emit('leaveDoc', docId);
    }

    /**
     * Apply OT update to a document
     */
    async applyOtUpdate(docId: string, update: DocumentUpdate): Promise<void> {
        log(`Applying OT update to doc: ${docId}`);
        await this.emit('applyOtUpdate', docId, update);
    }

    /**
     * Get connected users
     */
    async getConnectedUsers(): Promise<OnlineUser[]> {
        log('Getting connected users');
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
        log('Disconnecting socket');
        this.socket.disconnect();
        this._connected = false;
    }

    /**
     * Reconnect to socket
     */
    reconnect() {
        if (!this._connected) {
            log('Reconnecting socket');
            this.init();
        }
    }
}
