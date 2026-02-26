#!/usr/bin/env bash
# Copyright 2026 Google LLC
# SPDX-License-Identifier: Apache-2.0


#
# Script: batch-edit.sh
# Purpose: Used by JJ View extension during `jj diffedit` to programmatically
#          apply file modifications. It copies a list of temporary source files
#          (the new content) into their corresponding destination paths within
#          the "right" side of the diff.
# Note: Exits with code 0 to signal JJ to apply the modified "right" directory
#       as the new state of the revision.
#

left=$1
right=$2
shift 2

while [ "$#" -gt 0 ]; do
    tmp_file="$1"
    dest_file="$2"
    shift 2

    dest_path="$right/$dest_file"
    dest_dir=$(dirname "$dest_path")
    
    mkdir -p "$dest_dir"
    cp "$tmp_file" "$dest_path"
done
exit 0
