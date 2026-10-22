# Velsuno — registro técnico de lanzamiento

Registro persistente del trabajo hacia el MVP. Se actualiza en cada ciclo. Antes de una sesión nueva: leer este
archivo, `docs/status.md` y `git log`; no repetir la auditoría si sigue vigente.

Estados: VERIFICADO (evidencia reproducible) · IMPLEMENTADO SIN VERIFICAR · PARCIAL · EJECUTABLE · BLOQUEADO (PO).

## Auditoría 2026-10-20 (solo lectura, por frente)
Fuente: workflow `wf_21009840-56c` (6 de 7 frentes; G — producción/QA — quedó sin auditar por el límite de uso).
Resultado completo por frente en el journal del workflow; resumen:

| Frente | Verificado | Pendiente ejecutable (principal) | Bloqueado por el PO |
|---|---|---|---|
| A Auth/seguridad | registro por correo, login + Cap + bloqueo, recuperación, /auth/confirm, proxy | sesiones tras recuperación, logout solo este dispositivo, cookies HttpOnly/Secure, CSP, oráculo de teléfono en `complete_registration`, guard de EXECUTE en funciones | CAP_SECRET en Vercel, migración 035, contraseñas filtradas (plan), plantillas y SMTP propio, login solo servidor |
| B Bancos | contrato de adaptadores, dedupe, review_required, import pegado | enrutamiento multi-banco, BBVA, Interbank (scaffold), entidades HTML, plantilla no verificada nunca autoconfirma, límites Free en el puente | mensajes reales BCP/BBVA, proveedor de correo entrante |
| C Planificación | dinero libre, ocurrencias, liquidaciones | pagos parciales, fondos de reserva, guardas SQL de liquidación, omitido ≠ pagado | — (aprobación en Preview) |
| D IA / Vels | puerta única, cuota, validación | varias deudas de tarjeta en un mensaje, plazo total, copy honesto sin IA, sanitizado | clave en plan de pago, AI_PRICES, bench real |
| E Correo/integraciones | SMTP Brevo conectado (servicio existente), puente con firma | ledger reintentable, proveedores (Postmark/Brevo/Cloudflare), DKIM, código de reenvío Gmail, TLS del pool | dominio + DNS en Brevo, tracking off, proveedor entrante + MX, variables del servidor |
| F Pagos | precios en servidor, pedidos, compra demo | adaptador Culqi con mocks, webhook, ciclo de vida, cancelación, guard test/live | cuenta Culqi (USD + recurrentes), llaves, planes, webhook, decisiones comerciales/legales |

## Ejecución
| Bloque | Rama | Estado (2026-10-22) | Evidencia |
|---|---|---|---|
| B Bancos (11 tareas) | `wf/front-b-banks` | IMPLEMENTADO; revisiones adversarial y de seguridad hechas (sin bloqueantes, 7 hallazgos mayores); correcciones en curso | check 646 · test:db 151 · build OK (antes de correcciones) |
| A Auth/seguridad | `wf/front-a-auth` | 7 tareas con commit (sesiones, cookies, cabeceras, CSP report-only, proxy fail-closed, bloqueo, cuenta existente); migración 049 en curso | pendiente de verificación final |
| C Planificación | `wf/front-c-planning` | C1–C4 con commit (guarda SQL de liquidaciones, omitido ≠ pagado, pagos parciales: esquema + motor); C5–C12 en curso | pendiente |
| F Pagos (Culqi) | `wf/front-f-billing` | en curso | — |
| D IA, E Correo | — | en cola tras A/B | — |

Interrupción 2026-10-20/22: el reinicio del entorno detuvo los procesos; el trabajo quedó en las ramas y se retomó sin reiniciar.

## Bloqueado por el PO (acción mínima)
Se consolida al cerrar el ciclo; ver la sección final del reporte del ciclo.

## Próxima ejecución
Integrar ramas revisadas en `claude/beautiful-keller-ikxlrj`, aplicar migraciones nuevas al proyecto
`jeloegnvaxlfqjntbbyy` (solo no destructivas), verificación completa y recorrido en navegador.
