/** Shown while the server prepares Resumen; same shape as the screen (title, Dinero libre, income row, list). */
export default function Loading() {
  return (
    <div className="stack route-loading" role="status" aria-busy="true" aria-label="Cargando">
      <div className="sk" style={{ height: 36, width: '40%' }} />
      <div className="sk" style={{ height: 300, borderRadius: 'var(--radius-card)' }} />
      <div className="sk" style={{ height: 72, borderRadius: 'var(--radius-card)' }} />
      <div className="sk" style={{ height: 200, borderRadius: 'var(--radius-card)' }} />
    </div>
  );
}
