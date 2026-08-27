"use client";

import { Button } from "@appica/ui-react/button";
import { type SyntheticEvent, useEffect, useState } from "react";
import { Search, Save, ShieldCheck } from "lucide-react";

import {
  getPlatformSiteSettings,
  isLiveMarketplaceEnabled,
  lookupPlatformSiteSettings,
  savePlatformSiteSettings,
  type PlatformSiteSettings,
} from "../api";
import { SectionHeading } from "./Primitives";

interface PlatformSiteSettingsPanelProps {
  organizationId?: string;
  platformPath: string;
  platformName: string;
  onNotice: (message: string) => void;
}

/** A small, platform-scoped legal metadata editor shared by root and child administrators. */
export function PlatformSiteSettingsPanel({
  organizationId,
  platformPath,
  platformName,
  onNotice,
}: PlatformSiteSettingsPanelProps) {
  const [settings, setSettings] = useState<PlatformSiteSettings | null>(null);
  const [icpNumber, setIcpNumber] = useState("");
  const [icpSubject, setIcpSubject] = useState("");
  const [icpRecordUrl, setIcpRecordUrl] = useState("");
  const [publicSecurityNumber, setPublicSecurityNumber] = useState("");
  const [publicSecurityUrl, setPublicSecurityUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);

  useEffect(() => {
    if (!organizationId || !isLiveMarketplaceEnabled()) return;
    let mounted = true;
    setLoading(true);
    void getPlatformSiteSettings(organizationId)
      .then((current) => {
        if (!mounted) return;
        applySettings(current);
      })
      .catch(() => {
        // A missing row is a normal first-run state. The form remains available for the first save.
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [organizationId]);

  const save = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!organizationId) {
      onNotice("当前平台尚未完成身份注册，暂时不能保存备案信息");
      return;
    }
    if (!isLiveMarketplaceEnabled()) {
      onNotice("当前环境未启用真实平台 API，备案信息没有写入系统");
      return;
    }
    setSaving(true);
    try {
      const updated = await savePlatformSiteSettings({
        organizationId,
        icpNumber,
        icpSubject,
        icpRecordUrl,
        publicSecurityNumber,
        publicSecurityUrl,
        expectedVersion: settings?.version,
      });
      applySettings(updated);
      onNotice("备案信息已保存；公开页会在下一次读取时展示");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "备案信息保存失败");
    } finally {
      setSaving(false);
    }
  };

  const lookup = async () => {
    if (!organizationId) {
      onNotice("当前平台尚未完成身份注册，暂时不能查询备案");
      return;
    }
    if (!isLiveMarketplaceEnabled()) {
      onNotice("当前环境未启用真实平台 API，自动查询没有执行");
      return;
    }
    setLookingUp(true);
    try {
      const result = await lookupPlatformSiteSettings({
        organizationId,
        platformPath,
        hostname:
          typeof window === "undefined" ? undefined : window.location.hostname,
      });
      setIcpNumber(result.icp_number ?? "");
      setIcpSubject(result.icp_subject ?? "");
      setIcpRecordUrl(result.icp_record_url ?? "");
      setPublicSecurityNumber(result.public_security_number ?? "");
      setPublicSecurityUrl(result.public_security_url ?? "");
      onNotice("已取得查询服务返回值，请核对后保存");
    } catch (error) {
      onNotice(
        error instanceof Error ? error.message : "自动查询失败，请手动填写",
      );
    } finally {
      setLookingUp(false);
    }
  };

  return (
    <section
      className="surface site-settings-panel"
      aria-labelledby="site-settings-title"
    >
      <div className="site-settings-heading">
        <SectionHeading eyebrow="网站与合规" title="备案信息" />
        <Button
          className="site-settings-lookup min-h-11"
          variant="outline"
          size="md"
          type="button"
          onClick={() => void lookup()}
          disabled={lookingUp || loading}
        >
          <Search size={16} aria-hidden="true" />
          {lookingUp ? "查询中…" : "自动查询当前域名"}
        </Button>
      </div>
      <p className="site-settings-intro">
        {platformName}{" "}
        的公开备案资料由商城负责人确认后发布。自动查询只连接服务器端配置的查询服务，不会把域名或凭据交给浏览器外的未知网站。
      </p>
      <form className="site-settings-form" onSubmit={save}>
        <label htmlFor="site-icp-number">
          <span>ICP备案号</span>
          <input
            className="min-h-11"
            id="site-icp-number"
            value={icpNumber}
            onChange={(event) => setIcpNumber(event.target.value)}
            placeholder="例如：京ICP备00000000号"
            maxLength={128}
          />
        </label>
        <label htmlFor="site-icp-subject">
          <span>备案主体</span>
          <input
            className="min-h-11"
            id="site-icp-subject"
            value={icpSubject}
            onChange={(event) => setIcpSubject(event.target.value)}
            placeholder="公司或个人主体名称"
            maxLength={200}
          />
        </label>
        <label htmlFor="site-icp-url">
          <span>备案查询链接（可选）</span>
          <input
            className="min-h-11"
            id="site-icp-url"
            type="url"
            value={icpRecordUrl}
            onChange={(event) => setIcpRecordUrl(event.target.value)}
            placeholder="https://…"
            inputMode="url"
          />
        </label>
        <label htmlFor="site-psb-number">
          <span>公安备案号（可选）</span>
          <input
            className="min-h-11"
            id="site-psb-number"
            value={publicSecurityNumber}
            onChange={(event) => setPublicSecurityNumber(event.target.value)}
            placeholder="例如：京公网安备00000000000000号"
            maxLength={128}
          />
        </label>
        <label htmlFor="site-psb-url">
          <span>公安备案链接（可选）</span>
          <input
            className="min-h-11"
            id="site-psb-url"
            type="url"
            value={publicSecurityUrl}
            onChange={(event) => setPublicSecurityUrl(event.target.value)}
            placeholder="https://…"
            inputMode="url"
          />
        </label>
        <div className="site-settings-actions">
          <p>
            <ShieldCheck size={16} aria-hidden="true" />
            {settings?.configured ? "当前已发布备案资料" : "尚未发布备案资料"}
            {settings?.lookup_checked_at
              ? ` · 最近查询 ${formatDate(settings.lookup_checked_at)}`
              : ""}
          </p>
          <Button
            className="min-h-11"
            variant="primary"
            size="md"
            type="submit"
            disabled={saving || loading}
          >
            <Save size={16} aria-hidden="true" />
            {saving ? "保存中…" : "保存备案信息"}
          </Button>
        </div>
      </form>
    </section>
  );

  function applySettings(current: PlatformSiteSettings) {
    setSettings(current);
    setIcpNumber(current.icp_number ?? "");
    setIcpSubject(current.icp_subject ?? "");
    setIcpRecordUrl(current.icp_record_url ?? "");
    setPublicSecurityNumber(current.public_security_number ?? "");
    setPublicSecurityUrl(current.public_security_url ?? "");
  }
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("zh-CN");
}
