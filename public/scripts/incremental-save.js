/**
 * Incremental Save Module for SillyTavern.
 *
 * Provides append/patch/meta operations that transfer only changed data,
 * dramatically reducing bandwidth on high-latency connections.
 *
 * Architecture (aligned with Luker's proven pattern):
 *   - Point-of-origin writes: callers invoke appendChatMessages/patchChatMessages
 *     at the exact point where a message is created or modified.
 *   - Snapshot-on-call: messages/operations are deep-cloned immediately on call,
 *     before being enqueued, preventing race conditions with streaming/swipe/plugins.
 *   - Unified write queue: all writes serialize through runSerializedChatWrite,
 *     guaranteeing strict sequential ordering.
 *
 * Design: this module has ZERO imports from script.js to avoid circular dependency.
 * Context (avatarUrl, fileName, groupId, chatMetadata) is resolved via a
 * contextResolver function injected by script.js at init time.
 *
 * Exports:
 *   - runSerializedChatWrite(task) — unified write queue
 *   - appendChatMessages(messages) → Promise<boolean>
 *   - patchChatMessages(operations) → Promise<boolean>
 *   - saveChatMetadataIncremental(metadata) → Promise<boolean>
 *   - initIncrementalSave(integrity) — seed integrity from loaded chat
 *   - setCsrfToken(token) — set CSRF token for requests
 *   - setContextResolver(resolver) — inject context resolver from script.js
 *   - isIncrementalSaveEnabled() → boolean
 *   - getIntegrity() → string
 *
 * Returns true on success; false signals the caller to fallback to full save.
 */

// No imports from script.js to avoid circular dependency.

// ─── State ──────────────────────────────────────────────────────────────────

/** @type {string} CSRF token for API requests. */
let csrfToken = '';

/** @type {string} Current integrity slug cached from last successful write or initial load. */
let currentIntegrity = '';

/** @type {Promise<any>} Unified write queue — each write waits for previous to complete. */
let chatWriteQueue = Promise.resolve();

/** @type {boolean} Feature toggle — disabled if server doesn't support incremental endpoints. */
let enabled = true;

/** @type {(() => {avatarUrl?: string, fileName?: string, groupId?: string, chatMetadata?: object}) | null} */
let contextResolver = null;

// ─── Initialization ─────────────────────────────────────────────────────────

/**
 * Set the CSRF token. Called from script.js after token is obtained.
 * @param {string} token
 */
export function setCsrfToken(token) {
    csrfToken = token || '';
}

/**
 * Inject the context resolver function. Called from script.js at init time.
 * The resolver returns the current chat target info (avatarUrl, fileName, groupId, chatMetadata).
 * @param {() => {avatarUrl?: string, fileName?: string, groupId?: string, chatMetadata?: object}} resolver
 */
export function setContextResolver(resolver) {
    contextResolver = typeof resolver === 'function' ? resolver : null;
}

/**
 * Initialize the integrity slug from chat_metadata when a chat is loaded.
 * Called once after /api/chats/get or /api/chats/group/get returns.
 * @param {string} [integrity] - The integrity slug from chat_metadata.
 */
export function initIncrementalSave(integrity) {
    currentIntegrity = typeof integrity === 'string' ? integrity.trim() : '';
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

// ─── Unified Write Queue ────────────────────────────────────────────────────

/**
 * Serialized write queue. ALL chat write operations (append, patch, metadata,
 * and full saves) should be enqueued through this function to prevent concurrent
 * writes from interleaving or racing.
 *
 * Each new task waits for the previous one to settle before executing.
 * Errors are swallowed between tasks to prevent a failed write from blocking
 * subsequent writes.
 *
 * @param {() => Promise<any>} task - Async function to execute.
 * @returns {Promise<any>}
 */
export function runSerializedChatWrite(task) {
    if (typeof task !== 'function') {
        return Promise.resolve(undefined);
    }
    const run = chatWriteQueue
        .catch(() => undefined)
        .then(() => task());
    chatWriteQueue = run.catch(() => undefined);
    return run;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Append new messages to the current chat via incremental endpoint.
 * Messages are deep-cloned immediately (snapshot-on-call) before enqueuing.
 *
 * @param {object[]} messages - Messages to append (will be cloned).
 * @returns {Promise<boolean>} True if appended successfully, false to fallback.
 */
export function appendChatMessages(messages) {
    if (!enabled || !Array.isArray(messages) || messages.length === 0) {
        return Promise.resolve(false);
    }
    // Snapshot-on-call: deep-clone before enqueuing to prevent mutation during async window
    const cloned = JSON.parse(JSON.stringify(messages));
    return runSerializedChatWrite(() => appendInternal(cloned));
}

/**
 * Patch existing messages in the current chat via incremental endpoint.
 * Operations are deep-cloned immediately (snapshot-on-call) before enqueuing.
 *
 * @param {object[]} operations - JSON Patch-style operations (will be cloned).
 * @returns {Promise<boolean>} True if patched successfully, false to fallback.
 */
export function patchChatMessages(operations) {
    if (!enabled || !Array.isArray(operations) || operations.length === 0) {
        return Promise.resolve(false);
    }
    const cloned = JSON.parse(JSON.stringify(operations));
    return runSerializedChatWrite(() => patchInternal(cloned));
}

/**
 * Patch chat metadata (deep merge) via incremental endpoint.
 * Metadata is deep-cloned immediately before enqueuing.
 *
 * @param {object} metadata - Fields to merge into chat_metadata (will be cloned).
 * @returns {Promise<boolean>} True if patched successfully, false to fallback.
 */
export function saveChatMetadataIncremental(metadata) {
    if (!enabled || !metadata || typeof metadata !== 'object') {
        return Promise.resolve(false);
    }
    const cloned = JSON.parse(JSON.stringify(metadata));
    return runSerializedChatWrite(() => metaPatchInternal(cloned));
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Build request headers (Content-Type + CSRF).
 * @returns {object}
 */
function getHeaders() {
    return {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
    };
}

/**
 * Resolve the current chat context from the injected resolver.
 * Returns null if resolver is not set or returns invalid data.
 * @returns {{avatarUrl?: string, fileName?: string, groupId?: string, chatMetadata?: object} | null}
 */
function resolveCurrentContext() {
    if (!contextResolver) return null;
    try {
        return contextResolver();
    } catch {
        return null;
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

// ─── Internal Implementation ────────────────────────────────────────────────

/**
 * @param {object[]} messages - Already-cloned messages to append.
 * @returns {Promise<boolean>}
 */
async function appendInternal(messages) {
    try {
        const context = resolveCurrentContext();
        if (!context) return false;

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
            const payload = await response.json().catch(() => ({}));
            console.warn('[IncrementalSave] append 409 conflict, current:', payload.current_integrity);
            if (payload.current_integrity) {
                currentIntegrity = payload.current_integrity;
            }
            return false;
        }

        if (response.status === 404) {
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
 * @param {object[]} operations - Already-cloned patch operations.
 * @returns {Promise<boolean>}
 */
async function patchInternal(operations) {
    try {
        const context = resolveCurrentContext();
        if (!context) return false;

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
 * @param {object} metadata - Already-cloned metadata to merge.
 * @returns {Promise<boolean>}
 */
async function metaPatchInternal(metadata) {
    try {
        const context = resolveCurrentContext();
        if (!context) return false;

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
