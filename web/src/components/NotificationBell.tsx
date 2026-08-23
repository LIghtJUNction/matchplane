"use client";

import { Bell, Check, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import {
  getUserNotifications,
  markUserNotificationsRead,
  type UserNotification,
} from "../api";
import type { InterfaceLocale } from "../lib/preferences";

export function NotificationBell({
  locale,
  userId,
}: {
  locale: InterfaceLocale;
  userId: string;
}) {
  const titleId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<UserNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const feed = await getUserNotifications(30);
        setNotifications(feed.notifications);
        setUnreadCount(feed.unreadCount);
        setError(null);
      } catch (cause) {
        if (!silent) {
          setError(
            cause instanceof Error
              ? cause.message
              : locale === "en"
                ? "Notifications unavailable"
                : "通知读取失败",
          );
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [locale],
  );

  useEffect(() => {
    setNotifications([]);
    setUnreadCount(0);
    setError(null);
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, 30_000);
    const refresh = () => void load(true);
    window.addEventListener("focus", refresh);
    window.addEventListener("matchplane:notifications-updated", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("matchplane:notifications-updated", refresh);
    };
  }, [load, userId]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const openNotification = async (notification: UserNotification) => {
    if (!notification.read) {
      try {
        const nextUnreadCount = await markUserNotificationsRead({
          id: notification.id,
        });
        setUnreadCount(nextUnreadCount);
        setNotifications((current) =>
          current.map((item) =>
            item.id === notification.id ? { ...item, read: true } : item,
          ),
        );
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : locale === "en"
              ? "Could not update notification"
              : "通知状态保存失败",
        );
        return;
      }
    }
    if (
      notification.actionPath.startsWith("/") &&
      !notification.actionPath.startsWith("//")
    ) {
      window.location.assign(notification.actionPath);
    }
  };

  const markAllRead = async () => {
    try {
      const nextUnreadCount = await markUserNotificationsRead({ all: true });
      setUnreadCount(nextUnreadCount);
      setNotifications((current) =>
        current.map((item) => ({ ...item, read: true })),
      );
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : locale === "en"
            ? "Could not update notifications"
            : "通知状态保存失败",
      );
    }
  };

  const label =
    locale === "en"
      ? unreadCount
        ? `Notifications, ${unreadCount} unread`
        : "Notifications"
      : unreadCount
        ? `通知，${unreadCount} 条未读`
        : "通知";

  return (
    <div className="notification-bell" ref={rootRef}>
      <button
        ref={buttonRef}
        className="notification-bell-trigger"
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? titleId : undefined}
        onClick={() => {
          setOpen((current) => !current);
          if (!open) void load(true);
        }}
      >
        <Bell aria-hidden="true" />
        {unreadCount ? (
          <span className="notification-count" aria-hidden="true">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        ) : null}
      </button>
      {open ? (
        <section
          className="notification-popover"
          id={titleId}
          role="dialog"
          aria-modal="false"
          aria-labelledby={`${titleId}-heading`}
        >
          <header>
            <h2 id={`${titleId}-heading`}>
              {locale === "en" ? "Notifications" : "通知"}
            </h2>
            {unreadCount ? (
              <button type="button" onClick={() => void markAllRead()}>
                <Check aria-hidden="true" />
                {locale === "en" ? "Mark all read" : "全部已读"}
              </button>
            ) : null}
          </header>
          {loading ? (
            <div className="notification-state" aria-live="polite">
              {locale === "en" ? "Loading…" : "读取中…"}
            </div>
          ) : error ? (
            <div className="notification-state is-error" role="alert">
              <span>{error}</span>
              <button type="button" onClick={() => void load()}>
                <RefreshCw aria-hidden="true" />
                {locale === "en" ? "Retry" : "重试"}
              </button>
            </div>
          ) : notifications.length ? (
            <div className="notification-list">
              {notifications.map((notification) => (
                <button
                  className={notification.read ? "is-read" : undefined}
                  type="button"
                  key={notification.id}
                  onClick={() => void openNotification(notification)}
                >
                  <span className="notification-dot" aria-hidden="true" />
                  <span>
                    <strong>{notification.title}</strong>
                    {notification.body ? (
                      <small>{notification.body}</small>
                    ) : null}
                    <time dateTime={notification.createdAt}>
                      {formatTime(notification.createdAt, locale)}
                    </time>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="notification-state">
              {locale === "en" ? "No notifications" : "暂无通知"}
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}

function formatTime(value: string, locale: InterfaceLocale): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale === "en" ? "en" : "zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
