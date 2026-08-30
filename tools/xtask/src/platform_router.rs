use std::{
    collections::HashSet,
    fs::File,
    io::Read,
    net::IpAddr,
    os::unix::fs::{FileExt, PermissionsExt},
    path::{Component, Path, PathBuf},
    sync::Arc,
};

use rustix::{
    fs::{AtFlags, Dir, FileType, Mode, OFlags, fstat, open, openat, statat},
    io::Errno,
};
use secrecy::SecretString;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use url::Url;
use uuid::{Uuid, Variant};
use zeroize::Zeroize;

pub const DEFAULT_SECRET_ROOT: &str = "/etc/matchplane/secrets/root-email";
const POINTER_FILE: &str = "platform-router.current";
const GENERATION_DIRECTORY: &str = "platform-router.generations";
const LEGACY_CONFIG_FILE: &str = "platform-router.json";
const LEGACY_KEY_FILE: &str = "platform-router.key";
const MAX_POINTER_BYTES: u64 = 4 * 1024;
const MAX_GENERATION_BYTES: u64 = 1024 * 1024;
const MAX_LEGACY_BYTES: u64 = 64 * 1024;
const MAX_KEY_BYTES: u64 = 16_384;
const MAX_PENDING_AUDIT_RECORDS: usize = 1_024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagedSource {
    ManagedGeneration,
    Legacy,
    Absent,
    ManagedUnreadable,
}

impl ManagedSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ManagedGeneration => "managed_generation",
            Self::Legacy => "legacy",
            Self::Absent => "absent",
            Self::ManagedUnreadable => "managed_unreadable",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagedUnreadableKind {
    RootInvalid,
    PointerUnreadable,
    PointerInvalid,
    GenerationDirectoryInvalid,
    GenerationUnreadable,
    GenerationChecksumMismatch,
    GenerationInvalid,
    GenerationIdentityMismatch,
    CredentialMissing,
    CredentialInvalid,
    LegacyInvalid,
    SecurityPolicyInvalid,
}

impl ManagedUnreadableKind {
    pub fn code(self) -> &'static str {
        match self {
            Self::RootInvalid => "managed_root_invalid",
            Self::PointerUnreadable => "managed_pointer_unreadable",
            Self::PointerInvalid => "managed_pointer_invalid",
            Self::GenerationDirectoryInvalid => "managed_generation_directory_invalid",
            Self::GenerationUnreadable => "managed_generation_unreadable",
            Self::GenerationChecksumMismatch => "managed_generation_checksum_mismatch",
            Self::GenerationInvalid => "managed_generation_invalid",
            Self::GenerationIdentityMismatch => "managed_generation_identity_mismatch",
            Self::CredentialMissing => "managed_credential_missing",
            Self::CredentialInvalid => "managed_credential_invalid",
            Self::LegacyInvalid => "legacy_managed_config_invalid",
            Self::SecurityPolicyInvalid => "managed_security_policy_invalid",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ManagedUnreadable {
    kind: ManagedUnreadableKind,
}

impl ManagedUnreadable {
    fn new(kind: ManagedUnreadableKind) -> Self {
        Self { kind }
    }

    pub fn code(&self) -> &'static str {
        self.kind.code()
    }
}

#[derive(Clone)]
pub struct ManagedRouterConfig {
    pub endpoint: String,
    pub model: String,
    pub protocol: String,
    pub enabled: bool,
    credential_file: String,
    assistant_instructions: String,
    assistant_max_output_tokens: i64,
    assistant_temperature: f64,
    assistant_max_steps: i64,
    assistant_timeout_ms: i64,
    assistant_reasoning_effort: String,
    model_reasoning_efforts: Vec<String>,
}

impl ManagedRouterConfig {
    fn tuning_invariants_hold(&self) -> bool {
        utf16_len(&self.assistant_instructions) <= 4_000
            && (64..=512).contains(&self.assistant_max_output_tokens)
            && (0.0..=1.0).contains(&self.assistant_temperature)
            && (2..=8).contains(&self.assistant_max_steps)
            && (4_000..=30_000).contains(&self.assistant_timeout_ms)
            && (self.assistant_reasoning_effort == "none"
                || self
                    .model_reasoning_efforts
                    .contains(&self.assistant_reasoning_effort))
            && self.model_reasoning_efforts.len() <= 16
    }
}

#[derive(Clone)]
pub struct ManagedRouterRead {
    _root: Option<Arc<File>>,
    active_credential: Option<Arc<File>>,
    source: ManagedSource,
    active: Option<ManagedRouterConfig>,
    draft: Option<ManagedRouterConfig>,
    unreadable: Option<ManagedUnreadable>,
    pointer_valid: Option<bool>,
    generation_valid: Option<bool>,
    permission_issues: Vec<String>,
    orphan_temp_count: u64,
    oldest_orphan_age_seconds: Option<u64>,
}

impl ManagedRouterRead {
    pub fn source(&self) -> ManagedSource {
        self.source
    }

    pub fn active(&self) -> Option<&ManagedRouterConfig> {
        self.active.as_ref()
    }

    pub fn unreadable(&self) -> Option<&ManagedUnreadable> {
        self.unreadable.as_ref()
    }

    pub fn active_credential_configured(&self) -> bool {
        self.active.is_some()
    }

    fn any_credential_configured(&self) -> bool {
        self.active.is_some() || self.draft.is_some()
    }

    pub fn read_active_secret(&self) -> Result<Option<SecretString>, ManagedUnreadable> {
        if let Some(unreadable) = self.unreadable.as_ref() {
            return Err(unreadable.clone());
        }
        let Some(file) = self.active_credential.as_deref() else {
            return Ok(None);
        };
        read_secret(file).map(Some)
    }

    #[cfg(test)]
    pub(crate) fn test_absent() -> Self {
        Self {
            _root: None,
            active_credential: None,
            source: ManagedSource::Absent,
            active: None,
            draft: None,
            unreadable: None,
            pointer_valid: None,
            generation_valid: None,
            permission_issues: Vec::new(),
            orphan_temp_count: 0,
            oldest_orphan_age_seconds: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn test_managed_generation(enabled: bool) -> Self {
        Self {
            _root: None,
            active_credential: None,
            source: ManagedSource::ManagedGeneration,
            active: Some(ManagedRouterConfig {
                endpoint: "https://api.lmm.best/v1".to_owned(),
                model: "deepseek-v3.2".to_owned(),
                protocol: "openai-compatible".to_owned(),
                enabled,
                credential_file: LEGACY_KEY_FILE.to_owned(),
                assistant_instructions: String::new(),
                assistant_max_output_tokens: 320,
                assistant_temperature: 0.2,
                assistant_max_steps: 5,
                assistant_timeout_ms: 20_000,
                assistant_reasoning_effort: "none".to_owned(),
                model_reasoning_efforts: Vec::new(),
            }),
            draft: None,
            unreadable: None,
            pointer_valid: Some(true),
            generation_valid: Some(true),
            permission_issues: Vec::new(),
            orphan_temp_count: 0,
            oldest_orphan_age_seconds: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn test_security_policy_unreadable() -> Self {
        Self {
            _root: None,
            active_credential: None,
            source: ManagedSource::ManagedUnreadable,
            active: None,
            draft: None,
            unreadable: Some(ManagedUnreadable::new(
                ManagedUnreadableKind::SecurityPolicyInvalid,
            )),
            pointer_valid: Some(true),
            generation_valid: Some(false),
            permission_issues: vec!["credential_mode".to_owned()],
            orphan_temp_count: 0,
            oldest_orphan_age_seconds: None,
        }
    }

    pub fn mount_report(&self) -> ValidateMountsReport {
        let mut issues = Vec::new();
        if let Some(unreadable) = &self.unreadable {
            issues.push(unreadable.code().to_owned());
        }
        ValidateMountsReport {
            ok: issues.is_empty() && self.permission_issues.is_empty(),
            source: self.source.as_str().to_owned(),
            pointer_valid: self.pointer_valid,
            generation_valid: self.generation_valid,
            credential_configured: self.any_credential_configured(),
            permission_issues: self.permission_issues.clone(),
            issues,
            orphan_temps: OrphanTempReport {
                count: self.orphan_temp_count,
                oldest_age_seconds: self.oldest_orphan_age_seconds,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ValidateMountsReport {
    pub ok: bool,
    pub source: String,
    pub pointer_valid: Option<bool>,
    pub generation_valid: Option<bool>,
    pub credential_configured: bool,
    pub permission_issues: Vec<String>,
    pub issues: Vec<String>,
    pub orphan_temps: OrphanTempReport,
}

#[derive(Debug, Clone, Serialize)]
pub struct OrphanTempReport {
    pub count: u64,
    pub oldest_age_seconds: Option<u64>,
}

#[derive(Clone)]
pub struct PlatformRouterReader {
    root: PathBuf,
}

impl Default for PlatformRouterReader {
    fn default() -> Self {
        Self::new(DEFAULT_SECRET_ROOT)
    }
}

impl PlatformRouterReader {
    pub fn new(root: impl AsRef<Path>) -> Self {
        Self {
            root: root.as_ref().to_path_buf(),
        }
    }

    pub fn read(&self) -> ManagedRouterRead {
        let root = match open_directory(&self.root) {
            Ok(root) => root,
            Err(_) => {
                return self.unreadable(
                    ManagedUnreadableKind::RootInvalid,
                    None,
                    None,
                    Vec::new(),
                    OrphanTempReport {
                        count: 0,
                        oldest_age_seconds: None,
                    },
                );
            }
        };
        let root = Arc::new(root);
        let mut permissions = Vec::new();
        if !record_mode_issue(&root, 0o770, "root_mode", &mut permissions) {
            return self.unreadable(
                ManagedUnreadableKind::SecurityPolicyInvalid,
                None,
                None,
                permissions,
                OrphanTempReport {
                    count: 0,
                    oldest_age_seconds: None,
                },
            );
        }
        let orphan_temps = match inspect_orphan_temps(&root) {
            Ok(report) => report,
            Err(()) => {
                permissions.push("orphan_temp_scan_unavailable".to_owned());
                return self.unreadable(
                    ManagedUnreadableKind::SecurityPolicyInvalid,
                    None,
                    None,
                    permissions,
                    OrphanTempReport {
                        count: 0,
                        oldest_age_seconds: None,
                    },
                );
            }
        };

        let pointer_file = match open_optional_regular(&root, POINTER_FILE, MAX_POINTER_BYTES) {
            Ok(Some(file)) => file,
            Ok(None) => return self.read_legacy(&root, permissions, orphan_temps),
            Err(_) => {
                return self.unreadable(
                    ManagedUnreadableKind::PointerUnreadable,
                    Some(false),
                    None,
                    permissions,
                    orphan_temps,
                );
            }
        };
        if !record_mode_issue(&pointer_file, 0o640, "pointer_mode", &mut permissions) {
            return self.unreadable(
                ManagedUnreadableKind::SecurityPolicyInvalid,
                Some(false),
                None,
                permissions,
                orphan_temps,
            );
        }
        let pointer_bytes = match read_bounded(pointer_file, MAX_POINTER_BYTES) {
            Ok(bytes) => bytes,
            Err(_) => {
                return self.unreadable(
                    ManagedUnreadableKind::PointerUnreadable,
                    Some(false),
                    None,
                    permissions,
                    orphan_temps,
                );
            }
        };
        let pointer = match decode_pointer(&pointer_bytes) {
            Ok(pointer) => pointer,
            Err(_) => {
                return self.unreadable(
                    ManagedUnreadableKind::PointerInvalid,
                    Some(false),
                    None,
                    permissions,
                    orphan_temps,
                );
            }
        };

        let generation_directory = match openat(
            &root,
            GENERATION_DIRECTORY,
            read_directory_flags(),
            Mode::empty(),
        ) {
            Ok(fd) => File::from(fd),
            Err(_) => {
                return self.unreadable(
                    ManagedUnreadableKind::GenerationDirectoryInvalid,
                    Some(true),
                    Some(false),
                    permissions,
                    orphan_temps,
                );
            }
        };
        if !is_directory(&generation_directory) {
            return self.unreadable(
                ManagedUnreadableKind::GenerationDirectoryInvalid,
                Some(true),
                Some(false),
                permissions,
                orphan_temps,
            );
        }
        if !record_mode_issue(
            &generation_directory,
            0o750,
            "generation_directory_mode",
            &mut permissions,
        ) {
            return self.unreadable(
                ManagedUnreadableKind::SecurityPolicyInvalid,
                Some(true),
                Some(false),
                permissions,
                orphan_temps,
            );
        }
        let generation_name = format!("{}.json", pointer.generation_id);
        let generation_file = match open_required_regular(
            &generation_directory,
            &generation_name,
            MAX_GENERATION_BYTES,
        ) {
            Ok(file) => file,
            Err(_) => {
                return self.unreadable(
                    ManagedUnreadableKind::GenerationUnreadable,
                    Some(true),
                    Some(false),
                    permissions,
                    orphan_temps,
                );
            }
        };
        if !record_mode_issue(
            &generation_file,
            0o640,
            "generation_file_mode",
            &mut permissions,
        ) {
            return self.unreadable(
                ManagedUnreadableKind::SecurityPolicyInvalid,
                Some(true),
                Some(false),
                permissions,
                orphan_temps,
            );
        }
        let generation_bytes = match read_bounded(generation_file, MAX_GENERATION_BYTES) {
            Ok(bytes) => bytes,
            Err(_) => {
                return self.unreadable(
                    ManagedUnreadableKind::GenerationUnreadable,
                    Some(true),
                    Some(false),
                    permissions,
                    orphan_temps,
                );
            }
        };
        let actual_checksum = Sha256::digest(&generation_bytes);
        if !constant_time_equal(actual_checksum.as_slice(), &pointer.sha256) {
            return self.unreadable(
                ManagedUnreadableKind::GenerationChecksumMismatch,
                Some(true),
                Some(false),
                permissions,
                orphan_temps,
            );
        }
        let generation = match decode_generation(&generation_bytes) {
            Ok(generation) => generation,
            Err(_) => {
                return self.unreadable(
                    ManagedUnreadableKind::GenerationInvalid,
                    Some(true),
                    Some(false),
                    permissions,
                    orphan_temps,
                );
            }
        };
        if generation.generation_id != pointer.generation_id {
            return self.unreadable(
                ManagedUnreadableKind::GenerationIdentityMismatch,
                Some(true),
                Some(false),
                permissions,
                orphan_temps,
            );
        }
        let active_credential = match validate_credentials(
            &root,
            generation.active.as_ref(),
            generation.draft.as_ref(),
            &mut permissions,
        ) {
            Ok(file) => file,
            Err(kind) => {
                return self.unreadable(kind, Some(true), Some(false), permissions, orphan_temps);
            }
        };
        if !permissions.is_empty() {
            return self.unreadable(
                ManagedUnreadableKind::SecurityPolicyInvalid,
                Some(true),
                Some(false),
                permissions,
                orphan_temps,
            );
        }
        ManagedRouterRead {
            _root: Some(root),
            active_credential,
            source: ManagedSource::ManagedGeneration,
            active: generation.active,
            draft: generation.draft,
            unreadable: None,
            pointer_valid: Some(true),
            generation_valid: Some(true),
            permission_issues: permissions,
            orphan_temp_count: orphan_temps.count,
            oldest_orphan_age_seconds: orphan_temps.oldest_age_seconds,
        }
    }

    fn read_legacy(
        &self,
        root: &Arc<File>,
        mut permissions: Vec<String>,
        orphan_temps: OrphanTempReport,
    ) -> ManagedRouterRead {
        let legacy_file = match open_optional_regular(root, LEGACY_CONFIG_FILE, MAX_LEGACY_BYTES) {
            Ok(Some(file)) => file,
            Ok(None) => {
                return ManagedRouterRead {
                    _root: Some(Arc::clone(root)),
                    active_credential: None,
                    source: ManagedSource::Absent,
                    active: None,
                    draft: None,
                    unreadable: None,
                    pointer_valid: None,
                    generation_valid: None,
                    permission_issues: permissions,
                    orphan_temp_count: orphan_temps.count,
                    oldest_orphan_age_seconds: orphan_temps.oldest_age_seconds,
                };
            }
            Err(_) => {
                return self.unreadable(
                    ManagedUnreadableKind::LegacyInvalid,
                    None,
                    None,
                    permissions,
                    orphan_temps,
                );
            }
        };
        if !record_mode_issue(&legacy_file, 0o640, "legacy_config_mode", &mut permissions) {
            return self.unreadable(
                ManagedUnreadableKind::SecurityPolicyInvalid,
                None,
                None,
                permissions,
                orphan_temps,
            );
        }
        let bytes = match read_bounded(legacy_file, MAX_LEGACY_BYTES) {
            Ok(bytes) => bytes,
            Err(_) => {
                return self.unreadable(
                    ManagedUnreadableKind::LegacyInvalid,
                    None,
                    None,
                    permissions,
                    orphan_temps,
                );
            }
        };
        let active = match decode_config_bytes(&bytes, true) {
            Ok(config) => config,
            Err(_) => {
                return self.unreadable(
                    ManagedUnreadableKind::LegacyInvalid,
                    None,
                    None,
                    permissions,
                    orphan_temps,
                );
            }
        };
        let active_credential =
            match validate_credentials(root, Some(&active), None, &mut permissions) {
                Ok(file) => file,
                Err(kind) => return self.unreadable(kind, None, None, permissions, orphan_temps),
            };
        if !permissions.is_empty() {
            return self.unreadable(
                ManagedUnreadableKind::SecurityPolicyInvalid,
                None,
                None,
                permissions,
                orphan_temps,
            );
        }
        ManagedRouterRead {
            _root: Some(Arc::clone(root)),
            active_credential,
            source: ManagedSource::Legacy,
            active: Some(active),
            draft: None,
            unreadable: None,
            pointer_valid: None,
            generation_valid: None,
            permission_issues: permissions,
            orphan_temp_count: orphan_temps.count,
            oldest_orphan_age_seconds: orphan_temps.oldest_age_seconds,
        }
    }

    fn unreadable(
        &self,
        kind: ManagedUnreadableKind,
        pointer_valid: Option<bool>,
        generation_valid: Option<bool>,
        permission_issues: Vec<String>,
        orphan_temps: OrphanTempReport,
    ) -> ManagedRouterRead {
        ManagedRouterRead {
            _root: None,
            active_credential: None,
            source: ManagedSource::ManagedUnreadable,
            active: None,
            draft: None,
            unreadable: Some(ManagedUnreadable::new(kind)),
            pointer_valid,
            generation_valid,
            permission_issues,
            orphan_temp_count: orphan_temps.count,
            oldest_orphan_age_seconds: orphan_temps.oldest_age_seconds,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPointer {
    schema_version: u8,
    generation_id: String,
    sha256: String,
}

struct Pointer {
    generation_id: String,
    sha256: [u8; 32],
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawGeneration {
    schema_version: u8,
    generation_id: String,
    parent_generation_id: Option<String>,
    committed_at: String,
    active: Option<RawConfig>,
    draft: Option<RawDraft>,
    pending_audit: Vec<RawAuditRecord>,
}

struct Generation {
    generation_id: String,
    active: Option<ManagedRouterConfig>,
    draft: Option<ManagedRouterConfig>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawConfig {
    endpoint: String,
    model: String,
    protocol: String,
    enabled: bool,
    credential_file: Option<String>,
    #[serde(default)]
    assistant_instructions: Value,
    #[serde(default)]
    assistant_max_output_tokens: Value,
    #[serde(default)]
    assistant_temperature: Value,
    #[serde(default)]
    assistant_max_steps: Value,
    #[serde(default)]
    assistant_timeout_ms: Value,
    #[serde(default)]
    assistant_reasoning_effort: Value,
    #[serde(default)]
    model_reasoning_efforts: Value,
}

#[derive(Deserialize)]
struct RawDraft {
    config: RawConfig,
    metadata: RawDraftMetadata,
    attestation: Option<RawAttestation>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawDraftMetadata {
    key_changed: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAttestation {
    digest: String,
    tested_at: String,
    request_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAuditRecord {
    event_id: String,
    at: String,
    action: String,
    actor: String,
    request_id: String,
    endpoint_origin: String,
    model: String,
    enabled: bool,
    key_changed: bool,
}

fn decode_pointer(bytes: &[u8]) -> Result<Pointer, ()> {
    let raw: RawPointer = serde_json::from_slice(bytes).map_err(|_| ())?;
    if raw.schema_version != 1 || !canonical_uuid(&raw.generation_id) {
        return Err(());
    }
    let decoded = hex::decode(&raw.sha256).map_err(|_| ())?;
    if decoded.len() != 32
        || raw.sha256.len() != 64
        || !raw
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(());
    }
    let sha256: [u8; 32] = decoded.try_into().map_err(|_| ())?;
    Ok(Pointer {
        generation_id: raw.generation_id,
        sha256,
    })
}

fn decode_generation(bytes: &[u8]) -> Result<Generation, ()> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| ())?;
    let object = value.as_object().ok_or(())?;
    for key in [
        "schemaVersion",
        "generationId",
        "parentGenerationId",
        "committedAt",
        "active",
        "draft",
        "pendingAudit",
    ] {
        if !object.contains_key(key) {
            return Err(());
        }
    }
    if let Some(draft) = object.get("draft").and_then(Value::as_object) {
        for key in ["config", "metadata", "attestation"] {
            if !draft.contains_key(key) {
                return Err(());
            }
        }
    }
    let raw: RawGeneration = serde_json::from_value(value).map_err(|_| ())?;
    if raw.schema_version != 1
        || !canonical_uuid(&raw.generation_id)
        || raw
            .parent_generation_id
            .as_deref()
            .is_some_and(|value| !canonical_uuid(value))
        || !valid_timestamp(&raw.committed_at)
        || raw.pending_audit.len() > MAX_PENDING_AUDIT_RECORDS
    {
        return Err(());
    }
    let active = raw.active.map(normalize_config).transpose()?;
    let draft = raw.draft.map(validate_draft).transpose()?;
    let mut event_ids = HashSet::with_capacity(raw.pending_audit.len());
    for record in raw.pending_audit {
        validate_audit_record(&record)?;
        if !event_ids.insert(record.event_id) {
            return Err(());
        }
    }
    Ok(Generation {
        generation_id: raw.generation_id,
        active,
        draft,
    })
}

fn decode_config_bytes(bytes: &[u8], legacy_default: bool) -> Result<ManagedRouterConfig, ()> {
    // JSON.parse, used by the Web decoder, keeps the last duplicate key. Parsing through Value
    // preserves that behavior instead of serde's derived-struct duplicate-field rejection.
    let value: Value = serde_json::from_slice(bytes).map_err(|_| ())?;
    let raw: RawConfig = serde_json::from_value(value).map_err(|_| ())?;
    normalize_config_with_default(raw, legacy_default)
}

fn normalize_config(raw: RawConfig) -> Result<ManagedRouterConfig, ()> {
    normalize_config_with_default(raw, true)
}

fn normalize_config_with_default(
    raw: RawConfig,
    legacy_default: bool,
) -> Result<ManagedRouterConfig, ()> {
    let candidate = raw.endpoint.trim();
    let parsed = Url::parse(candidate).map_err(|_| ())?;
    if candidate.is_empty()
        || parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || utf16_len(parsed.path()) > 512
        || parsed.host_str().is_some_and(|hostname| {
            hostname
                .trim_start_matches('[')
                .trim_end_matches(']')
                .parse::<IpAddr>()
                .is_ok_and(private_or_reserved_ip)
        })
    {
        return Err(());
    }
    let path = parsed.path().trim_end_matches('/');
    let endpoint = if path.is_empty() {
        parsed.origin().ascii_serialization()
    } else {
        format!("{}{path}", parsed.origin().ascii_serialization())
    };
    let model = bounded_text(&raw.model, 256)?;
    if !matches!(
        raw.protocol.as_str(),
        "openai-compatible" | "anthropic-messages" | "gemini-generate-content"
    ) {
        return Err(());
    }
    let credential_file = match raw.credential_file {
        Some(value) => validate_credential_name(&value)?.to_owned(),
        None if legacy_default => LEGACY_KEY_FILE.to_owned(),
        None => return Err(()),
    };
    let assistant_instructions = match raw.assistant_instructions.as_str() {
        Some(value) => {
            let value = value.trim();
            if utf16_len(value) > 4_000 {
                return Err(());
            }
            value.to_owned()
        }
        None => String::new(),
    };
    let assistant_max_output_tokens =
        bounded_safe_integer(&raw.assistant_max_output_tokens, 320, 64, 512);
    let assistant_temperature = bounded_number(&raw.assistant_temperature, 0.2, 0.0, 1.0);
    let assistant_max_steps = bounded_safe_integer(&raw.assistant_max_steps, 5, 2, 8);
    let assistant_timeout_ms =
        bounded_safe_integer(&raw.assistant_timeout_ms, 20_000, 4_000, 30_000);
    let model_reasoning_efforts = normalize_reasoning_efforts(&raw.model_reasoning_efforts);
    let assistant_reasoning_effort = raw
        .assistant_reasoning_effort
        .as_str()
        .filter(|value| {
            model_reasoning_efforts
                .iter()
                .any(|effort| effort == *value)
        })
        .unwrap_or("none")
        .to_owned();
    let config = ManagedRouterConfig {
        endpoint,
        model,
        protocol: raw.protocol,
        enabled: raw.enabled,
        credential_file,
        assistant_instructions,
        assistant_max_output_tokens,
        assistant_temperature,
        assistant_max_steps,
        assistant_timeout_ms,
        assistant_reasoning_effort,
        model_reasoning_efforts,
    };
    if !config.tuning_invariants_hold() {
        return Err(());
    }
    Ok(config)
}

fn validate_draft(raw: RawDraft) -> Result<ManagedRouterConfig, ()> {
    let _ = raw.metadata.key_changed;
    if let Some(attestation) = raw.attestation
        && (!lowercase_sha256(&attestation.digest)
            || !valid_timestamp(&attestation.tested_at)
            || bounded_line(&attestation.request_id, 256).is_err())
    {
        return Err(());
    }
    normalize_config(raw.config)
}

fn validate_audit_record(record: &RawAuditRecord) -> Result<(), ()> {
    if !canonical_uuid(&record.event_id)
        || !valid_timestamp(&record.at)
        || !matches!(record.action.as_str(), "stage" | "test" | "activate")
        || bounded_line(&record.actor, 256).is_err()
        || bounded_line(&record.request_id, 256).is_err()
        || bounded_text(&record.model, 256).is_err()
    {
        return Err(());
    }
    let endpoint = Url::parse(&record.endpoint_origin).map_err(|_| ())?;
    if endpoint.scheme() != "https"
        || endpoint.host_str().is_none()
        || endpoint.host_str().is_some_and(|hostname| {
            hostname
                .trim_start_matches('[')
                .trim_end_matches(']')
                .parse::<IpAddr>()
                .is_ok_and(private_or_reserved_ip)
        })
        || endpoint.origin().ascii_serialization() != record.endpoint_origin
    {
        return Err(());
    }
    let _ = (record.enabled, record.key_changed);
    Ok(())
}

fn validate_credentials(
    root: &File,
    active: Option<&ManagedRouterConfig>,
    draft: Option<&ManagedRouterConfig>,
    permission_issues: &mut Vec<String>,
) -> Result<Option<Arc<File>>, ManagedUnreadableKind> {
    let active_credential = if let Some(config) = active {
        validate_credential_name(&config.credential_file)
            .map_err(|_| ManagedUnreadableKind::CredentialInvalid)?;
        let file = open_required_regular(root, &config.credential_file, MAX_KEY_BYTES)
            .map_err(credential_open_error)?;
        let _ = record_mode_issue(&file, 0o640, "credential_mode", permission_issues);
        Some(Arc::new(file))
    } else {
        None
    };
    if let Some(config) = draft
        && active.is_none_or(|active| active.credential_file != config.credential_file)
    {
        validate_credential_name(&config.credential_file)
            .map_err(|_| ManagedUnreadableKind::CredentialInvalid)?;
        let file = open_required_metadata_regular(root, &config.credential_file, MAX_KEY_BYTES)
            .map_err(credential_open_error)?;
        let _ = record_mode_issue(&file, 0o640, "credential_mode", permission_issues);
    }
    Ok(active_credential)
}

fn credential_open_error(error: FileReadError) -> ManagedUnreadableKind {
    if error == FileReadError::Missing {
        ManagedUnreadableKind::CredentialMissing
    } else {
        ManagedUnreadableKind::CredentialInvalid
    }
}

fn read_secret(file: &File) -> Result<SecretString, ManagedUnreadable> {
    let mut bytes = vec![0_u8; MAX_KEY_BYTES as usize + 1];
    let mut read = 0_usize;
    while read < bytes.len() {
        match file.read_at(&mut bytes[read..], read as u64) {
            Ok(0) => break,
            Ok(count) => read += count,
            Err(_) => {
                bytes.zeroize();
                return Err(ManagedUnreadable::new(
                    ManagedUnreadableKind::CredentialInvalid,
                ));
            }
        }
    }
    if read == 0 || read > MAX_KEY_BYTES as usize {
        bytes.zeroize();
        return Err(ManagedUnreadable::new(
            ManagedUnreadableKind::CredentialInvalid,
        ));
    }
    bytes.truncate(read);
    while bytes
        .last()
        .is_some_and(|byte| matches!(byte, b'\r' | b'\n'))
    {
        bytes.pop();
    }
    let secret = String::from_utf8(bytes).map_err(|error| {
        let mut bytes = error.into_bytes();
        bytes.zeroize();
        ManagedUnreadable::new(ManagedUnreadableKind::CredentialInvalid)
    })?;
    if secret.is_empty() {
        let mut secret = secret;
        secret.zeroize();
        return Err(ManagedUnreadable::new(
            ManagedUnreadableKind::CredentialInvalid,
        ));
    }
    Ok(SecretString::from(secret))
}

fn open_directory(path: &Path) -> Result<File, Errno> {
    let anchor = if path.is_absolute() {
        Path::new("/")
    } else {
        Path::new(".")
    };
    let mut directory = File::from(open(anchor, read_directory_flags(), Mode::empty())?);
    for component in path.components() {
        match component {
            Component::RootDir | Component::CurDir => continue,
            Component::Normal(name) => {
                directory = File::from(openat(
                    &directory,
                    name,
                    read_directory_flags(),
                    Mode::empty(),
                )?);
            }
            Component::ParentDir | Component::Prefix(_) => return Err(Errno::INVAL),
        }
    }
    if is_directory(&directory) {
        Ok(directory)
    } else {
        Err(Errno::NOTDIR)
    }
}

fn read_directory_flags() -> OFlags {
    OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::DIRECTORY
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FileReadError {
    Missing,
    Invalid,
}

fn open_optional_regular(
    directory: &File,
    name: &str,
    maximum: u64,
) -> Result<Option<File>, FileReadError> {
    match openat(
        directory,
        name,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    ) {
        Ok(fd) => validate_open_regular(File::from(fd), maximum).map(Some),
        Err(Errno::NOENT) => Ok(None),
        Err(_) => Err(FileReadError::Invalid),
    }
}

fn open_required_regular(
    directory: &File,
    name: &str,
    maximum: u64,
) -> Result<File, FileReadError> {
    open_optional_regular(directory, name, maximum)?.ok_or(FileReadError::Missing)
}

fn open_required_metadata_regular(
    directory: &File,
    name: &str,
    maximum: u64,
) -> Result<File, FileReadError> {
    let fd = match openat(
        directory,
        name,
        OFlags::PATH | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    ) {
        Ok(fd) => fd,
        Err(Errno::NOENT) => return Err(FileReadError::Missing),
        Err(_) => return Err(FileReadError::Invalid),
    };
    validate_open_regular(File::from(fd), maximum)
}

fn validate_open_regular(file: File, maximum: u64) -> Result<File, FileReadError> {
    let metadata = file.metadata().map_err(|_| FileReadError::Invalid)?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > maximum {
        return Err(FileReadError::Invalid);
    }
    Ok(file)
}

fn is_directory(file: &File) -> bool {
    fstat(file)
        .map(|stat| FileType::from_raw_mode(stat.st_mode).is_dir())
        .unwrap_or(false)
}

fn read_bounded(mut file: File, maximum: u64) -> Result<Vec<u8>, ()> {
    let mut bytes = Vec::new();
    file.by_ref()
        .take(maximum + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    if bytes.is_empty() || bytes.len() as u64 > maximum {
        return Err(());
    }
    Ok(bytes)
}

fn record_mode_issue(file: &File, expected: u32, code: &str, output: &mut Vec<String>) -> bool {
    let mode = match file.metadata() {
        Ok(metadata) => metadata.permissions().mode() & 0o777,
        Err(_) => {
            output.push(format!("{code}_unavailable"));
            return false;
        }
    };
    if mode != expected {
        output.push(code.to_owned());
        return false;
    }
    true
}

fn inspect_orphan_temps(root: &File) -> Result<OrphanTempReport, ()> {
    let mut directory = Dir::read_from(root).map_err(|_| ())?;
    let now = OffsetDateTime::now_utc().unix_timestamp();
    let mut count = 0_u64;
    let mut oldest_age_seconds = None;
    while let Some(entry) = directory.read() {
        let entry = entry.map_err(|_| ())?;
        let Ok(name) = entry.file_name().to_str() else {
            continue;
        };
        if !orphan_credential_temp_name(name) {
            continue;
        }
        let stat = statat(root, name, AtFlags::SYMLINK_NOFOLLOW).map_err(|_| ())?;
        if !FileType::from_raw_mode(stat.st_mode).is_file() {
            continue;
        }
        count = count.saturating_add(1);
        let age = now.saturating_sub(stat.st_mtime).try_into().unwrap_or(0);
        oldest_age_seconds = Some(oldest_age_seconds.unwrap_or(0).max(age));
    }
    Ok(OrphanTempReport {
        count,
        oldest_age_seconds,
    })
}

fn orphan_credential_temp_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix(".platform-router-key-") else {
        return false;
    };
    let Some((credential_id, temporary)) = rest.split_once(".key.") else {
        return false;
    };
    let Some(temporary_id) = temporary.strip_suffix(".tmp") else {
        return false;
    };
    canonical_uuid(credential_id) && canonical_uuid(temporary_id)
}

pub fn reserved_platform_router_slot(slot: &str) -> bool {
    validate_credential_name(slot).is_ok()
        || slot == POINTER_FILE
        || slot == GENERATION_DIRECTORY
        || slot == LEGACY_CONFIG_FILE
        || slot.starts_with("platform-router.")
        || slot.starts_with(".platform-router.current.")
        || slot.starts_with(".platform-router.tx.lock.")
        || slot.starts_with(".platform-router-key-")
        || slot.starts_with("platform-router.generations.")
        || slot.starts_with("platform-router.transaction")
}

fn validate_credential_name(value: &str) -> Result<&str, ()> {
    if value == LEGACY_KEY_FILE {
        return Ok(value);
    }
    let Some(id) = value
        .strip_prefix("platform-router-key-")
        .and_then(|value| value.strip_suffix(".key"))
    else {
        return Err(());
    };
    if value.contains('/') || value.contains('\\') || value.contains("..") || !canonical_uuid(id) {
        return Err(());
    }
    Ok(value)
}

fn canonical_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|uuid| {
        uuid.to_string() == value
            && !uuid.is_nil()
            && uuid.get_variant() == Variant::RFC4122
            && (1..=8).contains(&uuid.get_version_num())
    })
}

fn lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn bounded_safe_integer(value: &Value, fallback: i64, minimum: i64, maximum: i64) -> i64 {
    value
        .as_f64()
        .filter(|value| value.is_finite() && value.fract() == 0.0)
        .filter(|value| value.abs() <= MAX_SAFE_INTEGER)
        .map(|value| (value as i64).clamp(minimum, maximum))
        .unwrap_or(fallback)
}

fn bounded_number(value: &Value, fallback: f64, minimum: f64, maximum: f64) -> f64 {
    value
        .as_f64()
        .filter(|value| value.is_finite())
        .map(|value| value.clamp(minimum, maximum))
        .unwrap_or(fallback)
}

fn normalize_reasoning_efforts(value: &Value) -> Vec<String> {
    let Some(values) = value.as_array() else {
        return Vec::new();
    };
    let mut normalized = Vec::new();
    for value in values {
        let Some(value) = value.as_str() else {
            continue;
        };
        if value.is_empty()
            || value.len() > 32
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            || normalized.iter().any(|candidate| candidate == value)
        {
            continue;
        }
        normalized.push(value.to_owned());
        if normalized.len() == 16 {
            break;
        }
    }
    normalized
}

fn bounded_text(value: &str, maximum: usize) -> Result<String, ()> {
    let value = value.trim();
    if value.is_empty() || utf16_len(value) > maximum {
        return Err(());
    }
    Ok(value.to_owned())
}

fn bounded_line(value: &str, maximum: usize) -> Result<(), ()> {
    let value = value.trim();
    if value.is_empty()
        || utf16_len(value) > maximum
        || value.contains('\r')
        || value.contains('\n')
    {
        return Err(());
    }
    Ok(())
}

fn valid_timestamp(value: &str) -> bool {
    let Ok(timestamp) = OffsetDateTime::parse(value, &Rfc3339) else {
        return false;
    };
    if timestamp.offset() != time::UtcOffset::UTC || timestamp.nanosecond() % 1_000_000 != 0 {
        return false;
    }
    let canonical = format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        timestamp.year(),
        u8::from(timestamp.month()),
        timestamp.day(),
        timestamp.hour(),
        timestamp.minute(),
        timestamp.second(),
        timestamp.nanosecond() / 1_000_000
    );
    value == canonical
}

pub(crate) fn private_or_reserved_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => private_or_reserved_ipv4(address),
        IpAddr::V6(address) => {
            if let Some(mapped) = address.to_ipv4_mapped() {
                return private_or_reserved_ipv4(mapped);
            }
            let value = u128::from(address);
            // Non-mapped IPv6 is allowed only in the currently delegated global-unicast space.
            if !cidr_contains_u128(value, 0x2000_0000_0000_0000_0000_0000_0000_0000_u128, 3) {
                return true;
            }
            [
                // IETF protocol assignments (including Teredo, benchmarking, and ORCHID).
                (0x2001_0000_0000_0000_0000_0000_0000_0000_u128, 23),
                // Documentation and 6to4.
                (0x2001_0db8_0000_0000_0000_0000_0000_0000_u128, 32),
                (0x2002_0000_0000_0000_0000_0000_0000_0000_u128, 16),
                // Direct Delegation AS112 and the second documentation allocation.
                (0x2620_004f_8000_0000_0000_0000_0000_0000_u128, 48),
                (0x3fff_0000_0000_0000_0000_0000_0000_0000_u128, 20),
            ]
            .into_iter()
            .any(|(network, prefix)| cidr_contains_u128(value, network, prefix))
        }
    }
}

fn private_or_reserved_ipv4(address: std::net::Ipv4Addr) -> bool {
    let value = u32::from(address);
    [
        (u32::from_be_bytes([0, 0, 0, 0]), 8),
        (u32::from_be_bytes([10, 0, 0, 0]), 8),
        (u32::from_be_bytes([100, 64, 0, 0]), 10),
        (u32::from_be_bytes([127, 0, 0, 0]), 8),
        (u32::from_be_bytes([169, 254, 0, 0]), 16),
        (u32::from_be_bytes([172, 16, 0, 0]), 12),
        (u32::from_be_bytes([192, 0, 0, 0]), 24),
        (u32::from_be_bytes([192, 0, 2, 0]), 24),
        (u32::from_be_bytes([192, 88, 99, 0]), 24),
        (u32::from_be_bytes([192, 168, 0, 0]), 16),
        (u32::from_be_bytes([198, 18, 0, 0]), 15),
        (u32::from_be_bytes([198, 51, 100, 0]), 24),
        (u32::from_be_bytes([203, 0, 113, 0]), 24),
        // Multicast and the former Class E / limited-broadcast space are never valid
        // credential-bearing provider destinations.
        (u32::from_be_bytes([224, 0, 0, 0]), 3),
    ]
    .into_iter()
    .any(|(network, prefix)| cidr_contains_u32(value, network, prefix))
}

fn cidr_contains_u32(value: u32, network: u32, prefix: u32) -> bool {
    let mask = u32::MAX.checked_shl(32 - prefix).unwrap_or(0);
    value & mask == network & mask
}

fn cidr_contains_u128(value: u128, network: u128, prefix: u32) -> bool {
    let mask = u128::MAX.checked_shl(128 - prefix).unwrap_or(0);
    value & mask == network & mask
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::fs::{PermissionsExt, symlink},
    };

    use serde_json::json;

    const GENERATION_ID: &str = "018f47a2-4e8d-7a31-8e34-2feea4be9a11";
    const OTHER_GENERATION_ID: &str = "018f47a2-4e8d-7a31-8e34-2feea4be9a12";
    const CREDENTIAL_ID: &str = "018f47a2-4e8d-7a31-8e34-2feea4be9a13";
    const TEMPORARY_ID: &str = "018f47a2-4e8d-7a31-8e34-2feea4be9a14";
    const SECRET: &str = "never-serialize-this-managed-secret";

    struct TestRoot {
        path: PathBuf,
    }

    impl TestRoot {
        fn new() -> Self {
            let path = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../target/xtask-platform-router-tests")
                .join(Uuid::now_v7().to_string());
            fs::create_dir_all(&path).expect("create managed reader test root");
            fs::set_permissions(&path, fs::Permissions::from_mode(0o770))
                .expect("protect managed reader test root");
            let path = fs::canonicalize(path).expect("canonicalize managed reader test root");
            Self { path }
        }

        fn reader(&self) -> PlatformRouterReader {
            PlatformRouterReader::new(&self.path)
        }

        fn write_file(&self, name: &str, bytes: &[u8], mode: u32) {
            let path = self.path.join(name);
            fs::write(&path, bytes).expect("write test file");
            fs::set_permissions(path, fs::Permissions::from_mode(mode)).expect("protect test file");
        }

        fn credential_name() -> String {
            format!("platform-router-key-{CREDENTIAL_ID}.key")
        }

        fn generation_value(enabled: bool, credential: &str) -> Value {
            json!({
                "schemaVersion": 1,
                "generationId": GENERATION_ID,
                "parentGenerationId": null,
                "committedAt": "2026-08-25T00:00:00.000Z",
                "active": {
                    "endpoint": "https://api.lmm.best/v1",
                    "model": "deepseek-v3.2",
                    "protocol": "openai-compatible",
                    "enabled": enabled,
                    "credentialFile": credential
                },
                "draft": null,
                "pendingAudit": []
            })
        }

        fn install_generation(&self, value: Value, pointer_id: &str, checksum: Option<String>) {
            let directory = self.path.join(GENERATION_DIRECTORY);
            fs::create_dir(&directory).expect("create generation directory");
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o750))
                .expect("protect generation directory");
            let bytes = serde_json::to_vec(&value).expect("encode generation fixture");
            let generation_file = directory.join(format!("{pointer_id}.json"));
            fs::write(&generation_file, &bytes).expect("write generation fixture");
            fs::set_permissions(&generation_file, fs::Permissions::from_mode(0o640))
                .expect("protect generation fixture");
            let checksum = checksum.unwrap_or_else(|| hex::encode(Sha256::digest(&bytes)));
            let pointer = serde_json::to_vec(&json!({
                "schemaVersion": 1,
                "generationId": pointer_id,
                "sha256": checksum
            }))
            .expect("encode pointer fixture");
            self.write_file(POINTER_FILE, &pointer, 0o640);
        }

        fn install_credential(&self, name: &str, bytes: &[u8]) {
            self.write_file(name, bytes, 0o640);
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn reads_a_valid_managed_generation_and_secret() {
        let root = TestRoot::new();
        let credential = TestRoot::credential_name();
        root.install_credential(&credential, format!("{SECRET}\n").as_bytes());
        root.install_generation(
            TestRoot::generation_value(true, &credential),
            GENERATION_ID,
            None,
        );

        let read = root.reader().read();
        assert_eq!(read.source(), ManagedSource::ManagedGeneration);
        assert!(read.mount_report().ok);
        assert_eq!(read.active().map(|config| config.enabled), Some(true));
        let secret = read
            .read_active_secret()
            .expect("read valid secret")
            .expect("active secret exists");
        assert_eq!(secrecy::ExposeSecret::expose_secret(&secret), SECRET);
    }

    #[test]
    fn one_byte_generation_mismatch_is_managed_unreadable() {
        let root = TestRoot::new();
        let credential = TestRoot::credential_name();
        root.install_credential(&credential, SECRET.as_bytes());
        let generation = TestRoot::generation_value(true, &credential);
        root.install_generation(generation.clone(), GENERATION_ID, None);
        let mut changed = generation;
        changed["active"]["model"] = Value::String("deepseek-v3.3".to_owned());
        let generation_file = root
            .path
            .join(GENERATION_DIRECTORY)
            .join(format!("{GENERATION_ID}.json"));
        fs::write(
            generation_file,
            serde_json::to_vec(&changed).expect("encode changed generation"),
        )
        .expect("change one generation byte");

        let read = root.reader().read();
        assert_eq!(read.source(), ManagedSource::ManagedUnreadable);
        assert_eq!(
            read.unreadable().map(ManagedUnreadable::code),
            Some("managed_generation_checksum_mismatch")
        );
    }

    #[test]
    fn credential_traversal_is_rejected_before_opening() {
        let root = TestRoot::new();
        root.install_generation(
            TestRoot::generation_value(true, "../outside.key"),
            GENERATION_ID,
            None,
        );

        let read = root.reader().read();
        assert_eq!(read.source(), ManagedSource::ManagedUnreadable);
        assert_eq!(
            read.unreadable().map(ManagedUnreadable::code),
            Some("managed_generation_invalid")
        );
    }

    #[test]
    fn symlinked_and_oversized_credentials_are_rejected() {
        let root = TestRoot::new();
        let credential = TestRoot::credential_name();
        let outside = root
            .path
            .parent()
            .expect("test parent")
            .join("outside-secret");
        fs::write(&outside, SECRET).expect("write outside fixture");
        symlink(&outside, root.path.join(&credential)).expect("link credential fixture");
        root.install_generation(
            TestRoot::generation_value(true, &credential),
            GENERATION_ID,
            None,
        );
        assert_eq!(
            root.reader()
                .read()
                .unreadable()
                .map(ManagedUnreadable::code),
            Some("managed_credential_invalid")
        );
        fs::remove_file(root.path.join(&credential)).expect("remove symlink fixture");
        let _ = fs::remove_file(&outside);
        root.install_credential(&credential, &vec![b'x'; MAX_KEY_BYTES as usize + 1]);
        assert_eq!(
            root.reader()
                .read()
                .unreadable()
                .map(ManagedUnreadable::code),
            Some("managed_credential_invalid")
        );
    }

    #[test]
    fn generation_symlink_and_size_and_pending_bounds_are_rejected() {
        let root = TestRoot::new();
        let directory = root.path.join(GENERATION_DIRECTORY);
        fs::create_dir(&directory).expect("create generation directory");
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o750))
            .expect("protect generation directory");
        let target = root.path.join("generation-target");
        fs::write(&target, b"{}").expect("write generation target");
        symlink(&target, directory.join(format!("{GENERATION_ID}.json")))
            .expect("link generation fixture");
        root.write_file(
            POINTER_FILE,
            serde_json::to_string(&json!({
                "schemaVersion": 1,
                "generationId": GENERATION_ID,
                "sha256": "00".repeat(32)
            }))
            .expect("encode pointer")
            .as_bytes(),
            0o640,
        );
        assert_eq!(
            root.reader()
                .read()
                .unreadable()
                .map(ManagedUnreadable::code),
            Some("managed_generation_unreadable")
        );

        let root = TestRoot::new();
        let directory = root.path.join(GENERATION_DIRECTORY);
        fs::create_dir(&directory).expect("create oversized generation directory");
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o750))
            .expect("protect oversized generation directory");
        let bytes = vec![b'x'; MAX_GENERATION_BYTES as usize + 1];
        let generation_file = directory.join(format!("{GENERATION_ID}.json"));
        fs::write(&generation_file, &bytes).expect("write oversized generation");
        fs::set_permissions(&generation_file, fs::Permissions::from_mode(0o640))
            .expect("protect oversized generation");
        root.write_file(
            POINTER_FILE,
            serde_json::to_string(&json!({
                "schemaVersion": 1,
                "generationId": GENERATION_ID,
                "sha256": hex::encode(Sha256::digest(&bytes))
            }))
            .expect("encode oversized generation pointer")
            .as_bytes(),
            0o640,
        );
        assert_eq!(
            root.reader()
                .read()
                .unreadable()
                .map(ManagedUnreadable::code),
            Some("managed_generation_unreadable")
        );

        let root = TestRoot::new();
        let credential = TestRoot::credential_name();
        root.install_credential(&credential, SECRET.as_bytes());
        let mut generation = TestRoot::generation_value(true, &credential);
        generation["pendingAudit"] = Value::Array(vec![
            json!({
                "eventId": GENERATION_ID,
                "at": "2026-08-25T00:00:00.000Z",
                "action": "stage",
                "actor": "operator",
                "requestId": "request",
                "endpointOrigin": "https://api.lmm.best",
                "model": "gpt-5.6-sol",
                "enabled": true,
                "keyChanged": false
            });
            MAX_PENDING_AUDIT_RECORDS + 1
        ]);
        root.install_generation(generation, GENERATION_ID, None);
        assert_eq!(
            root.reader()
                .read()
                .unreadable()
                .map(ManagedUnreadable::code),
            Some("managed_generation_invalid")
        );

        let root = TestRoot::new();
        root.write_file(
            POINTER_FILE,
            &vec![b'x'; MAX_POINTER_BYTES as usize + 1],
            0o640,
        );
        assert_eq!(
            root.reader()
                .read()
                .unreadable()
                .map(ManagedUnreadable::code),
            Some("managed_pointer_unreadable")
        );
    }

    #[test]
    fn credential_metadata_validation_does_not_read_bytes() {
        let root = TestRoot::new();
        let credential = TestRoot::credential_name();
        root.install_credential(&credential, &[0xff, 0xfe, 0xfd]);
        root.install_generation(
            TestRoot::generation_value(true, &credential),
            GENERATION_ID,
            None,
        );
        let read = root.reader().read();
        assert_eq!(read.source(), ManagedSource::ManagedGeneration);
        assert!(read.mount_report().ok);
        assert_eq!(
            read.read_active_secret()
                .expect_err("preflight read must reject invalid UTF-8")
                .code(),
            "managed_credential_invalid"
        );
    }

    #[test]
    fn missing_credential_is_typed_unreadable() {
        let root = TestRoot::new();
        let credential = TestRoot::credential_name();
        root.install_generation(
            TestRoot::generation_value(true, &credential),
            GENERATION_ID,
            None,
        );
        assert_eq!(
            root.reader()
                .read()
                .unreadable()
                .map(ManagedUnreadable::code),
            Some("managed_credential_missing")
        );
    }

    #[test]
    fn pointer_symlink_and_noncanonical_uuid_are_rejected() {
        let root = TestRoot::new();
        let target = root.path.join("pointer-target");
        fs::write(&target, b"{}").expect("write pointer target");
        symlink(&target, root.path.join(POINTER_FILE)).expect("link pointer fixture");
        assert_eq!(
            root.reader()
                .read()
                .unreadable()
                .map(ManagedUnreadable::code),
            Some("managed_pointer_unreadable")
        );
        fs::remove_file(root.path.join(POINTER_FILE)).expect("remove pointer symlink");
        root.write_file(
            POINTER_FILE,
            serde_json::to_string(&json!({
                "schemaVersion": 1,
                "generationId": GENERATION_ID.to_ascii_uppercase(),
                "sha256": "00".repeat(32)
            }))
            .expect("encode pointer")
            .as_bytes(),
            0o640,
        );
        assert_eq!(
            root.reader()
                .read()
                .unreadable()
                .map(ManagedUnreadable::code),
            Some("managed_pointer_invalid")
        );
    }

    #[test]
    fn stale_pointer_identity_is_rejected() {
        let root = TestRoot::new();
        let credential = TestRoot::credential_name();
        root.install_credential(&credential, SECRET.as_bytes());
        let mut generation = TestRoot::generation_value(true, &credential);
        generation["generationId"] = Value::String(OTHER_GENERATION_ID.to_owned());
        root.install_generation(generation, GENERATION_ID, None);
        assert_eq!(
            root.reader()
                .read()
                .unreadable()
                .map(ManagedUnreadable::code),
            Some("managed_generation_identity_mismatch")
        );
    }

    #[test]
    fn absent_pointer_and_legacy_allow_absent_but_malformed_legacy_does_not() {
        let root = TestRoot::new();
        assert_eq!(root.reader().read().source(), ManagedSource::Absent);
        root.write_file(LEGACY_CONFIG_FILE, b"not-json", 0o640);
        assert_eq!(
            root.reader()
                .read()
                .unreadable()
                .map(ManagedUnreadable::code),
            Some("legacy_managed_config_invalid")
        );
    }

    #[test]
    fn valid_legacy_config_is_used_only_when_the_pointer_is_absent() {
        let root = TestRoot::new();
        root.install_credential(LEGACY_KEY_FILE, SECRET.as_bytes());
        root.write_file(
            LEGACY_CONFIG_FILE,
            serde_json::to_string(&json!({
                "endpoint": "https://api.lmm.best/v1/",
                "model": "deepseek-v3.2",
                "protocol": "openai-compatible",
                "enabled": true
            }))
            .expect("encode legacy fixture")
            .as_bytes(),
            0o640,
        );
        let read = root.reader().read();
        assert_eq!(read.source(), ManagedSource::Legacy);
        assert_eq!(
            read.active().map(|config| config.endpoint.as_str()),
            Some("https://api.lmm.best/v1")
        );
        assert!(read.mount_report().ok);
    }

    #[test]
    fn missing_draft_attestation_field_and_private_endpoint_are_invalid() {
        let root = TestRoot::new();
        let credential = TestRoot::credential_name();
        root.install_credential(&credential, SECRET.as_bytes());
        let mut generation = TestRoot::generation_value(true, &credential);
        generation["draft"] = json!({
            "config": generation["active"].clone(),
            "metadata": { "keyChanged": false }
        });
        root.install_generation(generation, GENERATION_ID, None);
        assert_eq!(
            root.reader()
                .read()
                .unreadable()
                .map(ManagedUnreadable::code),
            Some("managed_generation_invalid")
        );

        let root = TestRoot::new();
        let credential = TestRoot::credential_name();
        root.install_credential(&credential, SECRET.as_bytes());
        let mut generation = TestRoot::generation_value(true, &credential);
        generation["active"]["endpoint"] = Value::String("https://127.0.0.1/v1".to_owned());
        root.install_generation(generation, GENERATION_ID, None);
        assert_eq!(
            root.reader()
                .read()
                .unreadable()
                .map(ManagedUnreadable::code),
            Some("managed_generation_invalid")
        );
    }

    #[test]
    fn valid_disabled_generation_remains_authoritative() {
        let root = TestRoot::new();
        let credential = TestRoot::credential_name();
        root.install_credential(&credential, SECRET.as_bytes());
        root.install_generation(
            TestRoot::generation_value(false, &credential),
            GENERATION_ID,
            None,
        );
        let read = root.reader().read();
        assert_eq!(read.source(), ManagedSource::ManagedGeneration);
        assert_eq!(read.active().map(|config| config.enabled), Some(false));
    }

    #[test]
    fn root_and_generation_directory_symlinks_are_rejected() {
        let real = TestRoot::new();
        let link = real
            .path
            .parent()
            .expect("test parent")
            .join(format!("root-link-{}", Uuid::now_v7()));
        symlink(&real.path, &link).expect("create root symlink");
        assert_eq!(
            PlatformRouterReader::new(&link).read().source(),
            ManagedSource::ManagedUnreadable
        );
        fs::remove_file(&link).expect("remove root symlink");

        let root = TestRoot::new();
        let external = TestRoot::new();
        symlink(&external.path, root.path.join(GENERATION_DIRECTORY))
            .expect("create generation directory symlink");
        root.write_file(
            POINTER_FILE,
            serde_json::to_string(&json!({
                "schemaVersion": 1,
                "generationId": GENERATION_ID,
                "sha256": "00".repeat(32)
            }))
            .expect("encode pointer")
            .as_bytes(),
            0o640,
        );
        assert_eq!(
            root.reader()
                .read()
                .unreadable()
                .map(ManagedUnreadable::code),
            Some("managed_generation_directory_invalid")
        );
    }

    #[test]
    fn ipv6_policy_is_global_unicast_allowlist_with_explicit_special_range_carveouts() {
        let cases = [
            ("::", true),
            ("::1", true),
            ("::8.8.8.8", true),
            ("64:ff9b::808:808", true),
            ("100::1", true),
            ("2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff", false),
            ("2001::", true),
            ("2001:0:ffff::", true),
            ("2001:2::", true),
            ("2001:20::", true),
            ("2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff", true),
            ("2001:200::", false),
            ("2001:db7:ffff:ffff:ffff:ffff:ffff:ffff", false),
            ("2001:db8::", true),
            ("2001:db8:ffff:ffff:ffff:ffff:ffff:ffff", true),
            ("2001:db9::", false),
            ("2001:ffff:ffff:ffff:ffff:ffff:ffff:ffff", false),
            ("2002::", true),
            ("2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true),
            ("2003::", false),
            ("2606:4700:4700::1111", false),
            ("2620:4f:7fff:ffff:ffff:ffff:ffff:ffff", false),
            ("2620:4f:8000::", true),
            ("2620:4f:8000:ffff:ffff:ffff:ffff:ffff", true),
            ("2620:4f:8001::", false),
            ("3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff", false),
            ("3fff::", true),
            ("3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff", true),
            ("3fff:1000::", false),
            ("4000::", true),
            ("8000::", true),
            ("fc00::1", true),
            ("fe80::1", true),
            ("fec0::1", true),
            ("ff00::1", true),
        ];
        for (address, rejected) in cases {
            let address = address.parse::<IpAddr>().expect("valid IP policy fixture");
            assert_eq!(
                private_or_reserved_ip(address),
                rejected,
                "unexpected policy for {address}"
            );
        }
    }

    #[test]
    fn ipv4_mapped_ipv6_uses_the_ipv4_classifier() {
        let cases = [
            ("::ffff:10.0.0.1", true),
            ("::ffff:169.254.169.254", true),
            ("::ffff:8.8.8.8", false),
            ("::ffff:1.1.1.1", false),
        ];
        for (address, rejected) in cases {
            let address = address
                .parse::<IpAddr>()
                .expect("valid mapped IPv6 fixture");
            assert_eq!(
                private_or_reserved_ip(address),
                rejected,
                "unexpected mapped policy for {address}"
            );
        }
    }

    #[test]
    fn mount_report_counts_only_exact_regular_orphan_temp_names_and_is_secret_safe() {
        let root = TestRoot::new();
        let credential = TestRoot::credential_name();
        root.install_credential(&credential, SECRET.as_bytes());
        let generation = TestRoot::generation_value(true, &credential);
        let checksum = hex::encode(Sha256::digest(
            serde_json::to_vec(&generation).expect("encode generation for checksum"),
        ));
        root.install_generation(generation, GENERATION_ID, None);
        let exact = format!(".platform-router-key-{CREDENTIAL_ID}.key.{TEMPORARY_ID}.tmp");
        root.write_file(&exact, b"orphan", 0o640);
        root.write_file(
            ".platform-router-key-not-a-uuid.key.bad.tmp",
            b"noise",
            0o640,
        );
        let linked = format!(".platform-router-key-{OTHER_GENERATION_ID}.key.{TEMPORARY_ID}.tmp");
        symlink(root.path.join(&exact), root.path.join(linked)).expect("link orphan fixture");

        let report = root.reader().read().mount_report();
        assert!(report.ok, "orphan credentials remain report-only");
        assert_eq!(report.orphan_temps.count, 1);
        assert!(report.orphan_temps.oldest_age_seconds.is_some());
        let output = serde_json::to_string(&report).expect("serialize mount report");
        assert!(!output.contains(SECRET));
        assert!(!output.contains(root.path.to_string_lossy().as_ref()));
        assert!(!output.contains(&credential));
        assert!(!output.contains(&checksum));
    }

    #[test]
    fn rejects_intermediate_parent_symlink_components() {
        let holder = TestRoot::new();
        let real_parent = holder.path.join("real-parent");
        let child = real_parent.join("child");
        fs::create_dir_all(&child).expect("create real intermediate root");
        fs::set_permissions(&real_parent, fs::Permissions::from_mode(0o770))
            .expect("protect real parent");
        fs::set_permissions(&child, fs::Permissions::from_mode(0o770)).expect("protect real child");
        let linked_parent = holder.path.join("linked-parent");
        symlink(&real_parent, &linked_parent).expect("link intermediate root component");

        let read = PlatformRouterReader::new(linked_parent.join("child")).read();
        assert_eq!(read.source(), ManagedSource::ManagedUnreadable);
        assert_eq!(
            read.unreadable().map(ManagedUnreadable::code),
            Some("managed_root_invalid")
        );

        let parent_path = child.join("..").join("child");
        let read = PlatformRouterReader::new(parent_path).read();
        assert_eq!(read.source(), ManagedSource::ManagedUnreadable);
        assert_eq!(
            read.unreadable().map(ManagedUnreadable::code),
            Some("managed_root_invalid")
        );
    }

    #[test]
    fn unsafe_modes_are_managed_unreadable_and_never_expose_a_secret_capability() {
        fn valid_root() -> (TestRoot, String) {
            let root = TestRoot::new();
            let credential = TestRoot::credential_name();
            root.install_credential(&credential, SECRET.as_bytes());
            root.install_generation(
                TestRoot::generation_value(true, &credential),
                GENERATION_ID,
                None,
            );
            (root, credential)
        }

        let (root, _) = valid_root();
        fs::set_permissions(&root.path, fs::Permissions::from_mode(0o750))
            .expect("make root mode unsafe");
        let read = root.reader().read();
        assert_eq!(
            read.unreadable().map(ManagedUnreadable::code),
            Some("managed_security_policy_invalid")
        );
        assert_eq!(
            read.read_active_secret()
                .expect_err("unsafe root mode refuses key reads")
                .code(),
            "managed_security_policy_invalid"
        );

        let (root, _) = valid_root();
        fs::set_permissions(
            root.path.join(POINTER_FILE),
            fs::Permissions::from_mode(0o660),
        )
        .expect("make pointer mode unsafe");
        assert_eq!(
            root.reader()
                .read()
                .unreadable()
                .map(ManagedUnreadable::code),
            Some("managed_security_policy_invalid")
        );

        let (root, _) = valid_root();
        fs::set_permissions(
            root.path.join(GENERATION_DIRECTORY),
            fs::Permissions::from_mode(0o770),
        )
        .expect("make generation directory mode unsafe");
        assert_eq!(
            root.reader()
                .read()
                .unreadable()
                .map(ManagedUnreadable::code),
            Some("managed_security_policy_invalid")
        );

        let (root, _) = valid_root();
        fs::set_permissions(
            root.path
                .join(GENERATION_DIRECTORY)
                .join(format!("{GENERATION_ID}.json")),
            fs::Permissions::from_mode(0o600),
        )
        .expect("make generation file mode unsafe");
        assert_eq!(
            root.reader()
                .read()
                .unreadable()
                .map(ManagedUnreadable::code),
            Some("managed_security_policy_invalid")
        );

        let (root, credential) = valid_root();
        fs::set_permissions(
            root.path.join(credential),
            fs::Permissions::from_mode(0o600),
        )
        .expect("make credential mode unsafe");
        let read = root.reader().read();
        assert_eq!(
            read.unreadable().map(ManagedUnreadable::code),
            Some("managed_security_policy_invalid")
        );
        assert_eq!(
            read.read_active_secret()
                .expect_err("unsafe credential mode refuses key reads")
                .code(),
            "managed_security_policy_invalid"
        );

        let root = TestRoot::new();
        root.install_credential(LEGACY_KEY_FILE, SECRET.as_bytes());
        let legacy = serde_json::to_vec(&json!({
            "endpoint": "https://api.lmm.best/v1",
            "model": "deepseek-v3.2",
            "protocol": "openai-compatible",
            "enabled": true
        }))
        .expect("encode legacy fixture");
        root.write_file(LEGACY_CONFIG_FILE, &legacy, 0o600);
        assert_eq!(
            root.reader()
                .read()
                .unreadable()
                .map(ManagedUnreadable::code),
            Some("managed_security_policy_invalid")
        );
    }

    #[test]
    fn active_credential_capability_survives_path_replacement_unlink_and_root_swap() {
        let root = TestRoot::new();
        let credential = TestRoot::credential_name();
        root.install_credential(&credential, SECRET.as_bytes());
        root.install_generation(
            TestRoot::generation_value(true, &credential),
            GENERATION_ID,
            None,
        );
        let read = root.reader().read();
        let original_path = root.path.join(&credential);
        let old_path = root.path.join("old-credential");
        fs::rename(&original_path, &old_path).expect("move original credential");
        root.install_credential(&credential, b"replacement-secret");
        let secret = read
            .read_active_secret()
            .expect("read retained credential")
            .expect("retained active credential");
        assert_eq!(secrecy::ExposeSecret::expose_secret(&secret), SECRET);
        fs::remove_file(&old_path).expect("unlink original credential inode");
        let secret = read
            .read_active_secret()
            .expect("read unlinked retained credential")
            .expect("retained unlinked credential");
        assert_eq!(secrecy::ExposeSecret::expose_secret(&secret), SECRET);

        let old_root = root
            .path
            .parent()
            .expect("test root parent")
            .join(format!("swapped-root-{}", Uuid::now_v7()));
        fs::rename(&root.path, &old_root).expect("swap validated root away");
        fs::create_dir(&root.path).expect("create replacement root");
        fs::set_permissions(&root.path, fs::Permissions::from_mode(0o770))
            .expect("protect replacement root");
        root.install_credential(&credential, b"replacement-root-secret");
        let secret = read
            .read_active_secret()
            .expect("read retained credential after root swap")
            .expect("retained credential after root swap");
        assert_eq!(secrecy::ExposeSecret::expose_secret(&secret), SECRET);
        fs::remove_dir_all(old_root).expect("remove swapped original root");
    }

    #[test]
    fn web_contract_fixture_matrix_preserves_exact_bytes_and_normalization() {
        const BASE: &str = "\"endpoint\":\"https://api.lmm.best/v1\",\"model\":\"deepseek-v3.2\",\"protocol\":\"openai-compatible\",\"enabled\":true,\"credentialFile\":\"platform-router.key\"";
        fn fixture(prefix: &str, suffix: &str) -> Vec<u8> {
            format!("{{{prefix}{BASE}{suffix}}}").into_bytes()
        }
        fn assert_checksum(bytes: &[u8], expected: &str) {
            assert_eq!(hex::encode(Sha256::digest(bytes)), expected);
        }

        let defaults = fixture("", "");
        assert_checksum(
            &defaults,
            "86e97338e2fa7564ef710fc5d7d8b66b58a6c07a880ebe3beab2bc332cc08ca6",
        );
        let config = decode_config_bytes(&defaults, false).expect("decode Web defaults fixture");
        assert_eq!(config.assistant_instructions, "");
        assert_eq!(config.assistant_max_output_tokens, 320);
        assert_eq!(config.assistant_temperature, 0.2);
        assert_eq!(config.assistant_max_steps, 5);
        assert_eq!(config.assistant_timeout_ms, 20_000);
        assert_eq!(config.assistant_reasoning_effort, "none");
        assert!(config.model_reasoning_efforts.is_empty());

        let exact_utf16_boundary = fixture(
            "",
            &format!(",\"assistantInstructions\":\"{}\"", "😀".repeat(2_000)),
        );
        assert_checksum(
            &exact_utf16_boundary,
            "adf5a104b3dda940cbb2cc542ddcf4a2e40e0972d33e12acdff7127d64636703",
        );
        assert_eq!(
            decode_config_bytes(&exact_utf16_boundary, false)
                .expect("accept 4000 UTF-16 code units")
                .assistant_instructions
                .encode_utf16()
                .count(),
            4_000
        );

        for (length, expected) in [
            (
                4_001,
                "50444ab9c9fea1c6dac8900cc9f5f2e7dccaeaa9b08a2c5e1dcfd01cbfe9ba9f",
            ),
            (
                5_001,
                "a27487d90cf544a6b0bb071a5da13c230497e993f373d44502499a6eee6bbdee",
            ),
        ] {
            let bytes = fixture(
                "",
                &format!(",\"assistantInstructions\":\"{}\"", "a".repeat(length)),
            );
            assert_checksum(&bytes, expected);
            assert!(
                decode_config_bytes(&bytes, false).is_err(),
                "Web rejects an instruction field with {length} UTF-16 code units"
            );
        }

        let malformed = fixture(
            "",
            ",\"assistantMaxOutputTokens\":\"bad\",\"assistantTemperature\":null,\"assistantMaxSteps\":1.5,\"assistantTimeoutMs\":9007199254740992",
        );
        assert_checksum(
            &malformed,
            "055be838a28cb60ae786d38ac9111c81b55f6f351ba38cdffbab8f0c3f667241",
        );
        let config = decode_config_bytes(&malformed, false).expect("default malformed tuning");
        assert_eq!(config.assistant_max_output_tokens, 320);
        assert_eq!(config.assistant_temperature, 0.2);
        assert_eq!(config.assistant_max_steps, 5);
        assert_eq!(config.assistant_timeout_ms, 20_000);

        let malformed_text_and_reasoning = fixture(
            "",
            ",\"assistantInstructions\":7,\"assistantReasoningEffort\":false,\"modelReasoningEfforts\":\"high\"",
        );
        assert_checksum(
            &malformed_text_and_reasoning,
            "928913bea6d47ec427b36191ed581e719a8f131e9a6f8b3c86c8d7b6d7f4b5b6",
        );
        let config = decode_config_bytes(&malformed_text_and_reasoning, false)
            .expect("default malformed text and reasoning fields");
        assert_eq!(config.assistant_instructions, "");
        assert_eq!(config.assistant_reasoning_effort, "none");
        assert!(config.model_reasoning_efforts.is_empty());

        let reasoning = fixture(
            "",
            ",\"assistantReasoningEffort\":\"high\",\"modelReasoningEfforts\":[\"low\",\"high\",\"low\",\"bad value\",7,\"medium\"]",
        );
        assert_checksum(
            &reasoning,
            "a1e3cbf8e7f92de4c8aeabcc275d7347630df207ab2ebde377d57e3f091efeb9",
        );
        let config = decode_config_bytes(&reasoning, false).expect("normalize reasoning fixture");
        assert_eq!(config.model_reasoning_efforts, ["low", "high", "medium"]);
        assert_eq!(config.assistant_reasoning_effort, "high");

        let unknown_and_duplicate = fixture(
            "\"unknown\":{\"nested\":true},\"endpoint\":\"https://wrong.example/v1\",",
            ",\"assistantMaxOutputTokens\":99999",
        );
        assert_checksum(
            &unknown_and_duplicate,
            "00e53e7b89a6e7f15291c2a7d75b44df11d18727af080e82a03a759df5a6705f",
        );
        let config = decode_config_bytes(&unknown_and_duplicate, false)
            .expect("ignore unknown and keep the last duplicate like JSON.parse");
        assert_eq!(config.endpoint, "https://api.lmm.best/v1");
        assert_eq!(config.assistant_max_output_tokens, 512);

        assert!(decode_config_bytes(br#"{\"endpoint\":7}"#, false).is_err());
    }

    #[test]
    fn reserved_slots_cover_router_state_but_not_unrelated_secrets() {
        for slot in [
            "platform-router.current",
            "platform-router.json",
            "platform-router.key",
            "platform-router.tx.lock",
            "platform-router-key-018f47a2-4e8d-7a31-8e34-2feea4be9a13.key",
            ".platform-router-key-018f47a2-4e8d-7a31-8e34-2feea4be9a13.key.018f47a2-4e8d-7a31-8e34-2feea4be9a14.tmp",
        ] {
            assert!(
                reserved_platform_router_slot(slot),
                "slot {slot} must be reserved"
            );
        }
        assert!(!reserved_platform_router_slot("smtp-password"));
    }
}
