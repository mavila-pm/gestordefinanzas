# CR-002 / APROBADO POR EL PO (pedido explícito)

**Cambio y motivo.** La auditoría UX del 15-10-2026 (§2.3–2.4) pide lo siguiente:
- Ingresos y Gastos como pestañas propias, cada una con "Contárselo a Vels" o "Registrar manualmente".
- Deudas e Inversiones como módulos propios.
- Balance financiero con:
  - presupuesto por categoría;
  - meta de ahorro y meta de inversión, cada una como monto fijo o % del ingreso;
  - las cuotas de deudas sumadas al presupuesto.
- Navegación agrupada.
- Vels según el contexto de cada sección.

**Decisión vigente afectada.**
- MOTHER §89 excluye "Broker / Herramienta de inversión": Inversiones queda solo como seguimiento manual. Sin precios, comparaciones ni recomendaciones.
- MOTHER §27 y la navegación de UX-E cambian de jerarquía.

**Impacto.**
- Migración 059, aditiva:
  - `investments`;
  - `investment_entries`, solo se agregan filas;
  - la vista `investment_positions`;
  - columnas de metas en `planning_settings`;
  - perfil del onboarding en `user_preferences`.
- Motores puros: `financial-balance`, `investments` e `income-sources`.

**Riesgos y alternativas.**
- La meta en % sin ingreso conocido queda en "Sin dato", nunca en 0.
- El valor de una inversión es lo que la persona registra; nunca se completa con lo aportado.

**Recomendación.** Aplicar.

**Decisión de Mauro y evidencia.** Pedido "IMPLEMENTACIÓN INTEGRAL DE AUDITORÍA UX — VELSUNO" y PDF del 15-10-2026. Recorrido en Preview pendiente.

**Aceptación.**
- Pruebas: `tests/db/investments.test.ts`, `tests/financial-balance.test.ts`, `tests/investments.test.ts`, `tests/income-sources.test.ts`.
- Las rutas `/app/ingresos`, `/app/gastos`, `/app/deudas`, `/app/inversiones` y `/app/balance` responden sin errores.
