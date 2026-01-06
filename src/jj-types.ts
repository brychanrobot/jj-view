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

export interface JjBookmark {
    name: string;
    remote?: string;
}

export interface JjLogEntry {
    commit_id: string;
    change_id: string;
    change_id_shortest?: string;
    description: string;
    author: {
        name: string;
        email: string;
        timestamp: string;
    };
    committer: {
        name: string;
        email: string;
        timestamp: string;
    };
    parents: string[];
    bookmarks?: JjBookmark[];
    is_working_copy?: boolean;
    is_immutable?: boolean;
    is_empty?: boolean;
    parents_immutable?: boolean[];
    conflict?: boolean;
    changes?: JjStatusEntry[];
}

export interface JjStatusEntry {
    path: string;
    status: 'modified' | 'added' | 'removed' | 'renamed' | 'copied' | 'deleted'; // 'deleted' is sometimes used for removed
    additions?: number;
    deletions?: number;
    conflicted?: boolean;
}
