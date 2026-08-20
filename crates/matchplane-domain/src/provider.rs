//! Domain-level provider capabilities used by configurable platform services.

/// External capability families supported by MatchPlane providers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderCapability {
    Authentication,
    ArtificialIntelligence,
    Payment,
    Notification,
}

/// Stable provider identity independent from implementation details.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderDescriptor {
    pub id: String,
    pub name: String,
    pub capability: ProviderCapability,
    pub enabled: bool,
}

impl ProviderDescriptor {
    #[must_use]
    pub fn enabled(
        id: impl Into<String>,
        name: impl Into<String>,
        capability: ProviderCapability,
    ) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            capability,
            enabled: true,
        }
    }
}
