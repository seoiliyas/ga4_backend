#!/usr/bin/env bash
# ── Turnkey GCP Cloud Run + Cloud SQL + GCS setup (Bash / Cloud Shell) ────────
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-gtm-auditor-server}"
SQL_INSTANCE="${SQL_INSTANCE:-gtm-auditor-db}"
DB_NAME="${DB_NAME:-gtm_chat_history}"
DB_USER="${DB_USER:-gtm_app}"
SQL_TIER="${SQL_TIER:-db-f1-micro}"
SQL_EDITION="${SQL_EDITION:-enterprise}"
ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-}"
GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-}"
GOOGLE_CLIENT_SECRET="${GOOGLE_CLIENT_SECRET:-}"
IMG_BB_API_KEY="${IMG_BB_API_KEY:-}"

command -v gcloud >/dev/null 2>&1 || { echo "Error: gcloud CLI not found on PATH." >&2; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "Error: openssl not found on PATH." >&2; exit 1; }

ACTIVE_ACCT="$(gcloud auth list --filter='status:ACTIVE' --format='value(account)' | head -n1 || true)"
if [ -z "$ACTIVE_ACCT" ]; then
  echo "Error: Not authenticated with gcloud. Run: gcloud auth login" >&2
  exit 1
fi
echo "Authenticated gcloud account: $ACTIVE_ACCT"

if [ -z "$PROJECT_ID" ]; then
  PROJECT_ID="$(gcloud config get-value project 2>/dev/null || true)"
fi
if [ -z "$PROJECT_ID" ] || [ "$PROJECT_ID" = "(unset)" ]; then
  echo "Error: PROJECT_ID is required (e.g. PROJECT_ID=my-gcp-project ./deploy/cloudrun-setup.sh)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

secret_exists() {
  gcloud secrets describe "$1" --project="$PROJECT_ID" >/dev/null 2>&1
}

set_secret_value() {
  local name="$1"
  local value="$2"
  if ! secret_exists "$name"; then
    gcloud secrets create "$name" --project="$PROJECT_ID" --replication-policy=automatic
  fi
  printf '%s' "$value" | gcloud secrets versions add "$name" --project="$PROJECT_ID" --data-file=-
}

echo ""
echo "[1/8] Setting active GCP project to '$PROJECT_ID'..."
gcloud config set project "$PROJECT_ID"

echo ""
echo "[2/8] Enabling required GCP APIs..."
gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  sql-component.googleapis.com \
  aiplatform.googleapis.com \
  storage.googleapis.com \
  secretmanager.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  --project="$PROJECT_ID"

echo ""
echo "[3/8] Configuring runtime service account & IAM roles..."
SA_NAME="gtm-auditor-run"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
if ! gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" \
    --project="$PROJECT_ID" \
    --display-name="GTM Auditor Cloud Run Runtime"
fi
for role in roles/aiplatform.user roles/cloudsql.client roles/storage.objectAdmin roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="$role" \
    --quiet >/dev/null
done

echo ""
echo "[4/8] Provisioning Cloud SQL PostgreSQL 16 ($SQL_INSTANCE)..."
if ! gcloud sql instances describe "$SQL_INSTANCE" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud sql instances create "$SQL_INSTANCE" \
    --project="$PROJECT_ID" \
    --database-version=POSTGRES_16 \
    --edition="$SQL_EDITION" \
    --tier="$SQL_TIER" \
    --region="$REGION"
fi
INSTANCE_CONNECTION_NAME="$(gcloud sql instances describe "$SQL_INSTANCE" --project="$PROJECT_ID" --format='value(connectionName)')"

if ! gcloud sql databases describe "$DB_NAME" --instance="$SQL_INSTANCE" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud sql databases create "$DB_NAME" --instance="$SQL_INSTANCE" --project="$PROJECT_ID"
fi

DB_PASSWORD_SECRET="gtm-db-password"
DB_SECRET_EXISTS=0
if secret_exists "$DB_PASSWORD_SECRET"; then
  DB_SECRET_EXISTS=1
else
  DB_PASSWORD="$(openssl rand -hex 24)"
  set_secret_value "$DB_PASSWORD_SECRET" "$DB_PASSWORD"
fi

EXISTING_USER="$(gcloud sql users list --instance="$SQL_INSTANCE" --project="$PROJECT_ID" --filter="name=${DB_USER}" --format='value(name)' | head -n1 || true)"
if [ -z "$EXISTING_USER" ]; then
  if [ "$DB_SECRET_EXISTS" -eq 1 ]; then
    DB_PASSWORD="$(gcloud secrets versions access latest --secret="$DB_PASSWORD_SECRET" --project="$PROJECT_ID")"
  fi
  gcloud sql users create "$DB_USER" --instance="$SQL_INSTANCE" --project="$PROJECT_ID" --password="$DB_PASSWORD"
elif [ "$DB_SECRET_EXISTS" -eq 0 ]; then
  gcloud sql users set-password "$DB_USER" --instance="$SQL_INSTANCE" --project="$PROJECT_ID" --password="$DB_PASSWORD"
fi

echo ""
echo "[5/8] Provisioning GCS buckets & seeding GTM container..."
CONTAINER_BUCKET="${PROJECT_ID}-gtm-container"
FILES_BUCKET="${PROJECT_ID}-chat-files"
for bucket in "$CONTAINER_BUCKET" "$FILES_BUCKET"; do
  if ! gcloud storage buckets describe "gs://${bucket}" --project="$PROJECT_ID" >/dev/null 2>&1; then
    gcloud storage buckets create "gs://${bucket}" --project="$PROJECT_ID" --location="$REGION" --uniform-bucket-level-access
  fi
done
if [ -f "data/container-minified.json" ]; then
  gcloud storage cp data/container-minified.json "gs://${CONTAINER_BUCKET}/container.json" --project="$PROJECT_ID"
fi

echo ""
echo "[6/8] Configuring Secret Manager secrets..."
TOKEN_KEY_SECRET="gtm-token-encryption-key"
if ! secret_exists "$TOKEN_KEY_SECRET"; then
  set_secret_value "$TOKEN_KEY_SECRET" "$(openssl rand -hex 32)"
fi
[ -n "$GOOGLE_CLIENT_ID" ] && set_secret_value "gtm-google-client-id" "$GOOGLE_CLIENT_ID"
[ -n "$GOOGLE_CLIENT_SECRET" ] && set_secret_value "gtm-google-client-secret" "$GOOGLE_CLIENT_SECRET"
[ -n "$IMG_BB_API_KEY" ] && set_secret_value "gtm-imgbb-api-key" "$IMG_BB_API_KEY"

SECRET_MAPPINGS="TOKEN_ENCRYPTION_KEY=${TOKEN_KEY_SECRET}:latest,DB_PASSWORD=${DB_PASSWORD_SECRET}:latest"
secret_exists "gtm-google-client-id" && SECRET_MAPPINGS="${SECRET_MAPPINGS},GOOGLE_CLIENT_ID=gtm-google-client-id:latest"
secret_exists "gtm-google-client-secret" && SECRET_MAPPINGS="${SECRET_MAPPINGS},GOOGLE_CLIENT_SECRET=gtm-google-client-secret:latest"
secret_exists "gtm-imgbb-api-key" && SECRET_MAPPINGS="${SECRET_MAPPINGS},IMG_BB_API_KEY=gtm-imgbb-api-key:latest"

echo ""
echo "[7/8] Building & deploying Cloud Run service '$SERVICE_NAME'..."
ENV_FILE="$(mktemp "${TMPDIR:-/tmp}/cloudrun-env.XXXXXX.yaml")"
trap 'rm -f "$ENV_FILE"' EXIT
{
  printf 'GCP_PROJECT_ID: "%s"\n' "$PROJECT_ID"
  printf 'GCP_LOCATION: "%s"\n' "$REGION"
  printf 'INSTANCE_CONNECTION_NAME: "%s"\n' "$INSTANCE_CONNECTION_NAME"
  printf 'DB_NAME: "%s"\n' "$DB_NAME"
  printf 'DB_USER: "%s"\n' "$DB_USER"
  printf 'CONTAINER_BUCKET: "%s"\n' "$CONTAINER_BUCKET"
  printf 'FILES_BUCKET: "%s"\n' "$FILES_BUCKET"
  printf 'AUTO_INIT_DB: "true"\n'
  printf 'AUTO_SEED_CONTAINER: "true"\n'
  printf 'AUTO_CREATE_BUCKETS: "false"\n'
  if [ -n "$ALLOWED_ORIGINS" ]; then
    printf 'ALLOWED_ORIGINS: "%s"\n' "$ALLOWED_ORIGINS"
  fi
} > "$ENV_FILE"

gcloud run deploy "$SERVICE_NAME" \
  --source=. \
  --quiet \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --service-account="$SA_EMAIL" \
  --add-cloudsql-instances="$INSTANCE_CONNECTION_NAME" \
  --port=8080 \
  --timeout=300 \
  --cpu-boost \
  --allow-unauthenticated \
  --env-vars-file="$ENV_FILE" \
  --set-secrets="$SECRET_MAPPINGS"

echo ""
echo "[8/8] Setting PUBLIC_BASE_URL and verifying health/readiness..."
SERVICE_URL="$(gcloud run services describe "$SERVICE_NAME" --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)')"
gcloud run services update "$SERVICE_NAME" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --update-env-vars="PUBLIC_BASE_URL=${SERVICE_URL}"

echo ""
echo "Cloud Run URL: $SERVICE_URL"
echo "Checking ${SERVICE_URL}/health ..."
curl -sSf "${SERVICE_URL}/health" && echo ""
echo "Checking ${SERVICE_URL}/readyz ..."
curl -sSf "${SERVICE_URL}/readyz" && echo ""
echo "Done! Add ${SERVICE_URL}/api/ga4/oauth/callback as an Authorized redirect URI in Google Cloud OAuth if using GA4 mode."
