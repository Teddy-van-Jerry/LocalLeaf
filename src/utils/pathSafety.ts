import * as vscode from 'vscode';

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

/**
 * Verify that a workspace target is lexically contained and that none of its
 * existing path components is a symbolic link.
 */
export async function assertSafeWorkspacePath(
    workspaceFolder: vscode.Uri,
    target: vscode.Uri,
): Promise<void> {
    const workspacePath = workspaceFolder.path.replace(/\/+$/, '');
    const targetPath = target.path.replace(/\/+$/, '');
    const relativePath = targetPath === workspacePath
        ? ''
        : targetPath.startsWith(`${workspacePath}/`)
            ? targetPath.slice(workspacePath.length + 1)
            : undefined;
    if (
        relativePath === undefined
        || workspaceFolder.scheme !== target.scheme
        || workspaceFolder.authority !== target.authority
    ) {
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
