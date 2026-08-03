/**
 * Incremental Save Module for SillyTavern.
 *
 * Provides append/patch/meta operations that transfer only changed data,
 * dramatically reducing bandwidth on high-latency connections.
 *
 * Design: this module is self-contained. It exposes:
 *   - appendChatMessages(messages) → Promise<boolean>
 *   - patchChatMessages(operations) → Promise<boolean>
 *   - saveChatMetadataIncremental(metadata) → Promise<boolean>
 *   - initIncrementalSave(integrity) — seed integrity from loaded chat
 *   - isIncrementalSaveEnabled() → boolean
 *
 * Returns true on success; false signals the caller to fallback to full save.
 * All writes are serialized through a queue to prevent concurrent conflicts.
 *
 * References:
 *   - Luker's runSerializedChatWrite: public/script.js:12127
 *   - Luker's appendChatMessages: public/script.js:13686
 *   - Luker's patchChatMessages: public/script.js:13823
 */

import { getRequestHeaders } from './RossAscends-mods.js';

// ─── State ──────────────────────────────────────────────────────────────────

/** @type {string} Current integrity slug cached from last successful write or initial load. */
let currentIntegrity = '';

/** @type {Promise<any>} Serialized write queue — each write waits for previous to complete. */
let writeQueue = Promise.resolve();

/** @type {boolean} Feature toggle — disabled if server doesn't support incremental endpoints. */
let enabled = true;

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Initialize the integrity slug from chat_metadata when a chat is loaded.
 * Called once after /api/chats/get or /api/chats/group/get returns.
 * @param {string} [integrity] - The integrity slug from chat_metadata.
 */
export function initIncrementalSave(integrity) {
    currentIntegrity = typeof integrity === 'string' ? integrity.trim() : '';
}

/**
 * Check if incremental save is available (hasn't been disabled by server errors).
 * @returns {boolean}
 */
export function isIncrementalSaveEnabled() {
    return enabled;
}

/**
 * Get current integrity slug (for diagnostics / conflict resolution).
 * @returns {string}
 */
export function getIntegrity() {
    return currentIntegrity;
}

/**
 * Append new messages to the current chat via incremental endpoint.
 * Serialized through the write queue to prevent concurrent requests.
 *
 * @param {object[]} messages - Messages to append.
 * @param {object} context - Chat context for routing.
 * @param {string} [context.avatarUrl] - Character avatar filename (character chats).
 * @param {string} [context.fileName] - Chat file name (character chats).
 * @param {string} [context.groupId] - Group chat ID (group chats).
 * @param {object} [context.chatMetadata] - Current chat_metadata object.
 * @returns {Promise<boolean>} True if appended successfully, false to fallback.
 */
export function appendChatMessages(messages, context) {
    if (!enabled || !messages || messages.length === 0) {
        return Promise.resolve(false);
    }
    return runSerializedWrite(() => appendInternal(messages, context));
}

/**
 * Patch existing messages in the current chat via incremental endpoint.
 *
 * @param {object[]} operations - JSON Patch-style operations.
 * @param {object} context - Chat context for routing.
 * @returns {Promise<boolean>} True if patched successfully, false to fallback.
 */
export function patchChatMessages(operations, context) {
    if (!enabled || !operations || operations.length === 0) {
        return Promise.resolve(false);
    }
    return runSerializedWrite(() => patchInternal(operations, context));
}

/**
 * Patch chat metadata (deep merge) via incremental endpoint.
 *
 * @param {object} metadata - Fields to merge into chat_metadata.
 * @param {object} context - Chat context for routing.
 * @returns {Promise<boolean>} True if patched successfully, false to fallback.
 */
export function saveChatMetadataIncremental(metadata, context) {
    if (!enabled || !metadata || typeof metadata !== 'object') {
        return Promise.resolve(false);
    }
    return runSerializedWrite(() => metaPatchInternal(metadata, context));
}

// ─── Internal Implementation ────────────────────────────────────────────────

/**
 * Serialized write queue (same pattern as Luker's runSerializedChatWrite).
 * Ensures only one write request is in-flight at a time for the current chat.
 * @param {() => Promise<boolean>} task
 * @returns {Promise<boolean>}
 */
function runSerializedWrite(task) {
    const run = writeQueue
        .catch(() => undefined)
        .then(() => task());
    writeQueue = run.catch(() => undefined);
    return run;
}

/**
 * @param {object[]} messages
 * @param {object} context
 * @returns {Promise<boolean>}
 */
async function appendInternal(messages, context) {
    try {
        const isGroup = Boolean(context.groupId);
        const url = isGroup ? '/api/chats/group/append' : '/api/chats/append';

        const body = isGroup
            ? {
                id: context.groupId,
                messages,
                chat_metadata: context.chatMetadata || {},
                integrity: currentIntegrity,
            }
            : {
                avatar_url: context.avatarUrl,
                file_name: context.fileName,
                messages,
                chat_metadata: context.chatMetadata || {},
                integrity: currentIntegrity,
            };

        const response = await fetch(url, {
            method: 'POST',
            cache: 'no-cache',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
        });

        if (response.ok) {
            const payload = await response.json().catch(() => ({}));
            applyIntegrity(payload.integrity);
            console.debug('[IncrementalSave] append ok:', {
                appended: payload.appended,
                skipped: payload.skipped,
                integrity: payload.integrity,
            });
            return true;
        }

        if (response.status === 409) {
            // Integrity conflict — caller should fallback to full save.
            const payload = await response.json().catch(() => ({}));
            console.warn('[IncrementalSave] append 409 conflict, current:', payload.current_integrity);
            // Update our integrity to what the server has, so next attempt aligns.
            if (payload.current_integrity) {
                currentIntegrity = payload.current_integrity;
            }
            return false;
        }

        if (response.status === 404) {
            // Endpoint not available — disable incremental save.
            console.warn('[IncrementalSave] append endpoint not found, disabling.');
            enabled = false;
            return false;
        }

        console.warn('[IncrementalSave] append failed:', response.status);
        return false;
    } catch (error) {
        console.warn('[IncrementalSave] append error:', error);
        return false;
    }
}

/**
 * @param {object[]} operations
 * @param {object} context
 * @returns {Promise<boolean>}
 */
async function patchInternal(operations, context) {
    try {
        const isGroup = Boolean(context.groupId);
        const url = isGroup ? '/api/chats/group/patch' : '/api/chats/patch';

        const body = isGroup
            ? {
                id: context.groupId,
                operations,
                integrity: currentIntegrity,
            }
            : {
                avatar_url: context.avatarUrl,
                file_name: context.fileName,
                operations,
                integrity: currentIntegrity,
            };

        const response = await fetch(url, {
            method: 'POST',
            cache: 'no-cache',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
        });

        if (response.ok) {
            const payload = await response.json().catch(() => ({}));
            applyIntegrity(payload.integrity);
            console.debug('[IncrementalSave] patch ok:', {
                applied: payload.applied,
                total_messages: payload.total_messages,
                integrity: payload.integrity,
            });
            return true;
        }

        if (response.status === 409) {
            const payload = await response.json().catch(() => ({}));
            console.warn('[IncrementalSave] patch 409 conflict');
            if (payload.current_integrity) {
                currentIntegrity = payload.current_integrity;
            }
            return false;
        }

        if (response.status === 404) {
            console.warn('[IncrementalSave] patch endpoint not found, disabling.');
            enabled = false;
            return false;
        }

        console.warn('[IncrementalSave] patch failed:', response.status);
        return false;
    } catch (error) {
        console.warn('[IncrementalSave] patch error:', error);
        return false;
    }
}

/**
 * @param {object} metadata
 * @param {object} context
 * @returns {Promise<boolean>}
 */
async function metaPatchInternal(metadata, context) {
    try {
        const isGroup = Boolean(context.groupId);
        const url = isGroup ? '/api/chats/group/meta/patch' : '/api/chats/meta/patch';

        const body = isGroup
            ? {
                id: context.groupId,
                chat_metadata: metadata,
                integrity: currentIntegrity,
            }
            : {
                avatar_url: context.avatarUrl,
                file_name: context.fileName,
                chat_metadata: metadata,
                integrity: currentIntegrity,
            };

        const response = await fetch(url, {
            method: 'POST',
            cache: 'no-cache',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
        });

        if (response.ok) {
            const payload = await response.json().catch(() => ({}));
            applyIntegrity(payload.integrity);
            console.debug('[IncrementalSave] meta/patch ok:', { integrity: payload.integrity });
            return true;
        }

        if (response.status === 409) {
            const payload = await response.json().catch(() => ({}));
            console.warn('[IncrementalSave] meta/patch 409 conflict');
            if (payload.current_integrity) {
                currentIntegrity = payload.current_integrity;
            }
            return false;
        }

        if (response.status === 404) {
            console.warn('[IncrementalSave] meta/patch endpoint not found, disabling.');
            enabled = false;
            return false;
        }

        console.warn('[IncrementalSave] meta/patch failed:', response.status);
        return false;
    } catch (error) {
        console.warn('[IncrementalSave] meta/patch error:', error);
        return false;
    }
}

/**
 * Apply the new integrity slug returned from a successful write.
 * @param {string} [integrity]
 */
function applyIntegrity(integrity) {
    if (typeof integrity === 'string' && integrity.trim()) {
        currentIntegrity = integrity.trim();
    }
}
