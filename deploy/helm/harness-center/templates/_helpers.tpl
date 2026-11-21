{{/*
Expand the name of the chart.
*/}}
{{- define "harness-center.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "harness-center.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
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
Dedicated in-cluster Metrics Service name (always ClusterIP, never shared with external Fleet exposure).
*/}}
{{- define "harness-center.metricsServiceName" -}}
{{- printf "%s-metrics" (include "harness-center.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Governing headless Service name for StatefulSet stable pod DNS.
*/}}
{{- define "harness-center.headlessServiceName" -}}
{{- printf "%s-headless" (include "harness-center.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Render-time validation enforcing single-writer topology, required PostgreSQL Secret wiring,
and non-conflicting Prometheus scrape path.
*/}}
{{- define "harness-center.validateValues" -}}
{{- if ne (int .Values.replicaCount) 1 }}
{{- fail "harness-center requires replicaCount=1 (single authority writer topology; multiple replicas fence on PostgreSQL or split SQLite state)." }}
{{- end }}
{{- if and (eq .Values.storage.backend "postgres") (not .Values.storage.existingSecret) }}
{{- fail "storage.existingSecret is required when storage.backend=postgres so daemon-storage.json is mounted and never falls back to local SQLite." }}
{{- end }}
{{- if .Values.metrics.enabled }}
{{- $mpath := trim .Values.metrics.path }}
{{- $norm := trimSuffix "/" $mpath }}
{{- if or (not (hasPrefix "/" $mpath)) (contains "//" $mpath) (regexMatch "(^|/)\\.\\.?(/|$)" $mpath) (eq $norm "/healthz") (eq $norm "/readyz") }}
{{- fail (printf "metrics.path %q is invalid or conflicts with reserved probe paths /healthz or /readyz." .Values.metrics.path) }}
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
