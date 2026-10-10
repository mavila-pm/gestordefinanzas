-- ADR-0008: an explicit preference the person states ("no me importa quedarme en cero si pago deuda").
-- It never changes the plan by itself: it only lets a suggested extra debt payment use the cushion too, and the
-- trade-off is always shown. Default off; the person turns it on/off (Preguntar or Dinero libre).
alter table public.planning_settings add column allow_zero_for_debt boolean not null default false;
