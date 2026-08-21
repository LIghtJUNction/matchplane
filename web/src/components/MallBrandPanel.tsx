"use client";

import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from "react";
import { ImagePlus, Save } from "lucide-react";

import {
  getMallLegalDocuments,
  getMallSettings,
  saveMallLegalDocuments,
  saveMallSettings,
  uploadMallBrandLogo,
} from "../api";
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
  const [termsContent, setTermsContent] = useState("");
  const [savedTermsContent, setSavedTermsContent] = useState("");
  const [privacyContent, setPrivacyContent] = useState("");
  const [savedPrivacyContent, setSavedPrivacyContent] = useState("");
  const [termsVersion, setTermsVersion] = useState<number | null>(null);
  const [privacyVersion, setPrivacyVersion] = useState<number | null>(null);
  const [legalSaving, setLegalSaving] = useState(false);
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

  useEffect(() => {
    let mounted = true;
    void getMallLegalDocuments()
      .then((legal) => {
        if (!mounted) return;
        setTermsContent(legal.documents.terms.content);
        setSavedTermsContent(legal.documents.terms.content);
        setTermsVersion(legal.documents.terms.version);
        setPrivacyContent(legal.documents.privacy.content);
        setSavedPrivacyContent(legal.documents.privacy.content);
        setPrivacyVersion(legal.documents.privacy.version);
      })
      .catch((error) => { if (mounted) onNotice(error instanceof Error ? error.message : "法律页面读取失败"); });
    return () => { mounted = false; };
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

  const saveLegal = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canEdit) {
      onNotice("只有商城负责人可以保存法律页面");
      return;
    }
    if (!termsVersion || !privacyVersion) return;
    if (!termsContent.trim() || !privacyContent.trim()) {
      onNotice("请填写用户协议和隐私政策");
      return;
    }
    if (termsContent === savedTermsContent && privacyContent === savedPrivacyContent) {
      onNotice("法律页面没有需要保存的修改");
      return;
    }
    setLegalSaving(true);
    try {
      const legal = await saveMallLegalDocuments({
        termsContent,
        privacyContent,
        termsVersion,
        privacyVersion,
      });
      setTermsContent(legal.documents.terms.content);
      setSavedTermsContent(legal.documents.terms.content);
      setTermsVersion(legal.documents.terms.version);
      setPrivacyContent(legal.documents.privacy.content);
      setSavedPrivacyContent(legal.documents.privacy.content);
      setPrivacyVersion(legal.documents.privacy.version);
      onNotice("法律页面已保存");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "法律页面保存失败");
    } finally {
      setLegalSaving(false);
    }
  };

  return (
    <section className="surface mall-brand-panel" aria-labelledby="mall-brand-title">
      <SectionHeading title="品牌" titleId="mall-brand-title" />
      <p className="mall-brand-intro">设置商城名称和 Logo。</p>
      <form className="mall-brand-form" onSubmit={save}>
        <div className="mall-brand-preview" aria-label="品牌 Logo 预览">
          {previewUrl || logoUrl ? <img src={previewUrl || logoUrl || ""} alt={`${name || "商城"} Logo`} /> : <span>{(name || "M").slice(0, 1).toUpperCase()}</span>}
        </div>
        <div className="mall-brand-fields">
          <label htmlFor="mall-brand-name"><span>品牌名</span><input id="mall-brand-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={200} required disabled={!canEdit || saving} /></label>
          <label className="mall-brand-upload"><span>品牌 Logo</span><input type="file" accept="image/png,image/jpeg,image/webp,image/avif,image/heif,image/gif" onChange={selectLogo} disabled={!canEdit || saving} /><span className="button button-light"><ImagePlus size={16} aria-hidden="true" />{logoFile ? "已选择新 Logo" : logoUrl ? "替换 Logo" : "上传 Logo"}</span><small>支持 JPG、PNG、WebP、AVIF、HEIF、GIF，最大 4 MiB。</small></label>
        </div>
        <div className="mall-brand-actions">
          <p>{canEdit ? "保存后会显示在商城首页和登录页。" : "只有商城负责人可以修改品牌设置。"}</p>
          <button className="button button-dark" type="submit" disabled={!canEdit || saving || !version}><Save size={16} aria-hidden="true" />{saving ? "保存中…" : "保存品牌"}</button>
        </div>
      </form>
      <form className="mall-brand-legal" onSubmit={saveLegal}>
        <div className="mall-brand-legal-heading">
          <div><h3>法律页面</h3><p>注册前会要求用户阅读并同意。</p></div>
          <small>公开路径：<a href="/terms" target="_blank" rel="noreferrer">/terms</a> · <a href="/privacy" target="_blank" rel="noreferrer">/privacy</a></small>
        </div>
        <div className="mall-brand-legal-editor"><div><label htmlFor="mall-terms-content">用户协议</label><button type="button" className="text-action" onClick={() => setTermsContent(initialTermsTemplate())} disabled={!canEdit || legalSaving}>恢复初始模板</button></div><textarea id="mall-terms-content" value={termsContent} onChange={(event) => setTermsContent(event.target.value)} maxLength={100000} rows={11} disabled={!canEdit || legalSaving} /></div>
        <div className="mall-brand-legal-editor"><div><label htmlFor="mall-privacy-content">隐私政策</label><button type="button" className="text-action" onClick={() => setPrivacyContent(initialPrivacyTemplate())} disabled={!canEdit || legalSaving}>恢复初始模板</button></div><textarea id="mall-privacy-content" value={privacyContent} onChange={(event) => setPrivacyContent(event.target.value)} maxLength={100000} rows={11} disabled={!canEdit || legalSaving} /></div>
        <div className="mall-brand-legal-actions"><small>{termsContent.length + privacyContent.length}/200000</small><button className="button button-dark" type="submit" disabled={!canEdit || legalSaving || !termsVersion || !privacyVersion}><Save size={16} aria-hidden="true" />{legalSaving ? "保存中…" : "保存法律页面"}</button></div>
      </form>
    </section>
  );
}

function initialTermsTemplate(): string {
  return `# 用户协议

生效日期：以本页面显示的更新时间为准。

1. 服务说明
{{mall_name}} 提供商品浏览、店铺检索、撮合与相关服务。商品的展示、价格、库存和履约信息由对应店铺负责。

2. 账号使用
请使用真实、合法的信息注册和使用账号，并妥善保管登录凭据。不得利用本服务从事违法、侵权、欺诈或干扰平台正常运行的行为。

3. 商品与交易
下单、联系店铺或线下成交前，请自行核实商品信息和交易条件。除法律另有规定外，具体交易由用户与店铺按照双方确认的条件完成。

4. 平台规则
我们可以为保障安全、合规和服务质量，对违规内容、账号或店铺采取必要措施，并会在适用法律要求的范围内告知你。

5. 联系我们
如对本协议有疑问，请通过商城公开的联系方式与我们联系。`;
}

function initialPrivacyTemplate(): string {
  return `# 隐私政策

生效日期：以本页面显示的更新时间为准。

1. 我们收集的信息
为了提供账号、商品浏览、联系撮合和安全保障服务，{{mall_name}} 可能处理你的账号资料、设备与访问记录，以及你主动提交的商品或沟通信息。

2. 信息的使用
我们仅在提供、维护和改进服务，保障交易安全，履行法定义务以及取得你同意的范围内使用这些信息。

3. 信息的共享
我们不会公开你的联系方式。只有在你和对方均明确同意、或法律法规要求时，才会按相应流程提供必要信息。

4. 信息安全
我们采取合理的技术和管理措施保护信息安全。请勿向他人泄露密码、验证码或其他登录凭据。

5. 你的权利
你可以在账号页面更新个人资料、管理登录方式和会话；也可以通过商城公开的联系方式咨询、更正或删除相关信息。

6. 政策更新
本政策更新后会在此页面公布；重大变化会以适当方式提示。`;
}
