import * as vscode from 'vscode';
import * as path from 'path';

const INVALID_ENTITY_NAME = /[\\/\0-\x1f<>:"|?*]/;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/**
 * Validate one file or folder name received from Overleaf.
 *
 * Remote entity names are path components, never paths. Keeping that
 * distinction here prevents a server response from smuggling `..`, a slash,
 * or a Windows path separator into a local filesystem operation.
 */
export function validateProjectEntityName(name: string): string {
    if (
        typeof name !== 'string'
        || name.length === 0
        || name.length > 255
        || name === '.'
        || name === '..'
        || INVALID_ENTITY_NAME.test(name)
        || name.endsWith('.')
        || name.endsWith(' ')
        || WINDOWS_RESERVED_NAME.test(name)
    ) {
        throw new Error(`Unsafe Overleaf entity name: ${JSON.stringify(name)}`);
    }
    return name;
}

/**
 * Return the canonical LocalLeaf representation of a project path.
 * Canonical paths always start with `/`; folders also end with `/`.
 */
export function normalizeProjectPath(projectPath: string, allowRoot: boolean = true): string {
    if (
        typeof projectPath !== 'string'
        || projectPath.length > 32768
        || projectPath.includes('\0')
        || projectPath.includes('\\')
    ) {
        throw new Error(`Unsafe Overleaf project path: ${JSON.stringify(projectPath)}`);
    }

    const isFolder = projectPath.endsWith('/');
    const withoutLeadingSlash = projectPath.startsWith('/') ? projectPath.slice(1) : projectPath;
    const withoutTrailingSlash = isFolder
        ? withoutLeadingSlash.slice(0, -1)
        : withoutLeadingSlash;

    if (withoutTrailingSlash.length === 0) {
        if (!allowRoot) {
            throw new Error('The workspace root cannot be used as a synchronized entity path.');
        }
        return '/';
    }

    const segments = withoutTrailingSlash.split('/');
    if (segments.some(segment => segment.length === 0)) {
        throw new Error(`Unsafe Overleaf project path: ${JSON.stringify(projectPath)}`);
    }
    for (const segment of segments) {
        validateProjectEntityName(segment);
    }

    return `/${segments.join('/')}${isFolder ? '/' : ''}`;
}

export function joinProjectPath(parentPath: string, name: string, isFolder: boolean): string {
    const canonicalParent = normalizeProjectPath(parentPath);
    const safeName = validateProjectEntityName(name);
    const parent = canonicalParent === '/'
        ? '/'
        : canonicalParent.endsWith('/') ? canonicalParent : `${canonicalParent}/`;
    return normalizeProjectPath(`${parent}${safeName}${isFolder ? '/' : ''}`, false);
}

export function isFileNotFoundError(error: unknown): boolean {
    if (error instanceof vscode.FileSystemError) {
        return error.code === 'FileNotFound' || error.code === 'EntryNotFound';
    }
    if (error instanceof Error) {
        const message = error.message.toLowerCase();
        return message.includes('not found') || message.includes('enoent');
    }
    return false;
}

const WINDOWS_FILE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;

function isWindowsFileUri(uri: vscode.Uri): boolean {
    return uri.scheme === 'file' && (
        WINDOWS_FILE_PATH.test(uri.fsPath)
        || /^\/[A-Za-z]:\//.test(uri.path)
    );
}

/**
 * Return a slash-separated path relative to a workspace, or undefined when
 * the target is outside it. Windows file URIs use Windows path semantics so
 * drive letters and ordinary case differences do not produce false escapes.
 */
export function getWorkspaceRelativePath(
    workspaceFolder: vscode.Uri,
    target: vscode.Uri,
): string | undefined {
    const workspaceIsWindows = isWindowsFileUri(workspaceFolder);
    const targetIsWindows = isWindowsFileUri(target);
    if (workspaceIsWindows !== targetIsWindows) return undefined;

    const caseInsensitiveOrigin = workspaceIsWindows;
    const workspaceScheme = caseInsensitiveOrigin
        ? workspaceFolder.scheme.toLowerCase()
        : workspaceFolder.scheme;
    const targetScheme = caseInsensitiveOrigin ? target.scheme.toLowerCase() : target.scheme;
    const workspaceAuthority = caseInsensitiveOrigin
        ? workspaceFolder.authority.toLowerCase()
        : workspaceFolder.authority;
    const targetAuthority = caseInsensitiveOrigin
        ? target.authority.toLowerCase()
        : target.authority;
    if (workspaceScheme !== targetScheme || workspaceAuthority !== targetAuthority) {
        return undefined;
    }

    const pathApi = workspaceIsWindows ? path.win32 : path.posix;
    const workspacePath = workspaceIsWindows ? workspaceFolder.fsPath : workspaceFolder.path;
    const targetPath = workspaceIsWindows ? target.fsPath : target.path;
    const relativePath = pathApi.relative(
        pathApi.resolve(workspacePath),
        pathApi.resolve(targetPath),
    );
    if (relativePath === '') return '';
    if (
        pathApi.isAbsolute(relativePath)
        || relativePath === '..'
        || relativePath.startsWith(`..${pathApi.sep}`)
    ) {
        return undefined;
    }
    return relativePath.split(pathApi.sep).join('/');
}

/**
 * Verify that a workspace target is lexically contained and that none of its
 * existing path components is a symbolic link.
 */
export async function assertSafeWorkspacePath(
    workspaceFolder: vscode.Uri,
    target: vscode.Uri,
): Promise<void> {
    const relativePath = getWorkspaceRelativePath(workspaceFolder, target);
    if (relativePath === undefined) {
        throw new Error(`Refusing to access a path outside the workspace: ${target.toString()}`);
    }

    const candidates = [workspaceFolder];
    let current = workspaceFolder;
    for (const segment of relativePath.split('/').filter(Boolean)) {
        current = vscode.Uri.joinPath(current, segment);
        candidates.push(current);
    }

    for (const candidate of candidates) {
        try {
            const stat = await vscode.workspace.fs.stat(candidate);
            if ((stat.type & vscode.FileType.SymbolicLink) !== 0) {
                throw new Error(
                    `Refusing to access symbolic link: ${candidate.fsPath || candidate.path}`
                );
            }
        } catch (error) {
            if (isFileNotFoundError(error)) return;
            throw error;
        }
    }
}
