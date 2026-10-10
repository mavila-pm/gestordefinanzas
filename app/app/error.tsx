'use client';

/** Recoverable failure: keep the shell, say it plainly, offer a retry. Technical detail stays in the server logs. */
export default function AppError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="stack narrow-md">
      <div className="page-head">
        <h1>No pudimos cargar esto</h1>
        <p>Puede ser la conexión. Tus datos están a salvo.</p>
      </div>
      <div className="actions"><button type="button" onClick={reset}>Intentar de nuevo</button><a href="/app" className="button secondary">Ir al resumen</a></div>
    </main>
  );
}
