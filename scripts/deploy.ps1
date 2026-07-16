param(
  [Parameter(Mandatory = $true)][string]$ProjectId,
  [string]$Region = 'us-central1',
  [string]$Service = 'legacy-studio',
  [string]$Repository = 'legacy-studio',
  [Parameter(Mandatory = $true)][string]$RuntimeServiceAccount,
  [Parameter(Mandatory = $true)][string]$Bucket,
  [Parameter(Mandatory = $true)][string]$CloudSqlInstance,
  [Parameter(Mandatory = $true)][string]$CloudTasksQueuePath,
  [Parameter(Mandatory = $true)][string]$CloudTasksServiceAccount,
  [string]$DatabaseSecret = 'legacy-studio-database-url',
  [string]$GeminiSecret = 'legacy-studio-gemini-api-key',
  [string]$DeepgramSecret = 'legacy-studio-deepgram-api-key',
  [string]$OpenAiSecret = 'legacy-studio-openai-api-key',
  [string]$FingerprintSecret = 'legacy-studio-provider-fingerprint'
)

$ErrorActionPreference = 'Stop'
$image = "$Region-docker.pkg.dev/$ProjectId/$Repository/$Service"

gcloud config set project $ProjectId | Out-Null
gcloud builds submit --config cloudbuild.yaml --substitutions "_REGION=$Region,_REPOSITORY=$Repository,_SERVICE=$Service" .

gcloud run deploy $Service `
  --image "$image`:latest" `
  --region $Region `
  --platform managed `
  --allow-unauthenticated `
  --service-account $RuntimeServiceAccount `
  --add-cloudsql-instances $CloudSqlInstance `
  --memory 4Gi `
  --cpu 2 `
  --concurrency 1 `
  --timeout 900 `
  --set-env-vars "GCP_PROJECT_ID=$ProjectId,GCP_LOCATION=$Region,GCS_BUCKET=$Bucket,REMOTION_BUNDLE_PATH=/app/remotion-bundle,REMOTION_BROWSER_EXECUTABLE=/usr/bin/chromium,GEMINI_REQUIRE_PAID_PROJECT=true,GEMINI_PAID_PROJECT_VERIFIED=true,GEMINI_PAID_PROJECT_ID=$ProjectId" `
  --set-secrets "DATABASE_URL=$DatabaseSecret`:latest,GEMINI_API_KEY=$GeminiSecret`:latest,DEEPGRAM_API_KEY=$DeepgramSecret`:latest,OPENAI_API_KEY=$OpenAiSecret`:latest,PROVIDER_FINGERPRINT_SECRET=$FingerprintSecret`:latest"

$serviceUrl = gcloud run services describe $Service --region $Region --format 'value(status.url)'
if (-not $serviceUrl) { throw 'Cloud Run did not return a service URL.' }

gcloud run services update $Service `
  --region $Region `
  --update-env-vars "CLOUD_TASKS_QUEUE_PATH=$CloudTasksQueuePath,CLOUD_TASKS_TARGET_URL=$serviceUrl,CLOUD_TASKS_AUDIENCE=$serviceUrl,CLOUD_TASKS_SERVICE_ACCOUNT=$CloudTasksServiceAccount"

Invoke-RestMethod "$serviceUrl/api/health" | Out-Null
Write-Host "Legacy Studio is healthy at $serviceUrl"
