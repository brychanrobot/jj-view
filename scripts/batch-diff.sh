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

left=$1
right=$2
outLeft=$3
outRight=$4

copy_dir() {
    local src="$1"
    local dest="$2"
    
    if [ ! -d "$src" ]; then
        return
    fi
    
    mkdir -p "$dest"
    cp -R "$src/"* "$dest/" 2>/dev/null || true
    cp -R "$src/".* "$dest/" 2>/dev/null || true
}

copy_dir "$left" "$outLeft"
copy_dir "$right" "$outRight"
exit 1
