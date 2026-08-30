import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getAccountProfile: vi.fn(),
  saveAccountProfile: vi.fn(),
  uploadAccountAvatar: vi.fn(),
}));

vi.mock("../api", () => api);

import { PersonalProfilePanel } from "./PersonalProfilePanel";

const profile = {
  name: "Test User",
  email: "test@example.test",
  image: null,
  bio: "",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function renderPanel(locale: "zh" | "en" = "zh") {
  const onAvatarChanged = vi.fn();
  const view = render(
    <PersonalProfilePanel locale={locale} onAvatarChanged={onAvatarChanged} />,
  );
  return { ...view, onAvatarChanged };
}

function fileInput(container: HTMLElement) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("file input not found");
  return input;
}

beforeEach(() => {
  api.getAccountProfile.mockReset().mockResolvedValue(profile);
  api.saveAccountProfile
    .mockReset()
    .mockImplementation(async ({ bio }: { bio: string }) => ({
      ...profile,
      bio,
    }));
  api.uploadAccountAvatar.mockReset().mockResolvedValue("/avatar.webp");
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:avatar-preview"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
});

describe("PersonalProfilePanel", () => {
  it("renders accessible loading and Chinese editor copy", async () => {
    const load = deferred<typeof profile>();
    api.getAccountProfile.mockReturnValue(load.promise);
    renderPanel("zh");

    expect(
      screen.getByRole("status", { name: "正在读取个人资料" }),
    ).toHaveAttribute("aria-busy", "true");

    await act(async () => load.resolve(profile));
    expect(await screen.findByLabelText("个人简介")).toHaveAttribute(
      "placeholder",
      "介绍一下你自己，例如你的兴趣、常买的品类或经营方向。",
    );
    expect(
      screen.getByRole("button", { name: "更换头像" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "展示你自己" }),
    ).not.toBeInTheDocument();
  });

  it("renders English labels, actions, and placeholders", async () => {
    renderPanel("en");

    expect(await screen.findByLabelText("Bio")).toHaveAttribute(
      "placeholder",
      "Share your interests, the categories you often buy, or what you sell.",
    );
    expect(
      screen.getByRole("button", { name: "Change avatar" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save profile" })).toBeEnabled();
  });

  it("keeps a load failure visible and retries through loading to ready", async () => {
    const retry = deferred<typeof profile>();
    api.getAccountProfile
      .mockRejectedValueOnce(null)
      .mockReturnValueOnce(retry.promise);
    renderPanel("en");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Profile could not load");
    expect(alert).toHaveTextContent(
      "Reason: Your profile is temporarily unavailable",
    );

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      screen.getByRole("status", { name: "Loading your profile" }),
    ).toHaveAttribute("aria-busy", "true");
    await act(async () => retry.resolve(profile));
    expect(await screen.findByLabelText("Bio")).toBeEnabled();
  });

  it("preserves input after a verbatim save error and reports success", async () => {
    const user = userEvent.setup();
    api.saveAccountProfile
      .mockRejectedValueOnce(new Error("server kept this exact message"))
      .mockImplementationOnce(async ({ bio }: { bio: string }) => ({
        ...profile,
        bio,
      }));
    renderPanel("en");
    const bio = await screen.findByLabelText("Bio");
    await user.type(bio, "Retain this bio");

    await user.click(screen.getByRole("button", { name: "Save profile" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "server kept this exact message",
    );
    expect(bio).toHaveValue("Retain this bio");

    await user.click(screen.getByRole("button", { name: "Save profile" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Profile saved",
    );
    expect(api.saveAccountProfile).toHaveBeenLastCalledWith({
      bio: "Retain this bio",
    });
  });

  it("accepts 500 characters and rejects an over-boundary value", async () => {
    const user = userEvent.setup();
    renderPanel("en");
    const bio = await screen.findByLabelText("Bio");
    const boundary = "a".repeat(500);
    fireEvent.change(bio, { target: { value: boundary } });
    expect(screen.getByText("500/500")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save profile" }));
    expect(api.saveAccountProfile).toHaveBeenCalledWith({ bio: boundary });

    fireEvent.change(bio, { target: { value: `${boundary}b` } });
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    expect(api.saveAccountProfile).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your bio cannot exceed 500 characters",
    );
  });

  it("validates avatar type and size before making a request", async () => {
    const user = userEvent.setup({ applyAccept: false });
    const { container, onAvatarChanged } = renderPanel("en");
    await screen.findByLabelText("Bio");
    const input = fileInput(container);

    await user.upload(
      input,
      new File(["text"], "avatar.txt", { type: "text/plain" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose an image file for your avatar",
    );

    const tooLarge = new File(["image"], "avatar.png", { type: "image/png" });
    Object.defineProperty(tooLarge, "size", { value: 4 * 1024 * 1024 + 1 });
    await user.upload(input, tooLarge);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Avatar images must be 4 MiB or smaller",
    );
    expect(api.uploadAccountAvatar).not.toHaveBeenCalled();
    expect(onAvatarChanged).not.toHaveBeenCalled();
  });

  it("cleans previews and changes the header only after avatar API success", async () => {
    const user = userEvent.setup();
    api.uploadAccountAvatar
      .mockRejectedValueOnce(new Error("avatar API unavailable"))
      .mockResolvedValueOnce("/saved-avatar.webp");
    const { container, onAvatarChanged } = renderPanel("en");
    await screen.findByLabelText("Bio");
    const input = fileInput(container);

    await user.upload(
      input,
      new File(["first"], "first.png", { type: "image/png" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "avatar API unavailable",
    );
    expect(onAvatarChanged).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:avatar-preview");

    await user.upload(
      input,
      new File(["second"], "second.png", { type: "image/png" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Avatar saved");
    expect(onAvatarChanged).toHaveBeenCalledWith("/saved-avatar.webp");
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it("uses a visible Button to invoke the hidden native file input", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel("en");
    await screen.findByLabelText("Bio");
    const input = fileInput(container);
    const click = vi.spyOn(input, "click");
    const button = screen.getByRole("button", { name: "Change avatar" });

    await user.click(button);
    expect(click).toHaveBeenCalledOnce();
    expect(button).toHaveFocus();
    expect(input).toHaveClass("hidden");
  });

  it("disables requests according to active save and upload work", async () => {
    const user = userEvent.setup();
    const save = deferred<typeof profile>();
    const upload = deferred<string>();
    api.saveAccountProfile.mockReturnValueOnce(save.promise);
    api.uploadAccountAvatar.mockReturnValueOnce(upload.promise);
    const { container } = renderPanel("en");
    const bio = await screen.findByLabelText("Bio");
    const saveButton = screen.getByRole("button", { name: "Save profile" });
    const uploadButton = screen.getByRole("button", { name: "Change avatar" });

    await user.click(saveButton);
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(bio).toBeDisabled();
    expect(uploadButton).toBeEnabled();
    await act(async () => save.resolve(profile));

    await user.upload(
      fileInput(container),
      new File(["image"], "avatar.png", { type: "image/png" }),
    );
    expect(screen.getByRole("button", { name: "Uploading…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save profile" })).toBeDisabled();
    expect(bio).toBeEnabled();
    await act(async () => upload.resolve("/avatar.webp"));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Change avatar" }),
      ).toBeEnabled(),
    );
  });
});
