# Design: PCG Unified Operations Portal (Finance + Admin)

The locked system. Every Hallmark run reads this first and pages share it. Change it on purpose; the file is the rule. Locked 2026-10-27 from the Tips Editor redesign (v22.29) for the Finance section; extended the same day to the Admin console (same kit, same rules).

## System
- Genre: modern-minimal
- Shape of the first page: app screen (every Finance tab and every Admin section)
- Theme: brand (PCG orange #FF671F; Raleway + Source Sans 3)
- Posture: restrained. The accent marks the primary action, the current selection and state, nothing else.

## Tokens
`src/theme.js` is the source of truth (the portal styles inline; there is no tokens.css). Roles:
- Surfaces: `th.bg`, `th.card`, `th.card2` (table heads, footers), `th.card3` (hover, tracks), `th.cardBorder`
- Ink: `th.text`, `th.muted`, `th.subtle`
- State: `th.danger`, `th.success`, `th.warn`; accent `O`; on-accent `W`
- Faces: `FONTS.head` (Raleway: titles and figures only), `FONTS.body` (Source Sans 3: everything else)
- Radius: `RADIUS` (card 1rem, control 0.6rem, pill 999)
- A screen's CSS block declares `--fin-*` custom properties from these and uses only `var(--fin-*)` (see `FIN_CSS`).

## Kit
`src/finance-ui.jsx`: `FIN_CSS`, `FinFigure`/`FinFigures`, `FinTicker`/`useTickedNumber`, `FinBanner`, `FinSkeleton`, `FinTabs`, `FinBar`, `finStyles`, number formatters.

## Controls
- Primary: orange fill, white text, control radius, 40px high. One per region.
- Secondary: `th.card3` fill, `th.text`, same radius, 38px. Tertiary: a text link in the accent.
- Every control has `:focus-visible` (2px accent ring, instant), hover, active (1px drop) and disabled.

## Screens
- A title (Raleway 1.5rem), one short lede, then the controls row, then the panel.
- Figures: a label in body face sentence case, the number in Raleway, tabular numerals; never repeated elsewhere on the screen.
- Tables: heads in body face, sentence case, `th.card2`; numbers right-aligned, tabular.
- Every data region has loading (skeleton in its shape), empty (what goes here and the action), error (what broke) and full states.
- Each tab has one signature object (Tips Editor: the pool split by hours).
- Never: tracked capitals, emoji icons, dot-joined meta lines, arrows glued to links, dashes in copy, cards inside cards, glows.

## Motion
- Admin adds (user request "more animation", still state-only): section switch (indicator slides, panel fades up), list filtering animates rows in/out, edit drawers slide from the side, toggle knobs slide, removals offer Undo.
- Character: brisk, state only. Figures tick from the old value; bars grow by `scaleX`; added rows slide in, removed rows fold away; switches slide. No reveal on load. Under reduced motion everything ends at once.

## Exports
`src/theme.js` + `src/finance-ui.jsx` in this project.
