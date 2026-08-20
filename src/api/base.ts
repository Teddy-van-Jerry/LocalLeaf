/**
 * LocalLeaf API - Base HTTP client for Overleaf
 * Adapted from Overleaf-Workshop
 */

import * as http from 'http';
import * as https from 'https';
import * as stream from 'stream';
import type { RequestInit, Response } from 'node-fetch';
import { Identity } from '../utils/credentialManager';
import { validateServerUrl } from '../utils/serverUrl';
import { validateProjectEntityName } from '../utils/pathSafety';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_API_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_RESPONSE_BYTES = 100 * 1024 * 1024;
const MAX_PARTIAL_DOWNLOADS = 10_000;

type JsonObject = Record<string, unknown>;

function asJsonObject(value: unknown): JsonObject | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonObject
        : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function routeSegment(value: string, label: string): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || value.includes('\0')) {
        throw new Error(`Invalid Overleaf ${label}.`);
    }
    return encodeURIComponent(value);
}

function entityRouteSegment(entityType: string): string {
    if (entityType !== 'doc' && entityType !== 'file' && entityType !== 'folder') {
        throw new Error(`Invalid Overleaf entity type: ${entityType}`);
    }
    return entityType;
}

function mergeCookieHeaders(...headers: Array<string | undefined>): string {
    const cookies = new Map<string, string>();
    for (const header of headers) {
        for (const rawPair of header?.split(';') || []) {
            const pair = rawPair.trim();
            const separator = pair.indexOf('=');
            if (separator <= 0) continue;
            cookies.set(pair.slice(0, separator).trim(), pair);
        }
    }
    return [...cookies.values()].join('; ');
}

class ApiHttpError extends Error {
    constructor(message: string, readonly status?: number) {
        super(message);
    }
}

export interface ProjectInfo {
    id: string;
    name: string;
    lastUpdated?: string;
    accessLevel: 'owner' | 'collaborator' | 'readOnly';
    archived?: boolean;
    trashed?: boolean;
}

export interface FileEntity {
    _id: string;
    _type: 'doc' | 'file' | 'folder';
    name: string;
}

export interface FolderEntity extends FileEntity {
    _type: 'folder';
    docs: FileEntity[];
    fileRefs: FileEntity[];
    folders: FolderEntity[];
}

export interface ProjectEntity {
    _id: string;
    name: string;
    rootDoc_id?: string;
    rootFolder: FolderEntity[];
    compiler?: string;
    spellCheckLanguage?: string;
    owner: { _id: string; email: string; first_name: string; last_name?: string };
    members: Array<{ _id: string; email: string; first_name: string; last_name?: string; privileges: string }>;
}

export interface ProjectDetails {
    projectId: string;
    projectName?: string;
    rootDocId?: string;
    userId?: string;
    userEmail?: string;
    compiler?: string;
    rootFolder?: FolderEntity[];
}

export type AuthErrorType = 'session_expired' | 'invalid_credentials';

export interface ResponseSchema {
    type: 'success' | 'error';
    message?: string;
    authError?: AuthErrorType;
    userInfo?: { userId: string; userEmail: string };
    identity?: Identity;
    projects?: ProjectInfo[];
    project?: ProjectEntity;
    content?: Uint8Array;
    file?: FileEntity;
    doc?: FileEntity;
    folder?: FileEntity;
}

export class BaseAPI {
    private url: string;
    private agent: http.Agent | https.Agent;
    private identity?: Identity;
    private readonly activeRequests = new Set<AbortController>();
    private disposed = false;

    constructor(url: string) {
        const server = validateServerUrl(url);
        this.url = `${server.url}/`;
        this.agent = server.parsed.protocol === 'http:'
            ? new http.Agent({ keepAlive: true })
            : new https.Agent({ keepAlive: true });
    }

    private async fetchRoute(
        route: string,
        options: RequestInit,
        maxResponseBytes: number = MAX_API_RESPONSE_BYTES,
    ): Promise<Response> {
        if (this.disposed) {
            throw new Error('Overleaf request cancelled because the sync session was closed.');
        }

        const fetch = (await import('node-fetch')).default;
        const controller = new AbortController();
        this.activeRequests.add(controller);
        const timeout = setTimeout(() => controller.abort(), DEFAULT_REQUEST_TIMEOUT_MS);
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            clearTimeout(timeout);
            this.activeRequests.delete(controller);
        };

        try {
            const response = await fetch(this.url + route, {
                redirect: 'manual',
                agent: this.agent,
                ...options,
                signal: controller.signal,
                size: maxResponseBytes,
            });
            if (response.body) {
                response.body.once('end', release);
                response.body.once('close', release);
                response.body.once('error', release);
            } else {
                release();
            }
            return response;
        } catch (error) {
            release();
            if (controller.signal.aborted) {
                const reason = this.disposed ? 'sync session was closed' : 'request timed out';
                throw new Error(`Overleaf ${reason}.`);
            }
            throw error;
        }
    }

    private async responseError(response: Response): Promise<ResponseSchema> {
        let detail = '';
        try {
            detail = await response.text();
        } catch {
            detail = response.statusText;
        }
        if (detail.length > 4096) {
            detail = `${detail.slice(0, 4096)}…`;
        }
        const authError = response.status === 401 || response.status === 403
            ? 'session_expired' as const
            : undefined;
        return {
            type: 'error',
            message: authError ? 'Session expired' : `${response.status}: ${detail || response.statusText}`,
            authError,
        };
    }

    private discardResponseBody(response: Response): void {
        response.body?.resume();
    }

    private getResponseCookies(response: Response): string {
        const setCookieHeaders = response.headers.raw()['set-cookie'] || [];
        return mergeCookieHeaders(...setCookieHeaders.map(header => header.split(';', 1)[0]));
    }

    /** Abort all active requests and remove the in-memory identity. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.identity = undefined;
        for (const controller of this.activeRequests) {
            controller.abort();
        }
        this.activeRequests.clear();
        this.agent.destroy();
    }

    /**
     * Get CSRF token from login page
     */
    private async getCsrfToken(): Promise<Identity> {
        const res = await this.fetchRoute('login', {
            method: 'GET',
        });
        const body = await res.text();
        const match = body.match(/<input.*name="_csrf".*value="([^"]*)"/);
        if (!match) {
            throw new Error('Failed to get CSRF token.');
        }
        const csrfToken = match[1];
        const cookies = this.getResponseCookies(res);
        return { csrfToken, cookies };
    }

    /**
     * Get user ID from project page (validates cookies)
     */
    private async getUserId(cookies: string): Promise<{ userId: string; userEmail: string; csrfToken: string } | undefined> {
        const res = await this.fetchRoute('project', {
            method: 'GET',
            headers: {
                'Connection': 'keep-alive',
                'Cookie': cookies,
            }
        });

        const body = await res.text();
        const userIDMatch = body.match(/<meta\s+name="ol-user_id"\s+content="([^"]*)"/);
        const userEmailMatch = body.match(/<meta\s+name="ol-usersEmail"\s+content="([^"]*)"/);
        const csrfTokenMatch = body.match(/<meta\s+name="ol-csrfToken"\s+content="([^"]*)"/);

        if (userIDMatch && csrfTokenMatch) {
            return {
                userId: userIDMatch[1],
                userEmail: userEmailMatch ? userEmailMatch[1] : '',
                csrfToken: csrfTokenMatch[1],
            };
        }
        return undefined;
    }

    /**
     * Update cookies with socket.io session
     */
    async updateCookies(identity: Identity): Promise<Identity> {
        const res = await this.fetchRoute('socket.io/socket.io.js', {
            method: 'GET',
            headers: {
                'Connection': 'keep-alive',
                'Cookie': identity.cookies,
            }
        });
        const cookies = this.getResponseCookies(res);
        if (cookies) {
            identity.cookies = mergeCookieHeaders(identity.cookies, cookies);
        }
        this.discardResponseBody(res);
        return identity;
    }

    /**
     * Login with cookies (recommended for www.overleaf.com)
     */
    async cookiesLogin(cookies: string): Promise<ResponseSchema> {
        if (
            typeof cookies !== 'string'
            || cookies.length === 0
            || cookies.length > 65536
            || /[\r\n\0]/.test(cookies)
        ) {
            return { type: 'error', message: 'The Overleaf cookie header is invalid.' };
        }
        const res = await this.getUserId(cookies);
        if (res) {
            const { userId, userEmail, csrfToken } = res;
            const identity = await this.updateCookies({ cookies, csrfToken });
            return {
                type: 'success',
                userInfo: { userId, userEmail },
                identity,
            };
        }
        return {
            type: 'error',
            message: 'Failed to validate cookies. Please check that you copied the correct cookies.',
        };
    }

    /**
     * Login with email and password (not available for www.overleaf.com due to SSO/captcha)
     */
    async passportLogin(email: string, password: string): Promise<ResponseSchema> {
        const identity = await this.getCsrfToken();
        const res = await this.fetchRoute('login', {
            method: 'POST',
            headers: {
                'Accept': '*/*',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Content-Type': 'application/json',
                'Cookie': identity.cookies,
                'X-Csrf-Token': identity.csrfToken,
            },
            body: JSON.stringify({ _csrf: identity.csrfToken, email, password }),
        });

        if (res.status === 302) {
            const text = await res.text();
            const redirect = text.match(/Found. Redirecting to (.*)/)?.[1];
            if (redirect === '/project') {
                const newCookies = mergeCookieHeaders(identity.cookies, this.getResponseCookies(res));
                if (!newCookies) return { type: 'error', message: 'Login returned no session cookie.' };
                return this.cookiesLogin(newCookies);
            }
            return { type: 'error', message: `Redirecting to ${redirect}` };
        } else if (res.status === 200) {
            const json = asJsonObject(await res.json());
            const message = asJsonObject(json?.message);
            return { type: 'error', message: nonEmptyString(message?.message) || 'Login failed' };
        } else if (res.status === 401) {
            const json = asJsonObject(await res.json());
            const message = asJsonObject(json?.message);
            return { type: 'error', message: nonEmptyString(message?.text) || 'Unauthorized' };
        }
        return this.responseError(res);
    }

    /**
     * Set identity for authenticated requests
     */
    setIdentity(identity: Identity): this {
        this.identity = identity;
        return this;
    }

    /**
     * Get current identity
     */
    getIdentity(): Identity | undefined {
        return this.identity;
    }

    /**
     * Initialize Socket.io connection
     * Reference: Overleaf-Workshop base.ts _initSocketV0
     */
    initSocket(identity: Identity, query?: string): SocketIOClient.Socket {
        const socketUrl = new URL(this.url).origin + (query ?? '');

        const io: SocketIOClientStatic = require('socket.io-client');
        const options: SocketIOClient.ConnectOpts & {
            reconnect: boolean;
            'force new connection': boolean;
            extraHeaders: Record<string, string>;
        } = {
            reconnect: false,
            'force new connection': true,
            extraHeaders: {
                'Origin': new URL(this.url).origin,
                'Cookie': identity.cookies,
            },
        };
        const socket = io.connect(socketUrl, options);

        return socket;
    }

    /**
     * Generic HTTP request
     */
    private async request(
        method: 'GET' | 'POST' | 'DELETE',
        route: string,
        body?: object,
        extraHeaders?: object
    ): Promise<ResponseSchema> {
        if (!this.identity) {
            return { type: 'error', message: 'Not authenticated' };
        }

        const headers: Record<string, string> = {
            'Connection': 'keep-alive',
            'Cookie': this.identity.cookies,
            ...extraHeaders,
        };

        const fetchOptions: RequestInit = {
            method,
            headers,
        };

        if (method === 'POST' && body) {
            headers['Content-Type'] = 'application/json';
            fetchOptions.body = JSON.stringify({ _csrf: this.identity.csrfToken, ...body });
        }

        if (method === 'DELETE') {
            headers['X-Csrf-Token'] = this.identity.csrfToken;
        }

        const res = await this.fetchRoute(route, fetchOptions);

        if (res.status === 200 || res.status === 204) {
            this.discardResponseBody(res);
            return { type: 'success' };
        }
        return this.responseError(res);
    }

    /**
     * Download file content
     */
    private async download(route: string): Promise<Buffer> {
        if (!this.identity) {
            throw new Error('Not authenticated');
        }

        const content: Buffer[] = [];
        let offset = 0;

        for (let requestCount = 0; requestCount < MAX_PARTIAL_DOWNLOADS; requestCount++) {
            const headers: Record<string, string> = {
                'Connection': 'keep-alive',
                'Cookie': this.identity.cookies,
            };
            if (offset > 0) {
                headers.Range = `bytes=${offset}-`;
            }

            const res = await this.fetchRoute(route, {
                method: 'GET',
                headers,
            }, MAX_FILE_RESPONSE_BYTES);

            if (res.status === 200) {
                if (offset !== 0) {
                    this.discardResponseBody(res);
                    throw new ApiHttpError('The Overleaf server stopped a partial download unexpectedly.');
                }
                return await res.buffer();
            }

            if (res.status === 401 || res.status === 403) {
                this.discardResponseBody(res);
                throw new ApiHttpError('Session expired', res.status);
            }
            if (res.status !== 206) {
                const failure = await this.responseError(res);
                throw new ApiHttpError(failure.message || 'File download failed', res.status);
            }

            const contentRange = res.headers.get('content-range');
            const match = contentRange?.match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
            if (!match) {
                this.discardResponseBody(res);
                throw new ApiHttpError('The Overleaf server returned an invalid partial download range.');
            }

            const start = Number(match[1]);
            const end = Number(match[2]);
            const total = Number(match[3]);
            if (
                !Number.isSafeInteger(start)
                || !Number.isSafeInteger(end)
                || !Number.isSafeInteger(total)
                || start !== offset
                || end < start
                || end >= total
                || total > MAX_FILE_RESPONSE_BYTES
            ) {
                this.discardResponseBody(res);
                throw new ApiHttpError('The Overleaf server returned an unsafe partial download range.');
            }

            const chunk = await res.buffer();
            if (chunk.length !== end - start + 1) {
                throw new ApiHttpError('The Overleaf server returned an incomplete partial download.');
            }
            content.push(chunk);
            offset = end + 1;
            if (offset === total) {
                return Buffer.concat(content, total);
            }
        }

        throw new ApiHttpError('The Overleaf server returned too many partial download responses.');
    }

    /**
     * Get list of user's projects
     */
    async getProjects(): Promise<ResponseSchema> {
        if (!this.identity) {
            return { type: 'error', message: 'Not authenticated' };
        }

        const res = await this.fetchRoute('user/projects', {
            method: 'GET',
            headers: {
                'Connection': 'keep-alive',
                'Cookie': this.identity.cookies,
            },
        });

        if (res.status === 200) {
            const data = asJsonObject(await res.json());
            if (!Array.isArray(data?.projects)) {
                return { type: 'error', message: 'Overleaf returned an invalid project list.' };
            }
            const projects: ProjectInfo[] = data.projects.flatMap((value: unknown) => {
                const p = asJsonObject(value);
                if (
                    !p
                    || typeof p._id !== 'string'
                    || p._id.length === 0
                    || p._id.length > 1024
                    || typeof p.name !== 'string'
                    || p.name.length === 0
                    || p.name.length > 4096
                ) return [];
                const accessLevel: ProjectInfo['accessLevel'] = p.accessLevel === 'owner'
                    || p.accessLevel === 'collaborator'
                    || p.accessLevel === 'readOnly'
                    ? p.accessLevel
                    : 'readOnly';
                return [{
                    id: p._id,
                    name: p.name,
                    lastUpdated: typeof p.lastUpdated === 'string' ? p.lastUpdated : undefined,
                    accessLevel,
                    archived: Boolean(p.archived),
                    trashed: Boolean(p.trashed),
                }];
            });
            return { type: 'success', projects };
        }
        return this.responseError(res);
    }

    /**
     * Get file content
     */
    async getFile(projectId: string, fileId: string): Promise<ResponseSchema> {
        try {
            const content = await this.download(
                `project/${routeSegment(projectId, 'project ID')}/file/${routeSegment(fileId, 'file ID')}`
            );
            return { type: 'success', content: new Uint8Array(content) };
        } catch (error) {
            const status = error instanceof ApiHttpError ? error.status : undefined;
            return {
                type: 'error',
                message: error instanceof Error ? error.message : String(error),
                authError: status === 401 || status === 403 ? 'session_expired' : undefined,
            };
        }
    }

    /**
     * Upload a file to a project
     */
    async uploadFile(
        projectId: string,
        parentFolderId: string,
        filename: string,
        fileContent: Uint8Array
    ): Promise<ResponseSchema> {
        if (!this.identity) {
            return { type: 'error', message: 'Not authenticated' };
        }

        const FormData = require('form-data');
        const mimeTypes = require('mime-types');

        validateProjectEntityName(filename);
        const fileStream = stream.Readable.from(fileContent);
        const formData = new FormData();
        const mimeType = mimeTypes.lookup(filename);

        formData.append('targetFolderId', parentFolderId);
        formData.append('name', filename);
        formData.append('type', mimeType || 'text/plain');
        formData.append('qqfile', fileStream, { filename });

        const res = await this.fetchRoute(
            `project/${routeSegment(projectId, 'project ID')}/upload?folder_id=${routeSegment(parentFolderId, 'folder ID')}`,
            {
                method: 'POST',
                headers: {
                    'Connection': 'keep-alive',
                    'Cookie': this.identity.cookies,
                    'X-Csrf-Token': this.identity.csrfToken,
                },
                body: formData,
            }
        );

        if (res.ok) {
            let uploadData: unknown;
            try {
                uploadData = await res.json();
            } catch {
                // Some Overleaf versions return an empty successful response.
            }

            const uploadObject = asJsonObject(uploadData);
            const rawEntity = asJsonObject(uploadObject?.file)
                || asJsonObject(uploadObject?.entity)
                || uploadObject;
            const entityId = nonEmptyString(rawEntity?._id)
                || nonEmptyString(rawEntity?.id)
                || nonEmptyString(uploadObject?.entity_id);
            const rawEntityType = rawEntity?._type || rawEntity?.type || uploadObject?.entity_type;
            const entityType: FileEntity['_type'] =
                rawEntityType === 'doc' || rawEntityType === 'folder' ? rawEntityType : 'file';
            const file: FileEntity | undefined = entityId
                ? {
                    _id: entityId,
                    _type: entityType,
                    name: filename,
                }
                : undefined;

            return { type: 'success', file };
        }
        return this.responseError(res);
    }

    /**
     * Create a new document (text file)
     */
    async addDoc(projectId: string, parentFolderId: string, filename: string): Promise<ResponseSchema> {
        if (!this.identity) {
            return { type: 'error', message: 'Not authenticated' };
        }

        validateProjectEntityName(filename);
        const res = await this.fetchRoute(`project/${routeSegment(projectId, 'project ID')}/doc`, {
            method: 'POST',
            headers: {
                'Connection': 'keep-alive',
                'Cookie': this.identity.cookies,
                'Content-Type': 'application/json',
                'X-Csrf-Token': this.identity.csrfToken,
            },
            body: JSON.stringify({
                _csrf: this.identity.csrfToken,
                parent_folder_id: parentFolderId,
                name: filename,
            }),
        });

        if (res.ok) {
            let doc: FileEntity | undefined;
            try {
                const data = asJsonObject(await res.json());
                const rawDoc = asJsonObject(data?.doc) || data;
                const docId = nonEmptyString(rawDoc?._id) || nonEmptyString(rawDoc?.id);
                if (docId) {
                    doc = {
                        _id: docId,
                        _type: 'doc',
                        name: filename,
                    };
                }
            } catch {
                // Some Overleaf versions return an empty successful response.
            }

            return { type: 'success', doc };
        }
        return this.responseError(res);
    }

    /**
     * Create a new folder
     * Returns the created folder entity with _id
     */
    async addFolder(projectId: string, parentFolderId: string, folderName: string): Promise<ResponseSchema & { folder?: FileEntity }> {
        if (!this.identity) {
            return { type: 'error', message: 'Not authenticated' };
        }

        validateProjectEntityName(folderName);
        const res = await this.fetchRoute(`project/${routeSegment(projectId, 'project ID')}/folder`, {
            method: 'POST',
            headers: {
                'Connection': 'keep-alive',
                'Cookie': this.identity.cookies,
                'Content-Type': 'application/json',
                'X-Csrf-Token': this.identity.csrfToken,
            },
            body: JSON.stringify({
                _csrf: this.identity.csrfToken,
                parent_folder_id: parentFolderId,
                name: folderName,
            }),
        });

        if (res.ok) {
            // Parse response to get folder entity with _id
            const data = asJsonObject(await res.json());
            const folderId = nonEmptyString(data?._id) || nonEmptyString(data?.id);
            const folder: FileEntity | undefined = folderId
                ? {
                    _id: folderId,
                    _type: 'folder',
                    name: folderName,
                }
                : undefined;
            return { type: 'success', folder };
        }
        return this.responseError(res);
    }

    /**
     * Delete an entity (doc, file, or folder)
     */
    async deleteEntity(projectId: string, entityType: string, entityId: string): Promise<ResponseSchema> {
        return this.request(
            'DELETE',
            `project/${routeSegment(projectId, 'project ID')}/${entityRouteSegment(entityType)}/${routeSegment(entityId, 'entity ID')}`
        );
    }

    /**
     * Rename an entity
     */
    async renameEntity(
        projectId: string,
        entityType: string,
        entityId: string,
        newName: string
    ): Promise<ResponseSchema> {
        if (!this.identity) {
            return { type: 'error', message: 'Not authenticated' };
        }

        validateProjectEntityName(newName);
        const res = await this.fetchRoute(
            `project/${routeSegment(projectId, 'project ID')}/${entityRouteSegment(entityType)}/${routeSegment(entityId, 'entity ID')}/rename`, {
            method: 'POST',
            headers: {
                'Connection': 'keep-alive',
                'Cookie': this.identity.cookies,
                'Content-Type': 'application/json',
                'X-Csrf-Token': this.identity.csrfToken,
            },
            body: JSON.stringify({
                _csrf: this.identity.csrfToken,
                name: newName,
            }),
            });

        if (res.status === 200 || res.status === 204) {
            this.discardResponseBody(res);
            return { type: 'success' };
        }
        return this.responseError(res);
    }

    /**
     * Move an entity to another folder
     */
    async moveEntity(
        projectId: string,
        entityType: string,
        entityId: string,
        newParentFolderId: string
    ): Promise<ResponseSchema> {
        if (!this.identity) {
            return { type: 'error', message: 'Not authenticated' };
        }

        const res = await this.fetchRoute(
            `project/${routeSegment(projectId, 'project ID')}/${entityRouteSegment(entityType)}/${routeSegment(entityId, 'entity ID')}/move`, {
            method: 'POST',
            headers: {
                'Connection': 'keep-alive',
                'Cookie': this.identity.cookies,
                'Content-Type': 'application/json',
                'X-Csrf-Token': this.identity.csrfToken,
            },
            body: JSON.stringify({
                _csrf: this.identity.csrfToken,
                folder_id: newParentFolderId,
            }),
            });

        if (res.status === 200 || res.status === 204) {
            this.discardResponseBody(res);
            return { type: 'success' };
        }
        return this.responseError(res);
    }

    /**
     * Get project details via HTTP (alternative to socket.io joinProject)
     * Fetches project page and extracts metadata from HTML
     */
    async getProjectDetails(projectId: string): Promise<ResponseSchema & { projectData?: ProjectDetails }> {
        if (!this.identity) {
            return { type: 'error', message: 'Not authenticated' };
        }

        // Get project page which contains metadata in HTML
        const res = await this.fetchRoute(`project/${routeSegment(projectId, 'project ID')}`, {
            method: 'GET',
            headers: {
                'Connection': 'keep-alive',
                'Cookie': this.identity.cookies,
            },
        });

        if (res.status === 200) {
            const body = await res.text();

            // Extract project data from meta tags
            const extractMeta = (name: string): string | undefined => {
                const match = body.match(new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`));
                return match ? match[1] : undefined;
            };

            const extractJsonMeta = (name: string): unknown => {
                const match = body.match(new RegExp(`<meta\\s+name="${name}"\\s+data-type="json"\\s+content="([^"]*)"`));
                if (match) {
                    try {
                        return JSON.parse(match[1].replace(/&quot;/g, '"')) as unknown;
                    } catch {
                        return undefined;
                    }
                }
                return undefined;
            };

            const rootFolder = extractJsonMeta('ol-rootFolder');
            const projectData: ProjectDetails = {
                projectId: extractMeta('ol-project_id') || projectId,
                projectName: extractMeta('ol-projectName'),
                rootDocId: extractMeta('ol-rootDoc_id'),
                userId: extractMeta('ol-user_id'),
                userEmail: extractMeta('ol-usersEmail'),
                compiler: extractMeta('ol-compiler'),
                rootFolder: Array.isArray(rootFolder) ? rootFolder as FolderEntity[] : undefined,
            };

            return { type: 'success', projectData };
        }

        return this.responseError(res);
    }

    /**
     * Get document content via HTTP
     */
    async getDocContent(projectId: string, docId: string): Promise<ResponseSchema & { lines?: string[] }> {
        if (!this.identity) {
            return { type: 'error', message: 'Not authenticated' };
        }

        const res = await this.fetchRoute(
            `project/${routeSegment(projectId, 'project ID')}/doc/${routeSegment(docId, 'document ID')}`, {
            method: 'GET',
            headers: {
                'Connection': 'keep-alive',
                'Cookie': this.identity.cookies,
            },
            });

        if (res.status === 200) {
            const data = asJsonObject(await res.json());
            if (!Array.isArray(data?.lines) || data.lines.some((line: unknown) => typeof line !== 'string')) {
                return { type: 'error', message: 'Overleaf returned invalid document content.' };
            }
            return { type: 'success', lines: data.lines as string[] };
        }

        return this.responseError(res);
    }

    /**
     * Verify that current credentials are still valid
     */
    async verifyCredentials(): Promise<ResponseSchema> {
        if (!this.identity) {
            return { type: 'error', message: 'Not authenticated', authError: 'invalid_credentials' };
        }

        const result = await this.getUserId(this.identity.cookies);
        if (result) {
            return {
                type: 'success',
                userInfo: { userId: result.userId, userEmail: result.userEmail },
            };
        }
        return {
            type: 'error',
            message: 'Session expired or cookie invalid',
            authError: 'session_expired',
        };
    }
}
