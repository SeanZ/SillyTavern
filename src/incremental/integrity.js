/**
 * Integrity hash management for incremental chat saves.
 *
 * Each chat file has a companion sidecar `.state.json` that stores an integrity
 * UUID rotated on every successful write. The frontend caches this value and
 * sends it with subsequent write requests; the server rejects writes that carry
 * a stale slug (409 Conflict).
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Derives the sidecar state file path from the chat JSONL path.
 * Convention: `<chatName>.state.json` in the same directory.
 * @param {string} chatFilePath Absolute path to the `.jsonl` file.
 * @returns {string}
 */
export function getStateFilePath(chatFilePath) {
    const dir = path.dirname(chatFilePath);
    const base = path.basename(chatFilePath, '.jsonl');
    return path.join(dir, `${base}.state.json`);
}

/**
 * Reads the current integrity slug from the sidecar file.
 * Returns `null` if the sidecar doesn't exist or is unreadable.
 * @param {string} chatFilePath
 * @returns {string | null}
 */
export function readIntegrity(chatFilePath) {
    const stateFile = getStateFilePath(chatFilePath);
    try {
        const raw = fs.readFileSync(stateFile, 'utf8');
        const data = JSON.parse(raw);
        return typeof data.integrity === 'string' ? data.integrity : null;
    } catch {
        return null;
    }
}

/**
 * Writes a new integrity slug (and timestamp) to the sidecar file.
 * Creates the file if it doesn't exist.
 * @param {string} chatFilePath
 * @param {string} integrity
 */
export function writeIntegrity(chatFilePath, integrity) {
    const stateFile = getStateFilePath(chatFilePath);
    const data = { integrity, updated_at: Date.now() };
    fs.writeFileSync(stateFile, JSON.stringify(data), 'utf8');
}

/**
 * Generates a new random integrity slug.
 * @returns {string}
 */
export function generateIntegrity() {
    return randomUUID();
}

/**
 * @typedef {Object} IntegrityValidation
 * @property {boolean} valid - Whether the client's slug matches.
 * @property {string} current - The server's current integrity slug (empty string if none).
 */

/**
 * Validates the client-provided integrity slug against the stored one.
 *
 * Rules:
 * - If `force` is true, always valid.
 * - If the server has no stored integrity (sidecar missing), always valid.
 * - If `clientSlug` is empty/null, always valid (first-time save).
 * - Otherwise, client slug must exactly match stored slug.
 *
 * @param {string} chatFilePath
 * @param {string | null | undefined} clientSlug
 * @param {boolean} [force=false]
 * @returns {IntegrityValidation}
 */
export function validateIntegrity(chatFilePath, clientSlug, force = false) {
    const current = readIntegrity(chatFilePath) || '';

    if (force) {
        return { valid: true, current };
    }

    const slug = (clientSlug || '').trim();

    // No stored integrity or no client slug → allow (backward-compatible)
    if (!current || !slug) {
        return { valid: true, current };
    }

    return { valid: slug === current, current };
}
