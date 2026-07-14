UPDATE processing_jobs
SET status = 'retired_provider_pivot', lease_token = NULL,
    lease_expires_at = NULL, last_error = 'RESTART_AFTER_PROVIDER_MIGRATION',
    updated_at = NOW()
WHERE job_type = 'analyze_collection'
  AND status IN ('pending', 'processing');
