import { ActionForm } from '../../../components/action-form';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { rotateAddressAction } from '../actions';
import { describeSyncEvent, type SyncEventRow } from '../../../src/web/sync-history';
import { formatLimaDateTime } from '../../../src/web/transaction-input';

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
  return (
    <main className="stack narrow-md">
      <h1>Conexiones</h1>
      <section className="card stack-sm">
        <h2>Reenvío de correos del banco (Email Bridge)</h2>
        <p className="muted">Tendrás una dirección privada. Configuras en tu correo que solo las notificaciones de tu banco se reenvíen ahí;
          no leemos el resto de tu bandeja y no guardamos el texto de los correos.</p>
        {!ready && (
          <p className="warn" data-testid="bridge-status">Aún no disponible: falta activar el proveedor de correo entrante y el dominio.
            Mientras tanto puedes <a href="/app/importar">importar mensajes pegándolos</a>.</p>
        )}
        {data ? (
          <p data-testid="bridge-address">Tu dirección: <code>{data.address_local}@{domain ?? '(dominio pendiente)'}</code></p>
        ) : <p className="muted">Todavía no generaste tu dirección.</p>}
        <ActionForm action={rotateAddressAction} label="Generar dirección">
          <button type="submit" className={data ? 'secondary' : ''}>{data ? 'Generar una nueva (la actual deja de funcionar)' : 'Generar mi dirección'}</button>
        </ActionForm>
      </section>
      <section className="card stack-sm">
        <h2>Otras fuentes</h2>
        <ul className="list">
          <li><span>Gmail</span><span className="muted">Próximamente (requiere autorización OAuth)</span></li>
          <li><span>SMS de Android</span><span className="muted">Próximamente (requiere app Android)</span></li>
          <li><span>Importar mensaje pegado</span><a href="/app/importar">Disponible</a></li>
          <li><span>Registro manual</span><a href="/app/movimientos/nuevo">Disponible</a></li>
        </ul>
      </section>

      <section className="card stack-sm">
        <h2>Historial de sincronización</h2>
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
        <small className="muted">Últimos 30 eventos. Los mensajes repetidos o que no son movimientos no crean nada.</small>
      </section>
    </main>
  );
}
