#!/bin/sh
# Copyright 2026 Google LLC
# SPDX-License-Identifier: Apache-2.0


#
# Script: conflict-capture.sh
# Purpose: Used by JJ View extension during `jj resolve` to extract 
#          the base, left, and right sides of a merge conflict.
#          It copies these files into a temporary directory so VS Code
#          can open them in the 3-way merge editor.
# Note: Exits with code 1 to intentionally signal to JJ that the merge 
#       is not yet resolved, preventing auto-commit.
#

base=$1
left=$2
right=$3
output=$4

if [ -z "${output}" ]; then
    exit 1
fi

capture_side() {
    src=$1
    dest=$2
    if [ -f "${src}" ]; then
        cp -- "${src}" "${dest}" || return 1
    else
        touch "${dest}" || return 1
    fi
}

if capture_side "${base}" "${output}/base" && \
   capture_side "${left}" "${output}/left" && \
   capture_side "${right}" "${output}/right"; then
    touch "${output}/.complete"
fi

exit 1
