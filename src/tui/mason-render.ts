export interface TableColumn {
  label: string;
  minWidth?: number;
  maxWidth?: number;
  grow?: number;
}

export interface TableDisplay {
  kind: "table";
  title: string;
  subtitle?: string;
  columns: readonly TableColumn[];
  rows: readonly (readonly string[])[];
  emptyMessage: string;
  searchable: boolean;
  footer?: readonly string[];
  successMarkerColumn?: number;
}

export interface SummaryDisplay {
  kind: "summary";
  title: string;
  lines: readonly string[];
}

export interface ErrorDisplay {
  kind: "error";
  title: string;
  message: string;
  lines?: readonly string[];
}

export interface UsageDisplay {
  kind: "usage";
  title: string;
  lines: readonly string[];
}

export type DisplayModel = TableDisplay | SummaryDisplay | ErrorDisplay | UsageDisplay;

export type MasonResultKind =
  | "refresh"
  | "packages"
  | "installed"
  | "suggestions"
  | "install"
  | "uninstall"
  | "which"
  | "bin-dir"
  | "env"
  | "doctor";

export interface RenderOptions {
  width: number;
  filter?: string;
  filterSummary?: string | undefined;
  filterActions?: readonly ShortcutAction[] | undefined;
  scroll?: number;
  maxRows?: number;
  selectedRow?: number;
  fixedHeight?: boolean;
  showTitle?: boolean;
  showHelp?: boolean;
  totalRows?: number | undefined;
  style?: RenderStyle;
}

export interface RenderStyle {
  tableTitle?: (text: string) => string;
  tableHeader?: (text: string) => string;
  tableSeparator?: (text: string) => string;
  selectedRow?: (text: string) => string;
  help?: (text: string) => string;
  shortcutKey?: (text: string) => string;
  shortcutAction?: (text: string) => string;
  installedMarker?: (text: string) => string;
}

export type ShortcutAction = readonly [key: string, action: string];

const TABLE_SEPARATOR = "  ";
const SHORTCUT_SEPARATOR = " │ ";
const DEFAULT_MAX_ROWS = 24;

export function usageDisplay(): UsageDisplay {
  return {
    kind: "usage",
    title: "mason4agents commands",
    lines: [
      "/mason                                      open interactive panel",
      "/mason refresh [--registry <source>]",
      "/mason search [query] [--category <category>] [--language <language>] [--registry <source>]",
      "/mason list [--installed] [--outdated] [--registry <source>]",
      "/mason installed                             alias for list --installed",
      "/mason outdated                              alias for list --outdated",
      "/mason install <pkg[@version]>... [--registry <source>] [--allow-build-scripts]",
      "/mason uninstall <pkg>...",
      "/mason update [pkg...] [--registry <source>] [--allow-build-scripts]",
      "/mason which <executable>",
      "/mason bin-dir",
      "/mason env --shell bash|zsh|fish|powershell|cmd|json",
      "/mason doctor",
      "/mason register --omp                         update OMP lsp.json for installed LSP tools",
      "",
      `Table views: ${shortcutText([["[/]", "filter"], ["[↑]/[↓]/[PgUp]/[PgDn]", "scroll"], ["[q]/[Esc]", "close"]])}`,
    ],
  };
}

export function errorDisplay(title: string, message: string, lines: readonly string[] = []): ErrorDisplay {
  return { kind: "error", title, message, lines };
}

export function modelForResult(kind: MasonResultKind, data: unknown, title: string): DisplayModel {
  switch (kind) {
    case "packages":
      return packageTable(title, data);
    case "suggestions":
      return suggestionTable(title, data);
    case "installed":
      return installedTable(title, data);
    case "install":
      return installTable(title, data);
    case "uninstall":
      return uninstallTable(title, data);
    case "which":
      return whichSummary(title, data);
    case "bin-dir":
      return binDirSummary(title, data);
    case "env":
      return envSummary(title, data);
    case "doctor":
      return doctorSummary(title, data);
    case "refresh":
      return refreshSummary(title, data);
  }
}

export function renderDisplay(model: DisplayModel, options: RenderOptions): string[] {
  const width = normalizeWidth(options.width);
  switch (model.kind) {
    case "table":
      return renderTableDisplay(model, width, options);
    case "summary":
      return renderTextDisplay(model.title, model.lines, width, options.style);
    case "usage":
      return renderTextDisplay(model.title, model.lines, width, options.style);
    case "error": {
      const lines = [`Error: ${model.message}`, ...(model.lines ?? [])];
      return renderTextDisplay(model.title, lines, width, options.style);
    }
  }
}

export function renderDisplayText(model: DisplayModel, width = 120): string {
  return renderDisplay(model, { width, maxRows: 100 }).join("\n");
}

export function modelSupportsFiltering(model: DisplayModel): boolean {
  return model.kind === "table" && model.searchable;
}

function packageTable(title: string, data: unknown): TableDisplay {
  const rows = Array.isArray(data) ? data.map(packageRow) : [];
  const display: TableDisplay = {
    kind: "table",
    title,
    columns: [
      { label: "Name", minWidth: 8, maxWidth: 28 },
      { label: "Version", minWidth: 7, maxWidth: 16 },
      { label: "Status", minWidth: 8, maxWidth: 12 },
      { label: "Installed", minWidth: 9, maxWidth: 16 },
      { label: "Languages", minWidth: 9, maxWidth: 18 },
      { label: "Categories", minWidth: 10, maxWidth: 18 },
      { label: "Description", minWidth: 12, maxWidth: 48, grow: 1 },
    ],
    rows,
    emptyMessage: Array.isArray(data) ? "No packages found." : "Unexpected package list response.",
    searchable: true,
  };
  return display;
}

function suggestionTable(title: string, data: unknown): TableDisplay {
  const rows = Array.isArray(data) ? data.map(suggestionRow) : [];
  return {
    kind: "table",
    title,
    columns: [
      { label: "", minWidth: 1, maxWidth: 1 },
      { label: "Name", minWidth: 8, maxWidth: 28 },
      { label: "Version", minWidth: 7, maxWidth: 16 },
      { label: "Languages", minWidth: 9, maxWidth: 18 },
      { label: "Categories", minWidth: 10, maxWidth: 18 },
      { label: "Reason", minWidth: 12, maxWidth: 56, grow: 1 },
    ],
    rows,
    emptyMessage: Array.isArray(data) ? "No suggested packages found." : "Unexpected suggested package response.",
    searchable: true,
    successMarkerColumn: 0,
  };
}

function installedTable(title: string, data: unknown): TableDisplay {
  const rows = Array.isArray(data) ? data.map(installedRow) : [];
  return {
    kind: "table",
    title,
    columns: [
      { label: "Name", minWidth: 30, maxWidth: 30 },
      { label: "Version", minWidth: 20, maxWidth: 20 },
      { label: "Bins", minWidth: 30, maxWidth: 30 },
      { label: "Installed At", minWidth: 32, maxWidth: 32 },
    ],
    rows,
    emptyMessage: Array.isArray(data) ? "No packages installed." : "Unexpected installed package response.",
    searchable: true,
  };
}

function installTable(title: string, data: unknown): DisplayModel {
  if (!Array.isArray(data)) return summaryFromUnknown(title, data);
  return {
    kind: "table",
    title,
    columns: [
      { label: "Package", minWidth: 8, maxWidth: 30 },
      { label: "Version", minWidth: 7, maxWidth: 16 },
      { label: "Source", minWidth: 8, maxWidth: 36 },
      { label: "Bins", minWidth: 4, maxWidth: 32 },
      { label: "Package Dir", minWidth: 11, maxWidth: 48, grow: 1 },
    ],
    rows: data.map(installRow),
    emptyMessage: "Nothing to install or update.",
    searchable: true,
  };
}

function uninstallTable(title: string, data: unknown): DisplayModel {
  if (!Array.isArray(data)) return summaryFromUnknown(title, data);
  return {
    kind: "table",
    title,
    columns: [
      { label: "Package", minWidth: 8, maxWidth: 32 },
      { label: "Result", minWidth: 7, maxWidth: 16 },
    ],
    rows: data.map(uninstallRow),
    emptyMessage: "Nothing to uninstall.",
    searchable: true,
  };
}

function whichSummary(title: string, data: unknown): SummaryDisplay {
  if (!isRecord(data)) return summaryFromUnknown(title, data);
  const executable = stringValue(data.executable) || "<unknown>";
  const path = stringValue(data.path);
  const pkg = stringValue(data.package);
  const lines = path.length > 0
    ? [`${executable}: ${path}`, pkg.length > 0 ? `Package: ${pkg}` : ""]
    : [`${executable}: not found`, pkg.length > 0 ? `Package: ${pkg}` : ""];
  return { kind: "summary", title, lines: lines.filter((line) => line.length > 0) };
}

function binDirSummary(title: string, data: unknown): SummaryDisplay {
  if (isRecord(data)) {
    const binDir = stringValue(data.bin_dir);
    if (binDir.length > 0) return { kind: "summary", title, lines: [`Bin dir: ${binDir}`] };
  }
  if (typeof data === "string") return { kind: "summary", title, lines: [`Bin dir: ${data}`] };
  return summaryFromUnknown(title, data);
}

function envSummary(title: string, data: unknown): SummaryDisplay {
  if (!isRecord(data)) return summaryFromUnknown(title, data);
  const shell = stringValue(data.shell);
  if (shell.length > 0) return { kind: "summary", title, lines: [shell] };
  const path = stringValue(data.PATH);
  if (path.length > 0) return { kind: "summary", title, lines: [`PATH=${path}`] };
  return summaryFromUnknown(title, data);
}

function refreshSummary(title: string, data: unknown): SummaryDisplay {
  if (!isRecord(data)) return summaryFromUnknown(title, data);
  return {
    kind: "summary",
    title,
    lines: [
      `Source: ${stringValue(data.source) || "-"}`,
      `Packages: ${stringValue(data.package_count) || "0"}`,
      `Cache: ${stringValue(data.cache_file) || "-"}`,
      `Checksum: ${stringValue(data.checksum) || "-"}`,
    ],
  };
}

function doctorSummary(title: string, data: unknown): SummaryDisplay {
  if (!isRecord(data)) return summaryFromUnknown(title, data);
  const lines: string[] = [];
  const paths = recordValue(data.paths);
  if (paths) {
    pushLine(lines, "Bin dir", paths.bin_dir);
    pushLine(lines, "Bin dir exists", yesNo(paths.bin_dir_exists));
    pushLine(lines, "Data writable", yesNo(paths.data_dir_writable));
  }
  const registry = recordValue(data.registry);
  if (registry) {
    if (registry.cache_present === true) {
      lines.push(`Registry cache: ${stringValue(registry.package_count) || "0"} packages`);
    } else {
      lines.push(`Registry cache: ${stringValue(registry.error) || "missing"}`);
    }
  }
  const pathEnv = recordValue(data.path_env);
  if (pathEnv) {
    pushLine(lines, "PATH contains bin", yesNo(pathEnv.contains_bin_dir));
    pushLine(lines, "PATH bin first", yesNo(pathEnv.bin_dir_first));
  }
  const managers = Array.isArray(data.managers) ? data.managers : [];
  if (managers.length > 0) {
    lines.push("Managers:");
    for (const manager of managers) {
      if (!isRecord(manager)) continue;
      const name = stringValue(manager.source_type) || "<unknown>";
      lines.push(`  ${name}: ${manager.available === true ? "installed" : "missing"}`);
    }
  }
  lines.push(`Overall: ${data.ok === true ? "ok" : "needs attention"}`);
  return { kind: "summary", title, lines };
}

function summaryFromUnknown(title: string, data: unknown): SummaryDisplay {
  return { kind: "summary", title, lines: summarizeUnknown(data) };
}

function packageRow(value: unknown): string[] {
  if (!isRecord(value)) return [String(value), "", "", "", "", "", ""];
  return [
    stringValue(value.name) || "<unknown>",
    stringValue(value.version) || "-",
    packageStatus(value),
    stringValue(value.installed_version) || "-",
    stringList(value.languages),
    stringList(value.categories),
    stringValue(value.description),
  ];
}

function suggestionRow(value: unknown): string[] {
  if (!isRecord(value)) return ["", String(value), "", "", "", ""];
  return [
    value.installed === true ? "✓" : "",
    stringValue(value.name) || "<unknown>",
    stringValue(value.version) || "-",
    stringList(value.languages),
    stringList(value.categories),
    stringValue(value.reason) || stringValue(value.description),
  ];
}

function installedRow(value: unknown): string[] {
  if (!isRecord(value)) return [String(value), "", "", ""];
  return [
    stringValue(value.name) || "<unknown>",
    stringValue(value.version) || "-",
    keyList(value.bins),
    stringValue(value.installed_at) || "-",
  ];
}

function installRow(value: unknown): string[] {
  if (!isRecord(value)) return [String(value), "", "", "", ""];
  return [
    stringValue(value.package) || "<unknown>",
    stringValue(value.version) || "-",
    stringValue(value.source_id) || "-",
    keyList(value.bins),
    stringValue(value.package_dir) || "-",
  ];
}

function uninstallRow(value: unknown): string[] {
  if (!isRecord(value)) return [String(value), ""];
  return [stringValue(value.package) || "<unknown>", value.removed === true ? "removed" : "not installed"];
}

function packageStatus(value: Record<string, unknown>): string {
  if (value.deprecated === true) return "deprecated";
  if (value.installed === true && value.outdated === true) return "outdated";
  if (value.installed === true) return "installed";
  return "available";
}

function renderTableDisplay(model: TableDisplay, width: number, options: RenderOptions): string[] {
  const style = options.style;
  const filter = options.filter?.trim() ?? "";
  const filteredRows = filterTableRows(model.rows, filter);
  const maxRows = Math.max(1, Math.floor(options.maxRows ?? DEFAULT_MAX_ROWS));
  const fixedHeight = options.fixedHeight === true;
  const maxScroll = fixedHeight ? Math.max(0, filteredRows.length - 1) : Math.max(0, filteredRows.length - maxRows);
  const scroll = clamp(Math.floor(options.scroll ?? 0), 0, maxScroll);
  const selectedRow = options.selectedRow;
  const hasSelection = selectedRow !== undefined;
  const rowPrefixWidth = hasSelection ? 2 : 0;
  const tableWidth = Math.max(1, width - rowPrefixWidth);
  const totalRows = options.totalRows ?? model.rows.length;
  const titleParts = [`${model.title} — ${filteredRows.length}/${totalRows}`];
  if (filter.length > 0) titleParts.push(`filter: ${filter}`);
  if (options.filterSummary && options.filterSummary.length > 0) titleParts.push(options.filterSummary);
  const titleLine = truncateToWidth(titleParts.join("  "), width);
  const lines: string[] = [];
  if (options.showTitle !== false) lines.push(style?.tableTitle ? style.tableTitle(fitPlainToWidth(titleLine, width)) : titleLine);
  if (model.subtitle && model.subtitle.length > 0) lines.push(truncateToWidth(model.subtitle, width));
  if (filteredRows.length === 0 && !fixedHeight) {
    lines.push(truncateToWidth(model.emptyMessage, width));
    return lines;
  }
  const layout = computeColumnLayout(model.columns, filteredRows, tableWidth);
  const headerLines = formatTableRowLines(model.columns.map((column) => column.label), layout, tableWidth);
  const separatorLine = formatPrefixedTableLine(truncateToWidth(layout.separator, tableWidth), "  ", hasSelection, width);
  for (const headerLine of headerLines) {
    const prefixed = formatPrefixedTableLine(headerLine, "  ", hasSelection, width);
    lines.push(style?.tableHeader ? style.tableHeader(fitPlainToWidth(prefixed, width)) : prefixed);
  }
  lines.push(style?.tableSeparator ? style.tableSeparator(fitPlainToWidth(separatorLine, width)) : separatorLine);
  const rowLineSets = filteredRows.map((row) => formatTableRowLines(row, layout, tableWidth));
  const bodyLines: string[] = [];
  let renderedStart = 0;
  let renderedEnd = 0;
  if (filteredRows.length === 0) {
    bodyLines.push(formatPrefixedTableLine(fitPlainToWidth(truncateToWidth(model.emptyMessage, tableWidth), tableWidth), "  ", hasSelection, width));
  } else if (!fixedHeight) {
    renderedStart = scroll;
    renderedEnd = Math.min(filteredRows.length, scroll + maxRows);
    for (let rowIndex = renderedStart; rowIndex < renderedEnd; rowIndex += 1) {
      const selected = selectedRow === rowIndex;
      const rowLines = rowLineSets[rowIndex]!;
      for (let rowLineIndex = 0; rowLineIndex < rowLines.length; rowLineIndex += 1) {
        const prefix = selected && rowLineIndex === 0 ? "▶ " : "  ";
        const rowLine = formatPrefixedTableLine(rowLines[rowLineIndex]!, prefix, hasSelection, width);
        bodyLines.push(renderTableBodyLine(rowLine, model, layout, prefix, hasSelection, selected, style, width));
      }
    }
  } else {
    renderedStart = tableBodyStart(rowLineSets, scroll, selectedRow, maxRows);
    let rowIndex = renderedStart;
    while (rowIndex < filteredRows.length && bodyLines.length < maxRows) {
      const selected = selectedRow === rowIndex;
      const rowLines = rowLineSets[rowIndex]!;
      const remaining = maxRows - bodyLines.length;
      const visibleLineCount = Math.min(remaining, rowLines.length);
      for (let rowLineIndex = 0; rowLineIndex < visibleLineCount; rowLineIndex += 1) {
        const prefix = selected && rowLineIndex === 0 ? "▶ " : "  ";
        const rowLine = formatPrefixedTableLine(rowLines[rowLineIndex]!, prefix, hasSelection, width);
        bodyLines.push(renderTableBodyLine(rowLine, model, layout, prefix, hasSelection, selected, style, width));
      }
      rowIndex += 1;
    }
    renderedEnd = rowIndex;
  }
  while (fixedHeight && bodyLines.length < maxRows) {
    bodyLines.push(formatPrefixedTableLine(fitPlainToWidth("", tableWidth), "  ", hasSelection, width));
  }
  lines.push(...bodyLines);
  if (options.showHelp !== false) {
    const range = filteredRows.length === 0 ? "showing 0-0 of 0" : `showing ${renderedStart + 1}-${renderedEnd} of ${filteredRows.length}`;
    const navigationActions: ShortcutAction[] = hasSelection ? [["[↑]/[↓]", "select"], ["[Enter]", "detail"]] : [["[↑]/[↓]", "scroll"]];
    const helpActions: ShortcutAction[] = [
      ...(model.searchable ? options.filterActions ?? [["[/]", "filter"]] : []),
      ...navigationActions,
      ["[q]/[Esc]", "close"],
    ];
    lines.push(renderShortcutLine(range, helpActions, width, style));
  }
  if (model.footer) {
    for (const line of model.footer) lines.push(truncateToWidth(line, width));
  }
  return lines;
}

function renderTableBodyLine(
  rowLine: string,
  model: TableDisplay,
  layout: ColumnLayout,
  prefix: string,
  hasSelection: boolean,
  selected: boolean,
  style: RenderStyle | undefined,
  width: number,
): string {
  const selectedStyler = selected ? style?.selectedRow : undefined;
  const baseLine = selectedStyler ? fitPlainToWidth(rowLine, width) : rowLine;
  const markerIndex = successMarkerIndex(model, layout, prefix, hasSelection);
  if (markerIndex < 0 || baseLine[markerIndex] !== "✓") {
    return selectedStyler ? selectedStyler(baseLine) : baseLine;
  }
  const markerStyler = style?.installedMarker ?? selectedStyler;
  return renderStyledSegments(
    [
      { text: baseLine.slice(0, markerIndex), styler: selectedStyler },
      { text: baseLine[markerIndex]!, styler: markerStyler },
      { text: baseLine.slice(markerIndex + 1), styler: selectedStyler },
    ],
    baseLine.length,
    undefined,
    false,
  );
}

function successMarkerIndex(model: TableDisplay, layout: ColumnLayout, prefix: string, hasSelection: boolean): number {
  const column = model.successMarkerColumn;
  if (column === undefined || column < 0 || column >= layout.widths.length) return -1;
  let offset = hasSelection ? prefix.length : 0;
  for (let index = 0; index < column; index += 1) {
    offset += layout.widths[index]! + TABLE_SEPARATOR.length;
  }
  return offset;
}

function tableBodyStart(rowLineSets: readonly (readonly string[])[], scroll: number, selectedRow: number | undefined, bodyHeight: number): number {
  if (rowLineSets.length === 0) return 0;
  let start = clamp(scroll, 0, rowLineSets.length - 1);
  if (selectedRow === undefined) return start;
  const selected = clamp(Math.floor(selectedRow), 0, rowLineSets.length - 1);
  if (selected < start) return selected;
  let selectedBottom = 0;
  for (let index = start; index <= selected; index += 1) selectedBottom += rowLineSets[index]?.length ?? 1;
  while (selectedBottom > bodyHeight && start < selected) {
    selectedBottom -= rowLineSets[start]?.length ?? 1;
    start += 1;
  }
  return start;
}

function formatPrefixedTableLine(line: string, prefix: string, hasSelection: boolean, width: number): string {
  if (!hasSelection) return truncateToWidth(line, width);
  return truncateToWidth(`${prefix}${line}`, width);
}

function renderTextDisplay(title: string, textLines: readonly string[], width: number, style?: RenderStyle): string[] {
  const lines = [truncateToWidth(title, width)];
  for (const line of textLines) lines.push(renderInlineShortcutText(line, width, style));
  return lines;
}

export function shortcutText(actions: readonly ShortcutAction[]): string {
  return actions.map(([key, action]) => `${key}: ${action}`).join(SHORTCUT_SEPARATOR);
}

export function renderShortcutLine(prefix: string, actions: readonly ShortcutAction[], width: number, style?: RenderStyle): string {
  const segments: StyledSegment[] = [];
  if (prefix.length > 0) segments.push({ text: prefix, styler: style?.help });
  for (let index = 0; index < actions.length; index += 1) {
    const [key, action] = actions[index]!;
    if (index === 0 && prefix.length > 0) {
      segments.push({ text: " ", styler: style?.help });
    } else if (index > 0) {
      segments.push({ text: SHORTCUT_SEPARATOR, styler: style?.help });
    }
    segments.push(
      { text: key, styler: style?.shortcutKey },
      { text: ": ", styler: style?.shortcutAction },
      { text: action, styler: style?.shortcutAction },
    );
  }
  return renderStyledSegments(segments, width, style?.help, true);
}

export function renderInlineShortcutText(text: string, width: number, style?: RenderStyle, plainStyler = style?.help): string {
  const segments: StyledSegment[] = [];
  const pattern = /(\[[^\]]+\](?:\/\[[^\]]+\])?): ([^[]+)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const [matched, key, action] = match;
    if (match.index > cursor) segments.push({ text: text.slice(cursor, match.index), styler: plainStyler });
    segments.push(
      { text: key!, styler: style?.shortcutKey },
      { text: ": ", styler: style?.shortcutAction },
      { text: action!, styler: style?.shortcutAction },
    );
    cursor = match.index + matched.length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), styler: plainStyler });
  if (segments.length === 0) segments.push({ text, styler: plainStyler });
  return renderStyledSegments(segments, width, plainStyler, false);
}

interface StyledSegment {
  text: string;
  styler?: ((text: string) => string) | undefined;
}

function renderStyledSegments(segments: readonly StyledSegment[], width: number, padStyler: ((text: string) => string) | undefined, pad: boolean): string {
  const parts: string[] = [];
  let used = 0;
  for (const segment of segments) {
    if (used >= width) break;
    const remaining = width - used;
    const clipped = truncateToWidth(segment.text, remaining);
    parts.push(segment.styler ? segment.styler(clipped) : clipped);
    used += clipped.length;
    if (clipped.length < segment.text.length) break;
  }
  if (pad && used < width) {
    const padding = " ".repeat(width - used);
    parts.push(padStyler ? padStyler(padding) : padding);
  }
  return parts.join("");
}

function filterTableRows(rows: readonly (readonly string[])[], filter: string): readonly (readonly string[])[] {
  if (filter.length === 0) return rows;
  const needle = filter.toLocaleLowerCase();
  return rows.filter((row) => row.join(" ").toLocaleLowerCase().includes(needle));
}

interface ColumnLayout {
  widths: number[];
  separator: string;
}

function computeColumnLayout(columns: readonly TableColumn[], rows: readonly (readonly string[])[], width: number): ColumnLayout {
  if (columns.length === 0) return { widths: [width], separator: "" };
  let count = columns.length;
  while (count > 1 && minimumTableWidth(columns, count) > width) count -= 1;
  const widths: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const column = columns[index]!;
    const minWidth = columnMinWidth(column);
    const maxWidth = Math.max(minWidth, column.maxWidth ?? 80);
    let desired = clamp(column.label.length, minWidth, maxWidth);
    for (const row of rows) {
      desired = Math.max(desired, clamp((row[index] ?? "").length, minWidth, maxWidth));
    }
    widths.push(desired);
  }
  let total = widths.reduce((sum, value) => sum + value, 0) + TABLE_SEPARATOR.length * Math.max(0, count - 1);
  while (total > width && widths.some((value, index) => value > columnMinWidth(columns[index]!))) {
    let widest = 0;
    for (let index = 1; index < widths.length; index += 1) {
      if (widths[index]! > widths[widest]!) widest = index;
    }
    const minWidth = columnMinWidth(columns[widest]!);
    if (widths[widest]! <= minWidth) break;
    widths[widest] = widths[widest]! - 1;
    total -= 1;
  }
  if (total > width && widths.length === 1) {
    widths[0] = width;
    total = width;
  }
  while (total < width && widths.length > 0) {
    const growIndexes = widths
      .map((_, index) => index)
      .filter((index) => (columns[index]?.grow ?? 0) > 0);
    const targets = growIndexes.length > 0 ? growIndexes : [widths.length - 1];
    for (const index of targets) {
      if (total >= width) break;
      widths[index] = widths[index]! + 1;
      total += 1;
    }
  }
  return { widths, separator: "─".repeat(Math.max(1, width)) };
}

function minimumTableWidth(columns: readonly TableColumn[], count: number): number {
  let total = TABLE_SEPARATOR.length * Math.max(0, count - 1);
  for (let index = 0; index < count; index += 1) total += columnMinWidth(columns[index]!);
  return total;
}

function columnMinWidth(column: TableColumn): number {
  return Math.max(1, column.minWidth ?? Math.min(8, Math.max(1, column.label.length)));
}

function formatTableRowLines(row: readonly string[], layout: ColumnLayout, width: number): string[] {
  const cellLines = layout.widths.map((cellWidth, index) => wrapCell(row[index] ?? "", cellWidth));
  const height = Math.max(1, ...cellLines.map((lines) => lines.length));
  const lines: string[] = [];
  for (let lineIndex = 0; lineIndex < height; lineIndex += 1) {
    const cells = layout.widths.map((cellWidth, cellIndex) => padRight(cellLines[cellIndex]?.[lineIndex] ?? "", cellWidth));
    lines.push(fitPlainToWidth(cells.join(TABLE_SEPARATOR), width));
  }
  return lines;
}

function wrapCell(value: string, width: number): string[] {
  if (width <= 0) return [""];
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return [""];
  const lines: string[] = [];
  let rest = normalized;
  while (rest.length > width) {
    const index = wrapIndex(rest, width);
    const line = rest.slice(0, index).trimEnd();
    lines.push(line.length > 0 ? line : rest.slice(0, width));
    rest = rest.slice(index).trimStart();
  }
  lines.push(rest);
  return lines;
}

function wrapIndex(value: string, width: number): number {
  const hardLimit = Math.min(width, value.length);
  let best = -1;
  for (let index = 1; index < hardLimit; index += 1) {
    const char = value[index]!;
    if (char === " ") {
      best = index;
    } else if ("|/_.,;-".includes(char)) {
      best = index + 1;
    }
  }
  return best >= Math.floor(width * 0.45) ? best : hardLimit;
}

function truncateToWidth(value: string, width: number): string {
  if (width <= 0) return "";
  if (value.length <= width) return value;
  if (width === 1) return value.slice(0, 1);
  return `${value.slice(0, width - 1)}…`;
}

function padRight(value: string, width: number): string {
  if (value.length >= width) return value;
  return value + " ".repeat(width - value.length);
}

function fitPlainToWidth(value: string, width: number): string {
  const truncated = truncateToWidth(value, width);
  return padRight(truncated, width);
}


function normalizeWidth(width: number): number {
  if (!Number.isFinite(width)) return 80;
  return Math.max(1, Math.floor(width));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function stringList(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.map(stringValue).filter((item) => item.length > 0).join(",");
}

function keyList(value: unknown): string {
  if (!isRecord(value)) return "";
  return Object.keys(value).join(",");
}

function yesNo(value: unknown): string {
  if (value === true) return "yes";
  if (value === false) return "no";
  return stringValue(value) || "unknown";
}

function pushLine(lines: string[], label: string, value: unknown): void {
  const rendered = stringValue(value);
  if (rendered.length > 0) lines.push(`${label}: ${rendered}`);
}

function summarizeUnknown(value: unknown): string[] {
  if (value === null || value === undefined) return ["No data returned."];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return [`${value.length} item(s) returned.`];
  if (!isRecord(value)) return [String(value)];
  const lines: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (child === null || child === undefined) {
      lines.push(`${key}: -`);
    } else if (typeof child === "string" || typeof child === "number" || typeof child === "boolean") {
      lines.push(`${key}: ${String(child)}`);
    } else if (Array.isArray(child)) {
      lines.push(`${key}: ${child.length} item(s)`);
    } else {
      lines.push(`${key}: object`);
    }
  }
  return lines.length > 0 ? lines : ["No displayable fields returned."];
}
