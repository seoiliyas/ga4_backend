# ── Turnkey GCP Cloud Run + Cloud SQL + GCS setup (Windows PowerShell) ───────
param(
  [string]$ProjectId = $env:PROJECT_ID,
  [string]$Region = $(if ($env:REGION) { $env:REGION } else { 'us-central1' }),
  [string]$ServiceName = $(if ($env:SERVICE_NAME) { $env:SERVICE_NAME } else { 'gtm-auditor-server' }),
  [string]$SqlInstance = $(if ($env:SQL_INSTANCE) { $env:SQL_INSTANCE } else { 'gtm-auditor-db' }),
  [string]$DbName = $(if ($env:DB_NAME) { $env:DB_NAME } else { 'gtm_chat_history' }),
  [string]$DbUser = $(if ($env:DB_USER) { $env:DB_USER } else { 'gtm_app' }),
  [string]$SqlTier = $(if ($env:SQL_TIER) { $env:SQL_TIER } else { 'db-f1-micro' }),
  [string]$SqlEdition = $(if ($env:SQL_EDITION) { $env:SQL_EDITION } else { 'enterprise' }),
  [string]$AllowedOrigins = $env:ALLOWED_ORIGINS,
  [string]$GoogleClientId = $env:GOOGLE_CLIENT_ID,
  [string]$GoogleClientSecret = $env:GOOGLE_CLIENT_SECRET,
  [string]$ImgBbApiKey = $env:IMG_BB_API_KEY
)

$ErrorActionPreference = 'Stop'

function Assert-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command '$Name' not found on PATH."
  }
}

function Invoke-Gcloud {
  param([string[]]$GcloudArgs)
  $prevEap = $ErrorActionPreference
  $hasNative = Test-Path variable:PSNativeCommandUseErrorActionPreference
  if ($hasNative) { $prevNative = $PSNativeCommandUseErrorActionPreference }
  try {
    $ErrorActionPreference = 'Continue'
    if ($hasNative) { $PSNativeCommandUseErrorActionPreference = $false }
    & gcloud @GcloudArgs
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prevEap
    if ($hasNative) { $PSNativeCommandUseErrorActionPreference = $prevNative }
  }
  if ($exitCode -ne 0) {
    $safeArgs = $GcloudArgs | ForEach-Object {
      if ($_ -match '^--password=') { '--password=<REDACTED>' } else { $_ }
    }
    throw "gcloud $($safeArgs -join ' ') failed with exit code $exitCode"
  }
}

function Test-Gcloud {
  param([string[]]$GcloudArgs)
  $prevEap = $ErrorActionPreference
  $hasNative = Test-Path variable:PSNativeCommandUseErrorActionPreference
  if ($hasNative) { $prevNative = $PSNativeCommandUseErrorActionPreference }
  try {
    $ErrorActionPreference = 'Continue'
    if ($hasNative) { $PSNativeCommandUseErrorActionPreference = $false }
    & gcloud @GcloudArgs 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
  } finally {
    $ErrorActionPreference = $prevEap
    if ($hasNative) { $PSNativeCommandUseErrorActionPreference = $prevNative }
  }
}

function Get-GcloudValue {
  param([string[]]$GcloudArgs)
  $prevEap = $ErrorActionPreference
  $hasNative = Test-Path variable:PSNativeCommandUseErrorActionPreference
  if ($hasNative) { $prevNative = $PSNativeCommandUseErrorActionPreference }
  try {
    $ErrorActionPreference = 'Continue'
    if ($hasNative) { $PSNativeCommandUseErrorActionPreference = $false }
    $out = & gcloud @GcloudArgs 2>$null
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prevEap
    if ($hasNative) { $PSNativeCommandUseErrorActionPreference = $prevNative }
  }
  if ($exitCode -ne 0) { return $null }
  $line = @($out) | Where-Object { $_ -and $_.ToString().Trim() } | Select-Object -First 1
  if ($line) { return $line.ToString().Trim() }
  return $null
}

function Test-SecretExists([string]$SecretName, [string]$Project) {
  return (Test-Gcloud @('secrets', 'describe', $SecretName, "--project=$Project"))
}

function Set-SecretValue([string]$SecretName, [string]$Value, [string]$Project) {
  if (-not (Test-SecretExists $SecretName $Project)) {
    Invoke-Gcloud @('secrets', 'create', $SecretName, "--project=$Project", '--replication-policy=automatic')
  }
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("gcloud-secret-" + [guid]::NewGuid().ToString('N') + '.txt')
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  try {
    [System.IO.File]::WriteAllText($tmp, $Value, $utf8NoBom)
    Invoke-Gcloud @('secrets', 'versions', 'add', $SecretName, "--project=$Project", "--data-file=$tmp")
  } finally {
    if (Test-Path $tmp) { Remove-Item -Force $tmp }
  }
}

function New-RandomHex([int]$NumBytes = 32) {
  $bytes = New-Object byte[] $NumBytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }
  return ([System.BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
}

function Format-YamlDoubleQuoted([string]$Value) {
  $escaped = $Value -replace '\\', '\\\\' -replace '"', '\"'
  return "`"$escaped`""
}

Assert-Command 'gcloud'

$activeAcct = Get-GcloudValue @('auth', 'list', '--filter=status:ACTIVE', '--format=value(account)')
if (-not $activeAcct) {
  throw 'Not authenticated with gcloud. Run: gcloud auth login'
}
Write-Host "Authenticated gcloud account: $activeAcct"

if (-not $ProjectId) {
  $ProjectId = Get-GcloudValue @('config', 'get-value', 'project')
}
if (-not $ProjectId -or $ProjectId -eq '(unset)') {
  throw 'ProjectId is required. Pass -ProjectId <your-gcp-project-id> or run gcloud config set project <id>.'
}

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Push-Location $RepoRoot
try {
  Write-Host "`n[1/8] Setting active GCP project to '$ProjectId'..."
  Invoke-Gcloud @('config', 'set', 'project', $ProjectId)

  Write-Host "`n[2/8] Enabling required GCP APIs..."
  Invoke-Gcloud @(
    'services', 'enable',
    'run.googleapis.com',
    'sqladmin.googleapis.com',
    'sql-component.googleapis.com',
    'aiplatform.googleapis.com',
    'storage.googleapis.com',
    'secretmanager.googleapis.com',
    'cloudbuild.googleapis.com',
    'artifactregistry.googleapis.com',
    "--project=$ProjectId"
  )

  Write-Host "`n[3/8] Configuring runtime service account & IAM roles..."
  $SaName = 'gtm-auditor-run'
  $SaEmail = "$SaName@$ProjectId.iam.gserviceaccount.com"
  if (-not (Test-Gcloud @('iam', 'service-accounts', 'describe', $SaEmail, "--project=$ProjectId"))) {
    Invoke-Gcloud @(
      'iam', 'service-accounts', 'create', $SaName,
      "--project=$ProjectId",
      '--display-name=GTM Auditor Cloud Run Runtime'
    )
  }
  foreach ($role in @('roles/aiplatform.user', 'roles/cloudsql.client', 'roles/storage.objectAdmin', 'roles/secretmanager.secretAccessor')) {
    Invoke-Gcloud @(
      'projects', 'add-iam-policy-binding', $ProjectId,
      "--member=serviceAccount:$SaEmail",
      "--role=$role",
      '--quiet'
    ) | Out-Null
  }

  Write-Host "`n[4/8] Provisioning Cloud SQL PostgreSQL 16 ($SqlInstance)..."
  if (-not (Test-Gcloud @('sql', 'instances', 'describe', $SqlInstance, "--project=$ProjectId"))) {
    Invoke-Gcloud @(
      'sql', 'instances', 'create', $SqlInstance,
      "--project=$ProjectId",
      '--database-version=POSTGRES_16',
      "--edition=$SqlEdition",
      "--tier=$SqlTier",
      "--region=$Region"
    )
  }
  $InstanceConnectionName = Get-GcloudValue @('sql', 'instances', 'describe', $SqlInstance, "--project=$ProjectId", '--format=value(connectionName)')
  if (-not $InstanceConnectionName) {
    throw "Failed to resolve connectionName for Cloud SQL instance '$SqlInstance'."
  }

  if (-not (Test-Gcloud @('sql', 'databases', 'describe', $DbName, "--instance=$SqlInstance", "--project=$ProjectId"))) {
    Invoke-Gcloud @('sql', 'databases', 'create', $DbName, "--instance=$SqlInstance", "--project=$ProjectId")
  }

  $DbPasswordSecret = 'gtm-db-password'
  $dbSecretExists = Test-SecretExists $DbPasswordSecret $ProjectId
  $dbPassword = $null
  if (-not $dbSecretExists) {
    $dbPassword = New-RandomHex 24
    Set-SecretValue $DbPasswordSecret $dbPassword $ProjectId
  }

  $existingUser = Get-GcloudValue @('sql', 'users', 'list', "--instance=$SqlInstance", "--project=$ProjectId", "--filter=name=$DbUser", '--format=value(name)')
  if (-not $existingUser) {
    if (-not $dbPassword) {
      $dbPassword = Get-GcloudValue @('secrets', 'versions', 'access', 'latest', "--secret=$DbPasswordSecret", "--project=$ProjectId")
    }
    if (-not $dbPassword) {
      throw "Failed to read database password from Secret Manager secret '$DbPasswordSecret'."
    }
    Invoke-Gcloud @('sql', 'users', 'create', $DbUser, "--instance=$SqlInstance", "--project=$ProjectId", "--password=$dbPassword")
  } elseif (-not $dbSecretExists) {
    Invoke-Gcloud @('sql', 'users', 'set-password', $DbUser, "--instance=$SqlInstance", "--project=$ProjectId", "--password=$dbPassword")
  }

  Write-Host "`n[5/8] Provisioning GCS buckets & seeding GTM container..."
  $ContainerBucket = "$ProjectId-gtm-container"
  $FilesBucket = "$ProjectId-chat-files"
  foreach ($bucket in @($ContainerBucket, $FilesBucket)) {
    if (-not (Test-Gcloud @('storage', 'buckets', 'describe', "gs://$bucket", "--project=$ProjectId"))) {
      Invoke-Gcloud @('storage', 'buckets', 'create', "gs://$bucket", "--project=$ProjectId", "--location=$Region", '--uniform-bucket-level-access')
    }
  }
  $LocalContainer = Join-Path $RepoRoot 'data\container-minified.json'
  if (Test-Path $LocalContainer) {
    Invoke-Gcloud @('storage', 'cp', $LocalContainer, "gs://$ContainerBucket/container.json", "--project=$ProjectId")
  }

  Write-Host "`n[6/8] Configuring Secret Manager secrets..."
  $TokenKeySecret = 'gtm-token-encryption-key'
  if (-not (Test-SecretExists $TokenKeySecret $ProjectId)) {
    Set-SecretValue $TokenKeySecret (New-RandomHex 32) $ProjectId
  }
  if ($GoogleClientId) { Set-SecretValue 'gtm-google-client-id' $GoogleClientId $ProjectId }
  if ($GoogleClientSecret) { Set-SecretValue 'gtm-google-client-secret' $GoogleClientSecret $ProjectId }
  if ($ImgBbApiKey) { Set-SecretValue 'gtm-imgbb-api-key' $ImgBbApiKey $ProjectId }

  $secretMappings = @(
    "TOKEN_ENCRYPTION_KEY=${TokenKeySecret}:latest",
    "DB_PASSWORD=${DbPasswordSecret}:latest"
  )
  if (Test-SecretExists 'gtm-google-client-id' $ProjectId) { $secretMappings += 'GOOGLE_CLIENT_ID=gtm-google-client-id:latest' }
  if (Test-SecretExists 'gtm-google-client-secret' $ProjectId) { $secretMappings += 'GOOGLE_CLIENT_SECRET=gtm-google-client-secret:latest' }
  if (Test-SecretExists 'gtm-imgbb-api-key' $ProjectId) { $secretMappings += 'IMG_BB_API_KEY=gtm-imgbb-api-key:latest' }

  Write-Host "`n[7/8] Building & deploying Cloud Run service '$ServiceName'..."
  $envFile = Join-Path ([System.IO.Path]::GetTempPath()) ("cloudrun-env-" + [guid]::NewGuid().ToString('N') + '.yaml')
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  try {
    $envLines = @(
      "GCP_PROJECT_ID: $(Format-YamlDoubleQuoted $ProjectId)",
      'GCP_LOCATION: "global"',
      "INSTANCE_CONNECTION_NAME: $(Format-YamlDoubleQuoted $InstanceConnectionName)",
      "DB_NAME: $(Format-YamlDoubleQuoted $DbName)",
      "DB_USER: $(Format-YamlDoubleQuoted $DbUser)",
      "CONTAINER_BUCKET: $(Format-YamlDoubleQuoted $ContainerBucket)",
      "FILES_BUCKET: $(Format-YamlDoubleQuoted $FilesBucket)",
      'AUTO_INIT_DB: "true"',
      'AUTO_SEED_CONTAINER: "true"',
      'AUTO_CREATE_BUCKETS: "false"'
    )
    if ($AllowedOrigins) {
      $envLines += "ALLOWED_ORIGINS: $(Format-YamlDoubleQuoted $AllowedOrigins)"
    }
    [System.IO.File]::WriteAllText($envFile, ($envLines -join "`n") + "`n", $utf8NoBom)

    Invoke-Gcloud @(
      'run', 'deploy', $ServiceName,
      '--source=.',
      '--quiet',
      "--project=$ProjectId",
      "--region=$Region",
      "--service-account=$SaEmail",
      "--add-cloudsql-instances=$InstanceConnectionName",
      '--port=8080',
      '--timeout=300',
      '--cpu-boost',
      '--allow-unauthenticated',
      "--env-vars-file=$envFile",
      "--set-secrets=$($secretMappings -join ',')"
    )
  } finally {
    if (Test-Path $envFile) { Remove-Item -Force $envFile }
  }

  Write-Host "`n[8/8] Setting PUBLIC_BASE_URL and verifying health/readiness..."
  $ServiceUrl = Get-GcloudValue @('run', 'services', 'describe', $ServiceName, "--project=$ProjectId", "--region=$Region", '--format=value(status.url)')
  if (-not $ServiceUrl) {
    throw "Failed to retrieve Cloud Run service URL for '$ServiceName'."
  }
  Invoke-Gcloud @(
    'run', 'services', 'update', $ServiceName,
    "--project=$ProjectId",
    "--region=$Region",
    "--update-env-vars=PUBLIC_BASE_URL=$ServiceUrl"
  )

  Write-Host "`nCloud Run URL: $ServiceUrl"
  $prevEap = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    Write-Host "Checking $ServiceUrl/health ..."
    & curl.exe -sS -f "$ServiceUrl/health"
    if ($LASTEXITCODE -ne 0) {
      throw "Health check failed ($ServiceUrl/health)"
    }

    Write-Host "`nChecking $ServiceUrl/readyz ..."
    $readyOk = $false
    for ($attempt = 1; $attempt -le 6; $attempt++) {
      & curl.exe -sS -f "$ServiceUrl/readyz"
      if ($LASTEXITCODE -eq 0) {
        $readyOk = $true
        break
      }
      if ($attempt -lt 6) {
        Write-Host "Waiting for DB bootstrap readiness (attempt $attempt/6)..."
        Start-Sleep -Seconds 3
      }
    }
    if (-not $readyOk) {
      throw "Readiness check failed after 6 attempts ($ServiceUrl/readyz)"
    }
  } finally {
    $ErrorActionPreference = $prevEap
  }

  Write-Host "`nDone! Add '$ServiceUrl/api/ga4/oauth/callback' as an Authorized redirect URI in Google Cloud OAuth if using GA4 mode."
} finally {
  Pop-Location
}
