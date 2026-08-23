use async_trait::async_trait;
use matchplane_domain::{
    DomainId, MarketplaceIntentId, MarketplaceOfferId, MarketplacePartyId, MatchIntroductionId,
    TenantId,
};
use matchplane_storage::{
    AuthenticatedParty, CreateMarketplaceIntent, CreateMarketplaceIntroduction,
    CreateMarketplaceOffer, CreateMarketplaceSalesHandoff, MarketplaceBehaviorEventOutcome,
    MarketplaceContactEnvelope, MarketplaceDemandCandidate, MarketplaceIntent,
    MarketplaceIntentOutcome, MarketplaceIntentProfile, MarketplaceIntroduction,
    MarketplaceIntroductionOutcome, MarketplaceOffer, MarketplaceOfferCandidate,
    MarketplaceOfferOutcome, MarketplaceOfferPreference, MarketplaceSalesHandoff,
    MatchMarketplaceDemands, MatchMarketplaceOffers, PgStore, RecordMarketplaceBehaviorEvent,
    RequestMarketplaceContact, SetMarketplaceOfferPreference, StorageError,
    UpdateMarketplaceDemandDiscovery, UpdateMarketplaceIntent, UpdateMarketplaceOffer,
    UpsertMarketplaceIntentProfile, WithdrawMarketplaceOffer,
};

/// Persistence and authentication port for domain-neutral marketplace flows.
#[async_trait]
pub trait MarketplaceWriter: Send + Sync {
    async fn authenticate_marketplace_party(
        &self,
        tenant_id: TenantId,
        party_id: MarketplacePartyId,
        access_token_hash: &[u8],
        scope_domain_id: Option<DomainId>,
        scope_platform_path: Option<&str>,
    ) -> Result<AuthenticatedParty, StorageError>;

    async fn create_marketplace_intent(
        &self,
        request: &CreateMarketplaceIntent,
    ) -> Result<MarketplaceIntentOutcome, StorageError>;

    async fn marketplace_intent(
        &self,
        tenant_id: TenantId,
        intent_id: MarketplaceIntentId,
    ) -> Result<MarketplaceIntent, StorageError>;

    async fn update_marketplace_intent(
        &self,
        request: &UpdateMarketplaceIntent,
    ) -> Result<MarketplaceIntent, StorageError>;

    async fn marketplace_intent_profile(
        &self,
        tenant_id: TenantId,
        domain_id: DomainId,
        participant_id: MarketplacePartyId,
    ) -> Result<Option<MarketplaceIntentProfile>, StorageError>;

    async fn upsert_marketplace_intent_profile(
        &self,
        request: &UpsertMarketplaceIntentProfile,
    ) -> Result<MarketplaceIntentProfile, StorageError>;

    async fn record_marketplace_behavior_event(
        &self,
        request: &RecordMarketplaceBehaviorEvent,
    ) -> Result<MarketplaceBehaviorEventOutcome, StorageError>;

    async fn marketplace_offer_preferences_for_party(
        &self,
        tenant_id: TenantId,
        domain_id: DomainId,
        participant_id: MarketplacePartyId,
    ) -> Result<Vec<MarketplaceOfferPreference>, StorageError>;

    async fn set_marketplace_offer_preference(
        &self,
        request: &SetMarketplaceOfferPreference,
    ) -> Result<MarketplaceOfferPreference, StorageError>;

    async fn create_marketplace_sales_handoff(
        &self,
        request: &CreateMarketplaceSalesHandoff,
    ) -> Result<MarketplaceSalesHandoff, StorageError>;

    async fn match_marketplace_offers(
        &self,
        request: &MatchMarketplaceOffers,
    ) -> Result<Vec<MarketplaceOfferCandidate>, StorageError>;

    async fn match_marketplace_demands(
        &self,
        request: &MatchMarketplaceDemands,
    ) -> Result<Vec<MarketplaceDemandCandidate>, StorageError>;

    async fn update_marketplace_demand_discovery(
        &self,
        request: &UpdateMarketplaceDemandDiscovery,
    ) -> Result<MarketplaceIntent, StorageError>;

    async fn create_marketplace_offer(
        &self,
        request: &CreateMarketplaceOffer,
    ) -> Result<MarketplaceOfferOutcome, StorageError>;

    async fn update_marketplace_offer(
        &self,
        request: &UpdateMarketplaceOffer,
    ) -> Result<MarketplaceOffer, StorageError>;

    async fn withdraw_marketplace_offer(
        &self,
        request: &WithdrawMarketplaceOffer,
    ) -> Result<MarketplaceOffer, StorageError>;

    async fn marketplace_offers_for_party(
        &self,
        tenant_id: TenantId,
        domain_id: DomainId,
        supply_party_id: MarketplacePartyId,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<MarketplaceOffer>, StorageError>;

    async fn marketplace_offers_for_domain(
        &self,
        tenant_id: TenantId,
        domain_id: DomainId,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<MarketplaceOffer>, StorageError>;

    async fn activate_marketplace_offer(
        &self,
        tenant_id: TenantId,
        offer_id: MarketplaceOfferId,
        expected_version: i64,
    ) -> Result<MarketplaceOffer, StorageError>;

    async fn reject_marketplace_offer(
        &self,
        tenant_id: TenantId,
        offer_id: MarketplaceOfferId,
        expected_version: i64,
    ) -> Result<MarketplaceOffer, StorageError>;

    async fn create_marketplace_introduction(
        &self,
        request: &CreateMarketplaceIntroduction,
    ) -> Result<MarketplaceIntroductionOutcome, StorageError>;

    async fn marketplace_introductions_for_party(
        &self,
        tenant_id: TenantId,
        participant_id: MarketplacePartyId,
    ) -> Result<Vec<MarketplaceIntroduction>, StorageError>;

    async fn request_marketplace_contact(
        &self,
        request: &RequestMarketplaceContact,
    ) -> Result<MarketplaceIntroduction, StorageError>;

    async fn accept_marketplace_contact(
        &self,
        request: &matchplane_storage::AcceptMarketplaceContact,
    ) -> Result<MarketplaceIntroduction, StorageError>;

    async fn release_marketplace_contact(
        &self,
        tenant_id: TenantId,
        introduction_id: MatchIntroductionId,
        actor_party_id: MarketplacePartyId,
        idempotency_key: &str,
        request_fingerprint: Option<&[u8]>,
    ) -> Result<MarketplaceContactEnvelope, StorageError>;
}

#[async_trait]
impl MarketplaceWriter for PgStore {
    async fn authenticate_marketplace_party(
        &self,
        tenant_id: TenantId,
        party_id: MarketplacePartyId,
        access_token_hash: &[u8],
        scope_domain_id: Option<DomainId>,
        scope_platform_path: Option<&str>,
    ) -> Result<AuthenticatedParty, StorageError> {
        self.authenticate_marketplace_party(
            tenant_id,
            party_id,
            access_token_hash,
            scope_domain_id,
            scope_platform_path,
        )
        .await
    }

    async fn create_marketplace_intent(
        &self,
        request: &CreateMarketplaceIntent,
    ) -> Result<MarketplaceIntentOutcome, StorageError> {
        self.create_marketplace_intent(request).await
    }

    async fn marketplace_intent(
        &self,
        tenant_id: TenantId,
        intent_id: MarketplaceIntentId,
    ) -> Result<MarketplaceIntent, StorageError> {
        self.marketplace_intent(tenant_id, intent_id).await
    }

    async fn update_marketplace_intent(
        &self,
        request: &UpdateMarketplaceIntent,
    ) -> Result<MarketplaceIntent, StorageError> {
        self.update_marketplace_intent(request).await
    }

    async fn marketplace_intent_profile(
        &self,
        tenant_id: TenantId,
        domain_id: DomainId,
        participant_id: MarketplacePartyId,
    ) -> Result<Option<MarketplaceIntentProfile>, StorageError> {
        self.marketplace_intent_profile(tenant_id, domain_id, participant_id)
            .await
    }

    async fn upsert_marketplace_intent_profile(
        &self,
        request: &UpsertMarketplaceIntentProfile,
    ) -> Result<MarketplaceIntentProfile, StorageError> {
        self.upsert_marketplace_intent_profile(request).await
    }

    async fn record_marketplace_behavior_event(
        &self,
        request: &RecordMarketplaceBehaviorEvent,
    ) -> Result<MarketplaceBehaviorEventOutcome, StorageError> {
        self.record_marketplace_behavior_event(request).await
    }

    async fn marketplace_offer_preferences_for_party(
        &self,
        tenant_id: TenantId,
        domain_id: DomainId,
        participant_id: MarketplacePartyId,
    ) -> Result<Vec<MarketplaceOfferPreference>, StorageError> {
        self.marketplace_offer_preferences_for_party(tenant_id, domain_id, participant_id)
            .await
    }

    async fn set_marketplace_offer_preference(
        &self,
        request: &SetMarketplaceOfferPreference,
    ) -> Result<MarketplaceOfferPreference, StorageError> {
        self.set_marketplace_offer_preference(request).await
    }

    async fn create_marketplace_sales_handoff(
        &self,
        request: &CreateMarketplaceSalesHandoff,
    ) -> Result<MarketplaceSalesHandoff, StorageError> {
        self.create_marketplace_sales_handoff(request).await
    }

    async fn match_marketplace_offers(
        &self,
        request: &MatchMarketplaceOffers,
    ) -> Result<Vec<MarketplaceOfferCandidate>, StorageError> {
        self.match_marketplace_offers(request).await
    }

    async fn match_marketplace_demands(
        &self,
        request: &MatchMarketplaceDemands,
    ) -> Result<Vec<MarketplaceDemandCandidate>, StorageError> {
        self.match_marketplace_demands(request).await
    }

    async fn update_marketplace_demand_discovery(
        &self,
        request: &UpdateMarketplaceDemandDiscovery,
    ) -> Result<MarketplaceIntent, StorageError> {
        self.update_marketplace_demand_discovery(request).await
    }

    async fn create_marketplace_offer(
        &self,
        request: &CreateMarketplaceOffer,
    ) -> Result<MarketplaceOfferOutcome, StorageError> {
        self.create_marketplace_offer(request).await
    }

    async fn update_marketplace_offer(
        &self,
        request: &UpdateMarketplaceOffer,
    ) -> Result<MarketplaceOffer, StorageError> {
        self.update_marketplace_offer(request).await
    }

    async fn withdraw_marketplace_offer(
        &self,
        request: &WithdrawMarketplaceOffer,
    ) -> Result<MarketplaceOffer, StorageError> {
        self.withdraw_marketplace_offer(request).await
    }

    async fn marketplace_offers_for_party(
        &self,
        tenant_id: TenantId,
        domain_id: DomainId,
        supply_party_id: MarketplacePartyId,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<MarketplaceOffer>, StorageError> {
        self.marketplace_offers_for_party(tenant_id, domain_id, supply_party_id, limit, offset)
            .await
    }

    async fn marketplace_offers_for_domain(
        &self,
        tenant_id: TenantId,
        domain_id: DomainId,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<MarketplaceOffer>, StorageError> {
        self.marketplace_offers_for_domain(tenant_id, domain_id, limit, offset)
            .await
    }

    async fn activate_marketplace_offer(
        &self,
        tenant_id: TenantId,
        offer_id: MarketplaceOfferId,
        expected_version: i64,
    ) -> Result<MarketplaceOffer, StorageError> {
        self.activate_marketplace_offer(tenant_id, offer_id, expected_version)
            .await
    }

    async fn reject_marketplace_offer(
        &self,
        tenant_id: TenantId,
        offer_id: MarketplaceOfferId,
        expected_version: i64,
    ) -> Result<MarketplaceOffer, StorageError> {
        self.reject_marketplace_offer(tenant_id, offer_id, expected_version)
            .await
    }

    async fn create_marketplace_introduction(
        &self,
        request: &CreateMarketplaceIntroduction,
    ) -> Result<MarketplaceIntroductionOutcome, StorageError> {
        self.create_marketplace_introduction(request).await
    }

    async fn marketplace_introductions_for_party(
        &self,
        tenant_id: TenantId,
        participant_id: MarketplacePartyId,
    ) -> Result<Vec<MarketplaceIntroduction>, StorageError> {
        self.marketplace_introductions_for_party(tenant_id, participant_id)
            .await
    }

    async fn request_marketplace_contact(
        &self,
        request: &RequestMarketplaceContact,
    ) -> Result<MarketplaceIntroduction, StorageError> {
        self.request_marketplace_contact(request).await
    }

    async fn accept_marketplace_contact(
        &self,
        request: &matchplane_storage::AcceptMarketplaceContact,
    ) -> Result<MarketplaceIntroduction, StorageError> {
        self.accept_marketplace_contact(request).await
    }

    async fn release_marketplace_contact(
        &self,
        tenant_id: TenantId,
        introduction_id: MatchIntroductionId,
        actor_party_id: MarketplacePartyId,
        idempotency_key: &str,
        request_fingerprint: Option<&[u8]>,
    ) -> Result<MarketplaceContactEnvelope, StorageError> {
        self.release_marketplace_contact(
            tenant_id,
            introduction_id,
            actor_party_id,
            idempotency_key,
            request_fingerprint,
        )
        .await
    }
}
