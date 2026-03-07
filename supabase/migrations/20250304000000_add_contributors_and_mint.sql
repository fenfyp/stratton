-- Colonne mint_address sur la table pools (adresse du token créé sur pump.fun)
ALTER TABLE pools ADD COLUMN IF NOT EXISTS mint_address text;

-- Table des contributeurs d'une pool
CREATE TABLE IF NOT EXISTS pool_contributors (
  id            bigserial PRIMARY KEY,
  pool_pubkey   text      NOT NULL REFERENCES pools(pubkey) ON DELETE CASCADE,
  wallet        text      NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pool_pubkey, wallet)
);

CREATE INDEX IF NOT EXISTS idx_pool_contributors_pool ON pool_contributors(pool_pubkey);
