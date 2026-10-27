# CR-001 / APROBADO POR EL PO (pedido explícito)

**Cambio y motivo.** La liquidez sale de lo registrado en Cuentas y tarjetas, no de un total declarado.
- La auditoría UX del 15-10-2026 (Mauro, PDF "Auditoría Velsuno", §2.5–2.6) pide que "Cuánto tienes hoy", "Saldo", "Dinero disponible" y "Ahorro" provengan de cuentas, tarjetas y efectivo, y que se actualicen con cada ingreso y gasto.
- Tarjeta: nombre, color (negro, gris, azul, verde, rojo, celeste, amarillo), débito o crédito, banco (BCP, Interbank, BBVA, Scotiabank u "Otro" con su nombre), moneda y últimos 4 dígitos.
- Crédito: línea, días de corte y pago, vencimiento (MM/AA) y línea usada hoy.
- Débito: vencimiento y una o varias cuentas dentro de la tarjeta (nombre, moneda, saldo actual).
- Efectivo como sección propia.

**Decisión vigente afectada.**
- ADR-0005 §Balance ("el saldo es lo que la persona declara"): reemplazado por ADR-0020.
- MOTHER §27, campos de tarjeta: se suman color, vencimiento MM/AA, nombre de banco libre y línea usada.

**Impacto.**
- Producto: el saldo pasa a ser derivado y se actualiza con cada movimiento confirmado.
- Técnico: migración 057, aditiva y sin DROP; motor puro `src/domain/balance-effect.ts` y `src/engine/liquidity.ts`.
- Seguridad: nunca se guarda el número completo, CVV, PIN ni claves. Solo últimos 4; los nombres rechazan secuencias de 5 o más dígitos.
- Costos: ninguno.

**Riesgos y alternativas.**
- Un movimiento sin cuenta de origen no mueve ningún saldo: se muestra como "sin cuenta".
- Las transferencias sin destino se preguntan, nunca se adivinan.
- Fallback:
  - Mientras no haya cuentas con saldo, se usa el último total declarado.
  - Nunca se suman ambas fuentes.

**Recomendación.** Aplicar. Es aditivo y los usuarios actuales conservan su total declarado hasta registrar cuentas.

**Decisión de Mauro y evidencia.** Pedido escrito "IMPLEMENTACIÓN INTEGRAL DE AUDITORÍA UX — VELSUNO" (sesión del 27-10-2026) y PDF de auditoría del 15-10-2026. El recorrido en Preview queda pendiente.

**Archivos y aceptación.**
- Archivos: `supabase/migrations/20261027000057_money_sources.sql`, `tests/db/money-sources.test.ts`, `tests/liquidity.test.ts`, ADR-0020, `docs/runbooks/supabase-migrations.md`.
- Aceptación:
  - Crear una tarjeta de débito con 2 cuentas → la liquidez es la suma de sus saldos.
  - Un gasto con esa tarjeta baja la cuenta de su moneda.
  - Una compra con crédito no baja la liquidez; el pago de la tarjeta sí, una sola vez.
