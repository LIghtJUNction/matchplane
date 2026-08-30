import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkspaceSettingsDialog } from "./WorkspaceSettingsDialog";

afterEach(() => vi.unstubAllGlobals());

describe("WorkspaceSettingsDialog", () => {
  it("restores the opener after Escape and the Close button", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const view = render(
      <div>
        <button type="button">Open settings</button>
        <WorkspaceSettingsDialog
          open={false}
          onClose={onClose}
          title="Workspace settings"
          description="Manage this workspace"
        >
          <label>
            Workspace name
            <input />
          </label>
        </WorkspaceSettingsDialog>
      </div>,
    );

    const opener = screen.getByRole("button", { name: "Open settings" });
    opener.focus();
    view.rerender(
      <div>
        <button type="button">Open settings</button>
        <WorkspaceSettingsDialog
          open
          onClose={onClose}
          title="Workspace settings"
          description="Manage this workspace"
        >
          <label>
            Workspace name
            <input />
          </label>
        </WorkspaceSettingsDialog>
      </div>,
    );
    expect(
      screen.getByRole("dialog", { name: "Workspace settings" }),
    ).toHaveAttribute("aria-describedby", expect.any(String));
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    view.rerender(
      <div>
        <button type="button">Open settings</button>
        <WorkspaceSettingsDialog
          open={false}
          onClose={onClose}
          title="Workspace settings"
        >
          <span />
        </WorkspaceSettingsDialog>
      </div>,
    );
    await waitFor(() => expect(opener).toHaveFocus());
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );

    view.rerender(
      <div>
        <button type="button">Open settings</button>
        <WorkspaceSettingsDialog
          open
          onClose={onClose}
          title="Workspace settings"
        >
          <input aria-label="Workspace name" />
        </WorkspaceSettingsDialog>
      </div>,
    );
    await screen.findByRole("dialog", { name: "Workspace settings" });
    await user.click(
      screen.getByRole("button", { name: "Close workspace settings" }),
    );
    expect(onClose).toHaveBeenCalledTimes(2);
    view.rerender(
      <div>
        <button type="button">Open settings</button>
        <WorkspaceSettingsDialog
          open={false}
          onClose={onClose}
          title="Workspace settings"
        >
          <span />
        </WorkspaceSettingsDialog>
      </div>,
    );
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("keeps complete forward and reverse natural Tab cycles inside the modal", async () => {
    const animationFrames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    const flushAnimationFrames = () => {
      for (const callback of animationFrames.splice(0)) callback(0);
    };
    const user = userEvent.setup();
    render(
      <div>
        <button type="button">Background action</button>
        <WorkspaceSettingsDialog
          open
          onClose={vi.fn()}
          title="Store console"
          navigation={[
            { id: "general", label: "General" },
            { id: "customers", label: "Customers" },
          ]}
          activeNavigationId="general"
        >
          <label>
            Store name
            <input />
          </label>
        </WorkspaceSettingsDialog>
      </div>,
    );

    const dialog = screen.getByRole("dialog", { name: "Store console" });
    await waitFor(() => expect(animationFrames.length).toBeGreaterThan(0));
    flushAnimationFrames();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    const tabbableElements = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])",
      ),
    );
    const backgroundAction = screen.getByRole("button", {
      name: "Background action",
      hidden: true,
    });
    expect(backgroundAction.closest("[aria-hidden='true']")).not.toBeNull();
    expect(
      document.querySelector<HTMLElement>(
        "[role='presentation'][data-base-ui-inert]",
      ),
    ).toHaveStyle({ position: "fixed", inset: "0" });

    for (let index = 0; index < tabbableElements.length; index += 1) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
    for (let index = 0; index < tabbableElements.length; index += 1) {
      await user.tab({ shift: true });
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
  });

  it("filters and switches real settings destinations", async () => {
    const user = userEvent.setup();
    const onNavigationChange = vi.fn();
    render(
      <WorkspaceSettingsDialog
        open
        onClose={vi.fn()}
        title="常规"
        navigation={[
          { id: "general", label: "常规" },
          { id: "account", label: "账号" },
          { id: "appearance", label: "外观" },
          { id: "notifications", label: "通知" },
          { id: "stores", label: "店铺" },
          { id: "security", label: "安全" },
        ]}
        navigationLabel="设置"
        activeNavigationId="general"
        onNavigationChange={onNavigationChange}
        searchLabel="搜索设置"
        emptyNavigationLabel="没有匹配的设置"
      >
        <p>当前设置</p>
      </WorkspaceSettingsDialog>,
    );

    expect(screen.getByRole("button", { name: "常规" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await user.click(screen.getByRole("button", { name: "账号" }));
    expect(onNavigationChange).toHaveBeenCalledWith("account");
    await user.type(screen.getByRole("searchbox", { name: "搜索设置" }), "无");
    expect(screen.getByText("没有匹配的设置")).toBeInTheDocument();
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
    const scrollRegion = screen.getByRole("region", { name: "Preferences" });
    expect(scrollRegion).toHaveAttribute("tabindex", "0");
    scrollRegion.focus();
    expect(document.activeElement).toBe(scrollRegion);
    const backdrop = document.querySelector<HTMLElement>(
      "[data-slot='dialog-backdrop']",
    );
    expect(backdrop).not.toBeNull();
    await user.click(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
