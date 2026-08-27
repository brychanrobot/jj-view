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

REM 1. Unquote arguments (%~1 strips quotes) passed by JJ CLI / merge-tool
set "left=%~1"
set "right=%~2"
set "outLeft=%~3"
set "outRight=%~4"

REM 2. Normalize forward slashes to Windows backslashes for xcopy and mkdir
set "left=%left:/=\%"
set "right=%right:/=\%"
set "outLeft=%outLeft:/=\%"
set "outRight=%outRight:/=\%"

REM 3. Copy left (parent) and right (current) trees into cache directories
call :copy_dir "%left%" "%outLeft%"
if errorlevel 1 goto :fail

call :copy_dir "%right%" "%outRight%"
if errorlevel 1 goto :fail

REM 4. Signal successful extraction via .complete sentinel file so _warmDiffCache
REM    can distinguish an intentional abort (exit 1) from an unexpected script failure.
echo done > "%outRight%\.complete" 2>nul
exit /B 1

REM 5. Failure exit path: skip creating .complete so _warmDiffCache knows extraction failed
:fail
exit /B 1

REM ============================================================================
REM Subroutine: :copy_dir
REM Arguments:  %1 = source directory path, %2 = destination directory path
REM Returns:    0 on success (or if source doesn't exist), non-zero on failure
REM ============================================================================
:copy_dir
set "src=%~1"
set "dest=%~2"

REM For root commits or empty diffs, the source folder may not exist on disk.
REM Treat non-existent source as a successful no-op.
if not exist "%src%\" exit /B 0

REM Ensure target directory exists before copying
if not exist "%dest%" mkdir "%dest%" || exit /B 1

REM /E = recursive (including empty), /H = hidden/system files, /C = continue on error,
REM /I = assume destination is folder, /Y = overwrite without prompt.
xcopy "%src%\*" "%dest%\" /E /H /C /I /Y > nul 2>&1
exit /B %ERRORLEVEL%




