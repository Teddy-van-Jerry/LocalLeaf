export interface ValidatedServerUrl {
    url: string;
    parsed: URL;
    isOfficialOverleaf: boolean;
}

/** Validate and canonicalize an Overleaf server base URL. */
export function validateServerUrl(value: string): ValidatedServerUrl {
    const input = value.trim();
    if (input.length > 8192) {
        throw new Error('The Overleaf server URL is too long.');
    }
    let parsed: URL;
    try {
        parsed = new URL(input);
    } catch {
        throw new Error('The Overleaf server URL is invalid.');
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error('The Overleaf server must use HTTP or HTTPS.');
    }
    if (parsed.username || parsed.password) {
        throw new Error('The Overleaf server URL must not contain embedded credentials.');
    }
    if (parsed.search || parsed.hash) {
        throw new Error('The Overleaf server URL must not contain a query string or fragment.');
    }

    const normalizedPath = parsed.pathname.replace(/\/+$/, '');
    parsed.pathname = normalizedPath || '/';
    const url = `${parsed.origin}${normalizedPath}`;
    const hostname = parsed.hostname.toLowerCase();

    return {
        url,
        parsed,
        isOfficialOverleaf: hostname === 'overleaf.com' || hostname.endsWith('.overleaf.com'),
    };
}

export function isSupportedServerUrl(value: unknown): value is string {
    if (typeof value !== 'string' || value.trim().length === 0) return false;
    try {
        validateServerUrl(value);
        return true;
    } catch {
        return false;
    }
}
