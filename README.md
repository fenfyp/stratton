# Stratton — Solana Pool Launchpad

Stratton est une plateforme de **pool launchpad sur Solana** : des utilisateurs contribuent collectivement du SOL dans une pool, et quand l'objectif est atteint, les fonds sont automatiquement utilisés pour lancer un token sur [pump.fun](https://pump.fun). Les contributeurs reçoivent des tokens proportionnellement à leur mise.

---

## Table des matières

- [Comment ça fonctionne](#comment-ça-fonctionne)
- [Architecture](#architecture)
- [Structure du projet](#structure-du-projet)
- [Smart contract](#smart-contract)
- [Frontend](#frontend)
- [Executor](#executor)
- [Base de données Supabase](#base-de-données-supabase)
- [Installation locale](#installation-locale)
- [Déploiement](#déploiement)
- [Variables d'environnement](#variables-denvironnement)

---

## Comment ça fonctionne

```
1. Un créateur ouvre une pool avec un objectif en SOL (ex: 1 SOL)
2. Des contributeurs déposent du SOL dans la pool
3. Quand l'objectif est atteint, la pool passe en état "Ready"
4. L'executor détecte l'état Ready et appelle withdraw_for_launch
5. Le SOL est transféré vers le launch wallet
6. L'executor lance le token sur pump.fun avec ce SOL
7. Les tokens reçus sont distribués aux contributeurs au prorata
```

### Mécanique des fees

| Fee | Taux | Destination |
|---|---|---|
| Platform fee | 4% | Wallet de la plateforme (à la création) |
| Pending fee | 1% | Conservé — devient un bonus si l'utilisateur exit |

Si un contributeur **exit** avant le lancement, son `pending_fee` est **sacrifié** et ajouté au **bonus pool**. Ce bonus augmente l'allocation de tokens pour ceux qui restent.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        UTILISATEUR                          │
│                    (wallet Phantom)                         │
└──────────────────────────┬──────────────────────────────────┘
                           │ dépôt / exit / create pool
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              FRONTEND — Next.js (Vercel)                    │
│   /           Liste des pools                               │
│   /pool/[pubkey]  Détail pool (deposit, exit)               │
│   /create     Créer une pool                                │
│   /wallet     Mes contributions & tokens                    │
└──────────────────────────┬──────────────────────────────────┘
                           │ RPC Solana
                           ▼
┌─────────────────────────────────────────────────────────────┐
│         SMART CONTRACT — Anchor / Rust (Solana)             │
│   init_pool        Crée une pool                            │
│   init_contributor Initialise un compte contributeur        │
│   deposit          Dépose du SOL                            │
│   exit             Retire du SOL (avec penalty)             │
│   withdraw_for_launch  Transfère vers le launch wallet      │
└─────────────────────────────────────────────────────────────┘
                           │ polling toutes les 5s
                           ▼
┌─────────────────────────────────────────────────────────────┐
│           EXECUTOR — Node.js (Railway)                      │
│   Détecte les pools "Ready" → withdraw_for_launch           │
│   Lance le token sur pump.fun                               │
│   Distribue les tokens aux contributeurs                    │
│   Retry automatique en cas d'échec (3 tentatives)           │
└──────────────────────────┬──────────────────────────────────┘
                           │ metadata, contributors, status
                           ▼
┌─────────────────────────────────────────────────────────────┐
│             BASE DE DONNÉES — Supabase (PostgreSQL)         │
│   pools            Métadonnées des pools                    │
│   pool_contributors Wallets contributeurs                   │
└─────────────────────────────────────────────────────────────┘
```

---

## Structure du projet

```
stratton/
│
├── programs/stratton/src/
│   └── lib.rs                  # Smart contract Anchor (Rust)
│
├── app/                        # Frontend Next.js
│   ├── src/
│   │   ├── app/
│   │   │   ├── page.tsx        # Liste des pools
│   │   │   ├── create/         # Créer une pool
│   │   │   ├── pool/[pubkey]/  # Détail d'une pool
│   │   │   └── wallet/         # Mon portefeuille
│   │   ├── components/
│   │   │   └── Navbar.tsx
│   │   ├── contexts/
│   │   │   └── WalletProvider.tsx
│   │   └── lib/
│   │       ├── idl.ts          # Program ID + IDL Anchor
│   │       ├── supabase.ts     # Client Supabase + helpers
│   │       └── stratton-idl.json
│   ├── public/
│   │   └── logo.png
│   └── .env.local.example
│
├── executor/                   # Backend Node.js
│   ├── index.js                # Boucle de polling principale
│   ├── pumpfun.js              # Lancement sur pump.fun
│   ├── distribute.js           # Distribution des tokens SPL
│   ├── init.js                 # Initialisation du programme (1 fois)
│   ├── stratton-idl.json       # Copie de l'IDL pour Railway
│   ├── scripts/
│   │   └── encode-keypair.sh   # Encode le keypair en base64 pour Railway
│   └── .env.example
│
├── supabase/
│   ├── migrations/             # Migrations SQL
│   └── functions/
│       └── upload-token-image/ # Edge function upload d'image
│
├── Anchor.toml                 # Config Anchor
└── .gitignore
```

---

## Smart contract

**Fichier :** `programs/stratton/src/lib.rs`

### Instructions

| Instruction | Description |
|---|---|
| `init_config` | Initialise le programme (1 seule fois, admin uniquement) |
| `init_pool` | Crée une nouvelle pool |
| `init_contributor` | Initialise le compte d'un contributeur |
| `deposit` | Dépose du SOL dans une pool (surplus remboursé automatiquement) |
| `exit` | Retire du SOL avec sacrifice du `pending_fee` |
| `withdraw_for_launch` | Transfère le SOL vers le launch wallet (executor uniquement) |

### Comptes on-chain

- **`ProgramConfig`** — PDA `[b"config"]` : stocke le wallet de l'executor
- **`PoolState`** — PDA `[b"pool", index]` : état de chaque pool
- **`ContributorState`** — PDA `[b"contributor", pool, wallet]` : état de chaque contributeur
- **Vault** — PDA `[b"vault", pool]` : compte système qui détient le SOL

### Statuts d'une pool

```
Filling → Ready → Launched
                ↘ Cancelled
```

---

## Frontend

**Stack :** Next.js 16, React 19, TypeScript, TailwindCSS, `@solana/wallet-adapter`, `@coral-xyz/anchor`

### Pages

| Route | Description |
|---|---|
| `/` | Liste de toutes les pools avec barre de progression |
| `/create` | Formulaire de création d'une pool (nom, ticker, objectif, image) |
| `/pool/[pubkey]` | Détail d'une pool : dépôt, exit, bonus pool, pénalité d'exit |
| `/wallet` | Mes contributions actives + tokens reçus post-lancement |

### Fonctionnalités clés

- Connexion Phantom Wallet
- Refresh automatique des données on-chain (5s page détail, 10s liste)
- Détection automatique du plafonnement de dépôt (surplus remboursé)
- Affichage du bonus pool et de la pénalité d'exit
- Upload d'image via Supabase Edge Function (signature wallet requise)

---

## Executor

**Stack :** Node.js, `@coral-xyz/anchor`, `@solana/spl-token`, `pumpdotfun-sdk`

### Fonctionnement

L'executor tourne en permanence sur Railway et poll toutes les **5 secondes** :

1. Récupère toutes les pools en état `Ready`
2. Appelle `withdraw_for_launch` → SOL envoyé au launch wallet
3. Lance le token sur pump.fun (`pumpfun.js`)
4. Distribue les tokens SPL aux contributeurs (`distribute.js`)
5. Met à jour `pump_fun_url` et `pump_fun_status` dans Supabase

### Retry automatique

En cas d'échec du lancement pump.fun :
- `pump_fun_status = 'pending'` + retry toutes les **60 secondes**
- Maximum **3 tentatives**
- Après 3 échecs → `pump_fun_status = 'failed'` + alerte console

### Initialisation (1 seule fois)

```bash
cd executor
node init.js   # Configure l'executor wallet dans le smart contract
```

---

## Base de données Supabase

### Tables

#### `pools`
| Colonne | Type | Description |
|---|---|---|
| `pubkey` | text | Adresse on-chain de la pool |
| `name` | text | Nom du token |
| `ticker` | text | Ticker ($XXX) |
| `description` | text | Description |
| `creator_wallet` | text | Wallet du créateur |
| `image_url` | text | URL de l'image uploadée |
| `pump_fun_url` | text | URL pump.fun après lancement |
| `mint_address` | text | Adresse du token SPL |
| `pump_fun_status` | text | `pending` / `success` / `failed` |
| `pump_fun_retry_count` | int | Nombre de tentatives |
| `pump_fun_last_error` | text | Dernière erreur |

#### `pool_contributors`
| Colonne | Type | Description |
|---|---|---|
| `pool_pubkey` | text | Référence vers `pools.pubkey` |
| `wallet` | text | Adresse du contributeur |
| `created_at` | timestamp | Date d'enregistrement |

### Sécurité

- **Row Level Security (RLS)** activé sur les deux tables
- **`anon_key`** : lecture publique + insertion (frontend)
- **`service_role_key`** : accès complet (executor uniquement, jamais exposé côté client)

---

## Installation locale

### Prérequis

- [Rust](https://rustup.rs/)
- [Anchor CLI](https://www.anchor-lang.com/docs/installation) `>= 0.32`
- [Solana CLI](https://docs.solana.com/cli/install-solana-cli-tools) `>= 1.18`
- Node.js `>= 20`
- Compte [Supabase](https://supabase.com)

### 1. Cloner le repo

```bash
git clone https://github.com/fenfyp/stratton.git
cd stratton
```

### 2. Lancer le validator local

```bash
solana-test-validator --reset
```

### 3. Déployer le smart contract

```bash
anchor build
anchor deploy --provider.cluster localnet
```

### 4. Configurer et lancer l'executor

```bash
cd executor
cp .env.example .env
# Remplir les variables dans .env

npm install
node init.js   # 1 seule fois
node index.js  # Démarre le polling
```

### 5. Lancer le frontend

```bash
cd app
cp .env.local.example .env.local
# Remplir les variables dans .env.local

npm install
npm run dev
# → http://localhost:3000
```

---

## Déploiement

### Smart contract (mainnet)

```bash
solana config set --url mainnet-beta
anchor build
anchor deploy --provider.cluster mainnet-beta
# Mettre à jour PROGRAM_ID dans tous les fichiers de config
```

### Frontend (Vercel)

1. Importer le repo sur [vercel.com](https://vercel.com)
2. **Root Directory** → `app`
3. Configurer les variables d'environnement (voir ci-dessous)
4. Deploy

### Executor (Railway)

1. Importer le repo sur [railway.app](https://railway.app)
2. **Root Directory** → `executor`
3. **Start Command** → `node index.js`
4. Générer le base64 du keypair :
   ```bash
   ./executor/scripts/encode-keypair.sh /path/to/launch-wallet.json
   ```
5. Configurer les variables d'environnement (voir ci-dessous)

---

## Variables d'environnement

### `app/.env.local`

```env
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon_key>
NEXT_PUBLIC_RPC_URL=https://<quicknode-endpoint>.quiknode.pro/<token>/
NEXT_PUBLIC_PROGRAM_ID=<program_id>
```

### `executor/.env`

```env
RPC_URL=https://<quicknode-endpoint>.quiknode.pro/<token>/
PROGRAM_ID=<program_id>

# Option A — local
EXECUTOR_KEYPAIR_PATH=/path/to/launch-wallet.json
# Option B — production (base64)
EXECUTOR_KEYPAIR_BASE64=<valeur générée par encode-keypair.sh>

ADMIN_KEYPAIR_PATH=/path/to/admin-wallet.json
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_ANON_KEY=<anon_key>
SUPABASE_SERVICE_ROLE_KEY=<service_role_key>
PLATFORM_FEE_WALLET=<wallet_pubkey>

# pump.fun
PUMP_FUN_ENABLED=false
PUMP_FUN_RPC_URL=https://<quicknode-endpoint>.quiknode.pro/<token>/
```

---

## Licence

MIT
