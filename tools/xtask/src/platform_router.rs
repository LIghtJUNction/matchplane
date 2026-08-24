use std::{
    collections::HashSet,
    fs::File,
    io::Read,
    net::IpAddr,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
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

#[derive(Debug, Clone)]
pub struct ManagedRouterConfig {
    pub endpoint: String,
    pub model: String,
    pub protocol: String,
    pub enabled: bool,
    credential_file: String,
}

#[derive(Debug, Clone)]
pub struct ManagedRouterRead {
    root: PathBuf,
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
        let Some(config) = self.active.as_ref() else {
            return Ok(None);
        };
        read_secret(&self.root, &config.credential_file).map(Some)
    }

    #[cfg(test)]
    pub(crate) fn test_managed_generation(enabled: bool) -> Self {
        Self {
            root: PathBuf::new(),
            source: ManagedSource::ManagedGeneration,
            active: Some(ManagedRouterConfig {
                endpoint: "https://api.lmm.best/v1".to_owned(),
                model: "deepseek-v3.2".to_owned(),
                protocol: "openai-compatible".to_owned(),
                enabled,
                credential_file: LEGACY_KEY_FILE.to_owned(),
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

#[derive(Debug, Clone)]
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
        let mut permissions = Vec::new();
        record_mode_issue(&root, 0o750, "root_mode", &mut permissions);
        let orphan_temps = match inspect_orphan_temps(&root) {
            Ok(report) => report,
            Err(()) => {
                permissions.push("orphan_temp_scan_unavailable".to_owned());
                OrphanTempReport {
                    count: 0,
                    oldest_age_seconds: None,
                }
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
        record_mode_issue(&pointer_file, 0o640, "pointer_mode", &mut permissions);
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
        record_mode_issue(
            &generation_directory,
            0o750,
            "generation_directory_mode",
            &mut permissions,
        );
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
        record_mode_issue(
            &generation_file,
            0o640,
            "generation_file_mode",
            &mut permissions,
        );
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
        if let Err(kind) = validate_credentials(
            &root,
            generation.active.as_ref(),
            generation.draft.as_ref(),
            &mut permissions,
        ) {
            return self.unreadable(kind, Some(true), Some(false), permissions, orphan_temps);
        }
        ManagedRouterRead {
            root: self.root.clone(),
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
        root: &File,
        mut permissions: Vec<String>,
        orphan_temps: OrphanTempReport,
    ) -> ManagedRouterRead {
        let legacy_file = match open_optional_regular(root, LEGACY_CONFIG_FILE, MAX_LEGACY_BYTES) {
            Ok(Some(file)) => file,
            Ok(None) => {
                return ManagedRouterRead {
                    root: self.root.clone(),
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
        record_mode_issue(&legacy_file, 0o640, "legacy_config_mode", &mut permissions);
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
        if let Err(kind) = validate_credentials(root, Some(&active), None, &mut permissions) {
            return self.unreadable(kind, None, None, permissions, orphan_temps);
        }
        ManagedRouterRead {
            root: self.root.clone(),
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
            root: self.root.clone(),
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
    let raw: RawConfig = serde_json::from_slice(bytes).map_err(|_| ())?;
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
        || candidate.len() > 2_048
        || parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path().len() > 512
        || parsed
            .host_str()
            .is_some_and(private_or_reserved_ip_literal)
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
    Ok(ManagedRouterConfig {
        endpoint,
        model,
        protocol: raw.protocol,
        enabled: raw.enabled,
        credential_file,
    })
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
        || endpoint
            .host_str()
            .is_some_and(private_or_reserved_ip_literal)
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
) -> Result<(), ManagedUnreadableKind> {
    let mut credentials = HashSet::new();
    if let Some(config) = active {
        credentials.insert(config.credential_file.as_str());
    }
    if let Some(config) = draft {
        credentials.insert(config.credential_file.as_str());
    }
    for credential in credentials {
        validate_credential_name(credential)
            .map_err(|_| ManagedUnreadableKind::CredentialInvalid)?;
        let file =
            open_required_metadata_regular(root, credential, MAX_KEY_BYTES).map_err(|error| {
                if error == FileReadError::Missing {
                    ManagedUnreadableKind::CredentialMissing
                } else {
                    ManagedUnreadableKind::CredentialInvalid
                }
            })?;
        record_mode_issue(&file, 0o640, "credential_mode", permission_issues);
    }
    Ok(())
}

fn read_secret(root: &Path, credential: &str) -> Result<SecretString, ManagedUnreadable> {
    validate_credential_name(credential)
        .map_err(|_| ManagedUnreadable::new(ManagedUnreadableKind::CredentialInvalid))?;
    let root = open_directory(root)
        .map_err(|_| ManagedUnreadable::new(ManagedUnreadableKind::RootInvalid))?;
    let file = open_required_regular(&root, credential, MAX_KEY_BYTES).map_err(|error| {
        ManagedUnreadable::new(if error == FileReadError::Missing {
            ManagedUnreadableKind::CredentialMissing
        } else {
            ManagedUnreadableKind::CredentialInvalid
        })
    })?;
    let mut bytes = read_bounded(file, MAX_KEY_BYTES)
        .map_err(|_| ManagedUnreadable::new(ManagedUnreadableKind::CredentialInvalid))?;
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
    if secret.is_empty() || secret.len() > MAX_KEY_BYTES as usize {
        let mut secret = secret;
        secret.zeroize();
        return Err(ManagedUnreadable::new(
            ManagedUnreadableKind::CredentialInvalid,
        ));
    }
    Ok(SecretString::from(secret))
}

fn open_directory(path: &Path) -> Result<File, Errno> {
    let fd = open(path, read_directory_flags(), Mode::empty())?;
    let file = File::from(fd);
    if is_directory(&file) {
        Ok(file)
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

fn record_mode_issue(file: &File, expected: u32, code: &str, output: &mut Vec<String>) {
    let mode = match file.metadata() {
        Ok(metadata) => metadata.permissions().mode() & 0o777,
        Err(_) => {
            output.push(format!("{code}_unavailable"));
            return;
        }
    };
    if mode != expected {
        output.push(code.to_owned());
    }
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

fn bounded_text(value: &str, maximum: usize) -> Result<String, ()> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > maximum {
        return Err(());
    }
    Ok(value.to_owned())
}

fn bounded_line(value: &str, maximum: usize) -> Result<(), ()> {
    let value = value.trim();
    if value.is_empty()
        || value.chars().count() > maximum
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

fn private_or_reserved_ip_literal(hostname: &str) -> bool {
    let Ok(address) = hostname
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
    else {
        return false;
    };
    match address {
        IpAddr::V4(address) => {
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
                (u32::from_be_bytes([224, 0, 0, 0]), 4),
            ]
            .into_iter()
            .any(|(network, prefix)| cidr_contains_u32(value, network, prefix))
        }
        IpAddr::V6(address) => {
            let value = u128::from(address);
            [
                (0_u128, 128),
                (1_u128, 128),
                (0x0000_0000_0000_0000_0000_ffff_0000_0000_u128, 96),
                (0x0100_0000_0000_0000_0000_0000_0000_0000_u128, 64),
                (0x2001_0db8_0000_0000_0000_0000_0000_0000_u128, 32),
                (0xfc00_0000_0000_0000_0000_0000_0000_0000_u128, 7),
                (0xfe80_0000_0000_0000_0000_0000_0000_0000_u128, 10),
                (0xff00_0000_0000_0000_0000_0000_0000_0000_u128, 8),
            ]
            .into_iter()
            .any(|(network, prefix)| cidr_contains_u128(value, network, prefix))
        }
    }
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
            fs::set_permissions(&path, fs::Permissions::from_mode(0o750))
                .expect("protect managed reader test root");
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
        assert_eq!(report.orphan_temps.count, 1);
        assert!(report.orphan_temps.oldest_age_seconds.is_some());
        let output = serde_json::to_string(&report).expect("serialize mount report");
        assert!(!output.contains(SECRET));
        assert!(!output.contains(root.path.to_string_lossy().as_ref()));
        assert!(!output.contains(&credential));
        assert!(!output.contains(&checksum));
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
