import {
  App,
  ButtonComponent,
  Modal,
  Notice,
  Platform,
  Setting,
  type Plugin,
} from "obsidian";

const ISSUES_URL = "https://github.com/Stef4678/knowledge-brain/issues/new";

/** The operating system, derived from Obsidian's Platform API. */
function osName(): string {
  if (Platform.isMacOS) return "macOS";
  if (Platform.isWin) return "Windows";
  if (Platform.isLinux) return "Linux";
  if (Platform.isAndroidApp) return "Android";
  if (Platform.isIosApp) return "iOS";
  return "Unknown";
}

/** A markdown environment block appended to every bug report. */
function environmentBlock(
  app: App,
  plugin: Plugin,
  apiKeyConfigured: boolean,
): string {
  const obsidianVersion =
    (app as App & { versions?: { obsidian?: string } }).versions?.obsidian ??
    "unknown";
  const platform = Platform.isDesktopApp
    ? "Desktop"
    : Platform.isMobileApp
      ? "Mobile"
      : "Unknown";
  return [
    "## Environment",
    `- Plugin: Knowledge Brain ${plugin.manifest.version}`,
    `- Obsidian: ${obsidianVersion}`,
    `- Platform: ${platform}`,
    `- OS: ${osName()}`,
    `- API key configured: ${apiKeyConfigured ? "yes" : "no"}`,
  ].join("\n");
}

/**
 * Collects a bug description and opens a pre-filled GitHub issue carrying the
 * environment info needed to reproduce the report.
 */
export class ReportBugModal extends Modal {
  private plugin: Plugin;
  private apiKeyConfigured: boolean;
  private description = "";

  constructor(app: App, plugin: Plugin, apiKeyConfigured: boolean) {
    super(app);
    this.plugin = plugin;
    this.apiKeyConfigured = apiKeyConfigured;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Report a bug" });

    new Setting(contentEl)
      .setName("Description")
      .setDesc("What happened, what did you expect, and how can it be reproduced?")
      .addTextArea((area) => {
        area.inputEl.rows = 6;
        area.onChange((value) => {
          this.description = value;
        });
      });

    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Your plugin and environment info is attached to the issue automatically.",
    });

    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    new ButtonComponent(buttons)
      .setButtonText("Cancel")
      .onClick(() => this.close());
    new ButtonComponent(buttons)
      .setButtonText("Open issue")
      .setCta()
      .onClick(() => this.submit());
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private submit(): void {
    const description = this.description.trim();
    if (!description) {
      new Notice("Knowledge Brain: please describe the bug first.");
      return;
    }
    const body = [description, "", environmentBlock(this.app, this.plugin, this.apiKeyConfigured)].join(
      "\n",
    );
    const url = `${ISSUES_URL}?title=${encodeURIComponent("Bug report")}&body=${encodeURIComponent(body)}`;
    window.open(url, "_blank");
    this.close();
  }
}
