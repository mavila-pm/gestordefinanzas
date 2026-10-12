/** Shown while the server prepares Resumen: the dashboard's own shape (top row, two columns), so nothing jumps. */
export default function Loading() {
  return (
    <div className="stack route-loading wide" role="status" aria-busy="true" aria-label="Cargando">
      <div className="sk" style={{ height: 36, width: '40%' }} />
      <div className="sk-row top">
        <div className="sk" style={{ height: 300, borderRadius: 'var(--radius-card)' }} />
        <div className="sk-row two"><div className="sk" style={{ height: 120 }} /><div className="sk" style={{ height: 120 }} /><div className="sk" style={{ height: 120 }} /><div className="sk" style={{ height: 120 }} /></div>
      </div>
      <div className="sk-row main">
        <div className="sk" style={{ height: 240, borderRadius: 'var(--radius-card)' }} />
        <div className="sk" style={{ height: 240, borderRadius: 'var(--radius-card)' }} />
      </div>
    </div>
  );
}
