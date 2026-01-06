// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import parse from 'parse-diff';

export interface SelectionRange {
    startLine: number;
    endLine: number;
}

export class PatchHelper {
    /**
     * Parses a git-style diff output into a list of hunks (chunks).
     */
    static parseDiff(diffOutput: string): parse.Chunk[] {
        const files = parse(diffOutput);
        if (files.length === 0) {
            return [];
        }
        return files[0].chunks;
    }

    /**
     * Applies selected lines (additions/deletions) from a diff to the base content.
     * Use a reconstruction strategy: Rebuild the file by iterating through the Base content
     * and choosing whether to keep the Base content or switch to the New content based on selections.
     *
     * @param baseContent The content of the file at the Base revision (Original).
     * @param diffOutput The raw output from `jj diff --git`.
     * @param selections The user's selections in the Editor (0-indexed line numbers in the 'new' side).
     * @param options.inverse If true, applies changes that are NOT selected.
     */
    static applySelectedLines(
        baseContent: string,
        diffOutput: string,
        selections: readonly SelectionRange[],
        options: { inverse?: boolean } = {},
    ): string {
        const files = parse(diffOutput);
        if (files.length === 0) {
            return baseContent;
        }

        const file = files[0];
        // Split base lines using consistent newline handling
        const baseLines = baseContent.endsWith('\n')
            ? baseContent.slice(0, -1).split(/\r?\n/)
            : baseContent.split(/\r?\n/);

        const resultLines: string[] = [];
        let baseLineIdx = 0; // 0-indexed current line in Base

        for (const chunk of file.chunks) {
            // 1. Copy unchanged lines BEFORE this hunk (Context from Base)
            while (baseLineIdx < chunk.oldStart - 1) {
                if (baseLineIdx < baseLines.length) {
                    resultLines.push(baseLines[baseLineIdx++]);
                } else {
                    break;
                }
            }

            // 2. Process the Hunk
            let hunkNewLineIndex = chunk.newStart; // 1-indexed in New File

            for (let i = 0; i < chunk.changes.length; ) {
                const startChange = chunk.changes[i];

                if (startChange.type === 'normal') {
                    // Context line inside hunk. Always keep from Base.
                    resultLines.push(startChange.content.substring(1));
                    baseLineIdx++;
                    hunkNewLineIndex++;
                    i++;
                } else {
                    // Start of a Change Block
                    let j = i;
                    while (j < chunk.changes.length && chunk.changes[j].type !== 'normal') {
                        j++;
                    }
                    const block = chunk.changes.slice(i, j);
                    const adds = block.filter((c) => c.type === 'add');
                    const dels = block.filter((c) => c.type === 'del');

                    // If it's a PURE ADDITION block, treat each line individually to allow fine-grained selection.
                    if (dels.length === 0 && adds.length > 0) {
                        for (const add of adds) {
                            const changeNewLineIdx = hunkNewLineIndex;
                            const isSelected = selections.some(
                                (s) => changeNewLineIdx - 1 >= s.startLine && changeNewLineIdx - 1 <= s.endLine,
                            );
                            const shouldApply = options.inverse ? !isSelected : isSelected;

                            if (shouldApply) {
                                resultLines.push(add.content.substring(1));
                            }
                            hunkNewLineIndex++; // Advance new line index for every add
                        }
                    }
                    // If it contains deletions (Replacement or Pure Deletion), keep it ATOMIC for correctness.
                    // This aligns with "Shared Index" model where replacement parts share the same location.
                    else {
                        const blockStartIdx = hunkNewLineIndex;
                        const blockEndIdx = hunkNewLineIndex + Math.max(0, adds.length - 1);

                        const isSelected = selections.some((s) => {
                            const selStart = s.startLine + 1;
                            const selEnd = s.endLine + 1;
                            return Math.max(blockStartIdx, selStart) <= Math.min(blockEndIdx, selEnd);
                        });

                        const shouldApplyNew = options.inverse ? !isSelected : isSelected;

                        if (shouldApplyNew) {
                            // Apply NEW (Additions)
                            baseLineIdx += dels.length; // Skip Old lines
                            for (const add of adds) {
                                resultLines.push(add.content.substring(1));
                            }
                        } else {
                            // Keep OLD (Deletions' existing content)
                            for (let k = 0; k < dels.length; k++) {
                                if (baseLineIdx < baseLines.length) {
                                    resultLines.push(baseLines[baseLineIdx++]);
                                }
                            }
                        }

                        hunkNewLineIndex += adds.length;
                    }

                    i = j;
                }
            }
        }

        // 3. Copy remaining lines from Base
        while (baseLineIdx < baseLines.length) {
            resultLines.push(baseLines[baseLineIdx++]);
        }

        const res = resultLines.join('\n');
        return baseContent.endsWith('\n') ? res + '\n' : res;
    }
}
