"use client";

import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";

import { getPublicPlatformSiteSettings, type PlatformSiteSettings } from "../api";
import type { SubplatformConfig } from "../subplatform";

export function PlatformFooter({ subplatform }: { subplatform: SubplatformConfig }) {
  const [settings, setSettings] = useState<PlatformSiteSettings | null>(null);

  useEffect(() => {
    let mounted = true;
    setSettings(null);
    void getPublicPlatformSiteSettings(subplatform.path)
      .then((current) => {
        if (mounted) setSettings(current);
      })
      .catch(() => {
        // A deployment without the optional metadata migration simply has no public filing line.
      });
    return () => {
      mounted = false;
    };
  }, [subplatform.path]);

  return (
    <footer className="app-footer">
      <span>© {new Date().getFullYear()} {subplatform.brandName}</span>
      {subplatform.slug === "root" ? <span className="app-footer-legal"><a href="/how">如何选购</a><a href="/terms">用户协议</a><a href="/privacy">隐私政策</a></span> : null}
      {settings?.icp_number ? (
        settings.icp_record_url ? (
          <a href={settings.icp_record_url} target="_blank" rel="noreferrer">
            {settings.icp_number}<ExternalLink size={13} aria-hidden="true" />
          </a>
        ) : <span>{settings.icp_number}</span>
      ) : null}
      {settings?.public_security_number ? (
        settings.public_security_url ? (
          <a href={settings.public_security_url} target="_blank" rel="noreferrer">
            {settings.public_security_number}<ExternalLink size={13} aria-hidden="true" />
          </a>
        ) : <span>{settings.public_security_number}</span>
      ) : null}
    </footer>
  );
}
