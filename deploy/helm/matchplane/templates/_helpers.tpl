{{- define "matchplane.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "matchplane.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name (include "matchplane.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "matchplane.labels" -}}
app.kubernetes.io/name: {{ include "matchplane.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "matchplane.selectorLabels" -}}
app.kubernetes.io/name: {{ include "matchplane.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "matchplane.image" -}}
{{- $digest := required "image.digest must be set to an immutable sha256 digest" .Values.image.digest -}}
{{- if not (regexMatch "^sha256:[0-9a-f]{64}$" $digest) -}}
{{- fail "image.digest must match sha256:<64 lowercase hexadecimal characters>" -}}
{{- end -}}
{{ printf "%s@%s" .Values.image.repository $digest }}
{{- end }}

{{- define "matchplane.webImage" -}}
{{- $digest := required "web.image.digest must be set to an immutable sha256 digest" .Values.web.image.digest -}}
{{- if not (regexMatch "^sha256:[0-9a-f]{64}$" $digest) -}}
{{- fail "web.image.digest must match sha256:<64 lowercase hexadecimal characters>" -}}
{{- end -}}
{{ printf "%s@%s" .Values.web.image.repository $digest }}
{{- end }}

{{- define "matchplane.builderImage" -}}
{{- $digest := required "subplatformBuilder.image.digest must be set to an immutable sha256 digest" .Values.subplatformBuilder.image.digest -}}
{{- if not (regexMatch "^sha256:[0-9a-f]{64}$" $digest) -}}
{{- fail "subplatformBuilder.image.digest must match sha256:<64 lowercase hexadecimal characters>" -}}
{{- end -}}
{{ printf "%s@%s" .Values.subplatformBuilder.image.repository $digest }}
{{- end }}

{{/*
  Managed platform-router state must survive Web pod replacement. The application lock is local
  to a Pod/PID namespace, so this rollout deliberately permits exactly one Web writer. The chart
  either retains its own PVC or mounts an operator-provided claim.
*/}}
{{- define "matchplane.platformRouterClaimName" -}}
{{- $storage := required "web.platformRouterStorage is required" .Values.web.platformRouterStorage -}}
{{- if not $storage.enabled -}}
{{- fail "web.platformRouterStorage.enabled must be true while the Web deployment is enabled" -}}
{{- end -}}
{{- if $storage.existingClaim -}}
{{- $storage.existingClaim -}}
{{- else -}}
{{- $_ := required "web.platformRouterStorage.accessModes must not be empty" $storage.accessModes -}}
{{- $_ := required "web.platformRouterStorage.size is required when existingClaim is empty" $storage.size -}}
{{- if and (eq .Values.runtime.environment "production") (not $storage.storageClass) -}}
{{- fail "web.platformRouterStorage.storageClass is required in production when existingClaim is empty" -}}
{{- end -}}
{{- printf "%s-platform-router-state" (include "matchplane.fullname" .) -}}
{{- end -}}
{{- end }}

{{/*
  Runtime credentials are intentionally selected per workload. The legacy
  runtime.existingSecret value remains a development/test fallback only; a
  production render fails unless every workload has its own secret. Each
  workload secret must expose database-url; cache-using workloads also expose
  valkey-url. This keeps a compromised public service from inheriting the
  payment/migration identity.
*/}}
{{- define "matchplane.runtimeSecret" -}}
{{- $root := .root -}}
{{- $service := .service -}}
{{- $serviceSecrets := default (dict) $root.Values.runtime.serviceSecrets -}}
{{- $serviceSecret := default "" (index $serviceSecrets $service) -}}
{{- if and (eq $root.Values.runtime.environment "production") (not $serviceSecret) -}}
{{- fail (printf "runtime.serviceSecrets.%s is required in production" $service) -}}
{{- end -}}
{{- if $serviceSecret -}}
{{- $serviceSecret -}}
{{- else -}}
{{- required "runtime.existingSecret is required for non-production renders" $root.Values.runtime.existingSecret -}}
{{- end -}}
{{- end }}

{{/* Kafka clients also receive distinct mTLS material per workload. */}}
{{- define "matchplane.kafkaTlsSecret" -}}
{{- $root := .root -}}
{{- $service := .service -}}
{{- $kafkaSecrets := default (dict) $root.Values.runtime.kafkaTlsSecrets -}}
{{- $serviceSecret := default "" (index $kafkaSecrets $service) -}}
{{- if and (eq $root.Values.runtime.environment "production") (not $serviceSecret) -}}
{{- fail (printf "runtime.kafkaTlsSecrets.%s is required in production" $service) -}}
{{- end -}}
{{- if $serviceSecret -}}
{{- $serviceSecret -}}
{{- else -}}
{{- required "runtime.existingKafkaTlsSecret is required for non-production renders" $root.Values.runtime.existingKafkaTlsSecret -}}
{{- end -}}
{{- end }}

{{- define "matchplane.environment" -}}
{{- $root := .root -}}
{{- $service := .service -}}
- name: MATCHPLANE_ENVIRONMENT
  value: {{ $root.Values.runtime.environment | quote }}
- name: MATCHPLANE_SERVICE_ROLE
  value: {{ $service | quote }}
- name: MATCHPLANE_NODE_ID
  value: {{ required "runtime.nodeId must be a unique UUID" $root.Values.runtime.nodeId | quote }}
- name: MATCHPLANE_DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "matchplane.runtimeSecret" (dict "root" $root "service" $service) }}
      key: database-url
- name: MATCHPLANE_KAFKA_BROKERS
  value: {{ $root.Values.runtime.kafkaBrokers | quote }}
- name: MATCHPLANE_KAFKA_SECURITY_PROTOCOL
  value: {{ $root.Values.runtime.kafkaSecurityProtocol | quote }}
- name: MATCHPLANE_KAFKA_SSL_CA_LOCATION
  value: {{ $root.Values.runtime.kafkaSslCaLocation | quote }}
- name: MATCHPLANE_KAFKA_SSL_CERTIFICATE_LOCATION
  value: {{ $root.Values.runtime.kafkaSslCertificateLocation | quote }}
- name: MATCHPLANE_KAFKA_SSL_KEY_LOCATION
  value: {{ $root.Values.runtime.kafkaSslKeyLocation | quote }}
{{- if ne $service "conversion-projector" }}
- name: MATCHPLANE_VALKEY_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "matchplane.runtimeSecret" (dict "root" $root "service" $service) }}
      key: valkey-url
{{- end }}
- name: MATCHPLANE_LOG_FILTER
  value: {{ $root.Values.runtime.logFilter | quote }}
- name: MATCHPLANE_OTLP_ENDPOINT
  value: {{ $root.Values.runtime.otlpEndpoint | quote }}
- name: MATCHPLANE_REQUIRE_TLS
  value: {{ $root.Values.runtime.requireTls | quote }}
- name: MATCHPLANE_TLS_CERTIFICATE_PATH
  value: {{ $root.Values.runtime.tlsCertificatePath | quote }}
- name: MATCHPLANE_TLS_PRIVATE_KEY_PATH
  value: {{ $root.Values.runtime.tlsPrivateKeyPath | quote }}
- name: MATCHPLANE_TLS_CLIENT_CA_PATH
  value: {{ $root.Values.runtime.tlsClientCaPath | quote }}
- name: MATCHPLANE_CONTACT_DATA_KEY_FILE
  value: {{ $root.Values.runtime.contactDataKeyPath | quote }}
- name: MATCHPLANE_CONTACT_DATA_KEY_VERSION
  value: {{ $root.Values.runtime.contactDataKeyVersion | quote }}
- name: MATCHPLANE_INVOICE_DATA_KEY_FILE
  value: {{ $root.Values.runtime.invoiceDataKeyPath | quote }}
- name: MATCHPLANE_INVOICE_DATA_KEY_VERSION
  value: {{ $root.Values.runtime.invoiceDataKeyVersion | quote }}
- name: MATCHPLANE_PAYMENT_ADMIN_TOKEN_FILE
  value: {{ $root.Values.runtime.paymentAdminTokenPath | quote }}
- name: MATCHPLANE_GATEWAY_ADMIN_TOKEN_FILE
  value: {{ $root.Values.runtime.gatewayAdminTokenPath | quote }}
- name: MATCHPLANE_PAYMENT_CALLBACK_ORIGIN
  value: {{ $root.Values.runtime.paymentCallbackOrigin | quote }}
{{- if eq $service "conversion-projector" }}
- name: MATCHPLANE_CONVERSION_PROJECTOR_ENABLED
  value: "true"
- name: MATCHPLANE_CONVERSION_PROJECTOR_BATCH_SIZE
  value: {{ $root.Values.conversionProjector.batchSize | quote }}
- name: MATCHPLANE_CONVERSION_PROJECTOR_POLL_MS
  value: {{ $root.Values.conversionProjector.pollMs | quote }}
- name: MATCHPLANE_CONVERSION_PROJECTOR_POOL_SIZE
  value: {{ $root.Values.conversionProjector.poolSize | quote }}
- name: MATCHPLANE_CONVERSION_PROJECTOR_DEGRADED_AFTER_SECONDS
  value: {{ $root.Values.conversionProjector.degradedAfterSeconds | quote }}
{{- end }}
{{- end }}
