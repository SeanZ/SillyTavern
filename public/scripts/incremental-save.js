/**
 * Incremental Save Module for SillyTavern.
 *
 * Provides append/patch/meta operations that transfer only changed data,
 * dramatically reducing bandwidth on high-latency connections.
 *
 * Design: this module is self-contained with ZERO imports from script.js
 * to avoid circular dependency (script.js imports us, we can't import it back).
 * The CSRF token is passed in via setCsrfToken() during initialization.
 *
 * Exports:
 *   - appendChatMessages(messages) → Promise<boolean>
 *   - patchChatMessages(operations) → Promise<boolean>
 *   - saveChatMetadataIncremental(metadata) → Promise<boolean>
 *   - initIncrementalSave(integrity, chatLength) — seed from loaded chat
 *   - tryIncrementalSave(context) — intelligent routing
 *   - markMessageEdited(index) — track edits for patch routing
 *   - setCsrfToken(token) — set CSRF token for requests
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

// No imports from script.js to avoid circular dependency.
// CSRF token is injected via setCsrfToken().

// ─── State ──────────────────────────────────────────────────────────────────

/** @type {string} CSRF token for API requests. */
let csrfToken = '';

/** @type {string} Current integrity slug cached from last successful write or initial load. */
let currentIntegrity = '';

/** @type {Promise<any>} Serialized write queue — each write waits for previous to complete. */
let writeQueue = Promise.resolve();

/** @type {boolean} Feature toggle — disabled if server doesn't support incremental endpoints. */
let enabled = true;

/**
 * Build request headers (Content-Type + CSRF). Self-contained, no external imports.
 * @returns {object}
 */
function getHeaders() {
    return {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
    };
}

/**
 * Set the CSRF token. Called from script.js after token is obtained.
 * @param {string} token
 */
export function setCsrfToken(token) {
    csrfToken = token || '';
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Initialize the integrity slug from chat_metadata when a chat is loaded.
 * Called once after /api/chats/get or /api/chats/group/get returns.
 * @param {string} [integrity] - The integrity slug from chat_metadata.
 * @param {number} [chatLength=0] - Current chat.length at load time.
 */
export function initIncrementalSave(integrity, chatLength = 0) {
    currentIntegrity = typeof integrity === 'string' ? integrity.trim() : '';
    lastSavedChatLength = chatLength;
    enabled = true; // Re-enable on chat switch (may have been disabled by 404)
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
            headers: getHeaders(),
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
            headers: getHeaders(),
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
            headers: getHeaders(),
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

// ─── Intelligent Save Routing ───────────────────────────────────────────────

/** @type {number} Chat length after last successful save (used to detect appends). */
let lastSavedChatLength = 0;

/**
 * Notify the module that a full save completed successfully (from the legacy path).
 * This keeps lastSavedChatLength in sync even when incremental save isn't used.
 * @param {number} chatLength - Current chat.length after save.
 * @param {string} [integrity] - Integrity slug if returned by the server.
 */
export function notifyFullSaveCompleted(chatLength, integrity) {
    lastSavedChatLength = chatLength;
    if (integrity) applyIntegrity(integrity);
}

/**
 * Try to perform an incremental save based on what changed.
 * Called from saveChatConditional() before the full-save fallback.
 *
 * Detection logic:
 * - chat.length > lastSavedChatLength → messages were appended → use /append
 * - chat.length < lastSavedChatLength → messages were deleted → use /patch (remove)
 * - chat.length === lastSavedChatLength → message edited or metadata changed → full save
 *   (field-level diff detection is too complex for Phase 1; leave for Phase 2)
 *
 * @param {object} params
 * @param {object[]} params.chat - The current chat array.
 * @param {object} params.chatMetadata - Current chat_metadata.
 * @param {string} [params.avatarUrl] - Character avatar (for character chats).
 * @param {string} [params.fileName] - Chat file name (for character chats).
 * @param {string} [params.groupId] - Group chat ID (for group chats).
 * @returns {Promise<boolean>} True if incremental save succeeded; false to fall through.
 */
export async function tryIncrementalSave({ chat, chatMetadata, avatarUrl, fileName, groupId }) {
    if (!enabled) return false;
    if (!chat || !Array.isArray(chat)) return false;

    const currentLength = chat.length;
    const context = { avatarUrl, fileName, groupId, chatMetadata };

    // Case 1: Messages were appended (most common — AI reply or user send)
    if (currentLength > lastSavedChatLength && lastSavedChatLength > 0) {
        const newMessages = chat.slice(lastSavedChatLength);
        const ok = await appendChatMessages(newMessages, context);
        if (ok) {
            lastSavedChatLength = currentLength;
            return true;
        }
        return false;
    }

    // Case 2: Messages were deleted
    if (currentLength < lastSavedChatLength && lastSavedChatLength > 0) {
        // Deletion is complex to express as patch ops without knowing which
        // messages were removed. Fall through to full save for now.
        // After full save completes, lastSavedChatLength will be updated.
        pendingEditedIndices.clear();
        return false;
    }

    // Case 3: Same length — check if we have tracked edits
    if (currentLength === lastSavedChatLength && pendingEditedIndices.size > 0) {
        // Build patch operations for each edited message
        const operations = [];
        for (const index of pendingEditedIndices) {
            if (index >= 0 && index < chat.length) {
                operations.push({ op: 'replace', path: `/${index}`, value: chat[index] });
            }
        }

        if (operations.length > 0) {
            const ok = await patchChatMessages(operations, context);
            if (ok) {
                pendingEditedIndices.clear();
                return true;
            }
        }
        // Patch failed — fall through to full save
        pendingEditedIndices.clear();
        return false;
    }

    // Case 4: Same length, no tracked edits — could be metadata-only or
    // untracked change. Fall through to full save.
    pendingEditedIndices.clear();
    return false;
}

/**
 * Reset tracking state (called when switching chats).
 * @param {number} [chatLength=0]
 */
export function resetIncrementalState(chatLength = 0) {
    lastSavedChatLength = chatLength;
    pendingEditedIndices.clear();
}

// ─── Message Edit Tracking ───────────────────────────────────────────────

/** @type {Set<number>} Indices of messages modified since last save. */
const pendingEditedIndices = new Set();

/**
 * Mark a message as edited. Called by edit flows before saveChatDebounced().
 * When tryIncrementalSave detects same-length (no append/delete), it will
 * send patch operations for these indices instead of a full save.
 *
 * @param {number} index - The message index in chat[] that was edited.
 */
export function markMessageEdited(index) {
    if (typeof index === 'number' && index >= 0) {
        pendingEditedIndices.add(index);
    }
}
