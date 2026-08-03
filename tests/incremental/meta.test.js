import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { patchMetadata } from '../../src/incremental/meta.js';
import { writeIntegrity, readIntegrity } from '../../src/incremental/integrity.js';

let tmpDir;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-test-meta-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createChatFile(chatPath, header, messages) {
    const lines = [header, ...messages].map(m => JSON.stringify(m)).join('\n');
    fs.writeFileSync(chatPath, lines, 'utf8');
}

function readHeader(chatPath) {
    const content = fs.readFileSync(chatPath, 'utf8');
    const firstLine = content.split('\n')[0];
    return JSON.parse(firstLine);
}

function readAllLines(chatPath) {
    const content = fs.readFileSync(chatPath, 'utf8');
    return content.split('\n').filter(l => l.trim());
}

describe('patchMetadata', () => {
    const baseHeader = { chat_metadata: { title: 'Original', tags: ['a'] }, user_name: 'unused', character_name: 'unused' };

    test('deep merges metadata into header', () => {
        const chatPath = path.join(tmpDir, 'meta.jsonl');
        const messages = [{ name: 'User', mes: 'Hi' }];
        createChatFile(chatPath, baseHeader, messages);
        writeIntegrity(chatPath, 'slug');

        const result = patchMetadata({
            chatFilePath: chatPath,
            metadata: { title: 'Updated', newField: 42 },
            integrity: 'slug',
        });

        expect(result.integrity).toBeTruthy();
        const header = readHeader(chatPath);
        expect(header.chat_metadata.title).toBe('Updated');
        expect(header.chat_metadata.newField).toBe(42);
        expect(header.chat_metadata.tags).toEqual(['a']); // preserved
    });

    test('does not modify message lines', () => {
        const chatPath = path.join(tmpDir, 'preserve.jsonl');
        const messages = [
            { name: 'User', mes: 'One' },
            { name: 'AI', mes: 'Two' },
        ];
        createChatFile(chatPath, baseHeader, messages);
        writeIntegrity(chatPath, 'slug');

        patchMetadata({
            chatFilePath: chatPath,
            metadata: { title: 'Changed' },
            integrity: 'slug',
        });

        const lines = readAllLines(chatPath);
        expect(lines.length).toBe(3); // header + 2 messages
        expect(JSON.parse(lines[1]).mes).toBe('One');
        expect(JSON.parse(lines[2]).mes).toBe('Two');
    });

    test('merges nested objects', () => {
        const chatPath = path.join(tmpDir, 'nested.jsonl');
        const header = { chat_metadata: { settings: { a: 1, b: 2 } }, user_name: 'u', character_name: 'c' };
        createChatFile(chatPath, header, []);
        writeIntegrity(chatPath, 'slug');

        patchMetadata({
            chatFilePath: chatPath,
            metadata: { settings: { b: 99, c: 3 } },
            integrity: 'slug',
        });

        const updated = readHeader(chatPath);
        expect(updated.chat_metadata.settings).toEqual({ a: 1, b: 99, c: 3 });
    });

    test('rotates integrity after successful patch', () => {
        const chatPath = path.join(tmpDir, 'rotate.jsonl');
        createChatFile(chatPath, baseHeader, []);
        writeIntegrity(chatPath, 'old-slug');

        const result = patchMetadata({
            chatFilePath: chatPath,
            metadata: { x: 1 },
            integrity: 'old-slug',
        });

        expect(result.integrity).not.toBe('old-slug');
        expect(readIntegrity(chatPath)).toBe(result.integrity);
    });

    test('throws INTEGRITY_CONFLICT on mismatch', () => {
        const chatPath = path.join(tmpDir, 'conflict.jsonl');
        createChatFile(chatPath, baseHeader, []);
        writeIntegrity(chatPath, 'correct');

        expect(() => {
            patchMetadata({
                chatFilePath: chatPath,
                metadata: { x: 1 },
                integrity: 'wrong',
            });
        }).toThrow();

        try {
            patchMetadata({ chatFilePath: chatPath, metadata: { x: 1 }, integrity: 'wrong' });
        } catch (e) {
            expect(e.code).toBe('INTEGRITY_CONFLICT');
        }
    });

    test('throws CHAT_NOT_FOUND for missing file', () => {
        expect(() => {
            patchMetadata({
                chatFilePath: path.join(tmpDir, 'ghost.jsonl'),
                metadata: { x: 1 },
            });
        }).toThrow();

        try {
            patchMetadata({ chatFilePath: path.join(tmpDir, 'ghost.jsonl'), metadata: { x: 1 } });
        } catch (e) {
            expect(e.code).toBe('CHAT_NOT_FOUND');
        }
    });

    test('works when chat_metadata is initially empty', () => {
        const chatPath = path.join(tmpDir, 'empty-meta.jsonl');
        const header = { user_name: 'u', character_name: 'c' };
        createChatFile(chatPath, header, []);
        writeIntegrity(chatPath, 'slug');

        patchMetadata({
            chatFilePath: chatPath,
            metadata: { title: 'New' },
            integrity: 'slug',
        });

        const updated = readHeader(chatPath);
        expect(updated.chat_metadata.title).toBe('New');
    });
});
