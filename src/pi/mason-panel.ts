import type { CliBridge } from "./cli";

export interface MasonPanelState {
  query: string;
  category: string | undefined;
  language: string | undefined;
  packages: unknown[];
  selected?: unknown;
  doctor?: unknown;
  lastAction?: unknown;
}

export interface MasonPanel {
  title: string;
  state: MasonPanelState;
  refresh(): Promise<MasonPanelState>;
  search(query?: string, filters?: { category: string | undefined; language: string | undefined }): Promise<MasonPanelState>;
  install(packages: string[]): Promise<MasonPanelState>;
  uninstall(packages: string[]): Promise<MasonPanelState>;
  update(packages?: string[]): Promise<MasonPanelState>;
  doctor(): Promise<MasonPanelState>;
  render(): string;
}

export function createMasonPanel(bridge: CliBridge): MasonPanel {
  const state: MasonPanelState = { query: "", category: undefined, language: undefined, packages: [] };
  return {
    title: "mason4agents",
    state,
    async refresh() {
      state.lastAction = await bridge.run(["refresh"]);
      return this.search(state.query, { category: state.category, language: state.language });
    },
    async search(query = "", filters: { category: string | undefined; language: string | undefined } = { category: undefined, language: undefined }) {
      state.query = query;
      state.category = filters.category;
      state.language = filters.language;
      const argv = ["search"];
      if (query.length > 0) argv.push(query);
      if (filters.category) argv.push("--category", filters.category);
      if (filters.language) argv.push("--language", filters.language);
      const data = await bridge.run(argv);
      state.packages = Array.isArray(data) ? data : [];
      return state;
    },
    async install(packages: string[]) {
      state.lastAction = await bridge.run(["install", ...packages]);
      return this.search(state.query, { category: state.category, language: state.language });
    },
    async uninstall(packages: string[]) {
      state.lastAction = await bridge.run(["uninstall", ...packages]);
      return this.search(state.query, { category: state.category, language: state.language });
    },
    async update(packages: string[] = []) {
      state.lastAction = await bridge.run(["update", ...packages]);
      return this.search(state.query, { category: state.category, language: state.language });
    },
    async doctor() {
      state.doctor = await bridge.run(["doctor"]);
      return state;
    },
    render() {
      const rows = state.packages.map(renderPackage).join("\n");
      const header = `mason4agents — ${state.packages.length} package(s)`;
      return rows.length > 0 ? `${header}\n${rows}` : header;
    }
  };
}

export async function openMasonPanel(ctx: unknown, bridge: CliBridge): Promise<MasonPanel> {
  const panel = createMasonPanel(bridge);
  await panel.search();
  const anyCtx = ctx as { ui?: { custom?: (factory: Function) => unknown } };
  if (typeof anyCtx.ui?.custom === "function") {
    await anyCtx.ui.custom((_tui: unknown, _theme: unknown, _keybindings: unknown, done: (result?: unknown) => void) => {
      const component = {
        dispose() {},
        render() {},
        handleInput(key: string) {
          if (key === "q" || key === "\x1b") {
            done(undefined);
          }
        },
        invalidate() {},
      };
      return component;
    });
  }
  return panel;
}

function renderPackage(value: unknown): string {
  if (typeof value !== "object" || value === null) return String(value);
  const pkg = value as { name?: unknown; version?: unknown; installed?: unknown; categories?: unknown };
  const installed = pkg.installed === true ? "installed" : "available";
  const categories = Array.isArray(pkg.categories) ? pkg.categories.join(",") : "";
  return `${String(pkg.name ?? "<unknown>")} ${String(pkg.version ?? "")} [${installed}] ${categories}`.trim();
}