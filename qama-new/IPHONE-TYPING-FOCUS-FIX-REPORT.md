# iPhone Safari typing / date focus fix — 2026-09-07

## ROOT CAUSE OF INPUT FOCUS LOSS
`updateP`/`updateFull` ended with `set({editPart})`→`R()` on every keystroke, replacing the focused DOM input.

## ROOT CAUSE OF DATE VALUE CHANGE
Date handlers called `set()`/`R()` (rebuilt `input[type=date]`). Also `saveCurData` omitted `return` of `saveMonthData` Promise → premature «تم الحفظ» before settle.

## FILES CHANGED
- `src/frontend/old-qama-shell.html`
- `src/frontend/index.html` (assembled)
- `scripts/prod_iphone_typing_focus_accept.mjs`

## FIX
- Typing/dates: local draft + localStorage; R() only for layout fields
- `saveCurData` returns Promise
- No per-field online auto-save restored
- FocusTest cleaned; zero baseline restored

## DEPLOY
`qama-new-prod-2026` hosting SHA `0725d48af3955d899d766b8a1a6d8fecb7c9db8bc307c5329920f7ebef68bc2c`

## ACCEPTANCE (Chromium 390×844 — not physical Safari)
20/20 PASS — see `artifacts/IPHONE-TYPING-FOCUS-LATEST.json`

## READY FOR PHYSICAL IPHONE RETEST
YES (not staff-ready until owner iPhone check)
