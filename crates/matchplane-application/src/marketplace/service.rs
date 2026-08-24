use axum::http::HeaderMap;
use matchplane_domain::{
    DomainId, MarketplaceIntentId, MarketplaceOfferId, MarketplacePartyId, MatchIntroductionId,
    TenantId,
};
use matchplane_http::{
    party_bearer_token_hash, platform_path_from_headers, request_fingerprint,
    request_id_from_headers,
};
use matchplane_storage::{
    AcceptMarketplaceContact, AuthenticatedParty, CreateMarketplaceIntent,
    CreateMarketplaceIntroduction, CreateMarketplaceOffer, CreateMarketplaceSalesHandoff,
    MarketplaceBehaviorEventOutcome, MarketplaceContactEnvelope, MarketplaceDemandCandidate,
    MarketplaceIntent, MarketplaceIntentOutcome, MarketplaceIntentProfile, MarketplaceIntroduction,
    MarketplaceIntroductionOutcome, MarketplaceOffer, MarketplaceOfferCandidate,
    MarketplaceOfferOutcome, MarketplaceOfferPreference, MarketplaceSalesHandoff,
    MatchMarketplaceDemands, MatchMarketplaceOffers, RecordMarketplaceBehaviorEvent,
    RequestMarketplaceContact, SetMarketplaceOfferPreference, StorageError,
    UpdateMarketplaceDemandDiscovery, UpdateMarketplaceIntent, UpdateMarketplaceOffer,
    UpsertMarketplaceIntentProfile, WithdrawMarketplaceOffer,
};

use crate::ApplicationError;

use super::ports::MarketplaceWriter;

/// Seller-owned fields and scope required to update one marketplace offer.
#[derive(Debug)]
pub struct UpdateOfferCommand {
    /// Tenant that owns the offer.
    pub tenant_id: TenantId,
    /// Domain that scopes the offer.
    pub domain_id: DomainId,
    /// Authenticated supply-side party performing the update.
    pub actor_party_id: MarketplacePartyId,
    /// Offer being updated.
    pub offer_id: MarketplaceOfferId,
    /// Public offer name.
    pub display_name: String,
    /// Domain-defined public attributes.
    pub attributes: serde_json::Value,
    /// Domain-defined commercial terms.
    pub terms: serde_json::Value,
    /// Optimistic-lock version expected by the caller.
    pub expected_version: i64,
}

/// Scope and pagination for an authenticated marketplace offer listing.
#[derive(Debug, Clone, Copy)]
pub struct ListOffersQuery {
    /// Tenant that owns the offers.
    pub tenant_id: TenantId,
    /// Domain that scopes the offers.
    pub domain_id: DomainId,
    /// Authenticated supply-side party requesting the listing.
    pub supply_party_id: MarketplacePartyId,
    /// Whether an administrator is requesting all offers in the domain.
    pub domain_wide: bool,
    /// Maximum number of offers to return.
    pub limit: u16,
    /// Number of offers to skip.
    pub offset: u32,
}

/// Domain-neutral marketplace application service.
#[derive(Debug, Clone)]
pub struct MarketplaceService<W> {
    writer: W,
}

impl<W> MarketplaceService<W> {
    /// Creates a marketplace service bound to a persistence port.
    pub fn new(writer: W) -> Self {
        Self { writer }
    }

    /// Ensures a party exposes a legacy buyer/seller role.
    pub fn ensure_role(party: &AuthenticatedParty, role: &str) -> Result<(), ApplicationError> {
        require_role(party, role)
    }

    /// Ensures a party exposes a domain-neutral marketplace side.
    pub fn ensure_marketplace_side(
        party: &AuthenticatedParty,
        side: &str,
    ) -> Result<(), ApplicationError> {
        require_marketplace_side(party, side)
    }
}

impl<W: MarketplaceWriter> MarketplaceService<W> {
    /// Authenticates a marketplace party within a tenant scope.
    pub async fn authenticate(
        &self,
        headers: &HeaderMap,
        tenant_id: TenantId,
        party_id: MarketplacePartyId,
    ) -> Result<AuthenticatedParty, ApplicationError> {
        let token_hash = party_bearer_token_hash(headers)?;
        let platform_path = platform_path_from_headers(headers, false)?;
        self.writer
            .authenticate_marketplace_party(
                tenant_id,
                party_id,
                token_hash.as_slice(),
                None,
                platform_path.as_deref(),
            )
            .await
            .map_err(map_party_auth_error)
    }

    /// Authenticates a marketplace party within a tenant/domain/path scope.
    pub async fn authenticate_domain(
        &self,
        headers: &HeaderMap,
        tenant_id: TenantId,
        party_id: MarketplacePartyId,
        domain_id: DomainId,
    ) -> Result<AuthenticatedParty, ApplicationError> {
        let token_hash = party_bearer_token_hash(headers)?;
        let platform_path = platform_path_from_headers(headers, true)?.ok_or_else(|| {
            ApplicationError::validation(
                "x-matchplane-platform-path is required for child platform capabilities",
            )
        })?;
        self.writer
            .authenticate_marketplace_party(
                tenant_id,
                party_id,
                token_hash.as_slice(),
                Some(domain_id),
                Some(&platform_path),
            )
            .await
            .map_err(map_party_auth_error)
    }

    /// Creates a marketplace intent after authenticating the participant.
    pub async fn create_intent(
        &self,
        headers: &HeaderMap,
        command: &CreateMarketplaceIntent,
    ) -> Result<(MarketplaceIntentOutcome, bool), ApplicationError> {
        let party = self
            .authenticate_domain(
                headers,
                command.tenant_id,
                command.participant_id,
                command.domain_id,
            )
            .await?;
        require_marketplace_side(&party, &command.side)?;
        let outcome = self.writer.create_marketplace_intent(command).await?;
        Ok((outcome.clone(), outcome.duplicate))
    }

    /// Loads an intent owned by the authenticated participant.
    pub async fn intent(
        &self,
        headers: &HeaderMap,
        tenant_id: TenantId,
        domain_id: Option<DomainId>,
        participant_id: MarketplacePartyId,
        intent_id: MarketplaceIntentId,
    ) -> Result<MarketplaceIntent, ApplicationError> {
        if let Some(domain_id) = domain_id {
            self.authenticate_domain(headers, tenant_id, participant_id, domain_id)
                .await?;
        } else {
            self.authenticate(headers, tenant_id, participant_id)
                .await?;
        }
        let intent = self.writer.marketplace_intent(tenant_id, intent_id).await?;
        if intent.participant_id != participant_id {
            return Err(ApplicationError::forbidden(
                "marketplace intent belongs to another participant",
            ));
        }
        Ok(intent)
    }

    /// Updates an authenticated participant's intent.
    pub async fn update_intent(
        &self,
        headers: &HeaderMap,
        request: &UpdateMarketplaceIntent,
    ) -> Result<MarketplaceIntent, ApplicationError> {
        self.authenticate_domain(
            headers,
            request.tenant_id,
            request.participant_id,
            request.domain_id,
        )
        .await?;
        self.writer
            .update_marketplace_intent(request)
            .await
            .map_err(ApplicationError::from)
    }

    /// Reads a participant profile.
    pub async fn profile(
        &self,
        headers: &HeaderMap,
        tenant_id: TenantId,
        domain_id: DomainId,
        participant_id: MarketplacePartyId,
    ) -> Result<Option<MarketplaceIntentProfile>, ApplicationError> {
        self.authenticate_domain(headers, tenant_id, participant_id, domain_id)
            .await?;
        self.writer
            .marketplace_intent_profile(tenant_id, domain_id, participant_id)
            .await
            .map_err(ApplicationError::from)
    }

    /// Upserts a participant profile.
    pub async fn upsert_profile(
        &self,
        headers: &HeaderMap,
        request: &UpsertMarketplaceIntentProfile,
    ) -> Result<MarketplaceIntentProfile, ApplicationError> {
        self.authenticate_domain(
            headers,
            request.tenant_id,
            request.participant_id,
            request.domain_id,
        )
        .await?;
        self.writer
            .upsert_marketplace_intent_profile(request)
            .await
            .map_err(ApplicationError::from)
    }

    /// Records a behavior event for an authenticated participant.
    pub async fn behavior_event(
        &self,
        headers: &HeaderMap,
        request: &RecordMarketplaceBehaviorEvent,
    ) -> Result<(MarketplaceBehaviorEventOutcome, bool), ApplicationError> {
        self.authenticate_domain(
            headers,
            request.tenant_id,
            request.participant_id,
            request.domain_id,
        )
        .await?;
        let outcome = self
            .writer
            .record_marketplace_behavior_event(request)
            .await?;
        Ok((outcome.clone(), outcome.duplicate))
    }

    /// Lists offer preferences for a participant.
    pub async fn preferences(
        &self,
        headers: &HeaderMap,
        tenant_id: TenantId,
        domain_id: DomainId,
        participant_id: MarketplacePartyId,
    ) -> Result<Vec<MarketplaceOfferPreference>, ApplicationError> {
        self.authenticate_domain(headers, tenant_id, participant_id, domain_id)
            .await?;
        self.writer
            .marketplace_offer_preferences_for_party(tenant_id, domain_id, participant_id)
            .await
            .map_err(ApplicationError::from)
    }

    /// Sets an offer preference for a participant.
    pub async fn set_preference(
        &self,
        headers: &HeaderMap,
        request: &SetMarketplaceOfferPreference,
    ) -> Result<MarketplaceOfferPreference, ApplicationError> {
        let party = self
            .authenticate_domain(
                headers,
                request.tenant_id,
                request.participant_id,
                request.domain_id,
            )
            .await?;
        require_marketplace_side(&party, "demand")?;
        self.writer
            .set_marketplace_offer_preference(request)
            .await
            .map_err(ApplicationError::from)
    }

    /// Creates a sales handoff for a participant.
    pub async fn create_sales_handoff(
        &self,
        headers: &HeaderMap,
        request: &CreateMarketplaceSalesHandoff,
    ) -> Result<MarketplaceSalesHandoff, ApplicationError> {
        let party = self
            .authenticate_domain(
                headers,
                request.tenant_id,
                request.participant_id,
                request.domain_id,
            )
            .await?;
        require_marketplace_side(&party, "demand")?;
        self.writer
            .create_marketplace_sales_handoff(request)
            .await
            .map_err(ApplicationError::from)
    }

    /// Matches offers for a demand-side participant.
    pub async fn match_offers(
        &self,
        headers: &HeaderMap,
        tenant_id: TenantId,
        domain_id: DomainId,
        participant_id: MarketplacePartyId,
        intent_id: MarketplaceIntentId,
        limit: usize,
    ) -> Result<Vec<MarketplaceOfferCandidate>, ApplicationError> {
        let party = self
            .authenticate_domain(headers, tenant_id, participant_id, domain_id)
            .await?;
        require_marketplace_side(&party, "demand")?;
        self.writer
            .match_marketplace_offers(&MatchMarketplaceOffers {
                tenant_id,
                intent_id,
                participant_id,
                limit,
            })
            .await
            .map_err(ApplicationError::from)
    }

    /// Matches demands for a supply-side participant.
    pub async fn match_demands(
        &self,
        headers: &HeaderMap,
        tenant_id: TenantId,
        domain_id: DomainId,
        participant_id: MarketplacePartyId,
        offer_id: MarketplaceOfferId,
        limit: usize,
    ) -> Result<Vec<MarketplaceDemandCandidate>, ApplicationError> {
        let party = self
            .authenticate_domain(headers, tenant_id, participant_id, domain_id)
            .await?;
        require_marketplace_side(&party, "supply")?;
        self.writer
            .match_marketplace_demands(&MatchMarketplaceDemands {
                tenant_id,
                domain_id,
                offer_id,
                participant_id,
                limit,
            })
            .await
            .map_err(ApplicationError::from)
    }

    /// Updates demand discovery settings for an intent.
    pub async fn update_demand_discovery(
        &self,
        headers: &HeaderMap,
        request: &UpdateMarketplaceDemandDiscovery,
    ) -> Result<MarketplaceIntent, ApplicationError> {
        let party = self
            .authenticate_domain(
                headers,
                request.tenant_id,
                request.participant_id,
                request.domain_id,
            )
            .await?;
        require_marketplace_side(&party, "demand")?;
        self.writer
            .update_marketplace_demand_discovery(request)
            .await
            .map_err(ApplicationError::from)
    }

    /// Creates a marketplace offer for a supply-side participant.
    pub async fn create_offer(
        &self,
        headers: &HeaderMap,
        command: &CreateMarketplaceOffer,
    ) -> Result<(MarketplaceOfferOutcome, bool), ApplicationError> {
        let party = self
            .authenticate_domain(
                headers,
                command.tenant_id,
                command.supply_party_id,
                command.domain_id,
            )
            .await?;
        require_marketplace_side(&party, "supply")?;
        let outcome = self.writer.create_marketplace_offer(command).await?;
        Ok((outcome.clone(), outcome.duplicate))
    }

    /// Updates an offer on behalf of a supply-side participant.
    pub async fn update_offer(
        &self,
        headers: &HeaderMap,
        command: UpdateOfferCommand,
    ) -> Result<MarketplaceOffer, ApplicationError> {
        let party = self
            .authenticate_domain(
                headers,
                command.tenant_id,
                command.actor_party_id,
                command.domain_id,
            )
            .await?;
        require_marketplace_side(&party, "supply")?;
        self.writer
            .update_marketplace_offer(&UpdateMarketplaceOffer {
                tenant_id: command.tenant_id,
                domain_id: command.domain_id,
                actor_party_id: command.actor_party_id,
                can_manage_domain: matches!(party.role.as_str(), "admin" | "both"),
                platform_path: party.platform_path.clone(),
                request_id: request_id_from_headers(headers),
                offer_id: command.offer_id,
                display_name: command.display_name,
                attributes: command.attributes,
                terms: command.terms,
                expected_version: command.expected_version,
            })
            .await
            .map_err(ApplicationError::from)
    }

    /// Withdraws an offer on behalf of a supply-side participant.
    pub async fn withdraw_offer(
        &self,
        headers: &HeaderMap,
        tenant_id: TenantId,
        domain_id: DomainId,
        actor_party_id: MarketplacePartyId,
        offer_id: MarketplaceOfferId,
        expected_version: i64,
    ) -> Result<MarketplaceOffer, ApplicationError> {
        let party = self
            .authenticate_domain(headers, tenant_id, actor_party_id, domain_id)
            .await?;
        require_marketplace_side(&party, "supply")?;
        self.writer
            .withdraw_marketplace_offer(&WithdrawMarketplaceOffer {
                tenant_id,
                domain_id,
                actor_party_id,
                can_manage_domain: matches!(party.role.as_str(), "admin" | "both"),
                platform_path: party.platform_path.clone(),
                request_id: request_id_from_headers(headers),
                offer_id,
                expected_version,
            })
            .await
            .map_err(ApplicationError::from)
    }

    /// Lists offers for a participant or an entire domain.
    pub async fn offers(
        &self,
        headers: &HeaderMap,
        query: ListOffersQuery,
    ) -> Result<Vec<MarketplaceOffer>, ApplicationError> {
        if !(1..=100).contains(&query.limit) {
            return Err(ApplicationError::validation(
                "marketplace offer limit must be between 1 and 100",
            ));
        }
        if query.offset > 10_000 {
            return Err(ApplicationError::validation(
                "marketplace offer offset must be between 0 and 10000",
            ));
        }
        let party = self
            .authenticate_domain(
                headers,
                query.tenant_id,
                query.supply_party_id,
                query.domain_id,
            )
            .await?;
        require_marketplace_side(&party, "supply")?;
        if query.domain_wide {
            require_role(&party, "admin")?;
            self.writer
                .marketplace_offers_for_domain(
                    query.tenant_id,
                    query.domain_id,
                    i64::from(query.limit),
                    i64::from(query.offset),
                )
                .await
        } else {
            self.writer
                .marketplace_offers_for_party(
                    query.tenant_id,
                    query.domain_id,
                    query.supply_party_id,
                    i64::from(query.limit),
                    i64::from(query.offset),
                )
                .await
        }
        .map_err(ApplicationError::from)
    }

    /// Activates an offer as an operator action.
    pub async fn activate_offer(
        &self,
        tenant_id: TenantId,
        offer_id: MarketplaceOfferId,
        expected_version: i64,
    ) -> Result<MarketplaceOffer, ApplicationError> {
        self.writer
            .activate_marketplace_offer(tenant_id, offer_id, expected_version)
            .await
            .map_err(ApplicationError::from)
    }

    /// Rejects a draft offer as an operator action.
    pub async fn reject_offer(
        &self,
        tenant_id: TenantId,
        offer_id: MarketplaceOfferId,
        expected_version: i64,
    ) -> Result<MarketplaceOffer, ApplicationError> {
        self.writer
            .reject_marketplace_offer(tenant_id, offer_id, expected_version)
            .await
            .map_err(ApplicationError::from)
    }

    /// Creates an introduction for a demand-side participant.
    pub async fn create_introduction(
        &self,
        headers: &HeaderMap,
        domain_id: DomainId,
        command: &CreateMarketplaceIntroduction,
    ) -> Result<(MarketplaceIntroductionOutcome, bool), ApplicationError> {
        let party = self
            .authenticate_domain(
                headers,
                command.tenant_id,
                command.participant_id,
                domain_id,
            )
            .await?;
        require_marketplace_side(&party, "demand")?;
        let outcome = self.writer.create_marketplace_introduction(command).await?;
        Ok((outcome.clone(), outcome.duplicate))
    }

    /// Lists introductions visible to a participant.
    pub async fn introductions(
        &self,
        headers: &HeaderMap,
        tenant_id: TenantId,
        domain_id: Option<DomainId>,
        participant_id: MarketplacePartyId,
    ) -> Result<Vec<MarketplaceIntroduction>, ApplicationError> {
        if let Some(domain_id) = domain_id {
            self.authenticate_domain(headers, tenant_id, participant_id, domain_id)
                .await?;
        } else {
            self.authenticate(headers, tenant_id, participant_id)
                .await?;
        }
        self.writer
            .marketplace_introductions_for_party(tenant_id, participant_id)
            .await
            .map_err(ApplicationError::from)
    }

    /// Opens the contact consent step for a demand participant.
    pub async fn request_contact(
        &self,
        headers: &HeaderMap,
        tenant_id: TenantId,
        domain_id: DomainId,
        participant_id: MarketplacePartyId,
        introduction_id: MatchIntroductionId,
        idempotency_key: String,
    ) -> Result<MarketplaceIntroduction, ApplicationError> {
        let party = self
            .authenticate_domain(headers, tenant_id, participant_id, domain_id)
            .await?;
        require_marketplace_side(&party, "demand")?;
        self.writer
            .request_marketplace_contact(&RequestMarketplaceContact {
                tenant_id,
                introduction_id,
                demand_party_id: participant_id,
                idempotency_key,
                request_fingerprint: request_fingerprint(headers),
            })
            .await
            .map_err(ApplicationError::from)
    }

    /// Records supply-side contact consent.
    pub async fn consent_contact(
        &self,
        headers: &HeaderMap,
        tenant_id: TenantId,
        domain_id: DomainId,
        participant_id: MarketplacePartyId,
        introduction_id: MatchIntroductionId,
        idempotency_key: String,
    ) -> Result<MarketplaceIntroduction, ApplicationError> {
        let party = self
            .authenticate_domain(headers, tenant_id, participant_id, domain_id)
            .await?;
        require_marketplace_side(&party, "supply")?;
        self.writer
            .accept_marketplace_contact(&AcceptMarketplaceContact {
                tenant_id,
                introduction_id,
                supply_party_id: participant_id,
                idempotency_key,
            })
            .await
            .map_err(ApplicationError::from)
    }

    /// Releases encrypted counterpart contact metadata after consent checks.
    pub async fn release_contact(
        &self,
        headers: &HeaderMap,
        tenant_id: TenantId,
        domain_id: DomainId,
        actor_party_id: MarketplacePartyId,
        introduction_id: MatchIntroductionId,
        idempotency_key: &str,
    ) -> Result<MarketplaceContactEnvelope, ApplicationError> {
        self.authenticate_domain(headers, tenant_id, actor_party_id, domain_id)
            .await?;
        self.writer
            .release_marketplace_contact(
                tenant_id,
                introduction_id,
                actor_party_id,
                idempotency_key,
                request_fingerprint(headers).as_deref(),
            )
            .await
            .map_err(ApplicationError::from)
    }
}

fn map_party_auth_error(error: StorageError) -> ApplicationError {
    match error {
        StorageError::Forbidden(_) => {
            ApplicationError::unauthorized("party bearer token is invalid")
        }
        other => ApplicationError::Storage(other),
    }
}

fn require_role(party: &AuthenticatedParty, role: &str) -> Result<(), ApplicationError> {
    if party.role == role || party.role == "both" {
        Ok(())
    } else {
        Err(ApplicationError::forbidden(format!(
            "{role} role is required"
        )))
    }
}

fn require_marketplace_side(
    party: &AuthenticatedParty,
    side: &str,
) -> Result<(), ApplicationError> {
    if !matches!(side, "demand" | "supply") {
        return Err(ApplicationError::validation(
            "side must be demand or supply",
        ));
    }
    let allowed = party
        .marketplace_sides
        .iter()
        .any(|capability| capability == side);
    if allowed {
        Ok(())
    } else {
        Err(ApplicationError::forbidden(format!(
            "marketplace {side} capability is required"
        )))
    }
}
