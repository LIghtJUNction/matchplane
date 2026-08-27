import { useState, type ComponentProps, type ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { appCopy, type AccountSettingsSection } from "../../hooks/useSubplatformRoute";
import type { StoreConsoleContext } from "../../hooks/useOwnedStores";
import type { AssetListing } from "../../types";
import type { PlatformOverlaysHost as PlatformOverlaysHostType } from "./PlatformOverlaysHost";

const deferredModules = vi.hoisted(() => {
  const create = () => {
    let finish!: (module: Record<string, unknown>) => void;
    let requestCount = 0;
    const module = new Promise<Record<string, unknown>>((resolve) => {
      finish = resolve;
    });
    return {
      request: () => {
        requestCount += 1;
        return module;
      },
      requests: () => requestCount,
      resolve: (value: Record<string, unknown>) => finish(value),
    };
  };

  return {
    listing: create(),
    storeConsole: create(),
    profile: create(),
    password: create(),
    identities: create(),
    passkeys: create(),
    sessions: create(),
    stores: create(),
  };
});

vi.mock("../ListingSheet", () => deferredModules.listing.request());
vi.mock("../SubplatformAdminDashboard", () =>
  deferredModules.storeConsole.request(),
);
vi.mock("../PersonalProfilePanel", () => deferredModules.profile.request());
vi.mock("../ChangePasswordPanel", () => deferredModules.password.request());
vi.mock("../IdentityBindingsPanel", () =>
  deferredModules.identities.request(),
);
vi.mock("../PasskeyPanel", () => deferredModules.passkeys.request());
vi.mock("../SessionPanel", () => deferredModules.sessions.request());
vi.mock("../HostedStoreOnboarding", () => deferredModules.stores.request());

const { PlatformOverlaysHost } = await import("./PlatformOverlaysHost");

type HostProps = ComponentProps<typeof PlatformOverlaysHostType>;

const subplatform = {
  slug: "root",
  path: "/",
  brandName: "MatchPlane",
  label: "MatchPlane",
  description: "Marketplace",
} as const;

const store = {
  id: "store-1",
  slug: "store-one",
  path: "/store-one",
  displayName: "Store One",
  description: "Test store",
  integrationKind: "hosted",
  membershipRole: "owner",
} as const;

const storeConsoleContext: StoreConsoleContext = {
  subplatform: { ...subplatform, ...store, brandName: store.displayName },
  store,
};

const listing: AssetListing = {
  id: "listing-1",
  title: "Deferred listing",
  subtitle: "Store One",
  price: "CNY 10.00",
  accent: "cactus",
  facts: [],
};

function baseProps(overrides: Partial<HostProps> = {}): HostProps {
  return {
    authUser: {
      id: "user-1",
      name: "Test User",
      email: "test@example.com",
    },
    role: "buyer",
    locale: "en",
    theme: "light",
    palette: "ink",
    textSize: "default",
    onThemeChange: vi.fn(),
    onLocaleChange: vi.fn(),
    onPaletteChange: vi.fn(),
    onTextSizeChange: vi.fn(),
    subplatform,
    fullscreenPlugin: false,
    storeConsoleOpen: false,
    setStoreConsoleOpen: vi.fn(),
    storeConsoleSection: "products",
    storeConsoleContext,
    setStoreConsoleContext: vi.fn(),
    canManageStoreConsole: true,
    ownedStores: [store],
    setOwnedStores: vi.fn(),
    ownedStoresError: null,
    ownedStoresResolved: true,
    openStoreConsoleFor: vi.fn(async () => undefined),
    accountSettingsSection: null,
    setAccountSettingsSection: vi.fn(),
    setAuthUser: vi.fn(),
    onSignOut: vi.fn(),
    listing: null,
    closeListing: vi.fn(),
    onContactListing: vi.fn(async () => undefined),
    modeDialogOpen: false,
    closeModeDialog: vi.fn(),
    paymentMode: "test",
    confirmModeChange: vi.fn(),
    notice: null,
    setNotice: vi.fn(),
    ui: appCopy("en"),
    ...overrides,
  };
}

function Marker({ children }: { children: ReactNode }) {
  return <p>{children}</p>;
}

function StatefulMarker({ children }: { children: ReactNode }) {
  const [count, setCount] = useState(0);
  return (
    <button type="button" onClick={() => setCount((value) => value + 1)}>
      {children} · {count}
    </button>
  );
}

function AccountSettingsHarness() {
  const [section, setSection] = useState<AccountSettingsSection | null>(null);
  const [locale, setLocale] = useState<"en" | "zh">("en");
  return (
    <>
      <button
        className="profile-button"
        type="button"
        onClick={() => setSection("profile")}
      >
        Open account settings
      </button>
      <PlatformOverlaysHost
        {...baseProps({
          locale,
          ui: appCopy(locale),
          onLocaleChange: setLocale,
          accountSettingsSection: section,
          setAccountSettingsSection: setSection,
        })}
      />
    </>
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("PlatformOverlaysHost deferred panels", () => {
  it("keeps closed overlays unloaded, loads account branches on demand, and restores focus", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    render(<AccountSettingsHarness />);

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(
      Object.values(deferredModules).map((module) => module.requests()),
    ).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);

    const opener = screen.getByRole("button", {
      name: "Open account settings",
    });
    await user.click(opener);

    expect(await screen.findByRole("status")).toHaveAccessibleName("Loading…");
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    deferredModules.profile.resolve({
      PersonalProfilePanel: () => <Marker>Profile panel ready</Marker>,
    });
    expect(await screen.findByText("Profile panel ready")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Account" }));
    expect(
      screen.getByRole("tab", { name: "Security", selected: true }),
    ).toHaveClass("min-h-11");
    expect(
      screen.queryByRole("tab", { name: "Appearance", selected: true }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Display and language")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole("status")).toHaveLength(4));
    deferredModules.password.resolve({
      ChangePasswordPanel: () => (
        <StatefulMarker>Password panel ready</StatefulMarker>
      ),
    });
    deferredModules.identities.resolve({
      IdentityBindingsPanel: () => <Marker>Identity panel ready</Marker>,
    });
    deferredModules.passkeys.resolve({
      PasskeyPanel: () => <Marker>Passkey panel ready</Marker>,
    });
    deferredModules.sessions.resolve({
      SessionPanel: () => <Marker>Session panel ready</Marker>,
    });
    const passwordPanel = await screen.findByRole("button", {
      name: "Password panel ready · 0",
    });
    expect(screen.getByText("Identity panel ready")).toBeInTheDocument();
    expect(screen.getByText("Passkey panel ready")).toBeInTheDocument();
    expect(screen.getByText("Session panel ready")).toBeInTheDocument();
    await user.click(passwordPanel);
    expect(passwordPanel).toHaveAccessibleName("Password panel ready · 1");

    await user.click(screen.getByRole("tab", { name: "Appearance" }));
    expect(
      screen.getByRole("tab", { name: "Appearance", selected: true }),
    ).toHaveClass("min-h-11");
    expect(screen.getByText("Display and language")).toBeInTheDocument();
    expect(
      document.getElementById("workspace-account-security-panel"),
    ).not.toBeVisible();
    expect(
      [
        deferredModules.password,
        deferredModules.identities,
        deferredModules.passkeys,
        deferredModules.sessions,
      ].map((module) => module.requests()),
    ).toEqual([1, 1, 1, 1]);

    await user.click(screen.getByRole("button", { name: "中文" }));
    expect(
      screen.getByRole("tab", { name: "外观", selected: true }),
    ).toBeInTheDocument();
    expect(screen.getByText("显示与语言")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "安全" }));
    expect(passwordPanel).toBeVisible();
    expect(passwordPanel).toHaveAccessibleName("Password panel ready · 1");

    await user.click(screen.getByRole("tab", { name: "外观" }));
    await user.click(screen.getByRole("button", { name: "English" }));
    expect(screen.getByRole("tab", { name: "Security" })).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /^My stores/ }),
    );
    expect(await screen.findByRole("status")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    deferredModules.stores.resolve({
      HostedStoreOnboarding: () => <Marker>Stores panel ready</Marker>,
    });
    expect(await screen.findByText("Stores panel ready")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close my stores" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
    expect(deferredModules.listing.requests()).toBe(0);
    expect(deferredModules.storeConsole.requests()).toBe(0);
  });

  it("loads the store console and listing only when each overlay opens", async () => {
    const user = userEvent.setup();
    const setStoreConsoleOpen = vi.fn();
    const closeListing = vi.fn();
    const view = render(
      <PlatformOverlaysHost
        {...baseProps({ setStoreConsoleOpen, closeListing })}
      />,
    );

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(deferredModules.storeConsole.requests()).toBe(0);
    expect(deferredModules.listing.requests()).toBe(0);

    view.rerender(
      <PlatformOverlaysHost
        {...baseProps({
          storeConsoleOpen: true,
          setStoreConsoleOpen,
          closeListing,
          locale: "zh",
        })}
      />,
    );
    expect(await screen.findByRole("status")).toHaveAccessibleName("正在加载…");
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    deferredModules.storeConsole.resolve({
      SubplatformAdminDashboard: () => (
        <Marker>Store console panel ready</Marker>
      ),
    });
    expect(
      await screen.findByText("Store console panel ready"),
    ).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(setStoreConsoleOpen).toHaveBeenCalledWith(false));

    view.rerender(
      <PlatformOverlaysHost
        {...baseProps({ listing, setStoreConsoleOpen, closeListing })}
      />,
    );
    expect(await screen.findByRole("status")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    deferredModules.listing.resolve({
      ListingSheet: ({ onClose }: { onClose: () => void }) => (
        <button type="button" onClick={onClose}>
          Close deferred listing
        </button>
      ),
    });
    await user.click(
      await screen.findByRole("button", { name: "Close deferred listing" }),
    );
    expect(closeListing).toHaveBeenCalledTimes(1);
  });
});
