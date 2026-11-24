#!/usr/bin/env sh
set -eu

# Materialize inline/Base64 service account JSON into GOOGLE_APPLICATION_CREDENTIALS
# when running outside Cloud Run ADC or without a mounted credentials file.
if [ -z "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]; then
  if [ -n "${GCP_SERVICE_ACCOUNT_JSON_B64:-}" ] || [ -n "${GCP_SERVICE_ACCOUNT_JSON:-}" ] || [ -n "${GEMINI_SERVICE_ACCOUNT_JSON:-}" ]; then
    SA_FILE="/tmp/gcp-sa.json"
    (
      umask 077
      node --input-type=module -e '
        import fs from "node:fs";
        const raw = (
          process.env.GCP_SERVICE_ACCOUNT_JSON_B64 ||
          process.env.GCP_SERVICE_ACCOUNT_JSON ||
          process.env.GEMINI_SERVICE_ACCOUNT_JSON ||
          ""
        ).trim();
        let out = raw;
        if (!raw.startsWith("{")) {
          const norm = raw.replace(/-/g, "+").replace(/_/g, "/");
          out = Buffer.from(norm, "base64").toString("utf8");
        }
        const parsed = JSON.parse(out);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Service account payload must be a JSON object");
        }
        fs.writeFileSync("/tmp/gcp-sa.json", out, { mode: 0o600 });
      '
    )
    export GOOGLE_APPLICATION_CREDENTIALS="$SA_FILE"
  fi
fi

if [ "${1:-}" = "--init-only" ]; then
  exec node --import tsx src/bootstrap.ts
fi

exec "$@"
