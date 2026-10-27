/** Mis suscripciones while it loads: title, four figures, list + detail — the same places the content takes. */
export default function Loading() {
  return (
    <div className="stack route-loading wide" role="status" aria-busy="true" aria-label="Cargando">
      <div className="sk" style={{ height: 36, width: '45%' }} />
      <div className="sk-row four">{[0, 1, 2, 3].map((i) => <div key={i} className="sk" style={{ height: 88, borderRadius: 'var(--radius-card)' }} />)}</div>
      <div className="sk-row main">
        <div className="stack-sm">{[0, 1, 2, 3].map((i) => <div key={i} className="sk" style={{ height: 64 }} />)}</div>
        <div className="sk" style={{ height: 320, borderRadius: 'var(--radius-card)' }} />
      </div>
    </div>
  );
}
