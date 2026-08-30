"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@appica/ui-react/button";

import { getMallLegalDocuments } from "../api";

export interface RegistrationLegalVersions {
  terms: number;
  privacy: number;
}

interface RegistrationLegalConsentProps {
  locale: "zh" | "en";
  accepted: boolean;
  disabled: boolean;
  onAcceptedChange: (accepted: boolean) => void;
  onVersionsChange: (versions: RegistrationLegalVersions | null) => void;
}

type LegalLoadState = "loading" | "ready" | "error";

export function RegistrationLegalConsent({
  locale,
  accepted,
  disabled,
  onAcceptedChange,
  onVersionsChange,
}: RegistrationLegalConsentProps) {
  const copy = legalConsentCopy(locale);
  const [loadState, setLoadState] = useState<LegalLoadState>("loading");
  const requestIdRef = useRef(0);

  const loadDocuments = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoadState("loading");
    onAcceptedChange(false);
    onVersionsChange(null);

    try {
      const legal = await getMallLegalDocuments();
      if (requestId !== requestIdRef.current) return;
      onVersionsChange({
        terms: legal.documents.terms.version,
        privacy: legal.documents.privacy.version,
      });
      setLoadState("ready");
    } catch {
      if (requestId === requestIdRef.current) setLoadState("error");
    }
  }, [onAcceptedChange, onVersionsChange]);

  useEffect(() => {
    void loadDocuments();
    return () => {
      requestIdRef.current += 1;
    };
  }, [loadDocuments]);

  if (loadState === "loading") {
    return (
      <p className="login-legal-state" role="status">
        {copy.loading}
      </p>
    );
  }

  if (loadState === "error") {
    return (
      <div className="login-legal-state is-error">
        <p role="alert">{copy.loadFailed}</p>
        <Button
          className="login-legal-retry"
          variant="outline"
          type="button"
          disabled={disabled}
          onClick={() => void loadDocuments()}
        >
          <RefreshCw size={15} aria-hidden="true" />
          {copy.retry}
        </Button>
      </div>
    );
  }

  return (
    <div className="login-legal-consent">
      <label className="login-legal-checkbox" htmlFor="login-legal-consent">
        <input
          id="login-legal-consent"
          type="checkbox"
          aria-label={copy.checkboxLabel}
          checked={accepted}
          onChange={(event) => onAcceptedChange(event.target.checked)}
          disabled={disabled}
        />
      </label>
      <span className="login-legal-copy">
        {copy.prefix}{" "}
        <a href="/terms" target="_blank" rel="noreferrer">
          {copy.terms}
        </a>{" "}
        {copy.join}{" "}
        <a href="/privacy" target="_blank" rel="noreferrer">
          {copy.privacy}
        </a>
      </span>
    </div>
  );
}

function legalConsentCopy(locale: "zh" | "en") {
  return locale === "en"
    ? {
        terms: "Terms of Service",
        privacy: "Privacy Policy",
        prefix: "I have read and agree to the",
        join: "and",
        checkboxLabel: "Agree to the Terms of Service and Privacy Policy",
        loading: "Loading the current agreement versions…",
        loadFailed:
          "The Terms and Privacy Policy could not be loaded, so registration cannot continue.",
        retry: "Try again",
      }
    : {
        terms: "用户协议",
        privacy: "隐私政策",
        prefix: "我已阅读并同意",
        join: "和",
        checkboxLabel: "同意用户协议和隐私政策",
        loading: "正在读取当前协议版本…",
        loadFailed: "暂时无法读取用户协议和隐私政策，因此不能继续注册。",
        retry: "重新读取",
      };
}
