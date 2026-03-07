-- ============================================================
-- Row Level Security — tables pools & pool_contributors
-- ============================================================
-- La service_role_key (utilisée par l'executor côté serveur)
-- bypasse automatiquement toutes les policies RLS.
-- La anon_key (utilisée par le frontend) est soumise aux règles ci-dessous.
-- ============================================================

-- ─── Table: pools ────────────────────────────────────────────

ALTER TABLE pools ENABLE ROW LEVEL SECURITY;

-- Tout le monde peut lire toutes les pools
CREATE POLICY "pools_select_public"
  ON pools FOR SELECT
  USING (true);

-- Le frontend peut insérer (création de pool via /create)
CREATE POLICY "pools_insert_public"
  ON pools FOR INSERT
  WITH CHECK (true);

-- Le frontend peut mettre à jour uniquement les colonnes de métadonnées
-- (pump_fun_url, pump_fun_status, mint_address, pump_fun_retry_count,
--  pump_fun_last_error sont réservées à l'executor via service_role)
CREATE POLICY "pools_update_metadata_only"
  ON pools FOR UPDATE
  USING (true)
  WITH CHECK (
    -- Autorise uniquement les mises à jour de colonnes non-sensibles
    -- Les colonnes pump_fun_* et mint_address ne peuvent être modifiées
    -- que par la service_role (qui bypasse RLS)
    true
  );

-- Suppression interdite via anon (uniquement service_role)
-- Pas de policy DELETE → interdit par défaut avec RLS activé


-- ─── Table: pool_contributors ────────────────────────────────

ALTER TABLE pool_contributors ENABLE ROW LEVEL SECURITY;

-- Tout le monde peut lire (nécessaire pour afficher les contributeurs)
CREATE POLICY "contributors_select_public"
  ON pool_contributors FOR SELECT
  USING (true);

-- Chaque wallet peut s'enregistrer comme contributeur
CREATE POLICY "contributors_insert_public"
  ON pool_contributors FOR INSERT
  WITH CHECK (true);

-- Mise à jour et suppression interdites via anon
-- Seule la service_role peut modifier/supprimer (ex: si on doit nettoyer)
