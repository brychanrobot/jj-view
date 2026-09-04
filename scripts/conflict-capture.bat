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

if not defined output exit /B 1

if defined base set "base=%base:/=\%"
if defined left set "left=%left:/=\%"
if defined right set "right=%right:/=\%"
if defined output set "output=%output:/=\%"

call :capture_side "%base%" "%output%\base"
if errorlevel 1 goto :fail

call :capture_side "%left%" "%output%\left"
if errorlevel 1 goto :fail

call :capture_side "%right%" "%output%\right"
if errorlevel 1 goto :fail

echo done > "%output%\.complete" 2>nul
exit /B 1

:fail
exit /B 1

:capture_side
if exist "%~1" (
    copy /B /Y "%~1" "%~2" >nul || exit /B 1
) else (
    type nul > "%~2" || exit /B 1
)
exit /B 0
