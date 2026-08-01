@echo off
REM Kept for habit and for anything that still calls it, but the priority and
REM affinity work now lives in tame.mjs, which every harness imports. Doing it
REM there means it applies however the script was started, and — the reason for
REM the change — node stays a direct child of this shell. The old `start /B`
REM spawned a detached process, so killing the run left node behind holding a
REM SwiftShader browser, which is what had to be ended by hand.
node %*
