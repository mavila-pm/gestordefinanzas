# Landing vs app (2026-10-10)

Reference: `velsuno-landing.html` (PO). Rule: a promise is shown in the app only with real data; what depends on a
provider or on data Velsuno does not have is a blocker, never simulated. Conexiones stays out of the navigation
(connecting starts by talking to Vels).

| Promesa (landing) | Dónde en la app | Estado | Falta | Acción |
|---|---|---|---|---|
| Panel Maestro: disponible, ingresos, gastos, ahorro, próximo pago | Resumen | OK (rediseñado) | — | Grid desktop: Disponible + 4 KPIs; 2 columnas; móvil priorizado |
| "Te quedará" (cuánto queda, con pagos por venir restados) | Resumen → Dinero disponible (`/app/plan`) | OK | Horizonte = próximo ingreso, no fin de mes calendario (ADR-0005) | Se mantiene; Vels responde "¿me alcanza?" |
| En qué se fue tu dinero | Resumen (nuevo) + Análisis | OK | — | `spendSlices` (top 3 + Otros) |
| Movimientos con categoría y origen; Por revisar | Movimientos, Por revisar, aviso en Resumen | OK | — | — |
| Próximos pagos / proyección de recurrentes | Resumen, Próximos pagos | OK | — | — |
| Tarjetas: cierre, pago, línea total, % de uso | Resumen (nuevo bloque) + Cuentas y tarjetas | OK con datos registrados | Línea/utilizado los ingresa la persona (estado de cuenta) | `creditUse`; sin dato = "sin dato", nunca 0 |
| Préstamos / cuotas | Resumen, Próximos pagos, Análisis | OK | — | — |
| Meta de ahorro, ahorro mes a mes | Resumen, Análisis | OK | Metas con nombre (viaje) no existen | Pendiente (reservas con nombre, next work #1) |
| Fuentes de ingreso | Análisis "De dónde entró tu dinero" (nuevo) | PARCIAL | "Cuál rinde más / % que te deja" necesita costos por negocio | CR: etiquetar gastos por negocio |
| Alertas antes de vencimientos | Resumen (en app) | PARCIAL | Recordatorio fuera de la app (correo/push) | BLOQUEO: proveedor de envío |
| Sugerencias con IA / Vels | Vels | OK | Gemini real no verificado desde aquí | "¿Me alcanza?", "¿Qué pasa si gasto S/300?", "¿Cuándo pago?", "¿En qué se me fue?" → motor (0 cuota) |
| Salud crediticia | Resumen → Tarjetas y deudas (nuevo) | OK como indicadores propios | Score oficial: no hay acceso a Infocorp/SBS | Uso por tarjeta vs 30% + pagos vencidos; texto "No es tu calificación en Infocorp ni en la SBS". "Pagos a tiempo seguidos" no se muestra (no se guarda puntualidad) |
| Registro automático (reenviar avisos del banco) | Importar (pegar aviso BCP) | PARCIAL | Email Bridge sin proveedor inbound, dominio, MX, secretos; plantillas BCP SYNTHETIC_UNVERIFIED | BLOQUEO: no presentarlo como terminado |
| Inversiones (TEA, plazo fijo, fondos, rendimiento) | — | NO EXISTE | Spec §89: "Herramienta de inversión" fuera del core | CR del PO antes de implementar; nunca estimar rendimientos |
| Lo que prestas / te deben (personas) | `debts` solo modela lo que debes | NO EXISTE | Dirección (por cobrar) + recordatorio | CR: columna `direction` en `debts` (+ RLS/DB test) |
| "Te aumentaron la línea" / "línea nueva ofrecida" | — | NO EXISTE | Dato del banco que no recibimos | BLOQUEO: fuente de datos |
| Saldo total en cuentas (4 cuentas) | Saldo declarado por moneda (`balance_snapshots`) | PARCIAL | Saldo por cuenta | Pendiente (no se inventa por cuenta) |
| Planes, prueba 14 días, vitalicio, precios | Ajustes → Plan y uso | PARCIAL | Proveedor de pagos y precios | BLOQUEO: billing |
| Asesorías, sesiones, sorteos | — | Fuera de la app | Operación del negocio | PO |

Invariants kept: PEN ≠ USD (per-currency blocks), unknown ≠ 0, planned ≠ realized, card payment not a second expense
(all figures go through `monthlySummary`/`financialEffect`), own transfers excluded, AI never computes money.
