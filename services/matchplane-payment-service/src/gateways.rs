use std::{env, fs, path::Path, str::FromStr, sync::Arc};

use matchplane_domain::PaymentGatewayId;
use matchplane_payments::{
    AlipayGateway, EpayGateway, GatewayCapabilities, GatewayDescriptor, GatewayKind, GatewayMode,
    PaymentError, PaymentGateway, TestGateway, WaffoGateway, WechatPayGateway,
};
use secrecy::{ExposeSecret, SecretString};
use serde_json::Value;

/// Non-secret gateway configuration loaded from PostgreSQL.
#[derive(Debug, Clone)]
pub struct GatewayConfig {
    pub gateway_id: PaymentGatewayId,
    pub name: String,
    pub kind: GatewayKind,
    pub mode: GatewayMode,
    pub settings: Value,
    pub credential_secret_ref: Option<String>,
    /// Immutable configuration revision selected for a payment operation.
    pub version: i64,
}

impl GatewayConfig {
    pub fn from_parts(
        gateway_id: PaymentGatewayId,
        name: String,
        kind: &str,
        mode: &str,
        settings: Value,
        credential_secret_ref: Option<String>,
    ) -> Result<Self, PaymentError> {
        Self::from_parts_with_version(
            gateway_id,
            name,
            kind,
            mode,
            settings,
            credential_secret_ref,
            1,
        )
    }

    pub fn from_parts_with_version(
        gateway_id: PaymentGatewayId,
        name: String,
        kind: &str,
        mode: &str,
        settings: Value,
        credential_secret_ref: Option<String>,
        version: i64,
    ) -> Result<Self, PaymentError> {
        if version <= 0 {
            return Err(PaymentError::Invalid(
                "payment gateway configuration version must be positive".to_owned(),
            ));
        }
        Ok(Self {
            gateway_id,
            name,
            kind: GatewayKind::from_str(kind)?,
            mode: GatewayMode::from_str(mode)?,
            settings,
            credential_secret_ref,
            version,
        })
    }

    fn descriptor(&self) -> GatewayDescriptor {
        GatewayDescriptor {
            gateway_id: self.gateway_id,
            name: self.name.clone(),
            kind: self.kind,
            mode: self.mode,
            capabilities: capabilities(self.kind),
        }
    }
}

#[derive(Debug, Default)]
pub struct GatewayFactory;

impl GatewayFactory {
    pub fn build(config: &GatewayConfig) -> Result<Arc<dyn PaymentGateway>, PaymentError> {
        let descriptor = config.descriptor();
        match config.kind {
            GatewayKind::Test => Ok(Arc::new(TestGateway::new(descriptor))),
            GatewayKind::Epay => {
                let secrets = secrets(config)?;
                Ok(Arc::new(EpayGateway::with_currency(
                    descriptor,
                    required_setting(config, "base_url")?,
                    required_setting(config, "merchant_id")?,
                    secret_field(&secrets, "merchant_key")?,
                    setting(config, "currency").unwrap_or("CNY"),
                )?))
            }
            GatewayKind::WaffoPancake => {
                let secrets = secrets(config)?;
                Ok(Arc::new(WaffoGateway::new(
                    descriptor,
                    setting(config, "base_url").unwrap_or("https://api.waffo.com/"),
                    required_setting(config, "merchant_id")?,
                    secret_field(&secrets, "api_key")?,
                    secret_field(&secrets, "private_key")?,
                    required_secret_text(&secrets, "provider_public_key")?,
                )?))
            }
            GatewayKind::WechatPayV3 => {
                let secrets = secrets(config)?;
                Ok(Arc::new(WechatPayGateway::with_api_v3_key(
                    descriptor,
                    setting(config, "base_url").unwrap_or("https://api.mch.weixin.qq.com/"),
                    required_setting(config, "app_id")?,
                    required_setting(config, "merchant_id")?,
                    required_setting(config, "merchant_serial")?,
                    secret_field(&secrets, "merchant_private_key")?,
                    required_secret_text(&secrets, "platform_serial")?,
                    required_secret_text(&secrets, "platform_public_key")?,
                    secret_field(&secrets, "api_v3_key")?,
                )?))
            }
            GatewayKind::AlipayOpenapi => {
                let secrets = secrets(config)?;
                Ok(Arc::new(AlipayGateway::new(
                    descriptor,
                    setting(config, "gateway_url")
                        .unwrap_or("https://openapi.alipay.com/gateway.do"),
                    required_setting(config, "app_id")?,
                    secret_field(&secrets, "merchant_private_key")?,
                    required_secret_text(&secrets, "alipay_public_key")?,
                )?))
            }
            GatewayKind::Custom => Err(PaymentError::Unsupported {
                gateway: "custom",
                operation: "unregistered custom adapter",
            }),
        }
    }
}

fn capabilities(kind: GatewayKind) -> GatewayCapabilities {
    match kind {
        GatewayKind::Test | GatewayKind::WaffoPancake => GatewayCapabilities {
            manual_capture: true,
            void: true,
            refund: true,
            partial_capture: true,
            partial_refund: true,
            status_query: true,
        },
        GatewayKind::Epay => GatewayCapabilities {
            manual_capture: false,
            void: false,
            refund: true,
            partial_capture: false,
            partial_refund: true,
            status_query: true,
        },
        GatewayKind::WechatPayV3 | GatewayKind::AlipayOpenapi => GatewayCapabilities {
            manual_capture: false,
            void: true,
            refund: true,
            partial_capture: false,
            partial_refund: true,
            status_query: true,
        },
        GatewayKind::Custom => GatewayCapabilities {
            manual_capture: false,
            void: false,
            refund: false,
            partial_capture: false,
            partial_refund: false,
            status_query: false,
        },
    }
}

fn setting<'a>(config: &'a GatewayConfig, key: &str) -> Option<&'a str> {
    config.settings.get(key).and_then(Value::as_str)
}

fn required_setting<'a>(config: &'a GatewayConfig, key: &str) -> Result<&'a str, PaymentError> {
    setting(config, key).ok_or_else(|| {
        PaymentError::Invalid(format!("gateway {} setting {key} is required", config.name))
    })
}

fn secrets(config: &GatewayConfig) -> Result<Value, PaymentError> {
    let reference = config.credential_secret_ref.as_deref().ok_or_else(|| {
        PaymentError::Credential(format!("gateway {} has no secret reference", config.name))
    })?;
    let secret = resolve_secret(reference)?;
    serde_json::from_str(secret.expose_secret()).map_err(|_| {
        PaymentError::Credential(format!(
            "gateway {} secret must be a JSON object",
            config.name
        ))
    })
}

pub(crate) fn resolve_secret(reference: &str) -> Result<SecretString, PaymentError> {
    if let Some(path) = reference.strip_prefix("file:") {
        if !path.starts_with('/') {
            return Err(PaymentError::Credential(
                "secret file reference must be absolute".to_owned(),
            ));
        }
        let canonical = fs::canonicalize(path).map_err(|error| {
            PaymentError::Credential(format!("secret file unavailable: {error}"))
        })?;
        let allowed = [
            Path::new("/etc/matchplane/secrets"),
            Path::new("/run/secrets"),
        ];
        if !allowed.iter().any(|root| canonical.starts_with(root)) {
            return Err(PaymentError::Credential(
                "secret file must be inside an approved secret directory".to_owned(),
            ));
        }
        let value = fs::read_to_string(canonical).map_err(|error| {
            PaymentError::Credential(format!("secret file unavailable: {error}"))
        })?;
        return Ok(SecretString::new(value.trim().to_owned().into_boxed_str()));
    }
    if let Some(name) = reference.strip_prefix("env:") {
        if !(name.starts_with("MATCHPLANE_PAYMENT_GATEWAY_")
            || name.starts_with("MATCHPLANE_PAYMENT_PROVIDER_")
            || name.starts_with("MATCHPLANE_INVOICE_PROVIDER_"))
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        {
            return Err(PaymentError::Credential(
                "secret environment reference must use a dedicated gateway/provider prefix"
                    .to_owned(),
            ));
        }
        let value = env::var(name).map_err(|_| {
            PaymentError::Credential(format!("secret environment variable {name} is unavailable"))
        })?;
        return Ok(SecretString::new(value.into_boxed_str()));
    }
    Err(PaymentError::Credential(
        "secret reference must start with file: or env:".to_owned(),
    ))
}

fn secret_field(secrets: &Value, key: &str) -> Result<SecretString, PaymentError> {
    required_secret_text(secrets, key).map(|value| SecretString::new(value.into_boxed_str()))
}

fn required_secret_text(secrets: &Value, key: &str) -> Result<String, PaymentError> {
    secrets
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| PaymentError::Credential(format!("secret field {key} is required")))
}
