{{/* Names and labels. */}}
{{- define "tiles.fullname" -}}
{{- if contains "tiles" .Release.Name -}}{{ .Release.Name | trunc 50 | trimSuffix "-" }}{{- else -}}{{ printf "%s-tiles" .Release.Name | trunc 50 | trimSuffix "-" }}{{- end -}}
{{- end -}}

{{- define "tiles.labels" -}}
app.kubernetes.io/name: tiles
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "tiles.selector" -}}
app.kubernetes.io/name: tiles
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "tiles.image" -}}
{{ .image.repository }}:{{ .image.tag | default .root.Chart.AppVersion }}
{{- end -}}

{{/* The Secret the chart generates: the bundled database's password and URL, a data key. */}}
{{- define "tiles.generatedSecret" -}}{{ include "tiles.fullname" . }}-generated{{- end -}}

{{/* Settings refused at render time, so a broken install fails before anything starts. */}}
{{- define "tiles.validate" -}}
{{- if and (not .Values.database.bundled) (not .Values.secrets.existingSecret) -}}
{{- fail "database.bundled=false needs secrets.existingSecret with tiles_database_url" -}}
{{- end -}}
{{- if and (not .Values.redis.bundled) (not .Values.secrets.existingSecret) -}}
{{- fail "redis.bundled=false needs secrets.existingSecret with tiles_redis_url" -}}
{{- end -}}
{{- if and (eq .Values.env "production") (not .Values.oidc.issuer) -}}
{{- fail "env=production needs oidc.issuer: without sign-in every request is refused" -}}
{{- end -}}
{{- if and (eq .Values.env "production") (not .Values.secrets.generateDataKey) (not .Values.secrets.existingSecret) -}}
{{- fail "env=production needs data keys: set secrets.generateDataKey or give tiles_data_keys in secrets.existingSecret" -}}
{{- end -}}
{{- range list .Values.url .Values.apiUrl -}}
{{- if not (regexMatch "^https?://[^/\\s]+$" .) -}}
{{- fail (printf "url and apiUrl must be http(s) origins without a path, not %q" .) -}}
{{- end -}}
{{- end -}}
{{- if and .Values.ingress.enabled (eq (regexReplaceAll ":[0-9]+$" (urlParse .Values.url).host "") (regexReplaceAll ":[0-9]+$" (urlParse .Values.apiUrl).host "")) -}}
{{- fail "with the ingress, url and apiUrl need different host names: the app and the API each take a host's every path" -}}
{{- end -}}
{{- end -}}

{{/* Environment shared by the API and its jobs. */}}
{{- define "tiles.env" -}}
- name: TILES_ENV
  value: {{ .Values.env | quote }}
- name: TILES_LOG_LEVEL
  value: {{ .Values.logLevel | quote }}
- name: TILES_SECRETS_DIR
  value: /var/run/secrets/tiles
- name: TILES_APP_URL
  value: {{ .Values.url | quote }}
- name: TILES_CORS_ORIGINS
  value: {{ list .Values.url | toJson | quote }}
{{- if .Values.redis.bundled }}
- name: TILES_REDIS_URL
  value: {{ printf "redis://%s-redis:6379/0" (include "tiles.fullname" .) | quote }}
{{- end }}
- name: TILES_DB_POOL_MAX
  value: {{ .Values.api.dbPoolMax | quote }}
{{- with .Values.oidc }}
{{- if .issuer }}
- name: TILES_OIDC_ISSUER
  value: {{ .issuer | quote }}
{{- end }}
{{- if .jwksUrl }}
- name: TILES_OIDC_JWKS_URL
  value: {{ .jwksUrl | quote }}
{{- end }}
- name: TILES_OIDC_AUDIENCE
  value: {{ .audience | quote }}
- name: TILES_OIDC_CLIENT_ID
  value: {{ .clientId | quote }}
- name: TILES_OIDC_DEFAULT_ORG
  value: {{ .defaultOrg | quote }}
{{- end }}
{{- if .Values.copilot.model }}
- name: TILES_COPILOT_MODEL
  value: {{ .Values.copilot.model | quote }}
{{- end }}
- name: TILES_COPILOT_ORG_DAILY_TOKENS
  value: {{ .Values.copilot.orgDailyTokens | int64 | quote }}
{{- if .Values.sandbox.enabled }}
- name: TILES_SANDBOX_URL
  value: {{ printf "http://%s-sandbox:8100" (include "tiles.fullname" .) | quote }}
{{- end }}
{{- with .Values.models.endpointHosts }}
- name: TILES_MODEL_HOSTS
  value: {{ toJson . | quote }}
{{- end }}
{{- with .Values.smtp }}
{{- if .host }}
- name: TILES_SMTP_HOST
  value: {{ .host | quote }}
- name: TILES_SMTP_PORT
  value: {{ .port | quote }}
- name: TILES_SMTP_STARTTLS
  value: {{ .starttls | quote }}
- name: TILES_SMTP_USER
  value: {{ .user | quote }}
- name: TILES_SMTP_FROM
  value: {{ .from | quote }}
{{- end }}
{{- end }}
{{- with .Values.monitoring.otlpEndpoint }}
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: {{ . | quote }}
{{- end }}
{{- with .Values.extraEnv }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/* The secrets as files: the chart's generated ones and the operator's Secret, in one directory. */}}
{{- define "tiles.secretsVolume" -}}
- name: secrets
  projected:
    defaultMode: 0400
    sources:
      {{- if or .Values.database.bundled .Values.secrets.generateDataKey .Values.sandbox.enabled }}
      - secret:
          name: {{ include "tiles.generatedSecret" . }}
          items:
            {{- if .Values.database.bundled }}
            - { key: tiles_database_url, path: tiles_database_url }
            {{- end }}
            {{- if .Values.secrets.generateDataKey }}
            - { key: tiles_data_keys, path: tiles_data_keys }
            {{- end }}
            {{- if .Values.sandbox.enabled }}
            - { key: tiles_sandbox_token, path: tiles_sandbox_token }
            {{- end }}
      {{- end }}
      {{- with .Values.secrets.existingSecret }}
      - secret:
          name: {{ . }}
      {{- end }}
- name: tmp
  emptyDir: { sizeLimit: 64Mi }
{{- end -}}

{{- define "tiles.secretsMount" -}}
- { name: secrets, mountPath: /var/run/secrets/tiles, readOnly: true }
- { name: tmp, mountPath: /tmp }
{{- end -}}

{{/* Locked-down containers: not root, nothing written outside /tmp, no extra privileges. */}}
{{- define "tiles.podSecurity" -}}
runAsNonRoot: true
runAsUser: {{ .uid }}
runAsGroup: {{ .uid }}
fsGroup: {{ .uid }}
seccompProfile: { type: RuntimeDefault }
{{- end -}}

{{- define "tiles.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities: { drop: [ALL] }
{{- end -}}
