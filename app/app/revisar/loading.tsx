/** Shown the moment a tab or link is tapped, while the server prepares the page (the shell stays in place). */
export default function Loading() {
  return (
    <main className="stack narrow-md route-loading" aria-busy="true" aria-label="Cargando">
      <div className="sk" style={{ height: 32, width: '45%' }} />
      <div className="sk" style={{ height: 120 }} />
      <div className="sk" style={{ height: 56 }} />
      <div className="sk" style={{ height: 56 }} />
    </main>
  );
}
