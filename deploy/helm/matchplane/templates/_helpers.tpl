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
{{ printf "%s:%s" .Values.image.repository (.Values.image.tag | default .Chart.AppVersion) }}
{{- end }}

{{- define "matchplane.environment" -}}
- name: MATCHPLANE_ENVIRONMENT
  value: {{ .Values.runtime.environment | quote }}
- name: MATCHPLANE_NODE_ID
  value: {{ .Values.runtime.nodeId | quote }}
- name: MATCHPLANE_DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ required "runtime.existingSecret is required" .Values.runtime.existingSecret }}
      key: database-url
- name: MATCHPLANE_KAFKA_BROKERS
  value: {{ .Values.runtime.kafkaBrokers | quote }}
- name: MATCHPLANE_VALKEY_URL
  valueFrom:
    secretKeyRef:
      name: {{ required "runtime.existingSecret is required" .Values.runtime.existingSecret }}
      key: valkey-url
- name: MATCHPLANE_LOG_FILTER
  value: {{ .Values.runtime.logFilter | quote }}
- name: MATCHPLANE_OTLP_ENDPOINT
  value: {{ .Values.runtime.otlpEndpoint | quote }}
- name: MATCHPLANE_REQUIRE_TLS
  value: {{ .Values.runtime.requireTls | quote }}
- name: MATCHPLANE_TLS_CERTIFICATE_PATH
  value: {{ .Values.runtime.tlsCertificatePath | quote }}
- name: MATCHPLANE_TLS_PRIVATE_KEY_PATH
  value: {{ .Values.runtime.tlsPrivateKeyPath | quote }}
- name: MATCHPLANE_TLS_CLIENT_CA_PATH
  value: {{ .Values.runtime.tlsClientCaPath | quote }}
- name: MATCHPLANE_CONTACT_DATA_KEY_FILE
  value: {{ .Values.runtime.contactDataKeyPath | quote }}
- name: MATCHPLANE_CONTACT_DATA_KEY_VERSION
  value: {{ .Values.runtime.contactDataKeyVersion | quote }}
- name: MATCHPLANE_INVOICE_DATA_KEY_FILE
  value: {{ .Values.runtime.invoiceDataKeyPath | quote }}
- name: MATCHPLANE_INVOICE_DATA_KEY_VERSION
  value: {{ .Values.runtime.invoiceDataKeyVersion | quote }}
- name: MATCHPLANE_PAYMENT_ADMIN_TOKEN_FILE
  value: {{ .Values.runtime.paymentAdminTokenPath | quote }}
- name: MATCHPLANE_GATEWAY_ADMIN_TOKEN_FILE
  value: {{ .Values.runtime.gatewayAdminTokenPath | quote }}
{{- end }}
