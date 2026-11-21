{{/*
Expand the name of the chart.
*/}}
{{- define "harness-center.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a collision-free, release-unique fully qualified base name (<= 51 chars when default, <= 63 chars with fullnameOverride).
Every default release embeds an 8-char sha256 discriminator of .Release.Name so distinct releases
(e.g. "prod" vs "prod-harness-center" vs "prod-harness-center-metrics" or 53-char siblings) never collide.
*/}}
{{- define "harness-center.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- $releaseHash := .Release.Name | sha256sum | trunc 8 }}
{{- $prefix := printf "%s-%s" .Release.Name $name | trunc 42 | trimSuffix "-" }}
{{- printf "%s-%s" $prefix $releaseHash }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "harness-center.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "harness-center.labels" -}}
helm.sh/chart: {{ include "harness-center.chart" . }}
{{ include "harness-center.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "harness-center.selectorLabels" -}}
app.kubernetes.io/name: {{ include "harness-center.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Dedicated Fleet TLS Service name with explicit -fleet role suffix so Fleet, Metrics (-metrics),
and Headless (-headless) Services are pairwise disjoint across all releases and overrides.
*/}}
{{- define "harness-center.fleetServiceName" -}}
{{- $full := include "harness-center.fullname" . -}}
{{- if le (len $full) 57 -}}
{{- printf "%s-fleet" $full -}}
{{- else -}}
{{- printf "%s-%s-fleet" ($full | trunc 48 | trimSuffix "-") ($full | sha256sum | trunc 8) -}}
{{- end -}}
{{- end }}

{{/*
Dedicated in-cluster Metrics Service name (always ClusterIP, never shared with external Fleet exposure).
Truncates before appending the suffix and hashes long fullnames so Fleet, metrics, and headless Services never collide.
*/}}
{{- define "harness-center.metricsServiceName" -}}
{{- $full := include "harness-center.fullname" . -}}
{{- if le (len $full) 55 -}}
{{- printf "%s-metrics" $full -}}
{{- else -}}
{{- printf "%s-%s-metrics" ($full | trunc 46 | trimSuffix "-") ($full | sha256sum | trunc 8) -}}
{{- end -}}
{{- end }}

{{/*
Governing headless Service name for StatefulSet stable pod DNS.
Truncates before appending the suffix and hashes long fullnames to remain <= 63 chars and collision-free.
*/}}
{{- define "harness-center.headlessServiceName" -}}
{{- $full := include "harness-center.fullname" . -}}
{{- if le (len $full) 54 -}}
{{- printf "%s-headless" $full -}}
{{- else -}}
{{- printf "%s-%s-headless" ($full | trunc 45 | trimSuffix "-") ($full | sha256sum | trunc 8) -}}
{{- end -}}
{{- end }}

{{/*
Entrypoint ConfigMap name bounded to 63 chars even for maximum-length release names.
*/}}
{{- define "harness-center.entrypointConfigMapName" -}}
{{- $full := include "harness-center.fullname" . -}}
{{- if le (len $full) 52 -}}
{{- printf "%s-entrypoint" $full -}}
{{- else -}}
{{- printf "%s-%s-entrypoint" ($full | trunc 43 | trimSuffix "-") ($full | sha256sum | trunc 8) -}}
{{- end -}}
{{- end }}

{{/*
Render-time validation enforcing single-writer topology, required PostgreSQL Secret wiring,
persistent storage for SQLite workloads, distinct Fleet vs metrics container ports,
disjoint userRoot vs authorityRepoRoot mounts, metrics auth Secret key completeness,
and strict ASCII non-conflicting Prometheus scrape path.
*/}}
{{- define "harness-center.validateValues" -}}
{{- if ne (int .Values.replicaCount) 1 }}
{{- fail "harness-center requires replicaCount=1 (single authority writer topology; multiple replicas fence on PostgreSQL or split SQLite state)." }}
{{- end }}
{{- if and (eq .Values.storage.backend "postgres") (not .Values.storage.existingSecret) }}
{{- fail "storage.existingSecret is required when storage.backend=postgres so daemon-storage.json is mounted and never falls back to local SQLite." }}
{{- end }}
{{- if and (eq .Values.storage.backend "sqlite") (eq .Values.workloadKind "Deployment") (not .Values.persistence.enabled) }}
{{- fail "storage.backend=sqlite requires persistent storage: set workloadKind=StatefulSet or persistence.enabled=true on Deployment so Pod replacement does not lose the SQLite ledger." }}
{{- end }}
{{- if and .Values.fleet.enabled .Values.metrics.enabled (eq (int .Values.fleet.port) (int .Values.metrics.port)) }}
{{- fail (printf "fleet.port (%d) and metrics.port (%d) must be distinct when both fleet.enabled and metrics.enabled are true so the Fleet Service cannot forward to the plaintext metrics HTTP listener or collide on container bind." (int .Values.fleet.port) (int .Values.metrics.port)) }}
{{- end }}
{{- if and .Values.fleet.enabled (eq (trimSuffix "/" .Values.daemon.userRoot) (trimSuffix "/" .Values.fleet.authorityRepoRoot)) }}
{{- fail (printf "fleet.authorityRepoRoot (%q) must not equal daemon.userRoot (%q)." .Values.fleet.authorityRepoRoot .Values.daemon.userRoot) }}
{{- end }}
{{- if .Values.metrics.enabled }}
{{- $mpath := trim .Values.metrics.path }}
{{- if or (not (regexMatch "^/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$" $mpath)) (regexMatch "(^|/)\\.\\.?(/|$)" $mpath) (eq $mpath "/healthz") (eq $mpath "/readyz") }}
{{- fail (printf "metrics.path %q must use clean ASCII URL path segments and must not conflict with reserved probe paths /healthz or /readyz." .Values.metrics.path) }}
{{- end }}
{{- if and .Values.metrics.bearerTokenExistingSecret (not .Values.metrics.bearerTokenSecretKey) }}
{{- fail "metrics.bearerTokenSecretKey is required when metrics.bearerTokenExistingSecret is set." }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "harness-center.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "harness-center.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}
