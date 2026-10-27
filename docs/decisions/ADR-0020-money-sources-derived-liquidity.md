# ADR-0020 — Money sources and derived liquidity

- **Status:** ACCEPTED (PO request, CR-001). Date: 2026-10-27.
- **Migration:** `20261027000057_money_sources.sql`.
- **Supersedes:** ADR-0005 §Balance ("balance is what the person declares").
- **Keeps:** ADR-0002 (an ATM withdrawal is not spending) and ADR-0017 (apartados live inside the balance).

## Decision
**Sources.**
- `accounts.kind` is `bank` or `cash`. There is one active cash pocket per currency.
- Debit cards hold their bank accounts through `card_accounts`.
- Credit cards keep their line, cycle, colour, expiry and a "used" checkpoint.

**Balances are checkpoints plus movements.**
- `account_balance_checkpoints` and `card_used_checkpoints` are append-only: a correction is a new "saldo al".
- An account balance = latest checkpoint + Σ `balanceEffect()` of confirmed movements that occurred after it.
- With no checkpoint the balance is unknown (null), never 0.

**`balanceEffect()`** (in `src/domain`) is separate from `financialEffect()`. Metrics are unchanged.
- A credit purchase moves the card's used line, not an account.
- A card payment lowers the account and the used line. It is never a second expense.
- A transfer is −source +destination.
- A withdrawal is −bank +cash.
- A missing destination is reported, never guessed.

**Liquidity per currency** = Σ known balances of active bank + cash accounts.
- PEN and USD are never summed.
- Excluded: credit availability, investments, debts and goals.
- In-review movements are counted apart ("pendientes").
- If no account has a balance in that currency, the latest declared `balance_snapshots` total is used (`source: 'declared'`). The two sources are never added.

**Debit purchases.** A movement made with a debit card gets the card's one active account in its currency (trigger `transactions_resolve_account`, every write path). With 0 or 2+ candidates it stays null and the person picks.

**Writes.** `save_money_source` (card + accounts + checkpoints + links) and `set_cash_balance` are SECURITY INVOKER: they run under RLS, are atomic, and are idempotent per `client_ref`.

## Consequences
- Old rows keep working: every new column is nullable or defaulted, and the declared total stays the fallback.
- Bank notifications that name no account do not move a balance until the card or account is linked.
- A movement dated before a checkpoint does not change that balance; the UI says so.
