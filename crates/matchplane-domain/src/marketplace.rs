//! Domain-neutral marketplace concepts shared by every vertical.
//!
//! A vehicle listing and a buyer request are adapters around the same two primitives: a supply
//! offer and a demand intent. The participant entity is deliberately identical on both sides; a
//! vertical may label it seller/buyer, provider/requester, or another pair without changing the
//! matching, consent, or revenue invariants.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{DomainId, MarketplacePartyId, MatchIntroductionId, PromotionCampaignId};

/// Perspective of one participant in a match.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchSide {
    /// A participant expressing a need or preference.
    Demand,
    /// A participant presenting an offer or capability.
    Supply,
}

/// A vertical-neutral participant intent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MatchIntent {
    /// Participant whose intent is being evaluated.
    pub participant_id: MarketplacePartyId,
    /// Whether this instance is a demand or supply perspective.
    pub side: MatchSide,
    /// Vertical containing the intent schema.
    pub domain_id: DomainId,
    /// Human narrative used by the negotiation/retrieval layer.
    pub narrative: String,
    /// Schema-validated structured attributes.
    pub attributes: Value,
}

/// A durable introduction connecting one demand intent and one supply intent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MatchIntroduction {
    /// Introduction identifier.
    pub id: MatchIntroductionId,
    /// Demand-side participant.
    pub demand_party_id: MarketplacePartyId,
    /// Supply-side participant.
    pub supply_party_id: MarketplacePartyId,
    /// Explainable score captured at match time.
    pub score: f64,
    /// Human/machine-readable reasons captured at match time.
    pub reasons: Vec<String>,
}

/// Contact channel that can be exchanged after explicit consent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContactChannel {
    /// Telephone number.
    Phone,
    /// WeChat account identifier.
    Wechat,
}

/// Platform revenue strategy independent of whether the parties later transact offline.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RevenuePolicy {
    /// Charge the supply-side participant for promotion/exposure.
    SellerPromotion,
    /// Charge a disclosed fee on a platform-observed transaction.
    TransactionFee,
    /// Allow both policies to be enabled by tenant configuration.
    Hybrid,
}

/// A supply-side advertising campaign associated with an offer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SellerPromotion {
    /// Promotion identifier.
    pub id: PromotionCampaignId,
    /// Supply participant who funds the campaign.
    pub sponsor_party_id: MarketplacePartyId,
    /// Offer or listing targeted by the campaign. The vertical owns its concrete ID mapping.
    pub target_key: String,
    /// Revenue policy used for this campaign.
    pub policy: RevenuePolicy,
    /// Pricing model such as fixed, impression, click, or qualified lead.
    pub pricing_model: String,
    /// Campaign parameters and targeting, validated by the vertical adapter.
    pub settings: Value,
}
