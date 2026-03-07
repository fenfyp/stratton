use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_lang::solana_program::system_instruction;

declare_id!("3ged954nQvfoyxzbRfKj1AtkR7UsPEHKggzhid5QE4EL");

// ============================================================
// CONSTANTES
// ============================================================
const PLATFORM_FEE_BPS: u64 = 400;  // 4%
/// Admin pubkey — must match wallet in Anchor.toml [provider] for tests
const ADMIN: Pubkey = pubkey!("AZPZ2x9oGZkBMmLLmVmYByiUokMEj8BcJwKURsvxJkNN");
const PENDING_FEE_BPS: u64 = 100;   // 1%
const TOTAL_FEE_BPS: u64 = 500;     // 5%
const BPS_BASE: u64 = 10_000;

// ============================================================
// PROGRAM
// ============================================================
#[program]
pub mod stratton {
    use super::*;

    /// Initialise la config du programme (appelable une seule fois par l'admin)
    pub fn initialize(ctx: Context<Initialize>, executor_wallet: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.program_config;
        config.executor_wallet = executor_wallet;
        config.bump = ctx.bumps.program_config;
        Ok(())
    }

    /// Crée une nouvelle pool
    pub fn create_pool(
        ctx: Context<CreatePool>,
        pool_index: u64,
        target_net_lamports: u64,
        min_deposit_lamports: u64,
        max_per_wallet_lamports: u64,
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool_state;
        pool.creator = ctx.accounts.creator.key();
        pool.pool_index = pool_index;
        pool.platform_fee_wallet = ctx.accounts.platform_fee_wallet.key();
        pool.target_net_lamports = target_net_lamports;
        pool.min_deposit_lamports = min_deposit_lamports;
        pool.max_per_wallet_lamports = max_per_wallet_lamports;
        pool.total_contributed_net_lamports = 0;
        pool.bonus_pool_lamports = 0;
        pool.total_pending_fees_lamports = 0;
        pool.status = PoolStatus::Filling;
        pool.bump = ctx.bumps.pool_state;
        pool.vault_bump = ctx.bumps.vault;

        // Créer le vault comme compte système (owner = System Program) pour permettre
        // les transferts sortants via system_program::transfer.
        // invoke_signed requis car le vault est une PDA (le programme doit signer).
        let rent = Rent::get()?;
        let rent_lamports = rent.minimum_balance(0);
        let pool_key = pool.key();
        let vault_seeds = &[
            b"vault",
            pool_key.as_ref(),
            &[pool.vault_bump],
        ];
        anchor_lang::solana_program::program::invoke_signed(
            &system_instruction::create_account(
                &ctx.accounts.creator.key(),
                &ctx.accounts.vault.key(),
                rent_lamports,
                0,
                &system_program::ID,
            ),
            &[
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.creator.to_account_info(),
                ctx.accounts.vault.to_account_info(),
            ],
            &[vault_seeds],
        )?;

        Ok(())
    }

    pub fn init_contributor(ctx: Context<InitContributor>) -> Result<()> {
        let contributor = &mut ctx.accounts.contributor_state;
        contributor.contributed_net_lamports = 0;
        contributor.pending_fee_lamports = 0;
        Ok(())
    }

    /// Dépôt dans la pool
    pub fn deposit(ctx: Context<Deposit>, gross_amount: u64) -> Result<()> {
        let pool = &mut ctx.accounts.pool_state;
        let contributor = &mut ctx.accounts.contributor_state;

        // Vérifications
        require!(pool.status == PoolStatus::Filling, PoolError::PoolNotFilling);
        require!(gross_amount >= pool.min_deposit_lamports, PoolError::BelowMinDeposit);

        // Calcul du net sur le montant brut demandé
        let fee_platform_full = gross_amount * PLATFORM_FEE_BPS / BPS_BASE;
        let fee_pending_full = gross_amount * PENDING_FEE_BPS / BPS_BASE;
        let net_full = gross_amount - fee_platform_full - fee_pending_full;

        // Plafonnement au net restant si le dépôt dépasse la capacité
        // Le surplus reste dans le wallet de l'utilisateur (on ne le prélève jamais)
        let remaining_capacity = pool.target_net_lamports
            .checked_sub(pool.total_contributed_net_lamports)
            .unwrap_or(0);

        let (fee_platform_now, fee_pending, net) = if net_full <= remaining_capacity {
            (fee_platform_full, fee_pending_full, net_full)
        } else {
            // Recalcul du gross depuis le net plafonné (arrondi au supérieur)
            // pour que fee_platform + fee_pending + net_capped == gross_accepted
            let net_capped = remaining_capacity;
            let gross_accepted = (net_capped * BPS_BASE + (BPS_BASE - TOTAL_FEE_BPS) - 1)
                / (BPS_BASE - TOTAL_FEE_BPS);
            let fp = gross_accepted * PLATFORM_FEE_BPS / BPS_BASE;
            let fpend = gross_accepted * PENDING_FEE_BPS / BPS_BASE;
            let n = gross_accepted - fp - fpend;
            (fp, fpend, n)
        };

        // Vérif max par wallet
        let new_total = contributor.contributed_net_lamports
            .checked_add(net)
            .ok_or(PoolError::Overflow)?;
        require!(
            new_total <= pool.max_per_wallet_lamports,
            PoolError::ExceedsMaxPerWallet
        );

        // Transfer fee_platform_now → platform wallet
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.user.to_account_info(),
                    to: ctx.accounts.platform_fee_wallet.to_account_info(),
                },
            ),
            fee_platform_now,
        )?;

        // Transfer (net + fee_pending) → vault
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.user.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            net + fee_pending,
        )?;

        // Update contributor
        contributor.contributed_net_lamports = new_total;
        contributor.pending_fee_lamports = contributor.pending_fee_lamports
            .checked_add(fee_pending)
            .ok_or(PoolError::Overflow)?;

        // Update pool
        pool.total_contributed_net_lamports = pool.total_contributed_net_lamports
            .checked_add(net)
            .ok_or(PoolError::Overflow)?;
        pool.total_pending_fees_lamports = pool.total_pending_fees_lamports
            .checked_add(fee_pending)
            .ok_or(PoolError::Overflow)?;

        // Instant lock
        if pool.total_contributed_net_lamports >= pool.target_net_lamports {
            pool.status = PoolStatus::Ready;
        }

        Ok(())
    }

    /// Exit (partiel ou total)
    pub fn exit(ctx: Context<Exit>, withdraw_net_amount: u64) -> Result<()> {
        let contributor = &mut ctx.accounts.contributor_state;

        require!(
            ctx.accounts.pool_state.status == PoolStatus::Filling,
            PoolError::PoolNotFilling
        );
        require!(
            withdraw_net_amount <= contributor.contributed_net_lamports,
            PoolError::InsufficientFunds
        );
        require!(withdraw_net_amount > 0, PoolError::ZeroAmount);

        // Calcul proportionnel du pending fee converti en bonus
        let converted = contributor.pending_fee_lamports
            .checked_mul(withdraw_net_amount)
            .ok_or(PoolError::Overflow)?
            .checked_div(contributor.contributed_net_lamports)
            .ok_or(PoolError::Overflow)?;

        // Update contributor
        contributor.contributed_net_lamports -= withdraw_net_amount;
        contributor.pending_fee_lamports -= converted;

        // Update pool
        let pool = &mut ctx.accounts.pool_state;
        pool.total_contributed_net_lamports -= withdraw_net_amount;
        pool.total_pending_fees_lamports -= converted;
        pool.bonus_pool_lamports += converted;

        // Transfer withdraw_net_amount du vault vers user
        let pool_key = pool.key();
        let vault_seeds = &[
            b"vault",
            pool_key.as_ref(),
            &[pool.vault_bump],
        ];
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.user.to_account_info(),
                },
                &[vault_seeds],
            ),
            withdraw_net_amount,
        )?;

        Ok(())
    }

    /// Withdraw pour launch — appelable par n'importe qui ; les fonds vont au wallet plateforme
    pub fn withdraw_for_launch(ctx: Context<WithdrawForLaunch>) -> Result<()> {
        let pool = &mut ctx.accounts.pool_state;

        require!(pool.status == PoolStatus::Ready, PoolError::PoolNotReady);

        let launch_amount = pool.target_net_lamports
            .checked_add(pool.bonus_pool_lamports)
            .ok_or(PoolError::Overflow)?;
        let platform_pending = pool.total_pending_fees_lamports;

        pool.status = PoolStatus::Launched;

        let pool_key = pool.key();
        let vault_seeds = &[
            b"vault",
            pool_key.as_ref(),
            &[pool.vault_bump],
        ];

        // Transfer launch_amount → platform launch wallet
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.launch_wallet.to_account_info(),
                },
                &[vault_seeds],
            ),
            launch_amount,
        )?;

        // Transfer platform_pending → platform wallet
        if platform_pending > 0 {
            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.platform_fee_wallet.to_account_info(),
                    },
                    &[vault_seeds],
                ),
                platform_pending,
            )?;
        }

        Ok(())
    }
}

// ============================================================
// ACCOUNTS
// ============================================================
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + ProgramConfig::INIT_SPACE,
        seeds = [b"config"],
        bump
    )]
    pub program_config: Account<'info, ProgramConfig>,

    #[account(mut, address = ADMIN)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(pool_index: u64)]
pub struct CreatePool<'info> {
    #[account(
        init,
        payer = creator,
        space = 8 + PoolState::INIT_SPACE,
        seeds = [b"pool", creator.key().as_ref(), &pool_index.to_le_bytes()],
        bump
    )]
    pub pool_state: Account<'info, PoolState>,

    /// CHECK: vault PDA — créé manuellement avec owner = System Program
    #[account(
        mut,
        seeds = [b"vault", pool_state.key().as_ref()],
        bump
    )]
    pub vault: AccountInfo<'info>,

    #[account(mut)]
    pub creator: Signer<'info>,

    /// CHECK: juste un wallet qui reçoit les fees
    pub platform_fee_wallet: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitContributor<'info> {
    #[account(
        init,
        payer = user,
        space = 8 + ContributorState::INIT_SPACE,
        seeds = [b"contributor", pool_state.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub contributor_state: Account<'info, ContributorState>,

    #[account(
        seeds = [b"pool", pool_state.creator.as_ref(), &pool_state.pool_index.to_le_bytes()],
        bump = pool_state.bump
    )]
    pub pool_state: Account<'info, PoolState>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(
        mut,
        seeds = [b"pool", pool_state.creator.as_ref(), &pool_state.pool_index.to_le_bytes()],
        bump = pool_state.bump
    )]
    pub pool_state: Account<'info, PoolState>,

    #[account(
        mut,
        seeds = [b"contributor", pool_state.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub contributor_state: Account<'info, ContributorState>,

    /// CHECK: vault PDA — créé avec init, détenu par le programme (pas System)
    #[account(
        mut,
        seeds = [b"vault", pool_state.key().as_ref()],
        bump = pool_state.vault_bump
    )]
    pub vault: AccountInfo<'info>,

    /// CHECK: platform fee wallet depuis pool_state
    #[account(
        mut,
        constraint = platform_fee_wallet.key() == pool_state.platform_fee_wallet
    )]
    pub platform_fee_wallet: AccountInfo<'info>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Exit<'info> {
    #[account(
        mut,
        seeds = [b"pool", pool_state.creator.as_ref(), &pool_state.pool_index.to_le_bytes()],
        bump = pool_state.bump
    )]
    pub pool_state: Account<'info, PoolState>,

    #[account(
        mut,
        seeds = [b"contributor", pool_state.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub contributor_state: Account<'info, ContributorState>,

    /// CHECK: vault PDA — détenu par le programme
    #[account(
        mut,
        seeds = [b"vault", pool_state.key().as_ref()],
        bump = pool_state.vault_bump
    )]
    pub vault: AccountInfo<'info>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawForLaunch<'info> {
    #[account(
        seeds = [b"config"],
        bump = program_config.bump
    )]
    pub program_config: Account<'info, ProgramConfig>,

    #[account(
        mut,
        seeds = [b"pool", pool_state.creator.as_ref(), &pool_state.pool_index.to_le_bytes()],
        bump = pool_state.bump
    )]
    pub pool_state: Account<'info, PoolState>,

    /// CHECK: vault PDA — détenu par le programme
    #[account(
        mut,
        seeds = [b"vault", pool_state.key().as_ref()],
        bump = pool_state.vault_bump
    )]
    pub vault: AccountInfo<'info>,

    /// CHECK: platform fee wallet
    #[account(
        mut,
        constraint = platform_fee_wallet.key() == pool_state.platform_fee_wallet
    )]
    pub platform_fee_wallet: AccountInfo<'info>,

    /// CHECK: platform launch wallet — receives launch_amount (from ProgramConfig)
    #[account(
        mut,
        constraint = launch_wallet.key() == program_config.executor_wallet
    )]
    pub launch_wallet: AccountInfo<'info>,

    pub caller: Signer<'info>,

    pub system_program: Program<'info, System>,
}

// ============================================================
// ÉTATS
// ============================================================
#[account]
#[derive(InitSpace)]
pub struct ProgramConfig {
    pub executor_wallet: Pubkey,  // 32
    pub bump: u8,                 // 1
}

#[account]
#[derive(InitSpace)]
pub struct PoolState {
    pub creator: Pubkey,                          // 32
    pub pool_index: u64,                          // 8
    pub platform_fee_wallet: Pubkey,              // 32
    pub target_net_lamports: u64,                 // 8
    pub min_deposit_lamports: u64,                // 8
    pub max_per_wallet_lamports: u64,             // 8
    pub total_contributed_net_lamports: u64,      // 8
    pub bonus_pool_lamports: u64,                 // 8
    pub total_pending_fees_lamports: u64,         // 8
    pub status: PoolStatus,                       // 1
    pub bump: u8,                                 // 1
    pub vault_bump: u8,                           // 1
}

#[account]
#[derive(InitSpace)]
pub struct ContributorState {
    pub contributed_net_lamports: u64,  // 8
    pub pending_fee_lamports: u64,      // 8
}

// ============================================================
// ENUMS & ERREURS
// ============================================================
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub enum PoolStatus {
    Filling,
    Ready,
    Launched,
    Cancelled,
}

#[error_code]
pub enum PoolError {
    #[msg("La pool n'est pas en état Filling")]
    PoolNotFilling,
    #[msg("La pool n'est pas en état Ready")]
    PoolNotReady,
    #[msg("Montant en dessous du minimum")]
    BelowMinDeposit,
    #[msg("Dépasse le maximum par wallet")]
    ExceedsMaxPerWallet,
    #[msg("Fonds insuffisants")]
    InsufficientFunds,
    #[msg("Montant zéro non autorisé")]
    ZeroAmount,
    #[msg("Non autorisé")]
    Unauthorized,
    #[msg("Overflow arithmétique")]
    Overflow,
}