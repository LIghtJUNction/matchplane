"use client";

import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from "react";
import { ImagePlus, Save, UserRound } from "lucide-react";

import { getAccountProfile, saveAccountProfile, uploadAccountAvatar, type AccountProfile } from "../api";

export function PersonalProfilePanel({ onAvatarChanged, onNotice }: { onAvatarChanged: (image: string | null) => void; onNotice: (message: string) => void }) {
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [bio, setBio] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const previewRef = useRef<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void getAccountProfile()
      .then((next) => {
        if (!mounted) return;
        setProfile(next);
        setBio(next.bio);
      })
      .catch((error) => { if (mounted) onNotice(error instanceof Error ? error.message : "个人资料读取失败"); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => {
      mounted = false;
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    };
  }, [onNotice]);

  const uploadAvatar = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      onNotice("请上传图片格式的头像");
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      onNotice("头像图片不能超过 4 MiB");
      return;
    }
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    const preview = URL.createObjectURL(file);
    previewRef.current = preview;
    setPreviewUrl(preview);
    setUploading(true);
    try {
      const image = await uploadAccountAvatar(file);
      setProfile((current) => current ? { ...current, image } : current);
      onAvatarChanged(image);
      onNotice("头像已保存");
    } catch (error) {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
      previewRef.current = null;
      setPreviewUrl(null);
      onNotice(error instanceof Error ? error.message : "头像保存失败");
    } finally {
      setUploading(false);
    }
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (bio.trim().length > 500) {
      onNotice("个人简介不能超过 500 个字符");
      return;
    }
    setSaving(true);
    try {
      const updated = await saveAccountProfile({ bio });
      setProfile(updated);
      setBio(updated.bio);
      onNotice("个人资料已保存");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "个人资料保存失败");
    } finally {
      setSaving(false);
    }
  };

  const avatar = previewUrl || profile?.image || null;
  return (
    <section className="personal-profile-panel" aria-labelledby="personal-profile-title">
      <div className="personal-profile-heading">
        <div>
          <p className="eyebrow">个人资料</p>
          <h3 id="personal-profile-title">展示你自己</h3>
          <p>头像和简介属于你的账号，不会被当作联系方式自动公开。</p>
        </div>
      </div>
      <div className="personal-profile-identity">
        <span className="personal-profile-avatar">{avatar ? <img src={avatar} alt="当前头像" /> : <UserRound size={24} aria-hidden="true" />}</span>
        <span><strong>{profile?.name || "正在读取…"}</strong><small>{profile?.email || ""}</small></span>
        <label className="button button-light personal-profile-upload"><ImagePlus size={16} aria-hidden="true" />{uploading ? "上传中…" : "更换头像"}<input type="file" accept="image/png,image/jpeg,image/webp,image/avif,image/heif,image/gif" onChange={uploadAvatar} disabled={uploading || loading} /></label>
      </div>
      <form className="personal-profile-form" onSubmit={save}>
        <label htmlFor="personal-profile-bio"><span>个人简介</span><textarea id="personal-profile-bio" value={bio} onChange={(event) => setBio(event.target.value)} rows={4} maxLength={500} placeholder="介绍一下你自己，例如你的兴趣、常买的品类或经营方向。" disabled={loading || saving} /></label>
        <div><small>{bio.length}/500</small><button className="button button-dark" type="submit" disabled={loading || saving}><Save size={16} aria-hidden="true" />{saving ? "保存中…" : "保存个人资料"}</button></div>
      </form>
    </section>
  );
}
