@echo off
REM Copyright 2026 Google LLC
REM SPDX-License-Identifier: Apache-2.0

REM
REM Script: batch-edit.bat
REM Purpose: Used by JJ View extension during `jj diffedit` to programmatically
REM          apply file modifications. It copies a list of temporary source files
REM          (the new content) into their corresponding destination paths within
REM          the "right" side of the diff.
REM Note: Exits with code 0 to signal JJ to apply the modified "right" directory
REM       as the new state of the revision.
REM

set "left=%~1"
set "right=%~2"
set "left=%left:/=\%"
set "right=%right:/=\%"
shift
shift

:loop
if "%~1"=="" goto done
set "tmp_file=%~1"
set "dest_file=%~2"

set "tmp_file=%tmp_file:/=\%"
set "dest_file=%dest_file:/=\%"

set "dest_path=%right%\%dest_file%"
for %%I in ("%dest_path%") do set "dest_dir=%%~dpI"
if not exist "%dest_dir%" mkdir "%dest_dir%"

copy "%tmp_file%" "%dest_path%" > nul

shift
shift
goto loop

:done
exit /B 0
