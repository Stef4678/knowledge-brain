/**
 * Minimal Obsidian stub used only by the Node smoke tests (test/kb-test.ts).
 * Implements just enough of the vault/metadata API for KnowledgeBase to run
 * against an in-memory map of files.
 */
import { parse as yamlParse, stringify as yamlStringify } from "yaml";

// The plugin uses `window.setTimeout` etc. (per Obsidian's lint rules), but the
// smoke tests run in Node where `window` does not exist. Point it at the global
// scope so the tests exercise the same code paths.
(globalThis as Record<string, unknown>).window = globalThis;

export type App = unknown;
export type EventRef = { id: number };
export type TAbstractFile = TFile | { path: string };
export type WorkspaceLeaf = unknown;
export type RequestUrlParam = unknown;

export function parseYaml(text: string): unknown {
  try {
    return yamlParse(text);
  } catch {
    return null;
  }
}

export function stringifyYaml(value: unknown): string {
  return yamlStringify(value, { lineWidth: -1 });
}

export function normalizePath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/(^\/+|\/+$)/g, "");
}

export class Notice {
  constructor(_message: string | DocumentFragment) {}
}

export function requestUrl(): never {
  throw new Error("requestUrl not implemented in test stub");
}

export function requireApiVersion(_version: string): boolean {
  return false;
}

export class Plugin {
  manifest = { id: "stub", name: "Stub", version: "0.0.0" };
}

export class PluginSettingTab {
  app: unknown;
  containerEl: unknown;
  constructor(app: unknown, _plugin: unknown) {
    this.app = app;
    this.containerEl = {};
  }
  display(): void {}
}

export class Setting {
  constructor(_el: unknown) {}
  setName(): this {
    return this;
  }
  setDesc(): this {
    return this;
  }
  addText(): this {
    return this;
  }
  addSlider(): this {
    return this;
  }
  addToggle(): this {
    return this;
  }
  addButton(): this {
    return this;
  }
}

// Exported because settings.ts → reportBugModal.ts / confirmModal.ts imports
// them; the smoke tests never open a modal, so these are shape-only stubs.
export const Platform = {
  isDesktopApp: false,
  isMobileApp: false,
  isMacOS: false,
  isWin: true,
  isLinux: false,
  isAndroidApp: false,
  isIosApp: false,
};

export class ButtonComponent {
  constructor(_containerEl: unknown) {}
  setButtonText(_text: string): this {
    return this;
  }
  setClass(_cls: string): this {
    return this;
  }
  onClick(_cb: () => void): this {
    return this;
  }
}

export class Modal {
  app: unknown;
  contentEl = {
    createEl: (_tag: string, opts?: Record<string, unknown>) => ({
      textContent: typeof opts?.text === "string" ? opts.text : "",
    }),
    createDiv: () => ({}),
    empty: () => {},
  };

  constructor(app: unknown) {
    this.app = app;
  }
  open(): void {}
  close(): void {}
  onOpen(): void {}
  onClose(): void {}
}

let refId = 0;

export class TFile {
  path: string;
  stat: { mtime: number; ctime: number } | null = null;

  constructor(path: string, mtime = Date.now()) {
    this.path = path;
    this.stat = { mtime, ctime: mtime };
  }

  get basename(): string {
    return this.path.split("/").pop()!.replace(/\.md$/, "");
  }

  get extension(): string {
    return this.path.endsWith(".md") ? "md" : "";
  }
}

export class FakeVault {
  files = new Map<string, string>();

  set(path: string, content: string): void {
    this.files.set(path, content);
  }

  getMarkdownFiles(): TFile[] {
    return [...this.files.keys()]
      .filter((p) => p.endsWith(".md") && !p.startsWith(".obsidian/"))
      .map((p) => new TFile(p));
  }

  getAbstractFileByPath(path: string): TFile | null {
    return this.files.has(path) ? new TFile(path) : null;
  }

  async cachedRead(file: TFile): Promise<string> {
    return this.files.get(file.path) ?? "";
  }

  async modify(file: TFile, text: string): Promise<void> {
    this.files.set(file.path, text);
  }

  async create(path: string, text: string): Promise<TFile> {
    if (this.files.has(path)) {
      throw new Error(`File already exists: ${path}`);
    }
    this.files.set(path, text);
    return new TFile(path);
  }

  async rename(file: TFile, newPath: string): Promise<void> {
    const text = this.files.get(file.path);
    this.files.delete(file.path);
    if (text !== undefined) {
      this.files.set(newPath, text);
    }
  }

  async delete(file: TFile): Promise<void> {
    this.files.delete(file.path);
  }

  async trashFile(file: TFile): Promise<void> {
    this.files.delete(file.path);
  }

  async createFolder(path: string): Promise<unknown> {
    // Folders are implicit in the files map; nothing to create in the stub.
    return { path };
  }

  adapter = {
    remove: async (path: string): Promise<void> => {
      this.files.delete(path);
    },
  };

  on(): EventRef {
    return { id: ++refId };
  }

  offref(): void {}
}

export function fakeApp(vault: FakeVault): {
  vault: FakeVault;
  fileManager: { trashFile(file: TFile): Promise<void> };
  metadataCache: { on(): EventRef; offref(): void };
} {
  return {
    vault,
    fileManager: { trashFile: (file: TFile) => vault.trashFile(file) },
    metadataCache: {
      on: () => ({ id: ++refId }),
      offref: () => {},
    },
  };
}
