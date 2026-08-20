import { randomBytes } from 'crypto';

/** Generate an unpredictable nonce for a webview Content Security Policy. */
export function createNonce(): string {
    return randomBytes(16).toString('hex');
}
