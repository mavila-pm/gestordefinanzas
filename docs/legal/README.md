# Legal documents — internal notes

**LEGAL REVIEW REQUIRED BEFORE PRODUCTION.** `/terminos` and `/privacidad` (versions in `src/web/legal.ts`, rows in
`public.legal_documents`) are a serious base written from what the code actually does; they are not legal advice and
do not "protect against everything". Bracketed fields `[… — por completar]` are visible placeholders.

## Checklist (PO + lawyer)
- [ ] Razón social · RUC · domicilio
- [ ] Contacto legal y contacto de privacidad (correo); `SUPPORT_EMAIL` in Vercel
- [ ] Ley aplicable y jurisdicción / mecanismo de controversias
- [ ] Política de cobros, renovación, cancelación y reembolsos (cuando Plus tenga precio)
- [ ] Proveedores definitivos: correo (SMTP), pagos, IA activos en producción
- [ ] Registro del banco de datos personales ante la ANPD y base legal por finalidad (Ley 29733 y Reglamento)
- [ ] Revisión por abogado peruano especialista en protección de datos / consumo / servicios digitales

## Publishing a new version
1. Edit the page text. 2. New migration: `insert into public.legal_documents (kind, version) values (...)`.
3. Bump `TERMS_VERSION` / `PRIVACY_VERSION`. Registration then requires the new version; a re-acceptance flow for
existing accounts is not built yet (needed only when a material change is published).
