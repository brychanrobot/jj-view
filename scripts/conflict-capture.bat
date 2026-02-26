@echo off
REM Copyright 2026 Google LLC
REM SPDX-License-Identifier: Apache-2.0

REM
REM Script: conflict-capture.bat
REM Purpose: Used by JJ View extension during `jj resolve` to extract 
REM          the base, left, and right sides of a merge conflict.
REM          It copies these files into a temporary directory so VS Code
REM          can open them in the 3-way merge editor.
REM Note: Exits with code 1 to intentionally signal to JJ that the merge 
REM       is not yet resolved, preventing auto-commit.
REM

set "base=%~1"
set "left=%~2"
set "right=%~3"
set "output=%~4"

set "base=%base:/=\%"
set "left=%left:/=\%"
set "right=%right:/=\%"
set "output=%output:/=\%"

copy "%base%" "%output%\base"
copy "%left%" "%output%\left"
copy "%right%" "%output%\right"
exit /B 1
