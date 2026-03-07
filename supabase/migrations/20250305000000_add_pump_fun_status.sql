-- Suivi du statut du lancement pump.fun par pool
ALTER TABLE pools
  ADD COLUMN IF NOT EXISTS pump_fun_status      text,          -- 'pending' | 'success' | 'failed'
  ADD COLUMN IF NOT EXISTS pump_fun_retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pump_fun_last_error  text;

-- Index pour que le polling de retry soit rapide
CREATE INDEX IF NOT EXISTS idx_pools_pump_fun_pending
  ON pools(pump_fun_status)
  WHERE pump_fun_status = 'pending';
