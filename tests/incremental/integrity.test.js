import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getStateFilePath, readIntegrity, writeIntegrity, generateIntegrity, validateIntegrity } from '../../src/incremental/integrity.js';

let tmpDir;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-test-integrity-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('getStateFilePath', () => {
    test('derives sidecar path from chat JSONL path', () => {
        const chatPath = '/data/chats/char/my_chat.jsonl';
        expect(getStateFilePath(chatPath)).toBe('/data/chats/char/my_chat.state.json');
    });

    test('handles paths with dots in directory names', () => {
        const chatPath = '/data/chats/char.v2/chat.jsonl';
        expect(getStateFilePath(chatPath)).toBe('/data/chats/char.v2/chat.state.json');
    });
});

describe('generateIntegrity', () => {
    test('returns a UUID-like string', () => {
        const slug = generateIntegrity();
        expect(slug).toMatch(/^[0-9a-f-]{36}$/);
    });

    test('generates unique values', () => {
        const a = generateIntegrity();
        const b = generateIntegrity();
        expect(a).not.toBe(b);
    });
});

describe('writeIntegrity / readIntegrity', () => {
    test('round-trips integrity value', () => {
        const chatPath = path.join(tmpDir, 'test.jsonl');
        fs.writeFileSync(chatPath, '{}', 'utf8'); // dummy chat file

        writeIntegrity(chatPath, 'my-uuid-123');
        expect(readIntegrity(chatPath)).toBe('my-uuid-123');
    });

    test('returns null when sidecar does not exist', () => {
        const chatPath = path.join(tmpDir, 'nonexistent.jsonl');
        expect(readIntegrity(chatPath)).toBeNull();
    });

    test('returns null when sidecar is malformed', () => {
        const chatPath = path.join(tmpDir, 'broken.jsonl');
        const statePath = getStateFilePath(chatPath);
        fs.writeFileSync(statePath, 'not json', 'utf8');
        expect(readIntegrity(chatPath)).toBeNull();
    });

    test('overwrites previous integrity', () => {
        const chatPath = path.join(tmpDir, 'test.jsonl');
        fs.writeFileSync(chatPath, '{}', 'utf8');

        writeIntegrity(chatPath, 'first');
        writeIntegrity(chatPath, 'second');
        expect(readIntegrity(chatPath)).toBe('second');
    });
});

describe('validateIntegrity', () => {
    test('returns valid when no sidecar exists', () => {
        const chatPath = path.join(tmpDir, 'no-state.jsonl');
        const result = validateIntegrity(chatPath, 'anything', false);
        expect(result.valid).toBe(true);
    });

    test('returns valid when client slug is empty', () => {
        const chatPath = path.join(tmpDir, 'test.jsonl');
        fs.writeFileSync(chatPath, '{}', 'utf8');
        writeIntegrity(chatPath, 'server-uuid');

        expect(validateIntegrity(chatPath, '', false).valid).toBe(true);
        expect(validateIntegrity(chatPath, null, false).valid).toBe(true);
        expect(validateIntegrity(chatPath, undefined, false).valid).toBe(true);
    });

    test('returns valid when client slug matches', () => {
        const chatPath = path.join(tmpDir, 'test.jsonl');
        fs.writeFileSync(chatPath, '{}', 'utf8');
        writeIntegrity(chatPath, 'matching-uuid');

        const result = validateIntegrity(chatPath, 'matching-uuid', false);
        expect(result.valid).toBe(true);
        expect(result.current).toBe('matching-uuid');
    });

    test('returns invalid when client slug mismatches', () => {
        const chatPath = path.join(tmpDir, 'test.jsonl');
        fs.writeFileSync(chatPath, '{}', 'utf8');
        writeIntegrity(chatPath, 'server-uuid');

        const result = validateIntegrity(chatPath, 'stale-uuid', false);
        expect(result.valid).toBe(false);
        expect(result.current).toBe('server-uuid');
    });

    test('force=true always returns valid', () => {
        const chatPath = path.join(tmpDir, 'test.jsonl');
        fs.writeFileSync(chatPath, '{}', 'utf8');
        writeIntegrity(chatPath, 'server-uuid');

        const result = validateIntegrity(chatPath, 'wrong-uuid', true);
        expect(result.valid).toBe(true);
    });
});
