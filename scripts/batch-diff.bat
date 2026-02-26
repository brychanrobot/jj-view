@echo off
REM Copyright 2026 Google LLC
REM SPDX-License-Identifier: Apache-2.0

REM
REM Script: batch-diff.bat
REM Purpose: Used by JJ View extension during `jj diffedit` to efficiently
REM          extract the entire file tree for a specific revision.
REM          It extracts the "left" (parent) and "right" (current) states
REM          of the commit into temporary directories for caching.
REM Note: Exits with code 1 to intentionally abort the diffedit operation
REM       without applying any changes.
REM

set left=%1
set right=%2
set outLeft=%3
set outRight=%4

xcopy "%left%" "%outLeft%" /E /H /C /I /Y > nul
xcopy "%right%" "%outRight%" /E /H /C /I /Y > nul
exit /B 1
