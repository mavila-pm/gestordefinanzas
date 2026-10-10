# MVP — brecha y checklist de ejecución

**Definición usada** (el pedido no traía un `MVP_GOAL` concreto; se derivó de la spec, §51 "beta crítica", §63, §72–§75
"release blockers"): *una beta pública controlada en producción donde una persona en Perú se registra, carga sus datos
(manual, mensaje bancario o email reenviado), ve sus movimientos sin duplicados ni datos inventados, entiende su
Dinero libre, y nada de eso expone datos de otra persona.* Cambiar esta definición es decisión del PO.

**Evidencia del estado** (2026-10-07): `docs/status.md` (40 bloques, casi todos VERIFIED), unit 310, DB 108,
E2E 10 suites en verde por partes (237/237 + 55/55), build OK, CI en verde. Sin producción, sin dominio.

Leyenda: **P0** bloquea el MVP · **P1** necesario para un MVP sólido · **P2** después del MVP · **P3** futuro.

## P0 — Bloquea el MVP
- [ ] **P0 — Producción desplegada**
  - Estado: solo Vercel Preview desde la rama de trabajo; `main` sin merge; sin dominio.
  - Falta: merge aprobado a `main`, dominio, env vars de Production, Redirect URLs de Supabase para el dominio, smoke test.
  - Archivos: `docs/runbooks/production.md` (procedimiento completo: dominio, SMTP, env, merge, smoke test, rollback), `lib/env.ts` (`siteUrl`).
  - Hecho (2026-10-07): `siteUrl()` usa el dominio de producción de Vercel (`VERCEL_PROJECT_PRODUCTION_URL`) si falta `NEXT_PUBLIC_SITE_URL` (test `site-url`).
  - Depende de: PO (dominio, aprobación). Riesgo: medio.
  - Terminado cuando: la URL de producción sirve `/`, signup → email → `/auth/confirm` → `/bienvenida` funciona allí.
- [ ] **P0 — Emails de autenticación confiables (SMTP propio)**
  - Estado: SMTP por defecto de Supabase (límite bajo de envíos, no apto para usuarios reales); plantillas `token_hash` pendientes.
  - Hecho (2026-10-08): registro con correo primero, plantillas Velsuno en `supabase/templates/`, manejo de 429/fallas, runbook `docs/runbooks/auth-email.md`.
  - Falta: configurar SMTP propio y pegar plantillas (runbook); verificar registro y recuperación en un inbox real.
  - Depende de: PO (proveedor SMTP, dominio). Riesgo: alto (nadie puede confirmar su cuenta).
  - Terminado cuando: signup y recuperación llegan a Gmail/Outlook reales en < 1 min y el link abre la app correcta.
- [ ] **P0 — Plantillas BCP verificadas con mensajes reales**
  - Estado: adaptadores `src/ingestion/adapters/bcp/` (email + SMS) con plantillas `SYNTHETIC_UNVERIFIED`.
  - Falta: muestras reales anonimizadas (`REAL_ANONYMIZED`) en `tests/fixtures/bcp/samples/` y ajustar parsers si fallan.
  - Depende de: PO (pegar mensajes reales en `/app/importar` o compartir copias anonimizadas). Riesgo: alto — release blocker §75 "parser que genera datos falsos".
  - Terminado cuando: cada plantilla soportada tiene ≥ 1 muestra real que parsea monto, moneda, tipo y tarjeta correctos (`bcp-samples` en verde).
- [ ] **P0 — Regresión completa en verde sobre el candidato a release**
  - Hecho (2026-10-07): fixtures relativas al mes de Lima; `analysis-dashboard` 32/32 y `planning-account` 23/23 (antes fallaban
    por fecha; un texto de test desactualizado por la pasada de copy 038 corregido). Las otras 8 suites: 237/237 (2026-10-06).
  - Falta: una corrida N4 única (`scripts/e2e.sh` completo) sobre el commit candidato + cleanup (requiere vía con DELETE, ver P1).
  - Depende de: nada externo. Riesgo: medio (sin N4 no se puede afirmar "flujo principal no roto").
  - Terminado cuando: `scripts/e2e.sh` (todas las suites) pasa en cualquier fecha y cleanup devuelve `0 | 0`.
- [ ] **P0 — Política de privacidad y términos**
  - Hecho (2026-10-08): Términos y Privacidad reescritos (índice, versión, placeholders), aceptación versionada y auditada en el registro (`legal_acceptances`).
  - Antes (2026-10-07): `/privacidad` y `/terminos` (borrador basado en lo que el código realmente guarda y envía),
    enlazadas desde `/` y `/signup`; contacto desde `SUPPORT_EMAIL` (`components/legal-page.tsx`). Revisadas a 375 px.
  - Falta: aprobación del PO / revisión legal del texto, `SUPPORT_EMAIL` en Vercel, y registro del banco de datos ante la ANPD si aplica.
  - Depende de: PO / asesoría legal. Riesgo: alto (legal y de confianza).
  - Terminado cuando: `/privacidad` y `/terminos` publicadas, enlazadas en signup, con retención de emails/eventos definida (§78).

## P1 — Necesario para un MVP sólido
- [ ] **P1 — Un canal automático real (Email Bridge)**
  - Estado: webhook `app/api/inbound/email` + `src/infrastructure/inbound/` VERIFIED con firmas sintéticas; 503 sin configurar.
  - Falta: elegir proveedor de email entrante, dominio + MX, `DATABASE_URL` / `INBOUND_EMAIL_SECRET` / `INGEST_EMAIL_DOMAIN` en el servidor.
  - Depende de: PO (proveedor, costo). Riesgo: alto para la hipótesis del producto (sin automatización solo hay manual + pegado).
  - Terminado cuando: un email real del BCP reenviado crea 1 movimiento; reenviarlo de nuevo no duplica.
- [x] **P1 — Límites de plan aplicados en el servidor**
  - Estado: automatización Free (50 movimientos automáticos/mes Lima, 1 banco) aplicada en SQL (migración 032, `assert_auto_allowance`, test DB `plan-limits`).
  - Historial visible Free (3 meses) aplicado en el servidor en Inicio, Análisis y Movimientos (bloque 045); la exportación conserva todo.
  - Falta: Email Bridge debe llamar `assert_auto_allowance` al activarse.
  - Archivos: `src/domain/entitlements.ts`, `app/app/actions.ts`, migración nueva. Riesgo: medio (regla no negociable de CLAUDE.md).
  - Terminado cuando: un usuario Free no puede exceder un límite ni llamando la acción directamente (test DB).
- [ ] **P1 — IA real verificada y decisión de privacidad**
  - Estado: Gemini único proveedor (bloque 049, ADR-0015); sin clave en este entorno (llamada real NO VERIFICADA).
  - Falta: clave en Preview, una pregunta a Vels fuera de las reglas locales, `scripts/ai-bench.ts gemini` con datos sintéticos, decisión de retención de datos.
  - Depende de: PO (clave, privacidad). Riesgo: bajo (la app funciona sin IA; respuestas deterministas cuestan 0).
  - Terminado cuando: llamada real verificada en Preview y resultado del benchmark anotado en `docs/status.md`.
- [x] **P1 — Exportar mis datos** (Movimientos → Exportar CSV, historial completo).
  - Autoeliminación de cuenta **retirada del alcance** por decisión del PO (2026-10-08): sin botón, acción ni RPC; la migración 028
    nunca se aplicó y se eliminó. Las solicitudes de supresión (Ley 29733) se atienden por el contacto de privacidad y un
    administrador desde Supabase (Auth → Users), con borrado en cascada.
- [ ] **P1 — Adaptador BBVA (+ scaffold Interbank)**
  - Estado: no existe (spec §51 los lista en la beta crítica).
  - Falta: `src/ingestion/adapters/bbva/` con fixtures sintéticas versionadas y registro en `adapter-registry.ts`; Interbank solo scaffold.
  - Riesgo: medio (cobertura de mercado). Terminado cuando: `bbva-adapters` test en verde y el import pegado acepta BBVA.
- [ ] **P1 — Separar datos de prueba de datos reales**
  - Estado: E2E corre contra el único proyecto Supabase (61 usuarios sintéticos `@gestordefinanzas.invalid` sin limpiar: el conector MCP no ejecuta DELETE).
  - Falta: ejecutar `tests/e2e/cleanup.sql` por una vía con DELETE (psql con `E2E_DB_URL`) o un proyecto Supabase de staging (decisión PO).
  - Riesgo: medio (higiene de datos en la base que será producción). Terminado cuando: cleanup devuelve `probe_users=0 | orphan_rows=0`.
- [x] **P1 — CI en GitHub** — `.github/workflows/ci.yml` (check + test:db + build). Terminado cuando: el primer run está en verde.
- [ ] **P1 — Seguridad de Auth del proyecto**
  - Falta: Supabase advisors sin hallazgos críticos; protección de contraseñas filtradas (depende del plan de Supabase).
  - Terminado cuando: advisors de seguridad limpios o con excepción documentada.

## P2 — Importante después del MVP
- [ ] **P2 — Cobro real de Plus**: hoy prueba de 14 días simulada; falta proveedor de pagos tras `BillingProvider` (§77).
- [ ] **P2 — Observabilidad** (§60): logs estructurados existen en webhook e IA; falta monitoreo/alertas de fallos de parser, sync y auth.
- [ ] **P2 — Pagos parciales y fondos de reserva** en el motor de planificación (`src/engine/planning.ts`) — "next work" en status.
- [ ] **P2 — Lectura de estados de cuenta con cámara** (requiere proveedor de IA con visión).
- [ ] **P2 — Categorías propias del usuario** y política de edición directa de tarjetas/cuentas/presupuestos/deudas (ADR-0003).

## P3 — Futuro / nice-to-have
- [ ] **P3 — Pasada de copy** en pantallas antiguas (Reglas, Conexiones, Importar).
- [ ] **P3 — Post-beta de la spec (§53)**: Gmail OAuth, app Android de SMS, Outlook, Open Finance, tipo de cambio automático, voz, finanzas compartidas.

## Ya cumplido (no repetir)
Auth + RLS + aislamiento A/B · escrituras seguras auditadas · dedupe multifuente · revisión · manual · splits · cuentas y
tarjetas · aprendizaje de reglas · import pegado BCP · análisis, búsqueda, filtros, CSV · presupuestos, gastos fijos,
deudas · Free/Plus con prueba · Dinero libre y escenarios · Vels y onboarding · idempotencia · UI Velsuno. Ver `docs/status.md`.
