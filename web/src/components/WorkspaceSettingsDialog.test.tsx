import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { WorkspaceSettingsDialog } from "./WorkspaceSettingsDialog";

describe("WorkspaceSettingsDialog", () => {
  it("closes from Escape and the backdrop, and restores focus", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const view = render(
      <div>
        <button type="button">Open settings</button>
        <WorkspaceSettingsDialog open={false} onClose={onClose} title="Workspace settings" description="Manage this workspace">
          <label>Workspace name<input /></label>
        </WorkspaceSettingsDialog>
      </div>,
    );

    const opener = screen.getByRole("button", { name: "Open settings" });
    opener.focus();
    view.rerender(
      <div>
        <button type="button">Open settings</button>
        <WorkspaceSettingsDialog open onClose={onClose} title="Workspace settings" description="Manage this workspace">
          <label>Workspace name<input /></label>
        </WorkspaceSettingsDialog>
      </div>,
    );
    expect(screen.getByRole("dialog", { name: "Workspace settings" })).toHaveAttribute(
      "aria-describedby",
      expect.any(String),
    );
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    view.rerender(
      <div>
        <button type="button">Open settings</button>
        <WorkspaceSettingsDialog open={false} onClose={onClose} title="Workspace settings">
          <span />
        </WorkspaceSettingsDialog>
      </div>,
    );
    expect(document.activeElement).toBe(opener);

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("uses the supplied children and closes when the backdrop is clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <WorkspaceSettingsDialog open onClose={onClose} title="Preferences">
        <p>Theme controls</p>
      </WorkspaceSettingsDialog>,
    );

    expect(screen.getByText("Theme controls")).toBeInTheDocument();
    const backdrop = document.querySelector<HTMLElement>("[data-slot='dialog-backdrop']");
    expect(backdrop).not.toBeNull();
    await user.click(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
