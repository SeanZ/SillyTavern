import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { patchMessages, readChatFile } from '../../src/incremental/patch.js';
import { writeIntegrity } from '../../src/incremental/integrity.js';

let tmpDir;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-test-patch-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createChatFile(chatPath, header, messages) {
    const lines = [header, ...messages].map(m => JSON.stringify(m)).join('\n');
    fs.writeFileSync(chatPath, lines, 'utf8');
}

describe('readChatFile', () => {
    test('parses JSONL into header + messages', () => {
        const chatPath = path.join(tmpDir, 'chat.jsonl');
        const header = { chat_metadata: { title: 'Test' }, user_name: 'u', character_name: 'c' };
        const messages = [
            { name: 'User', mes: 'Hi' },
            { name: 'AI', mes: 'Hello' },
        ];
        createChatFile(chatPath, header, messages);

        const result = readChatFile(chatPath);
        expect(result.header.chat_metadata.title).toBe('Test');
        expect(result.messages).toHaveLength(2);
        expect(result.messages[0].mes).toBe('Hi');
        expect(result.messages[1].mes).toBe('Hello');
    });

    test('returns null for missing file', () => {
        expect(readChatFile(path.join(tmpDir, 'nope.jsonl'))).toBeNull();
    });
});

describe('patchMessages', () => {
    const header = { chat_metadata: {}, user_name: 'unused', character_name: 'unused' };

    test('replaces a whole message', () => {
        const chatPath = path.join(tmpDir, 'replace.jsonl');
        const messages = [
            { name: 'User', mes: 'Original' },
            { name: 'AI', mes: 'Response' },
        ];
        createChatFile(chatPath, header, messages);
        writeIntegrity(chatPath, 'slug');

        const result = patchMessages({
            chatFilePath: chatPath,
            operations: [{ op: 'replace', path: '/0', value: { name: 'User', mes: 'Edited' } }],
            integrity: 'slug',
        });

        expect(result.applied).toBe(1);
        expect(result.totalMessages).toBe(2);

        const updated = readChatFile(chatPath);
        expect(updated.messages[0].mes).toBe('Edited');
        expect(updated.messages[1].mes).toBe('Response'); // unchanged
    });

    test('replaces a message field', () => {
        const chatPath = path.join(tmpDir, 'field.jsonl');
        const messages = [{ name: 'User', mes: 'Old text', extra: { note: 'keep' } }];
        createChatFile(chatPath, header, messages);
        writeIntegrity(chatPath, 'slug');

        const result = patchMessages({
            chatFilePath: chatPath,
            operations: [{ op: 'replace', path: '/0/mes', value: 'New text' }],
            integrity: 'slug',
        });

        expect(result.applied).toBe(1);
        const updated = readChatFile(chatPath);
        expect(updated.messages[0].mes).toBe('New text');
        expect(updated.messages[0].extra.note).toBe('keep'); // untouched
    });

    test('removes a message', () => {
        const chatPath = path.join(tmpDir, 'remove.jsonl');
        const messages = [
            { name: 'User', mes: 'One' },
            { name: 'AI', mes: 'Two' },
            { name: 'User', mes: 'Three' },
        ];
        createChatFile(chatPath, header, messages);
        writeIntegrity(chatPath, 'slug');

        const result = patchMessages({
            chatFilePath: chatPath,
            operations: [{ op: 'remove', path: '/1' }],
            integrity: 'slug',
        });

        expect(result.applied).toBe(1);
        expect(result.totalMessages).toBe(2);
        const updated = readChatFile(chatPath);
        expect(updated.messages[0].mes).toBe('One');
        expect(updated.messages[1].mes).toBe('Three');
    });

    test('adds a message at index', () => {
        const chatPath = path.join(tmpDir, 'add.jsonl');
        const messages = [{ name: 'User', mes: 'First' }];
        createChatFile(chatPath, header, messages);
        writeIntegrity(chatPath, 'slug');

        const newMsg = { name: 'AI', mes: 'Inserted' };
        const result = patchMessages({
            chatFilePath: chatPath,
            operations: [{ op: 'add', path: '/1', value: newMsg }],
            integrity: 'slug',
        });

        expect(result.applied).toBe(1);
        expect(result.totalMessages).toBe(2);
        const updated = readChatFile(chatPath);
        expect(updated.messages[1].mes).toBe('Inserted');
    });

    test('idempotent: replace with same value is no-op', () => {
        const chatPath = path.join(tmpDir, 'idem.jsonl');
        const messages = [{ name: 'User', mes: 'Same' }];
        createChatFile(chatPath, header, messages);
        writeIntegrity(chatPath, 'slug');

        const result = patchMessages({
            chatFilePath: chatPath,
            operations: [{ op: 'replace', path: '/0', value: { name: 'User', mes: 'Same' } }],
            integrity: 'slug',
        });

        expect(result.applied).toBe(0);
    });

    test('idempotent: add with same value at index is no-op', () => {
        const chatPath = path.join(tmpDir, 'idem-add.jsonl');
        const messages = [{ name: 'AI', mes: 'Exists' }];
        createChatFile(chatPath, header, messages);
        writeIntegrity(chatPath, 'slug');

        const result = patchMessages({
            chatFilePath: chatPath,
            operations: [{ op: 'add', path: '/0', value: { name: 'AI', mes: 'Exists' } }],
            integrity: 'slug',
        });

        expect(result.applied).toBe(0);
    });

    test('throws INTEGRITY_CONFLICT on mismatch', () => {
        const chatPath = path.join(tmpDir, 'conflict.jsonl');
        createChatFile(chatPath, header, [{ name: 'A', mes: 'B' }]);
        writeIntegrity(chatPath, 'correct-slug');

        expect(() => {
            patchMessages({
                chatFilePath: chatPath,
                operations: [{ op: 'replace', path: '/0/mes', value: 'X' }],
                integrity: 'wrong-slug',
            });
        }).toThrow();

        try {
            patchMessages({ chatFilePath: chatPath, operations: [{ op: 'replace', path: '/0/mes', value: 'X' }], integrity: 'wrong' });
        } catch (e) {
            expect(e.code).toBe('INTEGRITY_CONFLICT');
        }
    });

    test('throws CHAT_NOT_FOUND for missing file', () => {
        expect(() => {
            patchMessages({
                chatFilePath: path.join(tmpDir, 'nope.jsonl'),
                operations: [{ op: 'replace', path: '/0/mes', value: 'X' }],
            });
        }).toThrow();

        try {
            patchMessages({ chatFilePath: path.join(tmpDir, 'nope.jsonl'), operations: [{ op: 'replace', path: '/0/mes', value: 'X' }] });
        } catch (e) {
            expect(e.code).toBe('CHAT_NOT_FOUND');
        }
    });

    test('throws INVALID_PATCH for out-of-bounds index', () => {
        const chatPath = path.join(tmpDir, 'oob.jsonl');
        createChatFile(chatPath, header, [{ name: 'A', mes: 'B' }]);
        writeIntegrity(chatPath, 'slug');

        expect(() => {
            patchMessages({
                chatFilePath: chatPath,
                operations: [{ op: 'replace', path: '/99/mes', value: 'X' }],
                integrity: 'slug',
            });
        }).toThrow();
    });

    test('applies multiple operations sequentially', () => {
        const chatPath = path.join(tmpDir, 'multi.jsonl');
        const messages = [
            { name: 'User', mes: 'First' },
            { name: 'AI', mes: 'Second' },
        ];
        createChatFile(chatPath, header, messages);
        writeIntegrity(chatPath, 'slug');

        const result = patchMessages({
            chatFilePath: chatPath,
            operations: [
                { op: 'replace', path: '/0/mes', value: 'First (edited)' },
                { op: 'replace', path: '/1/mes', value: 'Second (edited)' },
            ],
            integrity: 'slug',
        });

        expect(result.applied).toBe(2);
        const updated = readChatFile(chatPath);
        expect(updated.messages[0].mes).toBe('First (edited)');
        expect(updated.messages[1].mes).toBe('Second (edited)');
    });

    test('preserves header unchanged', () => {
        const chatPath = path.join(tmpDir, 'header.jsonl');
        const myHeader = { chat_metadata: { title: 'Keep Me' }, user_name: 'u', character_name: 'c' };
        createChatFile(chatPath, myHeader, [{ name: 'A', mes: 'B' }]);
        writeIntegrity(chatPath, 'slug');

        patchMessages({
            chatFilePath: chatPath,
            operations: [{ op: 'replace', path: '/0/mes', value: 'Changed' }],
            integrity: 'slug',
        });

        const updated = readChatFile(chatPath);
        expect(updated.header.chat_metadata.title).toBe('Keep Me');
    });
});
