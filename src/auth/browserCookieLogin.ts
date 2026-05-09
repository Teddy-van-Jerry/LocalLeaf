import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

interface DevToolsTarget {
    type?: string;
    url?: string;
    webSocketDebuggerUrl?: string;
}

interface BrowserCookie {
    name: string;
    value: string;
    domain: string;
    expires?: number;
}

export type BrowserCookieCaptureResult =
    | { type: 'success'; cookies: string }
    | { type: 'error'; message: string };

export type BrowserPreference = 'auto' | 'system' | 'chrome' | 'edge';

export async function captureCookiesViaBrowserLogin(
    serverUrl: string,
    preference: BrowserPreference = 'auto',
    log?: (message: string) => void,
): Promise<BrowserCookieCaptureResult> {
    const executable = await findChromiumExecutable(serverUrl, preference, log);
    if (!executable) {
        return {
            type: 'error',
            message: 'No supported Chromium browser found for the selected mode.',
        };
    }

    const port = await getFreePort();
    const tempProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localleaf-browser-login-'));
    const loginUrl = new URL('/login', normalizeServerUrl(serverUrl)).toString();

    let browserProcess: ChildProcess | undefined;
    try {
        log?.(`Opening browser for login: ${executable}`);
        browserProcess = await launchBrowser(executable, port, tempProfileDir, loginUrl);
        await waitForDebugTargets(port, 15000);
        const cookieHeader = await waitForLoginCookies(port, serverUrl, log);
        return { type: 'success', cookies: cookieHeader };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { type: 'error', message };
    } finally {
        if (browserProcess) {
            terminateProcessTree(browserProcess);
        }
        try {
            fs.rmSync(tempProfileDir, { recursive: true, force: true });
        } catch {
            // ignore cleanup failures
        }
    }
}

async function waitForLoginCookies(
    port: number,
    serverUrl: string,
    log?: (message: string) => void,
): Promise<string> {
    const deadline = Date.now() + 300000; // 5 minutes
    let lastKnownError = '';
    let lastAuthCheckAt = 0;
    let lastAuthCookie = '';
    let lastAuthResult = false;

    while (Date.now() < deadline) {
        try {
            const targets = await getDevToolsTargets(port);
            const target = pickTarget(targets, serverUrl);
            if (target?.webSocketDebuggerUrl) {
                const cookies = await getCookiesFromDevTools(target.webSocketDebuggerUrl);
                const cookieHeader = buildCookieHeader(cookies, serverUrl);
                if (cookieHeader && hasSessionCookie(cookieHeader)) {
                    const now = Date.now();
                    if (cookieHeader !== lastAuthCookie || now - lastAuthCheckAt >= 1000) {
                        lastAuthCookie = cookieHeader;
                        lastAuthCheckAt = now;
                        lastAuthResult = await isAuthenticatedCookie(serverUrl, cookieHeader);
                        if (!lastAuthResult) {
                            log?.('Session cookie detected but login is not fully confirmed yet. Waiting...');
                        }
                    }

                    if (lastAuthResult) {
                        return cookieHeader;
                    }
                }
            }
        } catch (error) {
            lastKnownError = error instanceof Error ? error.message : String(error);
            log?.(`Waiting for login cookies: ${lastKnownError}`);
        }

        await delay(300);
    }

    throw new Error(
        lastKnownError
            ? `Timed out waiting for login cookies (${lastKnownError})`
            : 'Timed out waiting for login cookies after 5 minutes. Complete login in the opened browser window.',
    );
}

function hasSessionCookie(cookieHeader: string): boolean {
    // Common session cookie names used by overleaf.com and self-hosted setups.
    return /(?:^|;\s*)(?:overleaf_session2|overleaf_session|connect\.sid)=/i.test(cookieHeader);
}

async function isAuthenticatedCookie(serverUrl: string, cookieHeader: string): Promise<boolean> {
    const fetch = (await import('node-fetch')).default;
    const projectUrl = new URL('/project', normalizeServerUrl(serverUrl)).toString();
    const res = await fetch(projectUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: {
            'Cookie': cookieHeader,
            'Accept': 'text/html,*/*',
        },
    });

    if (res.status === 200) {
        return true;
    }

    if (res.status >= 300 && res.status < 400) {
        const location = (res.headers.get('location') || '').toLowerCase();
        if (!location) {
            return false;
        }
        if (location.includes('/login')) {
            return false;
        }
        if (location.includes('/project')) {
            return true;
        }
    }

    return false;
}

function normalizeServerUrl(serverUrl: string): string {
    return serverUrl.endsWith('/') ? serverUrl : `${serverUrl}/`;
}

async function findChromiumExecutable(
    serverUrl: string,
    preference: BrowserPreference,
    log?: (message: string) => void,
): Promise<string | undefined> {
    const candidates = await getPrioritizedExecutableCandidates(serverUrl, preference, log);
    for (const candidate of candidates) {
        if (path.isAbsolute(candidate)) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
            continue;
        }
        if (await canExecute(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

async function getPrioritizedExecutableCandidates(
    serverUrl: string,
    preference: BrowserPreference,
    log?: (message: string) => void,
): Promise<string[]> {
    const candidates: string[] = [];

    if (preference === 'system') {
        // Respect the OS-registered default browser
        const defaultExecutable = await getSystemDefaultBrowserExecutable(serverUrl, log);
        if (defaultExecutable) {
            if (isChromiumBrowserExecutable(defaultExecutable)) {
                candidates.push(defaultExecutable);
            } else {
                log?.(`Default browser is not Chromium-based, falling back to Chrome/Edge: ${defaultExecutable}`);
            }
        }
        // Fallback: Chrome first, then Edge
        candidates.push(...getChromeExecutableCandidates());
        candidates.push(...getEdgeExecutableCandidates());
    } else if (preference === 'chrome') {
        candidates.push(...getChromeExecutableCandidates());
        candidates.push(...getEdgeExecutableCandidates());
    } else if (preference === 'edge') {
        candidates.push(...getEdgeExecutableCandidates());
        candidates.push(...getChromeExecutableCandidates());
    } else {
        // 'auto': Chrome first, then Edge — no system default lookup
        candidates.push(...getChromeExecutableCandidates());
        candidates.push(...getEdgeExecutableCandidates());
    }

    return dedupeCandidates(candidates);
}

function getChromeExecutableCandidates(): string[] {
    if (process.platform === 'win32') {
        const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
        const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
        const localAppData = process.env.LOCALAPPDATA || '';

        return [
            path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            'chrome',
            'google-chrome',
            'chromium',
        ];
    }

    if (process.platform === 'darwin') {
        return [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            'google-chrome',
            'chromium',
        ];
    }

    return [
        'google-chrome',
        'chromium-browser',
        'chromium',
    ];
}

function getEdgeExecutableCandidates(): string[] {
    if (process.platform === 'win32') {
        const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
        const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
        const localAppData = process.env.LOCALAPPDATA || '';

        return [
            path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            'msedge',
            'microsoft-edge',
        ];
    }

    if (process.platform === 'darwin') {
        return [
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            'microsoft-edge',
        ];
    }

    return ['microsoft-edge', 'msedge'];
}

function dedupeCandidates(candidates: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const candidate of candidates) {
        const key = process.platform === 'win32'
            ? candidate.toLowerCase()
            : candidate;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(candidate);
    }
    return result;
}

function isChromiumBrowserExecutable(executable: string): boolean {
    const name = path.basename(executable).toLowerCase();
    return name.includes('chrome')
        || name.includes('msedge')
        || name.includes('chromium')
        || name.includes('brave')
        || name.includes('opera')
        || name.includes('vivaldi')
        || name.includes('arc');
}

async function getSystemDefaultBrowserExecutable(
    serverUrl: string,
    log?: (message: string) => void,
): Promise<string | undefined> {
    if (process.platform === 'win32') {
        try {
            const preferredScheme = getPreferredScheme(serverUrl);
            const schemes: Array<'https' | 'http'> = preferredScheme === 'https'
                ? ['https', 'http']
                : ['http', 'https'];

            let progId: string | undefined;
            for (const scheme of schemes) {
                progId = await queryWindowsRegistryValue(
                    `HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\${scheme}\\UserChoice`,
                    'ProgId',
                );
                if (progId) {
                    break;
                }
            }
            if (!progId) return undefined;

            const command = await queryWindowsRegistryDefaultValue(`HKCR\\${progId}\\shell\\open\\command`);
            if (!command) return undefined;

            const executable = extractExecutableFromCommand(command);
            if (!executable) return undefined;

            if (path.isAbsolute(executable) && !fs.existsSync(executable)) {
                return undefined;
            }
            return executable;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log?.(`Failed to detect system default browser: ${message}`);
            return undefined;
        }
    }

    return undefined;
}

function getPreferredScheme(serverUrl: string): 'http' | 'https' {
    try {
        return new URL(serverUrl).protocol === 'http:' ? 'http' : 'https';
    } catch {
        return 'https';
    }
}

async function queryWindowsRegistryValue(key: string, valueName: string): Promise<string | undefined> {
    return new Promise((resolve) => {
        let stdout = '';
        const proc = spawn('reg', ['query', key, '/v', valueName], { stdio: ['ignore', 'pipe', 'ignore'] });
        proc.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
        proc.once('error', () => resolve(undefined));
        proc.once('close', (code) => {
            if (code !== 0) {
                resolve(undefined);
                return;
            }
            const re = new RegExp(`${escapeRegExp(valueName)}\\s+REG_\\w+\\s+(.+)$`, 'im');
            const match = stdout.match(re);
            resolve(match?.[1]?.trim());
        });
    });
}

async function queryWindowsRegistryDefaultValue(key: string): Promise<string | undefined> {
    return new Promise((resolve) => {
        let stdout = '';
        const proc = spawn('reg', ['query', key, '/ve'], { stdio: ['ignore', 'pipe', 'ignore'] });
        proc.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
        proc.once('error', () => resolve(undefined));
        proc.once('close', (code) => {
            if (code !== 0) {
                resolve(undefined);
                return;
            }
            const match = stdout.match(/REG_\w+\s+(.+)$/im);
            resolve(match?.[1]?.trim());
        });
    });
}

function extractExecutableFromCommand(command: string): string | undefined {
    const trimmed = command.trim();
    if (!trimmed) return undefined;

    if (trimmed.startsWith('"')) {
        const end = trimmed.indexOf('"', 1);
        if (end > 1) {
            return trimmed.slice(1, end);
        }
        return undefined;
    }

    const firstToken = trimmed.split(/\s+/, 1)[0];
    return firstToken || undefined;
}

function escapeRegExp(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function canExecute(command: string): Promise<boolean> {
    return new Promise((resolve) => {
        let settled = false;
        const proc = spawn(command, ['--version'], { stdio: 'ignore' });
        const finish = (ok: boolean) => {
            if (settled) return;
            settled = true;
            resolve(ok);
        };

        proc.once('error', () => finish(false));
        proc.once('close', (code) => finish(code === 0));

        setTimeout(() => {
            try {
                proc.kill();
            } catch {
                // ignore
            }
            finish(false);
        }, 2500);
    });
}

async function launchBrowser(
    executable: string,
    port: number,
    tempProfileDir: string,
    url: string,
): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const args = [
            `--remote-debugging-port=${port}`,
            '--no-first-run',
            '--no-default-browser-check',
            `--user-data-dir=${tempProfileDir}`,
            '--new-window',
            url,
        ];

        const proc = spawn(executable, args, { stdio: 'ignore' });
        const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            fn();
        };

        proc.once('error', (err) => finish(() => reject(err)));
        proc.once('exit', (code) => {
            if (code !== null && code !== 0) {
                finish(() => reject(new Error(`Browser exited early with code ${code}`)));
            }
        });

        setTimeout(() => finish(() => resolve(proc)), 400);
    });
}

async function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                server.close();
                reject(new Error('Failed to allocate a debug port.'));
                return;
            }
            const port = address.port;
            server.close(() => resolve(port));
        });
    });
}

async function waitForDebugTargets(port: number, timeoutMs: number): Promise<DevToolsTarget[]> {
    const deadline = Date.now() + timeoutMs;
    let lastError = '';
    while (Date.now() < deadline) {
        try {
            const targets = await getDevToolsTargets(port);
            if (targets.length > 0) {
                return targets;
            }
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
        await delay(400);
    }
    throw new Error(lastError || 'Timed out waiting for browser debugging endpoint.');
}

async function getDevToolsTargets(port: number): Promise<DevToolsTarget[]> {
    const fetch = (await import('node-fetch')).default;
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (!res.ok) {
        throw new Error(`DevTools endpoint returned ${res.status}`);
    }
    const data = await res.json() as unknown;
    if (!Array.isArray(data)) {
        return [];
    }
    return data as DevToolsTarget[];
}

function pickTarget(targets: DevToolsTarget[], serverUrl: string): DevToolsTarget | undefined {
    const host = new URL(serverUrl).hostname.toLowerCase();
    const pageTargets = targets.filter(t => t.type === 'page' && !!t.webSocketDebuggerUrl);

    const exact = pageTargets.find(t => {
        if (!t.url) return false;
        try {
            return new URL(t.url).hostname.toLowerCase() === host;
        } catch {
            return false;
        }
    });
    if (exact) return exact;

    if (pageTargets.length > 0) return pageTargets[0];

    return targets.find(t => !!t.webSocketDebuggerUrl);
}

async function getCookiesFromDevTools(wsUrl: string): Promise<BrowserCookie[]> {
    const WS: any = require('ws');

    return new Promise((resolve, reject) => {
        const ws: any = new WS(wsUrl);
        const timeout = setTimeout(() => {
            finishReject(new Error('Timed out while reading cookies from browser.'));
        }, 10000);

        let finished = false;
        const finishResolve = (cookies: BrowserCookie[]) => {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);
            try {
                ws.close();
            } catch {
                // ignore
            }
            resolve(cookies);
        };
        const finishReject = (error: Error) => {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);
            try {
                ws.close();
            } catch {
                // ignore
            }
            reject(error);
        };

        const getAllCookiesId = 2;
        const storageCookiesId = 3;

        ws.on('open', () => {
            ws.send(JSON.stringify({ id: 1, method: 'Network.enable' }));
            ws.send(JSON.stringify({ id: getAllCookiesId, method: 'Network.getAllCookies' }));
        });

        ws.on('message', (data: unknown) => {
            const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
            let payload: any;
            try {
                payload = JSON.parse(text);
            } catch {
                return;
            }

            if (payload.id === getAllCookiesId) {
                if (Array.isArray(payload.result?.cookies)) {
                    finishResolve(payload.result.cookies as BrowserCookie[]);
                    return;
                }
                ws.send(JSON.stringify({ id: storageCookiesId, method: 'Storage.getCookies' }));
                return;
            }

            if (payload.id === storageCookiesId) {
                if (Array.isArray(payload.result?.cookies)) {
                    finishResolve(payload.result.cookies as BrowserCookie[]);
                } else {
                    finishReject(new Error('Could not read cookies from browser.'));
                }
            }
        });

        ws.on('error', (error: Error) => finishReject(error));
        ws.on('close', () => {
            if (!finished) {
                finishReject(new Error('Browser debugging connection closed before cookies were read.'));
            }
        });
    });
}

function buildCookieHeader(cookies: BrowserCookie[], serverUrl: string): string {
    const host = new URL(serverUrl).hostname.toLowerCase();
    const nowSeconds = Date.now() / 1000;
    const unique = new Map<string, string>();

    for (const cookie of cookies) {
        if (!cookie.name) continue;
        if (typeof cookie.value !== 'string') continue;
        if (!domainMatches(cookie.domain, host)) continue;
        if (typeof cookie.expires === 'number' && cookie.expires > 0 && cookie.expires < nowSeconds) {
            continue;
        }
        unique.set(cookie.name, cookie.value);
    }

    return [...unique.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

function domainMatches(cookieDomain: string, host: string): boolean {
    const normalized = cookieDomain.startsWith('.')
        ? cookieDomain.slice(1).toLowerCase()
        : cookieDomain.toLowerCase();
    return host === normalized || host.endsWith(`.${normalized}`);
}

function terminateProcessTree(proc: ChildProcess): void {
    if (!proc.pid) return;

    if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
        killer.unref();
        return;
    }

    try {
        proc.kill('SIGTERM');
    } catch {
        // ignore
    }
}

async function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
