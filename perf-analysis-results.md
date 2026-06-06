## E2E Performance Statistical Analysis Report

Generated on: 2026-06-20T23:55:47.907Z

### Normalized Helpers (Spend sorted by Total Time)

| Metric | Count | Total Time (ms) | Avg (ms) | Median (ms) | P90 (ms) | Min (ms) | Max (ms) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `cleanupAfterTest: total` | 96 | 56475 | 588.3 | 163 | 324 | 76 | 10016 |
| `cleanupAfterTest: main cleanup` | 96 | 56385 | 587.3 | 163 | 324 | 76 | 10015 |
| `openWorkspace: total` | 94 | 54868 | 583.7 | 559 | 793 | 212 | 2569 |
| `openWorkspace: repository sync evaluate` | 93 | 31424 | 337.9 | 300 | 492 | 148 | 2135 |
| `VSCodeWorker.init() finished` | 5 | 27777 | 5555.4 | 6056 | 6447 | 3622 | 6447 |
| `openWorkspace: worker.getContext` | 96 | 18904 | 196.9 | 172 | 289 | 48 | 702 |
| `getContext (reused)` | 96 | 18880 | 196.7 | 172 | 288 | 48 | 701 |
| `launchNewVSCode: total` | 5 | 18497 | 3699.4 | 3701 | 4193 | 3027 | 4193 |
| `launchNewVSCode: monaco-workbench visibility` | 5 | 11127 | 2225.4 | 2215 | 2399 | 2025 | 2399 |
| `getDetailsWebview` | 20 | 10785 | 539.3 | 524 | 823 | 303 | 1013 |
| `awaitIpcReady` | 5 | 9271 | 1854.2 | 1861 | 2562 | 595 | 2562 |
| `reuseContext scanForRepositories` | 96 | 6500 | 67.7 | 65 | 93 | 10 | 175 |
| `pickQuickPickItem` | 13 | 5968 | 459.1 | 310 | 1009 | 44 | 1013 |
| `waitForLogCommitRow` | 68 | 5400 | 79.4 | 38 | 130 | 13 | 800 |
| `openWorkspace: dismiss UI` | 96 | 4684 | 48.8 | 35 | 95 | 8 | 226 |
| `launchNewVSCode: electron launch wrapper` | 5 | 3826 | 765.2 | 788 | 877 | 616 | 877 |
| `getLogWebview` | 96 | 3540 | 36.9 | 26 | 62 | 8 | 279 |
| `focusJJLog` | 75 | 3478 | 46.4 | 13 | 99 | 2 | 607 |
| `focusSCM` | 41 | 3419 | 83.4 | 68 | 111 | 38 | 270 |
| `hoverAndClick` | 26 | 2848 | 109.5 | 107 | 155 | 57 | 309 |
| `setScmDescription` | 8 | 2648 | 331.0 | 308 | 660 | 165 | 660 |
| `reuseContext updateSettings` | 96 | 2455 | 25.6 | 10 | 69 | 3 | 290 |
| `launchNewVSCode: electron.launch` | 5 | 2433 | 486.6 | 479 | 571 | 419 | 571 |
| `updateSettings: sendEvaluation` | 96 | 2430 | 25.3 | 10 | 68 | 3 | 290 |
| `waitForTab` | 26 | 2236 | 86.0 | 24 | 283 | 5 | 314 |
| `ensureViewVisible` | 6 | 2083 | 347.2 | 360 | 607 | 142 | 607 |
| `clickScmAction` | 18 | 2041 | 113.4 | 95 | 182 | 61 | 317 |
| `clickNotificationButton` | 3 | 2035 | 678.3 | 646 | 932 | 457 | 932 |
| `rightClickAndSelect New After` | 2 | 1903 | 951.5 | 1425 | 1425 | 478 | 1425 |
| `rightClickAndSelect New Before` | 2 | 1885 | 942.5 | 1355 | 1355 | 530 | 1355 |
| `rightClickAndSelect Abandon` | 2 | 1376 | 688.0 | 759 | 759 | 617 | 759 |
| `launchNewVSCode: app.firstWindow` | 5 | 1364 | 272.8 | 287 | 395 | 186 | 395 |
| `openScmItem` | 7 | 1349 | 192.7 | 173 | 293 | 142 | 293 |
| `openQuickInputWithShortcut` | 4 | 1277 | 319.3 | 449 | 458 | 163 | 458 |
| `expectSettingsOpen` | 4 | 1228 | 307.0 | 411 | 436 | 6 | 436 |
| `rightClickAndSelect Rebase onto Selected` | 1 | 1222 | 1222.0 | 1222 | 1222 | 1222 | 1222 |
| `selectCommits` | 5 | 1220 | 244.0 | 187 | 412 | 120 | 412 |
| `expectTree` | 17 | 1202 | 70.7 | 64 | 146 | 18 | 151 |
| `clickLogAction` | 5 | 1153 | 230.6 | 233 | 377 | 139 | 377 |
| `rightClickAndSelect Absorb` | 1 | 1032 | 1032.0 | 1032 | 1032 | 1032 | 1032 |
| `openFileInEditor` | 8 | 1019 | 127.4 | 115 | 183 | 92 | 183 |
| `rightClickAndSelect Compare All Files with Revision...` | 1 | 980 | 980.0 | 980 | 980 | 980 | 980 |
| `openScmDiff` | 5 | 868 | 173.6 | 169 | 217 | 142 | 217 |
| `rightClickAndSelect Upload` | 2 | 829 | 414.5 | 418 | 418 | 411 | 418 |
| `triggerRefresh` | 4 | 676 | 169.0 | 199 | 204 | 133 | 204 |
| `clickContextMenuItem` | 2 | 634 | 317.0 | 321 | 321 | 313 | 321 |
| `rightClickAndSelect New Merge Change` | 1 | 605 | 605.0 | 605 | 605 | 605 | 605 |
| `waitForLogPill` | 8 | 543 | 67.9 | 38 | 161 | 18 | 161 |
| `rightClickAndSelect Delete Bookmark` | 1 | 518 | 518.0 | 518 | 518 | 518 | 518 |
| `rightClickAndSelect Edit` | 1 | 516 | 516.0 | 516 | 516 | 516 | 516 |
| `rightClickAndSelect Show Multi-File Diff` | 1 | 483 | 483.0 | 483 | 483 | 483 | 483 |
| `launchNewVSCode: downloadAndUnzipVSCode` | 5 | 476 | 95.2 | 93 | 133 | 69 | 133 |
| `waitForQuickInput` | 8 | 467 | 58.4 | 41 | 122 | 6 | 122 |
| `expectModifiedFiles` | 4 | 443 | 110.8 | 124 | 197 | 27 | 197 |
| `rightClickAndSelect Forget Workspace` | 1 | 429 | 429.0 | 429 | 429 | 429 | 429 |
| `rightClickAndSelect Delete Workspace Directory` | 1 | 421 | 421.0 | 421 | 421 | 421 | 421 |
| `reuseContext updateWorkspaceFolders` | 96 | 413 | 4.3 | 2 | 9 | 1 | 25 |
| `rightClickAndSelect Set Bookmark` | 1 | 382 | 382.0 | 382 | 382 | 382 | 382 |
| `updateWorkspaceFolders: evaluate` | 96 | 374 | 3.9 | 2 | 8 | 1 | 25 |
| `rightClickAndSelect Duplicate` | 1 | 372 | 372.0 | 372 | 372 | 372 | 372 |
| `clearActiveEditor` | 4 | 306 | 76.5 | 89 | 107 | 41 | 107 |
| `openScmMerge` | 1 | 293 | 293.0 | 293 | 293 | 293 | 293 |
| `pressScmShortcut` | 8 | 286 | 35.8 | 37 | 61 | 5 | 61 |
| `expectNotificationToast` | 5 | 275 | 55.0 | 51 | 107 | 4 | 107 |
| `selectLine` | 2 | 237 | 118.5 | 121 | 121 | 116 | 121 |
| `openScmFile` | 1 | 189 | 189.0 | 189 | 189 | 189 | 189 |
| `expectBadgeLink` | 11 | 185 | 16.8 | 15 | 25 | 7 | 36 |
| `getScmItemLocator` | 8 | 101 | 12.6 | 16 | 34 | 0 | 34 |
| `clickLogTitleButton` | 1 | 71 | 71.0 | 71 | 71 | 71 | 71 |
| `undo` | 2 | 64 | 32.0 | 33 | 33 | 31 | 33 |
| `launchNewVSCode: writeConfigs` | 5 | 59 | 11.8 | 11 | 17 | 9 | 17 |
| `expectScmDescription` | 2 | 58 | 29.0 | 53 | 53 | 5 | 53 |
| `reuseContext updateEnvironment` | 96 | 49 | 0.5 | 0 | 2 | 0 | 7 |
| `save` | 1 | 38 | 38.0 | 38 | 38 | 38 | 38 |
| `cleanupAfterTest: close auxiliary windows` | 96 | 29 | 0.3 | 0 | 0 | 0 | 28 |
| `expectFileInScmGroup` | 1 | 20 | 20.0 | 20 | 20 | 20 | 20 |
| `redo` | 1 | 18 | 18.0 | 18 | 18 | 18 | 18 |

### Top 40 Detailed Helper Calls (Sorted by Total Time)

| Metric | Count | Total Time (ms) | Avg (ms) | Median (ms) | P90 (ms) | Min (ms) | Max (ms) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `cleanupAfterTest: total` | 96 | 56475 | 588.3 | 163 | 324 | 76 | 10016 |
| `cleanupAfterTest: main cleanup` | 96 | 56385 | 587.3 | 163 | 324 | 76 | 10015 |
| `openWorkspace: total` | 94 | 54868 | 583.7 | 559 | 793 | 212 | 2569 |
| `openWorkspace: repository sync evaluate` | 93 | 31424 | 337.9 | 300 | 492 | 148 | 2135 |
| `VSCodeWorker.init() finished` | 5 | 27777 | 5555.4 | 6056 | 6447 | 3622 | 6447 |
| `openWorkspace: worker.getContext` | 96 | 18904 | 196.9 | 172 | 289 | 48 | 702 |
| `getContext (reused)` | 96 | 18880 | 196.7 | 172 | 288 | 48 | 701 |
| `launchNewVSCode: total` | 5 | 18497 | 3699.4 | 3701 | 4193 | 3027 | 4193 |
| `launchNewVSCode: monaco-workbench visibility` | 5 | 11127 | 2225.4 | 2215 | 2399 | 2025 | 2399 |
| `getDetailsWebview` | 20 | 10785 | 539.3 | 524 | 823 | 303 | 1013 |
| `awaitIpcReady` | 5 | 9271 | 1854.2 | 1861 | 2562 | 595 | 2562 |
| `reuseContext scanForRepositories` | 96 | 6500 | 67.7 | 65 | 93 | 10 | 175 |
| `openWorkspace: dismiss UI` | 96 | 4684 | 48.8 | 35 | 95 | 8 | 226 |
| `launchNewVSCode: electron launch wrapper` | 5 | 3826 | 765.2 | 788 | 877 | 616 | 877 |
| `getLogWebview` | 96 | 3540 | 36.9 | 26 | 62 | 8 | 279 |
| `focusJJLog` | 75 | 3478 | 46.4 | 13 | 99 | 2 | 607 |
| `focusSCM` | 41 | 3419 | 83.4 | 68 | 111 | 38 | 270 |
| `hoverAndClick` | 26 | 2848 | 109.5 | 107 | 155 | 57 | 309 |
| `setScmDescription` | 8 | 2648 | 331.0 | 308 | 660 | 165 | 660 |
| `pickQuickPickItem regex` | 7 | 2619 | 374.1 | 157 | 1013 | 44 | 1013 |
| `reuseContext updateSettings` | 96 | 2455 | 25.6 | 10 | 69 | 3 | 290 |
| `launchNewVSCode: electron.launch` | 5 | 2433 | 486.6 | 479 | 571 | 419 | 571 |
| `updateSettings: sendEvaluation` | 96 | 2430 | 25.3 | 10 | 68 | 3 | 290 |
| `rightClickAndSelect New After` | 2 | 1903 | 951.5 | 1425 | 1425 | 478 | 1425 |
| `rightClickAndSelect New Before` | 2 | 1885 | 942.5 | 1355 | 1355 | 530 | 1355 |
| `ensureViewVisible Control+Alt+l` | 4 | 1778 | 444.5 | 491 | 607 | 320 | 607 |
| `clickNotificationButton Configure Path` | 2 | 1578 | 789.0 | 932 | 932 | 646 | 932 |
| `rightClickAndSelect Abandon` | 2 | 1376 | 688.0 | 759 | 759 | 617 | 759 |
| `launchNewVSCode: app.firstWindow` | 5 | 1364 | 272.8 | 287 | 395 | 186 | 395 |
| `waitForTab regex` | 17 | 1258 | 74.0 | 14 | 312 | 6 | 314 |
| `rightClickAndSelect Rebase onto Selected` | 1 | 1222 | 1222.0 | 1222 | 1222 | 1222 | 1222 |
| `selectCommits` | 5 | 1220 | 244.0 | 187 | 412 | 120 | 412 |
| `expectTree` | 17 | 1202 | 70.7 | 64 | 146 | 18 | 151 |
| `waitForLogCommitRow object` | 11 | 1143 | 103.9 | 37 | 55 | 14 | 800 |
| `rightClickAndSelect Absorb` | 1 | 1032 | 1032.0 | 1032 | 1032 | 1032 | 1032 |
| `pickQuickPickItem uqwlukoqypurvpqlyrxrzyupszkwwntv` | 1 | 1009 | 1009.0 | 1009 | 1009 | 1009 | 1009 |
| `waitForLogCommitRow initial setup` | 7 | 988 | 141.1 | 66 | 678 | 19 | 678 |
| `rightClickAndSelect Compare All Files with Revision...` | 1 | 980 | 980.0 | 980 | 980 | 980 | 980 |
| `clickScmAction Squash Revision into Parent` | 7 | 962 | 137.4 | 112 | 317 | 81 | 317 |
| `waitForTab SQUASH_MSG` | 5 | 952 | 190.4 | 175 | 283 | 130 | 283 |


