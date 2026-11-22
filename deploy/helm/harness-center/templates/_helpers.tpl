{{/*
Expand the name of the chart.
*/}}
{{- define "harness-center.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a collision-resistant, RFC 1035 DNS-label compliant fully qualified base name (<= 52 chars when default, <= 63 chars with fullnameOverride).
Every default release sanitizes non-DNS-label characters (including dots in Helm DNS-subdomain release names),
ensures an ASCII alphabetic leading character (prepending "ha-" when a release starts with a digit), and embeds a 16-char (64-bit)
sha256 discriminator of the raw .Release.Name so distinct releases (including "team.prod" vs "team-prod", "7center",
"prod" vs "prod-harness-center", and 53-char siblings) produce valid RFC 1035 Service names with 64-bit collision resistance.
*/}}
{{- define "harness-center.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- $releaseHash := .Release.Name | sha256sum | trunc 16 }}
{{- $raw := printf "%s-%s" .Release.Name $name | lower }}
{{- $sanitized := regexReplaceAll "[^a-z0-9-]+" $raw "-" | trimAll "-" }}
{{- if not (regexMatch "^[a-z]" $sanitized) }}
{{- $sanitized = printf "ha-%s" $sanitized | trimSuffix "-" }}
{{- end }}
{{- $prefix := $sanitized | trunc 35 | trimSuffix "-" }}
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
helm.sh/chart: {{ include "harness-center.chart" . | quote }}
{{ include "harness-center.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service | quote }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "harness-center.selectorLabels" -}}
app.kubernetes.io/name: {{ include "harness-center.name" . | quote }}
app.kubernetes.io/instance: {{ .Release.Name | quote }}
{{- end }}

{{/*
Dedicated Fleet TLS Service name with explicit -fleet role suffix (RFC 1035 DNS label, <= 63 chars)
so Fleet, Metrics (-metrics), and Headless (-headless) Services are pairwise disjoint across all releases and overrides.
*/}}
{{- define "harness-center.fleetServiceName" -}}
{{- $full := include "harness-center.fullname" . -}}
{{- if le (len $full) 57 -}}
{{- printf "%s-fleet" $full -}}
{{- else -}}
{{- printf "%s-%s-fleet" ($full | trunc 40 | trimSuffix "-") ($full | sha256sum | trunc 16) -}}
{{- end -}}
{{- end }}

{{/*
Dedicated in-cluster Metrics Service name (always ClusterIP, never shared with external Fleet exposure).
Truncates before appending the suffix and hashes long fullnames (64-bit) so Fleet, metrics, and headless Services never collide.
*/}}
{{- define "harness-center.metricsServiceName" -}}
{{- $full := include "harness-center.fullname" . -}}
{{- if le (len $full) 55 -}}
{{- printf "%s-metrics" $full -}}
{{- else -}}
{{- printf "%s-%s-metrics" ($full | trunc 38 | trimSuffix "-") ($full | sha256sum | trunc 16) -}}
{{- end -}}
{{- end }}

{{/*
Governing headless Service name for StatefulSet stable pod DNS.
Truncates before appending the suffix and hashes long fullnames (64-bit) to remain <= 63 chars and RFC 1035 compliant.
*/}}
{{- define "harness-center.headlessServiceName" -}}
{{- if .Values.service.headlessNameOverride -}}
{{- .Values.service.headlessNameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $full := include "harness-center.fullname" . -}}
{{- if le (len $full) 54 -}}
{{- printf "%s-headless" $full -}}
{{- else -}}
{{- printf "%s-%s-headless" ($full | trunc 37 | trimSuffix "-") ($full | sha256sum | trunc 16) -}}
{{- end -}}
{{- end -}}
{{- end }}

{{/*
Entrypoint ConfigMap name bounded to 63 chars even for maximum-length release names or fullnameOverrides.
*/}}
{{- define "harness-center.entrypointConfigMapName" -}}
{{- $full := include "harness-center.fullname" . -}}
{{- if le (len $full) 52 -}}
{{- printf "%s-entrypoint" $full -}}
{{- else -}}
{{- printf "%s-%s-entrypoint" ($full | trunc 35 | trimSuffix "-") ($full | sha256sum | trunc 16) -}}
{{- end -}}
{{- end }}

{{/*
Render-time validation enforcing single-writer topology, RFC 1035 fullnameOverride compliance,
required PostgreSQL Secret wiring, persistent storage for SQLite and Fleet-enabled workloads,
paired Fleet & external OIDC configuration completeness, distinct Fleet vs metrics container ports,
POSIX-normalized disjoint userRoot vs authorityRepoRoot mounts, metrics auth Secret key completeness,
and strict ASCII non-conflicting Prometheus scrape path.
*/}}
{{- define "harness-center.validateValues" -}}
{{- if ne (int .Values.replicaCount) 1 }}
{{- fail "harness-center requires replicaCount=1 (single authority writer topology; multiple replicas fence on PostgreSQL or split SQLite state)." }}
{{- end }}
{{- if and .Values.fullnameOverride (not (regexMatch "^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$" .Values.fullnameOverride)) }}
{{- fail (printf "fullnameOverride %q must be a valid RFC 1035 DNS label (^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$) so rendered Kubernetes Service names are accepted." .Values.fullnameOverride) }}
{{- end }}
{{- if and .Values.service.headlessNameOverride (not (regexMatch "^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$" .Values.service.headlessNameOverride)) }}
{{- fail (printf "service.headlessNameOverride %q must be a valid RFC 1035 DNS label (^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$) so StatefulSet spec.serviceName is accepted." .Values.service.headlessNameOverride) }}
{{- end }}
{{- if and (eq .Values.workloadKind "StatefulSet") .Values.service.headlessNameOverride }}
{{- $headlessName := include "harness-center.headlessServiceName" . -}}
{{- if and .Values.fleet.enabled (eq $headlessName (include "harness-center.fleetServiceName" .)) }}
{{- fail (printf "service.headlessNameOverride %q collides with Fleet Service name." $headlessName) }}
{{- end }}
{{- if and .Values.metrics.enabled (eq $headlessName (include "harness-center.metricsServiceName" .)) }}
{{- fail (printf "service.headlessNameOverride %q collides with Metrics Service name." $headlessName) }}
{{- end }}
{{- end }}
{{- if and (eq .Values.storage.backend "postgres") (not .Values.storage.existingSecret) }}
{{- fail "storage.existingSecret is required when storage.backend=postgres so daemon-storage.json is mounted and never falls back to local SQLite." }}
{{- end }}
{{- if and (eq .Values.storage.backend "sqlite") (eq .Values.workloadKind "Deployment") (not .Values.persistence.enabled) }}
{{- fail "storage.backend=sqlite requires persistent storage: set workloadKind=StatefulSet or persistence.enabled=true on Deployment so Pod replacement does not lose the SQLite ledger." }}
{{- end }}
{{- if and .Values.fleet.enabled (eq .Values.workloadKind "Deployment") (not .Values.persistence.enabled) }}
{{- fail "fleet.enabled=true requires persistent storage: set workloadKind=StatefulSet or persistence.enabled=true on Deployment so Pod replacement preserves <userRoot>/fleet/state.json and staged Fleet uploads/claims." }}
{{- end }}
{{- if and (eq .Values.identity.mode "managed") (eq .Values.workloadKind "Deployment") (not .Values.persistence.enabled) }}
{{- fail "identity.mode=managed requires persistent storage: set workloadKind=StatefulSet or persistence.enabled=true on Deployment so Pod replacement preserves managed Keycloak realm state." }}
{{- end }}
{{- if and (eq .Values.workloadKind "Deployment") (not .Values.persistence.enabled) }}
{{- if or (ne .Values.identity.mode "external") (not (trim .Values.identity.issuerUrl)) (not (trim .Values.identity.realm)) (not (trim .Values.identity.clientId)) (not (trim .Values.identity.existingClientSecret)) (not (trim .Values.identity.clientSecretKey)) }}
{{- fail "stateless Deployment (persistence.enabled=false) requires complete declarative external identity configuration: identity.mode=external with non-empty identity.issuerUrl, identity.realm, identity.clientId, identity.existingClientSecret, and identity.clientSecretKey so Pod replacement reconstructs identity without manual state." }}
{{- end }}
{{- end }}
{{- if .Values.fleet.enabled }}
{{- if and .Values.fleet.authorityRepoId (not .Values.fleet.tlsExistingSecret) }}
{{- fail "fleet.tlsExistingSecret is required when fleet.authorityRepoId is set (incomplete Fleet TLS listener configuration)." }}
{{- end }}
{{- if and .Values.fleet.tlsExistingSecret (not .Values.fleet.authorityRepoId) }}
{{- fail "fleet.authorityRepoId is required when fleet.tlsExistingSecret is set (incomplete Fleet TLS listener configuration)." }}
{{- end }}
{{- end }}
{{- if eq .Values.identity.mode "external" }}
{{- if and .Values.identity.issuerUrl (not .Values.identity.existingClientSecret) }}
{{- fail "identity.existingClientSecret is required when identity.mode=external and identity.issuerUrl is set (incomplete external OIDC configuration)." }}
{{- end }}
{{- if and .Values.identity.existingClientSecret (not .Values.identity.issuerUrl) }}
{{- fail "identity.issuerUrl is required when identity.mode=external and identity.existingClientSecret is set (incomplete external OIDC configuration)." }}
{{- end }}
{{- end }}
{{- if and .Values.fleet.enabled (eq (int .Values.fleet.port) (int .Values.metrics.port)) }}
{{- fail (printf "fleet.port (%d) and metrics.port (%d) must be distinct when fleet.enabled is true so the Fleet Service cannot forward to or collide with the daemon health/metrics HTTP listener." (int .Values.fleet.port) (int .Values.metrics.port)) }}
{{- end }}
{{- $userRootClean := clean .Values.daemon.userRoot -}}
{{- $repoRootClean := clean .Values.fleet.authorityRepoRoot -}}
{{- if and .Values.fleet.enabled (or (eq $userRootClean $repoRootClean) (hasPrefix (printf "%s/" $userRootClean) $repoRootClean) (hasPrefix (printf "%s/" $repoRootClean) $userRootClean)) }}
{{- fail (printf "fleet.authorityRepoRoot (%q -> %q) and daemon.userRoot (%q -> %q) must be disjoint normalized absolute paths." .Values.fleet.authorityRepoRoot $repoRootClean .Values.daemon.userRoot $userRootClean) }}
{{- end }}
{{- $mbind := lower (trim .Values.metrics.bind) }}
{{- if or (eq $mbind "") (regexMatch "^(localhost\\.?|127\\.(?:[0-9]{1,3}\\.){2}[0-9]{1,3}|\\[?::1\\]?|\\[?(?:0{1,4}:){7}0{0,3}1\\]?|\\[?::ffff:127\\.(?:[0-9]{1,3}\\.){2}[0-9]{1,3}\\]?)$" $mbind) }}
{{- fail (printf "metrics.bind %q must not be a loopback address because Kubernetes startup/readiness/liveness probes connect to the Pod IP (use 0.0.0.0 or ::)." .Values.metrics.bind) }}
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
{{- $reservedLabels := list "app.kubernetes.io/name" "app.kubernetes.io/instance" "helm.sh/chart" "app.kubernetes.io/version" "app.kubernetes.io/managed-by" }}
{{- range $k, $_ := .Values.podLabels }}
{{- if has $k $reservedLabels }}
{{- fail (printf "podLabels must not override reserved chart/selector label %q (would emit duplicate YAML keys or diverge from workload selector)." $k) }}
{{- end }}
{{- end }}
{{- range $k, $_ := .Values.metrics.serviceMonitor.labels }}
{{- if has $k $reservedLabels }}
{{- fail (printf "metrics.serviceMonitor.labels must not override reserved chart label %q." $k) }}
{{- end }}
{{- end }}
{{- range $k, $_ := .Values.metrics.prometheusRule.labels }}
{{- if has $k $reservedLabels }}
{{- fail (printf "metrics.prometheusRule.labels must not override reserved chart label %q." $k) }}
{{- end }}
{{- end }}
{{- $reservedPodAnnotations := list "checksum/config" "checksum/entrypoint" }}
{{- range $k, $_ := .Values.podAnnotations }}
{{- if has $k $reservedPodAnnotations }}
{{- fail (printf "podAnnotations must not override reserved chart annotation %q." $k) }}
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
