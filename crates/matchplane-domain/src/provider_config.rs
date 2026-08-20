//! Domain model for administrator-managed provider configuration.

use super::{ProviderCapability, ProviderDescriptor};

/// Configuration metadata for an external platform provider.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderConfig {
    /// Stable provider identifier.
    pub id: String,
    /// Human readable name.
    pub name: String,
    /// Provider capability category.
    pub capability: ProviderCapability,
    /// Whether this provider can be selected by runtime services.
    pub enabled: bool,
    /// Public endpoint identifier, never containing secrets.
    pub endpoint: Option<String>,
}

impl ProviderConfig {
    /// Creates runtime descriptor from persisted configuration.
    pub fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor {
            id: self.id.clone(),
            name: self.name.clone(),
            capability: self.capability,
            enabled: self.enabled,
        }
    }
}
