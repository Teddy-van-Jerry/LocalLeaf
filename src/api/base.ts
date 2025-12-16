/**
 * LocalLeaf API - Base HTTP client for Overleaf
 * Adapted from Overleaf-Workshop
 */

import * as http from 'http';
import * as https from 'https';
import * as stream from 'stream';
import { Identity } from '../utils/credentialManager';

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

export interface ResponseSchema {
    type: 'success' | 'error';
    message?: string;
    userInfo?: { userId: string; userEmail: string };
    identity?: Identity;
    projects?: ProjectInfo[];
    project?: ProjectEntity;
    content?: Uint8Array;
}

export class BaseAPI {
    private url: string;
    private agent: http.Agent | https.Agent;
    private identity?: Identity;

    constructor(url: string) {
        this.url = url.endsWith('/') ? url : url + '/';
        this.agent = new URL(url).protocol === 'http:'
            ? new http.Agent({ keepAlive: true })
            : new https.Agent({ keepAlive: true });
    }

    /**
     * Get CSRF token from login page
     */
    private async getCsrfToken(): Promise<Identity> {
        const fetch = (await import('node-fetch')).default;
        const res = await fetch(this.url + 'login', {
            method: 'GET',
            redirect: 'manual',
            agent: this.agent,
        });
        const body = await res.text();
        const match = body.match(/<input.*name="_csrf".*value="([^"]*)"/);
        if (!match) {
            throw new Error('Failed to get CSRF token.');
        }
        const csrfToken = match[1];
        const setCookieHeader = res.headers.raw()['set-cookie'];
        const cookies = setCookieHeader ? setCookieHeader[0].split(';')[0] : '';
        return { csrfToken, cookies };
    }

    /**
     * Get user ID from project page (validates cookies)
     */
    private async getUserId(cookies: string): Promise<{ userId: string; userEmail: string; csrfToken: string } | undefined> {
        const fetch = (await import('node-fetch')).default;
        const res = await fetch(this.url + 'project', {
            method: 'GET',
            redirect: 'manual',
            agent: this.agent,
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
        const fetch = (await import('node-fetch')).default;
        const res = await fetch(this.url + 'socket.io/socket.io.js', {
            method: 'GET',
            redirect: 'manual',
            agent: this.agent,
            headers: {
                'Connection': 'keep-alive',
                'Cookie': identity.cookies,
            }
        });
        const header = res.headers.raw()['set-cookie'];
        if (header !== undefined) {
            const cookies = header[0].split(';')[0];
            if (cookies) {
                identity.cookies = `${identity.cookies}; ${cookies}`;
            }
        }
        return identity;
    }

    /**
     * Login with cookies (recommended for www.overleaf.com)
     */
    async cookiesLogin(cookies: string): Promise<ResponseSchema> {
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
        const fetch = (await import('node-fetch')).default;
        const identity = await this.getCsrfToken();
        const res = await fetch(this.url + 'login', {
            method: 'POST',
            redirect: 'manual',
            agent: this.agent,
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
                const newCookies = res.headers.raw()['set-cookie'][0];
                return this.cookiesLogin(newCookies);
            }
            return { type: 'error', message: `Redirecting to ${redirect}` };
        } else if (res.status === 200) {
            const json = await res.json() as any;
            return { type: 'error', message: json.message?.message || 'Login failed' };
        } else if (res.status === 401) {
            const json = await res.json() as any;
            return { type: 'error', message: json.message?.text || 'Unauthorized' };
        }
        return { type: 'error', message: `${res.status}: ${await res.text()}` };
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
    initSocket(identity: Identity, query?: string): any {
        const socketUrl = new URL(this.url).origin + (query ?? '');

        const io = require('socket.io-client');
        const socket = io.connect(socketUrl, {
            reconnect: false,
            'force new connection': true,
            extraHeaders: {
                'Origin': new URL(this.url).origin,
                'Cookie': identity.cookies,
            },
        });

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

        const fetch = (await import('node-fetch')).default;
        const headers: Record<string, string> = {
            'Connection': 'keep-alive',
            'Cookie': this.identity.cookies,
            ...extraHeaders,
        };

        let fetchOptions: any = {
            method,
            redirect: 'manual',
            agent: this.agent,
            headers,
        };

        if (method === 'POST' && body) {
            headers['Content-Type'] = 'application/json';
            fetchOptions.body = JSON.stringify({ _csrf: this.identity.csrfToken, ...body });
        }

        if (method === 'DELETE') {
            headers['X-Csrf-Token'] = this.identity.csrfToken;
        }

        const res = await fetch(this.url + route, fetchOptions);

        if (res.status === 200 || res.status === 204) {
            return { type: 'success' };
        }
        return { type: 'error', message: `${res.status}: ${await res.text()}` };
    }

    /**
     * Download file content
     */
    private async download(route: string): Promise<Buffer> {
        if (!this.identity) {
            throw new Error('Not authenticated');
        }

        const fetch = (await import('node-fetch')).default;
        const content: Buffer[] = [];

        while (true) {
            const res = await fetch(this.url + route, {
                method: 'GET',
                redirect: 'manual',
                agent: this.agent,
                headers: {
                    'Connection': 'keep-alive',
                    'Cookie': this.identity.cookies,
                },
            });

            if (res.status === 200) {
                content.push(await res.buffer());
                break;
            } else if (res.status === 206) {
                content.push(await res.buffer());
            } else {
                break;
            }
        }

        return Buffer.concat(content);
    }

    /**
     * Logout from server
     */
    async logout(): Promise<ResponseSchema> {
        return this.request('POST', 'logout');
    }

    /**
     * Get list of user's projects
     */
    async getProjects(): Promise<ResponseSchema> {
        if (!this.identity) {
            return { type: 'error', message: 'Not authenticated' };
        }

        const fetch = (await import('node-fetch')).default;
        const res = await fetch(this.url + 'user/projects', {
            method: 'GET',
            redirect: 'manual',
            agent: this.agent,
            headers: {
                'Connection': 'keep-alive',
                'Cookie': this.identity.cookies,
            },
        });

        if (res.status === 200) {
            const data = await res.json() as any;
            const projects: ProjectInfo[] = data.projects.map((p: any) => ({
                id: p._id,
                name: p.name,
                lastUpdated: p.lastUpdated,
                accessLevel: p.accessLevel,
                archived: p.archived,
                trashed: p.trashed,
            }));
            return { type: 'success', projects };
        }
        return { type: 'error', message: `${res.status}: ${await res.text()}` };
    }

    /**
     * Get file content
     */
    async getFile(projectId: string, fileId: string): Promise<ResponseSchema> {
        const content = await this.download(`project/${projectId}/file/${fileId}`);
        return { type: 'success', content: new Uint8Array(content) };
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
        const fetch = (await import('node-fetch')).default;
        const mimeTypes = require('mime-types');

        const fileStream = stream.Readable.from(fileContent);
        const formData = new FormData();
        const mimeType = mimeTypes.lookup(filename);

        formData.append('targetFolderId', parentFolderId);
        formData.append('name', filename);
        formData.append('type', mimeType || 'text/plain');
        formData.append('qqfile', fileStream, { filename });

        const res = await fetch(
            this.url + `project/${projectId}/upload?folder_id=${parentFolderId}`,
            {
                method: 'POST',
                redirect: 'manual',
                agent: this.agent,
                headers: {
                    'Connection': 'keep-alive',
                    'Cookie': this.identity.cookies,
                    'X-Csrf-Token': this.identity.csrfToken,
                },
                body: formData,
            }
        );

        if (res.status === 200) {
            return { type: 'success' };
        }
        return { type: 'error', message: `${res.status}: ${await res.text()}` };
    }

    /**
     * Create a new document (text file)
     */
    async addDoc(projectId: string, parentFolderId: string, filename: string): Promise<ResponseSchema> {
        if (!this.identity) {
            return { type: 'error', message: 'Not authenticated' };
        }

        const fetch = (await import('node-fetch')).default;
        const res = await fetch(this.url + `project/${projectId}/doc`, {
            method: 'POST',
            redirect: 'manual',
            agent: this.agent,
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

        if (res.status === 200) {
            return { type: 'success' };
        }
        return { type: 'error', message: `${res.status}: ${await res.text()}` };
    }

    /**
     * Create a new folder
     */
    async addFolder(projectId: string, parentFolderId: string, folderName: string): Promise<ResponseSchema> {
        if (!this.identity) {
            return { type: 'error', message: 'Not authenticated' };
        }

        const fetch = (await import('node-fetch')).default;
        const res = await fetch(this.url + `project/${projectId}/folder`, {
            method: 'POST',
            redirect: 'manual',
            agent: this.agent,
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

        if (res.status === 200) {
            return { type: 'success' };
        }
        return { type: 'error', message: `${res.status}: ${await res.text()}` };
    }

    /**
     * Delete an entity (doc, file, or folder)
     */
    async deleteEntity(projectId: string, entityType: string, entityId: string): Promise<ResponseSchema> {
        return this.request('DELETE', `project/${projectId}/${entityType}/${entityId}`);
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

        const fetch = (await import('node-fetch')).default;
        const res = await fetch(this.url + `project/${projectId}/${entityType}/${entityId}/rename`, {
            method: 'POST',
            redirect: 'manual',
            agent: this.agent,
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
            return { type: 'success' };
        }
        return { type: 'error', message: `${res.status}: ${await res.text()}` };
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

        const fetch = (await import('node-fetch')).default;
        const res = await fetch(this.url + `project/${projectId}/${entityType}/${entityId}/move`, {
            method: 'POST',
            redirect: 'manual',
            agent: this.agent,
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
            return { type: 'success' };
        }
        return { type: 'error', message: `${res.status}: ${await res.text()}` };
    }

    /**
     * Get the server URL
     */
    getUrl(): string {
        return this.url;
    }

    /**
     * Get project details via HTTP (alternative to socket.io joinProject)
     * Fetches project page and extracts metadata from HTML
     */
    async getProjectDetails(projectId: string): Promise<ResponseSchema & { projectData?: any }> {
        if (!this.identity) {
            return { type: 'error', message: 'Not authenticated' };
        }

        const fetch = (await import('node-fetch')).default;

        // Get project page which contains metadata in HTML
        const res = await fetch(this.url + `project/${projectId}`, {
            method: 'GET',
            redirect: 'manual',
            agent: this.agent,
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

            const extractJsonMeta = (name: string): any => {
                const match = body.match(new RegExp(`<meta\\s+name="${name}"\\s+data-type="json"\\s+content="([^"]*)"`));
                if (match) {
                    try {
                        return JSON.parse(match[1].replace(/&quot;/g, '"'));
                    } catch {
                        return undefined;
                    }
                }
                return undefined;
            };

            const projectData = {
                projectId: extractMeta('ol-project_id') || projectId,
                projectName: extractMeta('ol-projectName'),
                rootDocId: extractMeta('ol-rootDoc_id'),
                userId: extractMeta('ol-user_id'),
                userEmail: extractMeta('ol-usersEmail'),
                compiler: extractMeta('ol-compiler'),
                rootFolder: extractJsonMeta('ol-rootFolder'),
            };

            return { type: 'success', projectData };
        }

        return { type: 'error', message: `${res.status}: Failed to get project details` };
    }

    /**
     * Get project entities (file tree) via HTTP
     */
    async getProjectEntities(projectId: string): Promise<ResponseSchema & { entities?: Array<{ path: string; type: string }> }> {
        if (!this.identity) {
            return { type: 'error', message: 'Not authenticated' };
        }

        const fetch = (await import('node-fetch')).default;
        const res = await fetch(this.url + `project/${projectId}/entities`, {
            method: 'GET',
            redirect: 'manual',
            agent: this.agent,
            headers: {
                'Connection': 'keep-alive',
                'Cookie': this.identity.cookies,
            },
        });

        if (res.status === 200) {
            const data = await res.json() as any;
            return { type: 'success', entities: data.entities };
        }

        return { type: 'error', message: `${res.status}: ${await res.text()}` };
    }

    /**
     * Get document content via HTTP
     */
    async getDocContent(projectId: string, docId: string): Promise<ResponseSchema & { lines?: string[] }> {
        if (!this.identity) {
            return { type: 'error', message: 'Not authenticated' };
        }

        const fetch = (await import('node-fetch')).default;
        const res = await fetch(this.url + `project/${projectId}/doc/${docId}`, {
            method: 'GET',
            redirect: 'manual',
            agent: this.agent,
            headers: {
                'Connection': 'keep-alive',
                'Cookie': this.identity.cookies,
            },
        });

        if (res.status === 200) {
            const data = await res.json() as any;
            return { type: 'success', lines: data.lines };
        }

        return { type: 'error', message: `${res.status}: ${await res.text()}` };
    }
}
