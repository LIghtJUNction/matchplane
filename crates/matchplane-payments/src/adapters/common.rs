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

use crate::PaymentError;

pub(super) fn require_https(base_url: &str) -> Result<(), PaymentError> {
    let url = reqwest::Url::parse(base_url)
        .map_err(|error| PaymentError::Invalid(format!("gateway URL is invalid: {error}")))?;
    if url.scheme() != "https" {
        return Err(PaymentError::Invalid(
            "production gateway URL must use HTTPS".to_owned(),
        ));
    }
    Ok(())
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
