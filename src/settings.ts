import { Notice, Plugin, PluginSettingTab, Setting, type App } from "obsidian";
import { QUESTION_TYPES, type Provider, type QuestionType, type PluginSettings } from "./types";
import { modelSupportsThinking, testProvider } from "./deepseek";

const GROUP_LABELS: Record<QuestionType, string> = {
  scientific: "Scientific",
  practical: "Practical",
  comparative: "Comparative",
  historical: "Historical",
  causal: "Causal",
  critical: "Critical",
};

const PROVIDER_LABELS: Record<Provider, string> = {
  deepseek: "DeepSeek",
  openai: "OpenAI (ChatGPT)",
  gemini: "Google Gemini",
  claude: "Anthropic Claude",
};

export const PROVIDER_BASE_URLS: Record<Provider, string> = {
  deepseek: "https://api.deepseek.com",
  openai: "https://api.openai.com",
  gemini: "https://generativelanguage.googleapis.com",
  claude: "https://api.anthropic.com",
};

export const PROVIDER_DEFAULT_MODELS: Record<Provider, string> = {
  deepseek: "deepseek-v4-flash",
  openai: "gpt-5.6-mini",
  gemini: "gemini-2.5-flash",
  claude: "claude-sonnet-5",
};

export const PROVIDER_MODELS: Record<Provider, string[]> = {
  deepseek: ["deepseek-v4-flash", "deepseek-v4-pro"],
  openai: [
    "gpt-4.1",
    "gpt-4.1-mini",
    "o3-mini",
    "gpt-5",
    "gpt-5-mini",
    "gpt-5.6",
    "gpt-5.6-mini",
  ],
  gemini: [
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-pro-preview",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-1.5-pro",
  ],
  claude: ["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
};

export const DEFAULT_SETTINGS: PluginSettings = {
  apiKey: "",
  provider: "deepseek",
  model: "deepseek-v4-flash",
  temperature: 1.0,
  thinking: true,
  defaultFolder: "",
  graphSpacing: 3,
  tagSeparator: "-",
  enableAiTags: true,
  enableAiStatus: true,
  combineSidebarPanes: false,
  followupCount: 2,
  followupGroups: Object.fromEntries(
    QUESTION_TYPES.map((q) => [q, true]),
  ) as Record<QuestionType, boolean>,
  supportUrl: "https://www.buymeacoffee.com/Stef4678",
};

/**
 * A throwable carrying a user-facing message. Thrown by the DeepSeek client
 * and converted to chat UI errors / notices by the caller.
 */
export class KbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KbError";
  }
}

/** True when a DeepSeek key is configured (empty key is treated as missing). */
export function hasApiKey(settings: PluginSettings): boolean {
  return settings.apiKey.trim().length > 0;
}

/** Throw a KbError with a user-facing message for a non-2xx AI provider response. */
export function errorFromResponse(status: number, text: string): KbError {
  let detail = "";
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.error === "object" && parsed.error !== null) {
      detail = String((parsed.error as Record<string, unknown>).message ?? "");
    } else if (typeof parsed === "object") {
      detail = JSON.stringify(parsed);
    }
  } catch {
    detail = text;
  }
  return new KbError(`The AI provider returned ${status}: ${detail || "unknown error"}`);
}

export class KnowledgeBrainSettingsTab extends PluginSettingTab {
  private settings: PluginSettings;
  private onChange: (s: PluginSettings) => void;
  private onReset: () => Promise<void>;

  constructor(
    app: App,
    plugin: Plugin,
    settings: PluginSettings,
    onChange: (s: PluginSettings) => void,
    onReset: () => Promise<void>,
  ) {
    super(app, plugin);
    this.settings = settings;
    this.onChange = onChange;
    this.onReset = onReset;
  }

  private set<K extends keyof PluginSettings>(key: K, value: PluginSettings[K]) {
    this.settings = { ...this.settings, [key]: value };
    this.onChange(this.settings);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Knowledge Brain", cls: "kb-settings-title" });
    containerEl.createEl("p", {
      text: "Knowledge Brain turns your markdown notes into a connected knowledge graph. Notes become “thoughts” linked through `parents:` frontmatter and visualized in an interactive graph. Chat with your notes, get AI-assisted tag and status suggestions, and receive follow-up questions to deepen your thinking.",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("Support Knowledge Base")
      .setDesc("If you find Knowledge Base useful, consider supporting its development!")
      .addButton((button) =>
        button.setButtonText("Buy Me a Coffee").setCta().onClick(() => {
          const url = this.settings.supportUrl || DEFAULT_SETTINGS.supportUrl;
          if (url) {
            window.open(url, "_blank");
          }
        }),
      );

    new Setting(containerEl)
      .setName("Provider")
      .setDesc("Which AI provider powers chat and AI-assisted ops.")
      .addDropdown((dropdown) => {
        for (const p of Object.keys(PROVIDER_LABELS) as Provider[]) {
          dropdown.addOption(p, PROVIDER_LABELS[p]);
        }
        dropdown.setValue(this.settings.provider).onChange(async (value) => {
          const provider = value as Provider;
          const known = PROVIDER_MODELS[provider];
          const current = this.settings.model;
          // Claude's temperature range is 0–1; clamp a saved higher value.
          const temperature =
            provider === "claude" ? Math.min(this.settings.temperature, 1) : this.settings.temperature;
          if (!known.includes(current)) {
            this.settings = {
              ...this.settings,
              provider,
              model: PROVIDER_DEFAULT_MODELS[provider],
              temperature,
            };
            await this.onChange(this.settings);
          } else if (temperature !== this.settings.temperature) {
            this.settings = { ...this.settings, provider, temperature };
            await this.onChange(this.settings);
          } else {
            this.set("provider", provider);
          }
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("API key")
      .setDesc("Required for chat and AI-assisted ops.")
      .addText((text) =>
        text
          .setPlaceholder("sk-...")
          .setValue(this.settings.apiKey)
          .onChange(async (value) => {
            this.set("apiKey", value.trim());
          }),
      );

    new Setting(containerEl)
      .setName("Model")
      .setDesc(`Model id for ${PROVIDER_LABELS[this.settings.provider]}. Pick a known one below, or type a custom id in the box.`)
      .addText((text) =>
        text
          .setPlaceholder("custom model id")
          .onChange(async (value) => {
            this.set("model", value.trim() || PROVIDER_DEFAULT_MODELS[this.settings.provider]);
          }),
      )
      .addDropdown((dropdown) => {
        const models = PROVIDER_MODELS[this.settings.provider];
        if (!models.includes(this.settings.model)) {
          dropdown.addOption(this.settings.model, `${this.settings.model} (custom)`);
        }
        for (const m of models) {
          dropdown.addOption(m, m);
        }
        dropdown.setValue(this.settings.model);
        dropdown.onChange(async (value) => {
          this.set("model", value);
        });
      });

    new Setting(containerEl)
      .setName("Temperature")
      .setDesc(
        this.settings.provider === "claude"
          ? "Chat sampling temperature (0–1)."
          : "Chat sampling temperature (0–2).",
      )
      .addSlider((slider) => {
        const max = this.settings.provider === "claude" ? 1 : 2;
        const value = Math.min(this.settings.temperature, max);
        slider
          .setLimits(0, max, 0.1)
          .setValue(value)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.set("temperature", v);
          });
      });

    new Setting(containerEl)
      .setName("Thinking mode")
      .setDesc(
        modelSupportsThinking(this.settings.provider, this.settings.model)
          ? `Reasoning is on for ${this.settings.model}. Stays on until you turn it off.`
          : `${this.settings.model} does not support thinking mode, so this setting is ignored for it.`,
      )
      .addToggle((toggle) => {
        toggle.setValue(this.settings.thinking).onChange(async (value) => {
          this.set("thinking", value);
        });
        toggle.setDisabled(
          !modelSupportsThinking(this.settings.provider, this.settings.model),
        );
      });

    new Setting(containerEl)
      .setName("Default folder for new thoughts")
      .setDesc(
        "Folder inside the vault where new thoughts are created (e.g. Thoughts). Leave empty for the vault root.",
      )
      .addText((text) =>
        text
          .setPlaceholder("Thoughts")
          .setValue(this.settings.defaultFolder)
          .onChange(async (value) => {
            this.set("defaultFolder", value.trim());
          }),
      );

    new Setting(containerEl)
      .setName("Graph node spacing")
      .setDesc("Distance between nodes in the graph (0.6 = dense, 6 = spread out).")
      .addSlider((slider) =>
        slider
          .setLimits(0.6, 6, 0.1)
          .setValue(this.settings.graphSpacing)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.set("graphSpacing", value);
          }),
      );

    new Setting(containerEl)
      .setName("Tag word separator")
      .setDesc("Separator used between words in multi-word tags, e.g. machine-learning vs machine_learning.")
      .addDropdown((dropdown) => {
        dropdown.addOption("-", "hyphen (-)");
        dropdown.addOption("_", "underscore (_)");
        dropdown.setValue(this.settings.tagSeparator).onChange(async (value) => {
          this.set("tagSeparator", value as "-" | "_");
        });
      });

    new Setting(containerEl)
      .setName("AI tag suggestions")
      .setDesc("Allow AI to suggest tags for a thought. Off hides the Suggest tags option.")
      .addToggle((toggle) =>
        toggle.setValue(this.settings.enableAiTags).onChange(async (value) => {
          this.set("enableAiTags", value);
        }),
      );

    new Setting(containerEl)
      .setName("AI status suggestions")
      .setDesc("Allow AI to suggest a status for a thought. Off hides the Suggest status option.")
      .addToggle((toggle) =>
        toggle.setValue(this.settings.enableAiStatus).onChange(async (value) => {
          this.set("enableAiStatus", value);
        }),
      );

    new Setting(containerEl)
      .setName("Follow-ups, siblings & backlinks in one page")
      .setDesc(
        "Show follow-up questions, siblings, and backlinks of the active note in a single right-sidebar tab. Off keeps them as separate tabs.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.settings.combineSidebarPanes)
          .onChange(async (value) => {
            this.set("combineSidebarPanes", value);
          }),
      );

    containerEl.createEl("h3", { text: "Follow-up questions" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Choose which question groups are generated for a thought, and how many questions each enabled group gets.",
    });

    for (const group of QUESTION_TYPES) {
      new Setting(containerEl)
        .setName(GROUP_LABELS[group])
        .addToggle((toggle) =>
          toggle
            .setValue(this.settings.followupGroups[group])
            .onChange(async (value) => {
              this.set("followupGroups", {
                ...this.settings.followupGroups,
                [group]: value,
              });
            }),
        );
    }

    new Setting(containerEl)
      .setName("Questions per group")
      .setDesc("Number of follow-up questions generated for each enabled group.")
      .addDropdown((dropdown) => {
        for (let n = 1; n <= 5; n++) {
          dropdown.addOption(String(n), `${n}`);
        }
        dropdown.setValue(String(this.settings.followupCount)).onChange(async (value) => {
          this.set("followupCount", Number(value));
        });
      });

    new Setting(containerEl)
      .setName("API key status")
      .addButton((button) =>
        button.setButtonText("Test connection").onClick(async () => {
          const s = this.settings;
          if (!hasApiKey(s)) {
            new Notice("Knowledge Brain: no API key configured.");
            return;
          }
          try {
            const summary = await testProvider(s);
            new Notice(`Knowledge Brain: ${summary}`);
          } catch (e) {
            new Notice(`Knowledge Brain: ${e instanceof Error ? e.message : String(e)}`);
          }
        }),
      );

    new Setting(containerEl)
      .setName("Reset settings")
      .setDesc("Restore all Knowledge Brain settings to their defaults.")
      .addButton((button) =>
        button.setButtonText("Reset").onClick(async () => {
          if (
            window.confirm(
              "Reset all Knowledge Brain settings to their defaults? This cannot be undone.",
            )
          ) {
            await this.onReset();
            this.display();
          }
        }),
      );
  }
}
