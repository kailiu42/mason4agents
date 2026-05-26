# Mason UI Guidelines

This document collects the UI requirements that have accumulated from `/mason`
work, current conversation decisions, code behavior, tests, and `docs/recap.md`.

## Boundaries

- Keep neutral TUI behavior in `src/tui/`.
- Keep Pi/OMP-specific overlay, theme, notification, working-indicator, and
  invalidation behavior in `src/pi/` adapters.
- Do not leak host APIs, theme token names, or Pi-specific lifecycle assumptions
  into the neutral TUI core.
- Direct slash-command output must not open blocking custom UI overlays. Use the
  interactive overlay for empty `/mason`; publish inline rendered output for
  direct subcommands such as `/mason doctor` or `/mason search ...`.

## Rendering and Layout

- Rendered lines must fit the width supplied by the host.
- Apply ANSI styling after plain layout/truncation so escape sequences do not
  corrupt width calculations.
- Tests that check visible width must strip ANSI SGR sequences.
- The TUI canvas height must stay stable across command views.
- Pad sparse command views instead of letting the panel jump vertically.
- Table headers, separators, and column widths must remain stable while moving
  selection or scrolling.
- Compute table layout from the filtered data set, not only the currently
  visible viewport rows.
- Wrap long cell content inside its column instead of shifting adjacent columns.
- Request a full-width Pi overlay for the interactive panel.
- Details should render as an in-place popup over the list, not as a host-specific
  page or Pi-only widget.

## Redraw and Async State

- Pi custom components are pull-rendered by the host. Any state-changing input or
  asynchronous result must explicitly request a render/invalidation.
- Keep a usable TUI/component handle for future invalidation needs; do not hide it
  behind unused placeholders.
- Initial panel work must not block the first visible render. Show the panel first,
  then start expensive cache/CLI work and invalidate when data returns.
- Fast tab switching must not allow stale CLI output to overwrite newer state.
  Guard async command updates with a monotonically increasing run id.
- Local `/mason` handlers should hide Pi's working row while running and restore
  it in `finally`.

## Navigation

- Long lists include the main package list and language/category picker lists.
- Down from the last item wraps to the first item.
- Up from the first item wraps to the last item.
- `g` jumps to the first item when not editing text.
- `G` jumps to the last item when not editing text.
- In text-editing modes, printable characters such as `g` and `G` belong to the
  draft input instead of navigation.
- `Enter` on a package row opens the detail popup.
- Detail popup close/back keys return to the list without closing the whole panel.

## Filtering

- `/` starts name filtering on the main package list.
- Name filtering updates the visible list live only when the draft has at least
  three characters.
- Pressing `Enter` commits the name filter.
- The name filter input must not appear as a separate row. While editing, show it
  inline in the tab row after the count as a highlighted bracketed badge:
  `[/ draft]` or `[/]` for an empty draft.
- After committing name filtering, keep the active condition visible in the same
  tab-row badge form: `[/ value]`.
- `l` opens a single-select language picker.
- `c` opens a single-select category picker.
- Language/category candidates must be generated dynamically from the current
  cached registry/list data (`languages` and `categories` fields). Do not hard-code
  production package names, languages, or categories.
- Language/category picker candidates include an all-items choice (`All languages`
  or `All categories`) represented by an empty filter value.
- Picker panels also support `/` filtering.
- Picker filtering updates visible candidates live only when the draft has at
  least three characters.
- Picker filter input appears inside the popup directly under the top border as a
  highlighted bracketed line such as `[/ draft]`.
- Pressing `Enter` while filtering inside a picker selects the current highlighted
  filtered candidate, closes the popup, and returns to the main list filtered by
  that selected language/category.
- Active language/category filters stay visible in the tab row after the count as
  highlighted badges: `[l Language]` and `[c Category]`.
- When multiple filters are active, display their badges together after the count,
  for example: `[/ server] [l TypeScript] [c LSP]`.
- Filter badges are status, not extra table rows; they must not change table body
  vertical positioning.

## Help and Visual Language

- Shortcut help should describe only currently valid actions.
- Table views show movement/filtering/action shortcuts; refresh views show the
  refresh confirmation shortcut; detail views show detail actions.
- Use the `▶` marker for the selected row/candidate.
- Use bracketed shortcut labels (`[/]`, `[l]`, `[c]`, `[Enter]`, `[Esc]`) in help.
- Active filter status also uses brackets and the edit/highlight style so users
  can distinguish constraints from ordinary tab metadata.
- Picker popups should show their title in the top border and keep help inside the
  popup body.

## Testing Expectations

- Unit tests should cover width bounds, stable height, stable headers/separators,
  selection movement, wrap-around navigation, `g`/`G`, filtering thresholds,
  picker selection, and visible filter badges.
- Tests should assert behavior, not current default styling details.
- Use fake bridge data to prove language/category candidates are derived from
  package data. Fixture values may be concrete, but production code must remain
  data-driven.
- Unit-level `handleInput()` success is not enough for host UI confidence; use a
  Pi/custom-component or PTY smoke path when validating redraw, width, focus, or
  escape-key behavior.
