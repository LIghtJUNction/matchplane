"use client";

import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from "react";
import { ImagePlus, Save } from "lucide-react";

import { getMallSettings, saveMallSettings, uploadMallBrandLogo } from "../api";
import { SectionHeading } from "./Primitives";

export function MallBrandPanel({
  rootRole,
  onBrandUpdated,
  onNotice,
}: {
  rootRole?: string | null;
  onBrandUpdated?: (brand: { name: string; logoUrl: string | null }) => void;
  onNotice: (message: string) => void;
}) {
  const canEdit = rootRole === "rootSuperAdmin";
  const [name, setName] = useState("");
  const [savedName, setSavedName] = useState("");
  const [version, setVersion] = useState<number | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const previewRef = useRef<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void getMallSettings()
      .then((mall) => {
        if (!mounted) return;
        setName(mall.name);
        setSavedName(mall.name);
        setVersion(mall.version);
        setLogoUrl(mall.logoUrl ?? null);
      })
      .catch((error) => { if (mounted) onNotice(error instanceof Error ? error.message : "商城品牌读取失败"); });
    return () => {
      mounted = false;
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    };
  }, [onNotice]);

  const selectLogo = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      onNotice("请上传图片格式的 Logo");
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      onNotice("Logo 图片不能超过 4 MiB");
      return;
    }
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    const nextPreview = URL.createObjectURL(file);
    previewRef.current = nextPreview;
    setPreviewUrl(nextPreview);
    setLogoFile(file);
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canEdit) {
      onNotice("只有商城负责人可以保存品牌设置");
      return;
    }
    if (!version) return;
    const nextName = name.trim();
    if (!nextName) {
      onNotice("请填写商城名称");
      return;
    }
    setSaving(true);
    try {
      let current: { name: string; version: number; logoUrl: string | null } = { name: savedName, version, logoUrl };
      if (nextName !== savedName) {
        const updated = await saveMallSettings({ name: nextName, expectedVersion: current.version });
        current = { name: updated.name, version: updated.version, logoUrl: updated.logoUrl ?? null };
      }
      if (logoFile) {
        const updated = await uploadMallBrandLogo({ file: logoFile, expectedVersion: current.version });
        current = { name: updated.name, version: updated.version, logoUrl: updated.logoUrl ?? null };
      }
      setName(current.name);
      setSavedName(current.name);
      setVersion(current.version);
      setLogoUrl(current.logoUrl ?? null);
      setLogoFile(null);
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
      previewRef.current = null;
      setPreviewUrl(null);
      onBrandUpdated?.({ name: current.name, logoUrl: current.logoUrl });
      onNotice("商城品牌已保存，公开页会立即使用新品牌");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "商城品牌保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="surface mall-brand-panel" aria-labelledby="mall-brand-title">
      <SectionHeading eyebrow="商城品牌" title="让商城看起来像你的品牌" titleId="mall-brand-title" />
      <p className="mall-brand-intro">品牌名称和 Logo 会用于商城首页、导航、登录页与页脚。Logo 会安全转换为 WebP 保存，不使用外部图片链接。</p>
      <form className="mall-brand-form" onSubmit={save}>
        <div className="mall-brand-preview" aria-label="品牌 Logo 预览">
          {previewUrl || logoUrl ? <img src={previewUrl || logoUrl || ""} alt={`${name || "商城"} Logo`} /> : <span>{(name || "M").slice(0, 1).toUpperCase()}</span>}
        </div>
        <div className="mall-brand-fields">
          <label htmlFor="mall-brand-name"><span>品牌名</span><input id="mall-brand-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={200} required disabled={!canEdit || saving} /></label>
          <label className="mall-brand-upload"><span>品牌 Logo</span><input type="file" accept="image/png,image/jpeg,image/webp,image/avif,image/heif,image/gif" onChange={selectLogo} disabled={!canEdit || saving} /><span className="button button-light"><ImagePlus size={16} aria-hidden="true" />{logoFile ? "已选择新 Logo" : logoUrl ? "替换 Logo" : "上传 Logo"}</span><small>支持 JPG、PNG、WebP、AVIF、HEIF、GIF，最大 4 MiB。</small></label>
        </div>
        <div className="mall-brand-actions">
          <p>{canEdit ? "保存后，所有公开入口会使用新品牌。" : "只有商城负责人可以修改品牌设置。"}</p>
          <button className="button button-dark" type="submit" disabled={!canEdit || saving || !version}><Save size={16} aria-hidden="true" />{saving ? "保存中…" : "保存品牌"}</button>
        </div>
      </form>
    </section>
  );
}
