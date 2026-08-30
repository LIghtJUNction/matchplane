"use client";

import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertIcon,
  AlertTitle,
} from "@appica/ui-react/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@appica/ui-react/avatar";
import { Button } from "@appica/ui-react/button";
import { Skeleton } from "@appica/ui-react/skeleton";
import { Textarea } from "@appica/ui-react/textarea";
import {
  AlertTriangle,
  CheckCircle2,
  ImagePlus,
  RefreshCw,
  Save,
  UserRound,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type SyntheticEvent,
} from "react";

import {
  getAccountProfile,
  saveAccountProfile,
  uploadAccountAvatar,
  type AccountProfile,
} from "../api";

type ProfileLocale = "zh" | "en";
type ProfileLoadState = "loading" | "ready" | "error";
type ProfileFeedback = { type: "success" | "error"; text: string };

interface ProfileCopy {
  loading: string;
  loadErrorTitle: string;
  loadErrorReason: string;
  loadFallback: string;
  retry: string;
  avatarAlt: string;
  userFallback: string;
  upload: string;
  uploading: string;
  avatarTypeError: string;
  avatarSizeError: string;
  avatarSaveFallback: string;
  avatarSaved: string;
  bioLabel: string;
  bioPlaceholder: string;
  bioLengthError: string;
  save: string;
  saving: string;
  profileSaveFallback: string;
  profileSaved: string;
}

const profileCopy: Record<ProfileLocale, ProfileCopy> = {
  zh: {
    loading: "正在读取个人资料",
    loadErrorTitle: "个人资料读取失败",
    loadErrorReason: "原因：",
    loadFallback: "暂时无法读取个人资料",
    retry: "重新读取",
    avatarAlt: "当前头像",
    userFallback: "用户",
    upload: "更换头像",
    uploading: "上传中…",
    avatarTypeError: "请上传图片格式的头像",
    avatarSizeError: "头像图片不能超过 4 MiB",
    avatarSaveFallback: "头像保存失败",
    avatarSaved: "头像已保存",
    bioLabel: "个人简介",
    bioPlaceholder: "介绍一下你自己，例如你的兴趣、常买的品类或经营方向。",
    bioLengthError: "个人简介不能超过 500 个字符",
    save: "保存个人资料",
    saving: "保存中…",
    profileSaveFallback: "个人资料保存失败",
    profileSaved: "个人资料已保存",
  },
  en: {
    loading: "Loading your profile",
    loadErrorTitle: "Profile could not load",
    loadErrorReason: "Reason:",
    loadFallback: "Your profile is temporarily unavailable",
    retry: "Retry",
    avatarAlt: "Current avatar",
    userFallback: "User",
    upload: "Change avatar",
    uploading: "Uploading…",
    avatarTypeError: "Choose an image file for your avatar",
    avatarSizeError: "Avatar images must be 4 MiB or smaller",
    avatarSaveFallback: "Avatar could not be saved",
    avatarSaved: "Avatar saved",
    bioLabel: "Bio",
    bioPlaceholder:
      "Share your interests, the categories you often buy, or what you sell.",
    bioLengthError: "Your bio cannot exceed 500 characters",
    save: "Save profile",
    saving: "Saving…",
    profileSaveFallback: "Profile could not be saved",
    profileSaved: "Profile saved",
  },
};

interface PersonalProfilePanelProps {
  locale: ProfileLocale;
  onAvatarChanged: (image: string | null) => void;
}

export function PersonalProfilePanel({
  locale,
  onAvatarChanged,
}: PersonalProfilePanelProps) {
  const copy = profileCopy[locale];
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [bio, setBio] = useState("");
  const [loadState, setLoadState] = useState<ProfileLoadState>("loading");
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [feedback, setFeedback] = useState<ProfileFeedback | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const requestIdRef = useRef(0);
  const previewRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const clearPreview = useCallback(() => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = null;
    if (mountedRef.current) setPreviewUrl(null);
  }, []);

  const loadProfile = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoadState("loading");
    setLoadError("");
    setFeedback(null);

    try {
      const next = await getAccountProfile();
      if (requestId !== requestIdRef.current || !mountedRef.current) return;
      setProfile(next);
      setBio(next.bio);
      setLoadState("ready");
    } catch (error) {
      if (requestId !== requestIdRef.current || !mountedRef.current) return;
      const message =
        error instanceof Error ? error.message : copy.loadFallback;
      setProfile(null);
      setLoadError(message);
      setLoadState("error");
    }
  }, [copy.loadFallback]);

  useEffect(() => {
    mountedRef.current = true;
    void loadProfile();
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
      previewRef.current = null;
    };
  }, [loadProfile]);

  const uploadAvatar = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (!file) return;
    setFeedback(null);
    if (!file.type.startsWith("image/")) {
      setFeedback({ type: "error", text: copy.avatarTypeError });
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setFeedback({ type: "error", text: copy.avatarSizeError });
      return;
    }

    clearPreview();
    const preview = URL.createObjectURL(file);
    previewRef.current = preview;
    setPreviewUrl(preview);
    setUploading(true);
    try {
      const image = await uploadAccountAvatar(file);
      clearPreview();
      if (!mountedRef.current) return;
      setProfile((current) => (current ? { ...current, image } : current));
      setFeedback({ type: "success", text: copy.avatarSaved });
      onAvatarChanged(image);
    } catch (error) {
      clearPreview();
      if (!mountedRef.current) return;
      const message =
        error instanceof Error ? error.message : copy.avatarSaveFallback;
      setFeedback({ type: "error", text: message });
    } finally {
      if (mountedRef.current) setUploading(false);
    }
  };

  const save = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (bio.length > 500) {
      setFeedback({ type: "error", text: copy.bioLengthError });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const updated = await saveAccountProfile({ bio });
      if (!mountedRef.current) return;
      setProfile(updated);
      setBio(updated.bio);
      setFeedback({ type: "success", text: copy.profileSaved });
    } catch (error) {
      if (!mountedRef.current) return;
      const message =
        error instanceof Error ? error.message : copy.profileSaveFallback;
      setFeedback({ type: "error", text: message });
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  if (loadState === "loading") {
    return (
      <section
        className="grid gap-5 py-3"
        role="status"
        aria-label={copy.loading}
        aria-busy="true"
      >
        <span className="sr-only">{copy.loading}</span>
        <div className="workspace-account-row" aria-hidden="true">
          <Skeleton className="size-12 rounded-full" />
          <span className="workspace-account-copy gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-48 max-w-full" />
          </span>
          <Skeleton className="h-11 w-28 max-[42rem]:col-span-full max-[42rem]:w-full" />
        </div>
        <Skeleton className="h-28 w-full" aria-hidden="true" />
      </section>
    );
  }

  if (loadState === "error") {
    return (
      <Alert variant="error" layout="inline">
        <AlertIcon>
          <AlertTriangle aria-hidden="true" />
        </AlertIcon>
        <AlertTitle as="div">{copy.loadErrorTitle}</AlertTitle>
        <AlertDescription>
          {copy.loadErrorReason} {loadError}
        </AlertDescription>
        <AlertAction>
          <Button
            variant="primary-outline"
            size="lg"
            type="button"
            onClick={() => void loadProfile()}
          >
            <RefreshCw aria-hidden="true" />
            {copy.retry}
          </Button>
        </AlertAction>
      </Alert>
    );
  }

  const avatar = previewUrl || profile?.image || null;
  return (
    <section className="grid gap-5">
      <div className="workspace-account-row border-b border-border py-3">
        <Avatar size={48}>
          {avatar ? <AvatarImage src={avatar} alt={copy.avatarAlt} /> : null}
          <AvatarFallback>
            <UserRound aria-hidden="true" />
          </AvatarFallback>
        </Avatar>
        <span className="workspace-account-copy">
          <strong>{profile?.name || copy.userFallback}</strong>
          <small>{profile?.email || ""}</small>
        </span>
        <Button
          className="max-[42rem]:col-span-full max-[42rem]:w-full"
          variant="outline"
          size="lg"
          type="button"
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
        >
          <ImagePlus aria-hidden="true" />
          {uploading ? copy.uploading : copy.upload}
        </Button>
        <input
          ref={fileInputRef}
          className="hidden"
          type="file"
          tabIndex={-1}
          aria-hidden="true"
          accept="image/png,image/jpeg,image/webp,image/avif,image/heif,image/gif"
          onChange={uploadAvatar}
          disabled={uploading}
        />
      </div>
      <form className="grid gap-3" onSubmit={save}>
        <label className="grid gap-2" htmlFor="personal-profile-bio">
          <span className="text-sm font-semibold text-foreground">
            {copy.bioLabel}
          </span>
          <Textarea
            id="personal-profile-bio"
            value={bio}
            onChange={(event) => setBio(event.target.value)}
            rows={4}
            maxLength={500}
            placeholder={copy.bioPlaceholder}
            disabled={saving}
          />
        </label>
        <div className="flex items-center justify-between gap-4">
          <small className="text-foreground-muted tabular-nums">
            {bio.length}/500
          </small>
          <Button
            className="!text-primary-foreground"
            size="lg"
            type="submit"
            disabled={saving || uploading}
          >
            <Save aria-hidden="true" />
            {saving ? copy.saving : copy.save}
          </Button>
        </div>
      </form>
      {feedback ? (
        <Alert
          variant={feedback.type === "error" ? "error" : "success"}
          role={feedback.type === "error" ? "alert" : "status"}
          layout="inline"
        >
          <AlertIcon>
            {feedback.type === "error" ? (
              <AlertTriangle aria-hidden="true" />
            ) : (
              <CheckCircle2 aria-hidden="true" />
            )}
          </AlertIcon>
          <AlertTitle as="div">{feedback.text}</AlertTitle>
        </Alert>
      ) : null}
    </section>
  );
}
