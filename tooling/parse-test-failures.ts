/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

interface Attachment {
    name: string;
    contentType: string;
    path?: string;
}

interface TestResult {
    status: string;
    duration: number;
    errors: Array<{ message: string }>;
    attachments: Attachment[];
}

interface TestCase {
    title: string;
    results: TestResult[];
}

interface TestSuite {
    fileName: string;
    tests: TestCase[];
    suites?: TestSuite[];
}

function parseZipEntries(zipBuffer: Buffer): Map<string, Buffer> {
    const entries = new Map<string, Buffer>();
    let offset = 0;

    while (offset < zipBuffer.length - 30) {
        // Local file header signature 0x04034b50 ("PK\x03\x04")
        if (zipBuffer.readUInt32LE(offset) !== 0x04034b50) {
            break;
        }

        const compression = zipBuffer.readUInt16LE(offset + 8);
        const compressedSize = zipBuffer.readUInt32LE(offset + 18);
        const fileNameLen = zipBuffer.readUInt16LE(offset + 26);
        const extraLen = zipBuffer.readUInt16LE(offset + 28);

        const fileName = zipBuffer.toString('utf-8', offset + 30, offset + 30 + fileNameLen);
        const dataStart = offset + 30 + fileNameLen + extraLen;
        const compressedData = zipBuffer.subarray(dataStart, dataStart + compressedSize);

        let fileData: Buffer;
        if (compression === 0) {
            fileData = compressedData;
        } else if (compression === 8) {
            fileData = zlib.inflateRawSync(compressedData);
        } else {
            fileData = Buffer.alloc(0);
        }

        entries.set(fileName, fileData);
        offset = dataStart + compressedSize;
    }

    return entries;
}

export function findFailedTestArtifacts() {
    const rootDir = process.cwd();
    const reportHtmlPath = path.join(rootDir, 'playwright-report', 'index.html');
    const testResultsDir = path.join(rootDir, 'test-results');

    console.log('=== Playwright Test Failure Artifact Finder ===\n');

    let foundFailures = 0;

    // 1. Try parsing playwright-report/index.html zip payload
    if (fs.existsSync(reportHtmlPath)) {
        const htmlContent = fs.readFileSync(reportHtmlPath, 'utf-8');
        const match = htmlContent.match(/(UEsDB[A-Za-z0-9+/=\s]+)/);

        if (match) {
            const b64Data = match[1].replace(/\s+/g, '');
            const zipBuffer = Buffer.from(b64Data, 'base64');
            const entries = parseZipEntries(zipBuffer);

            for (const [filename, content] of entries) {
                if (filename.endsWith('.json') && filename !== 'report.json') {
                    try {
                        const suiteData: TestSuite = JSON.parse(content.toString('utf-8'));
                        const processSuite = (suite: TestSuite) => {
                            const specFile = suite.fileName || filename;
                            for (const test of suite.tests || []) {
                                for (const result of test.results || []) {
                                    if (result.status !== 'passed' && result.status !== 'skipped') {
                                        foundFailures++;
                                        console.log(`\n❌ [FAILURE #${foundFailures}]`);
                                        console.log(`   Spec File: ${specFile}`);
                                        console.log(`   Test Title: ${test.title}`);
                                        if (result.errors && result.errors.length > 0) {
                                            const firstErr = result.errors[0].message.split('\n')[0];
                                            console.log(`   Error Message: ${firstErr}`);
                                        }

                                        console.log('   Artifacts:');
                                        for (const att of result.attachments || []) {
                                            if (att.path) {
                                                const absPath = path.resolve(rootDir, 'playwright-report', att.path);
                                                console.log(`     - [${att.name}] file://${absPath}`);
                                            }
                                        }
                                    }
                                }
                            }
                            for (const childSuite of suite.suites || []) {
                                processSuite(childSuite);
                            }
                        };
                        processSuite(suiteData);
                    } catch {
                        // ignore malformed JSON entry
                    }
                }
            }
        }
    }

    // 2. Also scan test-results directory directly for disk artifacts
    if (fs.existsSync(testResultsDir)) {
        const artifactFiles: string[] = [];
        const scanDir = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    scanDir(fullPath);
                } else if (entry.name === 'test-failure.png' || entry.name === 'test-failure.html') {
                    artifactFiles.push(fullPath);
                }
            }
        };
        scanDir(testResultsDir);

        if (artifactFiles.length > 0) {
            console.log(`\n=== Found ${artifactFiles.length} Artifact Files in test-results/ ===`);
            for (const file of artifactFiles) {
                console.log(`   file://${file}`);
            }
        }
    }

    if (foundFailures === 0) {
        console.log('No test failures found in the most recent report.');
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    findFailedTestArtifacts();
}
