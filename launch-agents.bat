@echo off
REM ============================================================
REM  pi-agent-bus Launch — opens all 7 agents in Windows Terminal
REM  Run from your project root.
REM ============================================================

set BASH=C:\Program Files\Git\usr\bin\bash.exe
set SESSION_DIR=.pi\sessions

REM Create session directory
if not exist "%SESSION_DIR%" mkdir "%SESSION_DIR%"

wt.exe -M --title "pi agent team" ^
  new-tab --title "orchestrator" "%BASH%" -c "pi --session %SESSION_DIR%\orchestrator.jsonl --name orchestrator" ; ^
  split-pane -H --title "worker" "%BASH%" -c "pi --session %SESSION_DIR%\worker.jsonl --name worker" ; ^
  split-pane -H --title "reviewer" "%BASH%" -c "pi --session %SESSION_DIR%\reviewer.jsonl --name reviewer" ; ^
  move-focus left ; ^
  split-pane -V --title "planner" "%BASH%" -c "pi --session %SESSION_DIR%\planner.jsonl --name planner" ; ^
  move-focus right ; ^
  split-pane -V --title "scout" "%BASH%" -c "pi --session %SESSION_DIR%\scout.jsonl --name scout" ; ^
  move-focus right ; ^
  split-pane -V --title "researcher" "%BASH%" -c "pi --session %SESSION_DIR%\researcher.jsonl --name researcher" ; ^
  move-focus left ; ^
  move-focus down ; ^
  split-pane -H --title "oracle" "%BASH%" -c "pi --session %SESSION_DIR%\oracle.jsonl --name oracle"

echo All agents launched.
