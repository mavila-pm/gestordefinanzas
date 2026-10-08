# Velsuno (gestordefinanzas)

App de finanzas personales para Perú (PEN/USD), modelo SaaS Free + Plus. Convierte notificaciones bancarias y registros
manuales en movimientos deduplicados y categorizados, y responde la pregunta diaria: **¿cuánto dinero puedo usar hasta
mi próximo ingreso?** (Dinero libre). Incluye un asistente, **Vels**, que explica los números sin inventarlos.

> Especificación vinculante: [`docs/product/MOTHER_DOCUMENT.md`](docs/product/MOTHER_DOCUMENT.md) (Prompt Madre).
> Estado vivo: [`docs/status.md`](docs/status.md) · Brecha al MVP: [`docs/MVP.md`](docs/MVP.md).

## Problema que resuelve
Registrar gastos a mano cansa y se abandona; los datos incompletos producen análisis falsos. Velsuno automatiza la
entrada (bancos → eventos → movimientos), separa lo confirmado de lo estimado, nunca convierte un dato desconocido en
S/ 0 y pregunta solo lo dudoso (cola "Por revisar").

## Estado actual
- **Beta en Vercel Preview** (rama `claude/beautiful-keller-ikxlrj`). **No hay producción** ni dominio todavía.
- Núcleo financiero, planificación (Dinero libre), revisión, importación de mensajes BCP pegados, splits, presupuestos,
  deudas, tarjetas, Vels y onboarding conversacional: implementados y verificados con tests (ver `docs/status.md`).
- Bloqueado por decisiones/credenciales externas: proveedor de email entrante (Email Bridge real), proveedor de IA en
  producción, proveedor de pagos, SMTP propio, dominio. Detalle y prioridades en [`docs/MVP.md`](docs/MVP.md).

## Arquitectura
```
Navegador (React 19, Server Components + Server Actions)
   │  cookies de sesión (Supabase Auth)
   ▼
Next.js 16 App Router (Vercel)  ── proxy.ts: refresca sesión y protege /app/* y /bienvenida
   ├─ app/…/page.tsx          lecturas con la sesión del usuario (lib/queries.ts, lib/planning.ts)
   ├─ app/…/actions.ts        escrituras validadas (src/web/*-input.ts) → funciones SQL seguras
   ├─ app/api/…/route.ts      webhook de email, prueba de IA
   ▼
src/ (TypeScript puro, testeable)          lib/ (servidor: Supabase, IA, consultas)
   domain → ingestion → engine → ai           lib/ai.ts = única puerta a proveedores de IA
   ▼
Supabase PostgreSQL: RLS por usuario, funciones security definer para escrituras, auditoría append-only
```
Regla central: **FUENTE → EVENTO NORMALIZADO → MOTOR FINANCIERO**. El código específico de un banco vive solo en
`src/ingestion/adapters/`. El dinero se calcula con el motor determinista; la IA solo interpreta (ADR-0006).
Mapa detallado de módulos y tests: [`docs/architecture/structure.md`](docs/architecture/structure.md).

## Stack
Next.js 16 · React 19 · TypeScript 5.9 · Supabase (PostgreSQL, Auth, RLS) · Vercel · Vitest · Playwright (`playwright-core`).
Sin librerías de UI ni de animación: CSS propio con los tokens de `brand/VELSUNO/`. Dependencias de runtime: 7.

## Estructura de carpetas
| Ruta | Contenido |
|---|---|
| `app/` | Rutas (App Router): públicas, `(auth)`, `/bienvenida` (onboarding), `/app/*` (producto), `api/` |
| `components/` | Componentes React (formularios, chat de Vels, hojas); `components/ui/` = sistema de diseño |
| `lib/` | Código solo de servidor: clientes Supabase, consultas, IA (`ai.ts`), planificación, onboarding |
| `src/domain/` | Tipos y reglas puras: dinero, modelo de transacción, `financialEffect()` |
| `src/ingestion/` | Fuentes (email, SMS) y adaptadores por banco/canal/versión (`adapters/bcp/`) |
| `src/engine/` | Dedupe, categorización, análisis, alertas, planificación, escenarios, tarjetas |
| `src/ai/` | Interpretación, prompts, proveedores (OpenRouter, Gemini, DeepSeek, fixture), cuotas |
| `src/web/` | Validación de formularios y helpers puros de la capa web |
| `src/infrastructure/` | Repositorio Postgres y webhook de email entrante |
| `supabase/migrations/` | Esquema, RLS y funciones SQL versionadas (27 migraciones aplicadas) |
| `tests/` | Unit (raíz), `tests/db/` (Postgres desechable), `tests/e2e/` (proyecto real) |
| `scripts/` | `e2e.sh`, `test-db.sh`, `qa/` (riesgo, logs, secretos), benchmark de IA |
| `brand/VELSUNO/` | Marca: tokens, fuente, íconos, logo |
| `docs/` | Spec, ADRs, arquitectura, runbooks, QA, estado, MVP |

## Requisitos
- Node.js ≥ 20 (CI usa 22) y npm.
- Para `npm run test:db`: binarios de PostgreSQL ≥ 15 (`PG_BIN` para indicar la ruta).
- Para E2E: Chromium de Playwright y acceso al proyecto Supabase (ver runbook).

## Instalación y configuración
```bash
npm install
cp .env.example .env.local   # completa los valores públicos de Supabase
```
### Variables de entorno (placeholders, nunca secretos reales en git)
| Variable | Dónde | Uso |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | pública | URL del proyecto Supabase |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | pública | clave publicable (`sb_publishable_…`); la app rechaza claves secretas |
| `NEXT_PUBLIC_SITE_URL` | pública, opcional | base de los links de email; en Preview se usa la URL de rama |
| `OPENROUTER_API_KEY` | **secreta, servidor** | IA vía OpenRouter (prueba técnica y llamadas sin datos de cuenta) |
| `OPENROUTER_MODEL` | servidor | modelo (por defecto `openrouter/free`) |
| `AI_PROVIDER` | servidor | `none` (defecto) · `openrouter` · `gemini` · `deepseek`; activa la IA de Vels/onboarding |
| `GEMINI_API_KEY`, `DEEPSEEK_API_KEY` | **secretas, servidor** | proveedores alternativos |
| `APP_URL` | servidor, opcional | URL enviada a OpenRouter como atribución |
| `DATABASE_URL`, `INBOUND_EMAIL_SECRET`, `INGEST_EMAIL_DOMAIN` | **secretas, servidor** | Email Bridge (sin ellas el webhook responde 503) |

Lista completa y comentada: [`.env.example`](.env.example). La service role de Supabase **nunca** se usa en la app.

## Ejecutar
```bash
npm run dev      # desarrollo en http://localhost:3000
npm run build    # build de producción
npm start        # sirve el build
```

## Base de datos y migraciones
- Supabase, proyecto único `jeloegnvaxlfqjntbbyy`. Cambios de esquema **solo** con archivos nuevos en
  `supabase/migrations/` (nunca editar una migración aplicada).
- Toda tabla nueva: RLS por usuario, grants explícitos y test A/B en `tests/db/`.
- Procedimiento y lista de migraciones aplicadas: [`docs/runbooks/supabase-migrations.md`](docs/runbooks/supabase-migrations.md) ·
  modelo de seguridad: [`docs/security/rls.md`](docs/security/rls.md).

## Tests
```bash
npm run check          # typecheck + unit (≈310) — antes de cada push
npm run test:db        # Postgres desechable: migraciones, RLS, aislamiento A/B, concurrencia (≈108)
scripts/e2e.sh [suite] # E2E contra el proyecto real con usuarios sintéticos (seed/cleanup: docs/runbooks/e2e.md)
scripts/qa/risk.sh     # qué nivel de verificación (N0–N4) exige tu diff — ver docs/qa.md
```
CI (GitHub Actions, `.github/workflows/ci.yml`): `check` + `test:db` + `build` en cada push y PR. Los E2E son manuales.

## Servicios externos
| Servicio | Uso | Estado |
|---|---|---|
| Supabase | Postgres, Auth, RLS | activo |
| Vercel | hosting (Preview) | activo; sin producción |
| OpenRouter / Gemini / DeepSeek | IA de Vels y onboarding (opcional) | configurable; sin clave la app funciona sin IA |
| Proveedor de email entrante | Email Bridge | pendiente de elegir |
| Proveedor de pagos | Plus | pendiente (Plus es simulado: prueba de 14 días) |

## Endpoints y módulos principales
| Ruta | Tipo | Qué hace |
|---|---|---|
| `GET /auth/confirm` | route | confirma email / recuperación de contraseña (token_hash) |
| `POST /api/inbound/email` | route | webhook Email Bridge (HMAC + anti-replay; 503 sin configurar) |
| `POST /api/ai/chat` | route | prueba técnica de IA (sesión, mismo origen, solo `message`; apagado en producción) |
| `GET /app/exportar` | route | exporta movimientos a CSV (protegido contra inyección de fórmulas) |
| `app/app/actions.ts` | server actions | movimientos, revisión, tarjetas, cuentas, presupuestos, deudas, reglas, splits |
| `app/app/plan/actions.ts` | server actions | Dinero libre: saldo, ingresos, pagos, aplicar plan, escenarios |
| `app/app/preguntar/actions.ts` · `app/bienvenida/actions.ts` | server actions | Vels y onboarding |
| `app/auth/actions.ts` | server actions | signup, login, logout, recuperación de contraseña |

## Flujo principal
1. **Registro** (`/signup`, solo correo) → enlace por email → contraseña → perfil (+18, Términos y Privacidad) → `/bienvenida`: onboarding conversacional.
2. **Entrada de datos**: manual (`/app/movimientos/nuevo`), mensaje bancario pegado (`/app/importar`) o, cuando exista
   proveedor, reenvío de emails (Email Bridge). Cada evento pasa por adaptador → normalización → dedupe → categoría →
   confianza; lo dudoso va a **Por revisar**.
3. **Resumen** (`/app`): Dinero libre hasta el próximo ingreso, lo que viene, el mes como contexto.
4. **Plan** (`/app/plan`), **Análisis**, **Presupuestos**, **Próximos pagos**, **Tarjetas** y **Vels** (`/app/preguntar`).

## Deploy
Vercel construye cada push de la rama como **Preview** ([`docs/runbooks/vercel-preview.md`](docs/runbooks/vercel-preview.md)).
Producción (`main`) requiere aprobación del Product Owner y los P0 de [`docs/MVP.md`](docs/MVP.md).

## Limitaciones actuales
- Solo hay adaptadores **BCP** (email y SMS) con plantillas `SYNTHETIC_UNVERIFIED`; BBVA e Interbank faltan.
- Email Bridge sin proveedor real; SMS solo pegando el texto.
- Plus sin cobro real; límites del plan mostrados pero no aplicados en todas las funciones.
- IA real no verificada en este entorno (sin clave); la app funciona sin IA.
- Dos suites E2E tienen fechas fijas de septiembre 2026 (deuda de tests, no del producto).

## Para agentes de IA
Empieza por [`CLAUDE.md`](CLAUDE.md) (mapa, reglas y comandos) y `docs/status.md`. Skills del proyecto en `.claude/skills/`.
