import { ActionForm } from '../../../components/action-form';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { rotateAddressAction } from '../actions';
import { describeSyncEvent, type SyncEventRow } from '../../../src/web/sync-history';
import { formatLimaDateTime } from '../../../src/web/transaction-input';

export const metadata = { title: 'Conexiones' };

export default async function Connections() {
  const supabase = await createSupabaseServerClient();
  const [{ data }, history] = await Promise.all([
    supabase.from('email_connections').select('address_local,created_at').eq('status', 'active').maybeSingle(),
    // RLS: only the user's own events.
    supabase.from('financial_events').select('channel,outcome,created_at,transaction_id').order('created_at', { ascending: false }).limit(30),
  ]);
  const events = (history.data ?? []) as SyncEventRow[];
  const domain = process.env.INGEST_EMAIL_DOMAIN;
  const ready = !!domain && !!process.env.INBOUND_EMAIL_SECRET && !!process.env.DATABASE_URL;
  const bridgeActive = ready && !!data;
  return (
    <main className="stack narrow-md">
      <div className="page-head">
        <h1>Conexiones</h1>
        <p>Así llegan tus movimientos a Velsuno.</p>
      </div>

      <ul className="plain sources">
        <li className="source">
          <div className="row" style={{ alignItems: 'baseline' }}>
            <strong>Reenvío de correos del banco</strong>
            {bridgeActive ? <span className="tag positive-tag">Activo</span> : <span className="tag" data-testid="bridge-status">Aún no disponible</span>}
          </div>
          <p className="muted small">Reenvías solo los avisos de tu banco a una dirección privada. No leemos el resto de tu correo.</p>
          {data ? (
            <p className="small" data-testid="bridge-address">Tu dirección: <code>{data.address_local}@{domain ?? '(dominio pendiente)'}</code></p>
          ) : null}
          <ActionForm action={rotateAddressAction} label="Generar dirección" className="inline">
            <button type="submit" className={data ? 'link small-link' : 'quiet'}>{data ? 'Cambiar dirección (la actual deja de funcionar)' : 'Generar mi dirección'}</button>
          </ActionForm>
        </li>
        <li className="source row">
          <span className="setting-text"><strong>Pegar un mensaje del banco</strong><small className="muted">Copias el correo o SMS y lo leemos.</small></span>
          <a href="/app/importar" className="button quiet">Pegar</a>
        </li>
        <li className="source row">
          <span className="setting-text"><strong>Registro manual</strong><small className="muted">Para efectivo o lo que no llega del banco.</small></span>
          <a href="/app/movimientos/nuevo" className="button quiet">Registrar</a>
        </li>
        <li className="source row muted-source">
          <span className="setting-text"><strong>Gmail</strong><small className="muted">Conexión directa con tu correo.</small></span>
          <span className="tag">Próximamente</span>
        </li>
        <li className="source row muted-source">
          <span className="setting-text"><strong>SMS en Android</strong><small className="muted">Lectura de los SMS del banco en tu teléfono.</small></span>
          <span className="tag">Próximamente</span>
        </li>
      </ul>

      <details className="card">
        <summary>Últimos mensajes recibidos</summary>
        <div className="stack-sm" style={{ marginTop: 8 }}>
        {history.error ? <p role="alert" className="error">No se pudo cargar el historial.</p>
          : events.length === 0 ? <p className="muted">Aún no llega ninguna notificación.</p> : (
          <ul className="list" data-testid="sync-history">
            {events.map((e, i) => {
              const d = describeSyncEvent(e);
              return (
                <li key={i}>
                  <span>{d.outcome}<br /><small className="muted">{d.channel} · {formatLimaDateTime(e.created_at)}</small></span>
                  {d.linkable && <a href={`/app/movimientos/${e.transaction_id}`}>Ver</a>}
                </li>
              );
            })}
          </ul>
        )}
        <small className="muted">Los 30 más recientes. Los repetidos o los que no son movimientos no crean nada.</small>
        </div>
      </details>
    </main>
  );
}
