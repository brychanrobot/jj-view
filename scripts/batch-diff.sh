#!/usr/bin/env bash
# Copyright 2026 Google LLC
# SPDX-License-Identifier: Apache-2.0

#
# Script: batch-diff.sh
# Purpose: Used by JJ View extension during `jj diffedit` to efficiently
#          extract the entire file tree for a specific revision.
#          It extracts the "left" (parent) and "right" (current) states
#          of the commit into temporary directories for caching.
# Note: Exits with code 1 to intentionally abort the diffedit operation
#       without applying any changes.
#

# Positional arguments passed by JJ merge-tool configuration
left=$1
right=$2
outLeft=$3
outRight=$4

# Helper function to safely copy directory contents.
# Note: Uses "$src/." to copy all contents (including hidden files) without
# matching "." and ".." which would recursively copy parent directories.
copy_dir() {
    local src="$1"
    local dest="$2"
    
    # Non-existent source (e.g. root commit left side) is a successful no-op
    if [ ! -d "$src" ]; then
        return 0
    fi
    
    mkdir -p "$dest" || return 1
    cp -R "$src/." "$dest/" || return 1
}

# Copy left (parent) and right (current) trees into cache directories.
# Only create the .complete marker if all copies succeed without error.
if copy_dir "$left" "$outLeft" && copy_dir "$right" "$outRight"; then
    touch "$outRight/.complete"
fi

# Exit 1 intentionally to abort the diffedit operation without applying changes
exit 1



