use base64::{Engine as _, engine::general_purpose::STANDARD};
use rsa::sha2::Sha256;
use rsa::{
    RsaPrivateKey, RsaPublicKey,
    pkcs1::{DecodeRsaPrivateKey, DecodeRsaPublicKey},
    pkcs1v15::{Signature, SigningKey, VerifyingKey},
    pkcs8::{DecodePrivateKey, DecodePublicKey},
};
use secrecy::{ExposeSecret, SecretString};
use signature::{SignatureEncoding, Signer, Verifier};

use crate::{Money, PaymentError};

pub(super) fn provider_client(base_url: &str) -> Result<(url::Url, reqwest::Client), PaymentError> {
    crate::provider_http_client(base_url, "production gateway URL", Duration::from_secs(15))
}

pub(super) fn sign_rsa_sha256(
    private_key_pem: &SecretString,
    message: &[u8],
) -> Result<String, PaymentError> {
    let pem = private_key_pem.expose_secret();
    let private_key = RsaPrivateKey::from_pkcs8_pem(pem)
        .or_else(|_| RsaPrivateKey::from_pkcs1_pem(pem))
        .map_err(|error| PaymentError::Credential(format!("invalid RSA private key: {error}")))?;
    let signing_key = SigningKey::<Sha256>::new(private_key);
    Ok(STANDARD.encode(signing_key.sign(message).to_bytes()))
}

pub(super) fn verify_rsa_sha256(
    public_key_pem: &str,
    message: &[u8],
    encoded_signature: &str,
) -> Result<(), PaymentError> {
    let public_key = RsaPublicKey::from_public_key_pem(public_key_pem)
        .or_else(|_| RsaPublicKey::from_pkcs1_pem(public_key_pem))
        .map_err(|error| PaymentError::Credential(format!("invalid RSA public key: {error}")))?;
    let bytes = STANDARD
        .decode(encoded_signature)
        .map_err(|_| PaymentError::Signature)?;
    let signature = Signature::try_from(bytes.as_slice()).map_err(|_| PaymentError::Signature)?;
    VerifyingKey::<Sha256>::new(public_key)
        .verify(message, &signature)
        .map_err(|_| PaymentError::Signature)
}

/// Parses a provider decimal amount without introducing floating-point rounding.
pub(super) fn decimal_money(value: &str, currency: &str, scale: u8) -> Result<Money, PaymentError> {
    let value = value.trim();
    if value.is_empty() || value.starts_with('-') || value.starts_with('+') {
        return Err(PaymentError::Invalid(
            "provider amount is invalid".to_owned(),
        ));
    }
    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
    if whole.is_empty()
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
        || fraction.len() > usize::from(scale)
    {
        return Err(PaymentError::Invalid(
            "provider amount is invalid".to_owned(),
        ));
    }
    let mut digits = whole.to_owned();
    digits.push_str(fraction);
    digits.extend(std::iter::repeat_n(
        '0',
        usize::from(scale) - fraction.len(),
    ));
    let amount = digits
        .parse::<i128>()
        .map_err(|_| PaymentError::Invalid("provider amount exceeds i128".to_owned()))?;
    Money::new(amount, currency.to_owned(), scale)
}

pub(super) fn required_field<'a>(
    value: Option<&'a str>,
    field: &str,
) -> Result<&'a str, PaymentError> {
    value
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| PaymentError::Invalid(format!("provider webhook omitted {field}")))
}
use std::time::Duration;
