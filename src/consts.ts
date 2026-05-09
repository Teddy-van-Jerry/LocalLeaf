/**
 * LocalLeaf Constants
 */

export const EXTENSION_ID = 'teddy-van-jerry.localleaf';
export const EXTENSION_NAME = 'LocalLeaf';

// Configuration paths
export const CONFIG_DIR = '.localleaf';
export const SETTINGS_FILE = 'settings.json';
export const IGNORE_FILE = '.leafignore';

// Credential storage keys
export const CREDENTIAL_KEY_PREFIX = 'localleaf.credential.';

// Default server
export const DEFAULT_SERVER = 'https://www.overleaf.com';

// Sync settings
export const DEFAULT_SYNC_INTERVAL = 5000;
export const DEBOUNCE_DELAY = 500;

// Special variables for .leafignore
export const VAR_MAIN_TEX = '$MAIN_TEX';
export const VAR_MAIN_PDF = '$MAIN_PDF';

// Default ignore patterns
export const DEFAULT_IGNORE_PATTERNS = [
    // Hidden files
    '.*',
    '.*/**',
    // LaTeX build artifacts
    '*.aux',
    '*.bbl',
    '*.bcf',
    '*.blg',
    '*.fdb_latexmk',
    '*.fls',
    '*.git',
    '*.log',
    '*.out',
    '*.run.xml',
    '*.synctex.gz',
    '*.synctex(busy)',
    '*.toc',
    '*.lof',
    '*.lot',
    '*.xdv',
    // Config directory itself
    '.localleaf/**',
];

// Status bar
export const STATUS_BAR_PRIORITY = 100;

// Commands
export const COMMANDS = {
    LOGIN: 'localleaf.login',
    LOGOUT: 'localleaf.logout',
    SHOW_ACCOUNT_PANEL: 'localleaf.showAccountPanel',
    LINK_FOLDER: 'localleaf.linkFolder',
    UNLINK_FOLDER: 'localleaf.unlinkFolder',
    SYNC_NOW: 'localleaf.syncNow',
    PULL_FROM_OVERLEAF: 'localleaf.pullFromOverleaf',
    PUSH_TO_OVERLEAF: 'localleaf.pushToOverleaf',
    EDIT_IGNORE_PATTERNS: 'localleaf.editIgnorePatterns',
    SHOW_SYNC_STATUS: 'localleaf.showSyncStatus',
    SET_MAIN_DOCUMENT: 'localleaf.setMainDocument',
    CONFIGURE: 'localleaf.configure',
    JUMP_TO_COLLABORATOR: 'localleaf.jumpToCollaborator',
    VERIFY_CREDENTIALS: 'localleaf.verifyCredentials',
    REFRESH_COOKIE: 'localleaf.refreshCookie',
    OPEN_PROJECT: 'localleaf.openProject',
    OPEN_LOCAL_PROJECT: 'localleaf.openLocalProject',
    REMOVE_COMMENTS: 'localleaf.removeComments',
    // Sync mode
    TOGGLE_SYNC_MODE: 'localleaf.toggleSyncMode',
    // Project sorting & filtering
    FILTER_PROJECTS: 'localleaf.filterProjects',
    SORT_PROJECTS_BY_NAME: 'localleaf.sortProjectsByName',
    SORT_PROJECTS_BY_DATE: 'localleaf.sortProjectsByDate',
    SORT_PROJECTS_BY_ACCESS: 'localleaf.sortProjectsByAccess',
    // Compilation & PDF preview
    COMPILE_LATEX: 'localleaf.compileLaTeX',
    SHOW_PDF_PREVIEW: 'localleaf.showPdfPreview',
    SELECT_COMPILER: 'localleaf.selectCompiler',
    TOGGLE_AUTO_COMPILE: 'localleaf.toggleAutoCompile',
    CANCEL_COMPILATION: 'localleaf.cancelCompilation',
    // Changes view context actions
    RESOLVE_CONFLICT_REMOTE: 'localleaf.resolveConflictRemote',
    RESOLVE_CONFLICT_LOCAL: 'localleaf.resolveConflictLocal',
    VIEW_DIFF: 'localleaf.viewDiff',
    DISCARD_CHANGE: 'localleaf.discardChange',
    DISCARD_ALL_LOCAL_CHANGES: 'localleaf.discardAllLocalChanges',
} as const;
