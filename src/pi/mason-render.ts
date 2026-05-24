export interface TableColumn {
  label: string;
  minWidth?: number;
  maxWidth?: number;
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
  | "install"
  | "uninstall"
  | "which"
  | "bin-dir"
  | "env"
  | "doctor";

export interface RenderOptions {
  width: number;
  filter?: string;
  scroll?: number;
  maxRows?: number;
}

const TABLE_SEPARATOR = "  ";
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
      "",
      "Table views: use / to filter, ↑/↓ or PgUp/PgDn to scroll, q or Esc to close.",
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
      return renderTextDisplay(model.title, model.lines, width);
    case "usage":
      return renderTextDisplay(model.title, model.lines, width);
    case "error": {
      const lines = [`Error: ${model.message}`, ...(model.lines ?? [])];
      return renderTextDisplay(model.title, lines, width);
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
      { label: "Description", minWidth: 12, maxWidth: 48 },
    ],
    rows,
    emptyMessage: Array.isArray(data) ? "No packages found." : "Unexpected package list response.",
    searchable: true,
  };
  return display;
}

function installedTable(title: string, data: unknown): TableDisplay {
  const rows = Array.isArray(data) ? data.map(installedRow) : [];
  return {
    kind: "table",
    title,
    columns: [
      { label: "Name", minWidth: 8, maxWidth: 30 },
      { label: "Version", minWidth: 7, maxWidth: 16 },
      { label: "Bins", minWidth: 4, maxWidth: 32 },
      { label: "Installed At", minWidth: 12, maxWidth: 24 },
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
      { label: "Package Dir", minWidth: 11, maxWidth: 48 },
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
  const filter = options.filter?.trim() ?? "";
  const filteredRows = filterTableRows(model.rows, filter);
  const maxRows = Math.max(1, Math.floor(options.maxRows ?? DEFAULT_MAX_ROWS));
  const maxScroll = Math.max(0, filteredRows.length - maxRows);
  const scroll = clamp(Math.floor(options.scroll ?? 0), 0, maxScroll);
  const end = Math.min(filteredRows.length, scroll + maxRows);
  const titleParts = [`${model.title} — ${filteredRows.length}/${model.rows.length}`];
  if (filter.length > 0) titleParts.push(`filter: ${filter}`);
  const lines = [truncateToWidth(titleParts.join("  "), width)];
  if (model.subtitle && model.subtitle.length > 0) lines.push(truncateToWidth(model.subtitle, width));
  if (filteredRows.length === 0) {
    lines.push(truncateToWidth(model.emptyMessage, width));
    return lines;
  }
  const visibleRows = filteredRows.slice(scroll, end);
  const layout = computeColumnLayout(model.columns, visibleRows, width);
  lines.push(formatTableRow(model.columns.map((column) => column.label), layout, width));
  lines.push(truncateToWidth(layout.separator, width));
  for (const row of visibleRows) lines.push(formatTableRow(row, layout, width));
  const range = `showing ${scroll + 1}-${end} of ${filteredRows.length}`;
  const help = model.searchable ? `${range}  / filter  ↑↓ scroll  q close` : `${range}  ↑↓ scroll  q close`;
  lines.push(truncateToWidth(help, width));
  if (model.footer) {
    for (const line of model.footer) lines.push(truncateToWidth(line, width));
  }
  return lines;
}

function renderTextDisplay(title: string, textLines: readonly string[], width: number): string[] {
  const lines = [truncateToWidth(title, width)];
  for (const line of textLines) lines.push(truncateToWidth(line, width));
  return lines;
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
  if (total > width && widths.length === 1) widths[0] = width;
  return { widths, separator: "─".repeat(Math.min(width, Math.max(1, total))) };
}

function minimumTableWidth(columns: readonly TableColumn[], count: number): number {
  let total = TABLE_SEPARATOR.length * Math.max(0, count - 1);
  for (let index = 0; index < count; index += 1) total += columnMinWidth(columns[index]!);
  return total;
}

function columnMinWidth(column: TableColumn): number {
  return Math.max(1, column.minWidth ?? Math.min(8, Math.max(1, column.label.length)));
}

function formatTableRow(row: readonly string[], layout: ColumnLayout, width: number): string {
  const cells = layout.widths.map((cellWidth, index) => padRight(truncateToWidth(row[index] ?? "", cellWidth), cellWidth));
  return truncateToWidth(cells.join(TABLE_SEPARATOR), width);
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
