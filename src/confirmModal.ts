import { App, ButtonComponent, Modal } from "obsidian";

/**
 * A yes/no replacement for `window.confirm`, which Obsidian's lint rules flag
 * (`no-alert`) and which is awkward to style. Renderer-global dialogs are also
 * blocked in some sandboxed builds, so a native Modal is the safe route.
 */
export class ConfirmModal extends Modal {
  private message: string;
  private onConfirm: () => void;

  constructor(app: App, message: string, onConfirm: () => void) {
    super(app);
    this.message = message;
    this.onConfirm = onConfirm;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("p", { text: this.message });
    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    new ButtonComponent(buttons)
      .setButtonText("Cancel")
      .onClick(() => this.close());
    // `.mod-warning` is the red destructive style; `setWarning` is deprecated
    // in the current API and `setDestructive` postdates the 1.7.2 minimum.
    new ButtonComponent(buttons)
      .setButtonText("Confirm")
      .setClass("mod-warning")
      .onClick(() => {
        this.close();
        this.onConfirm();
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
