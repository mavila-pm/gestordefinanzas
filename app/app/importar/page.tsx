import { ImportForm } from '../../../components/import-form';

export const metadata = { title: 'Pegar mensaje' };

export default function ImportPage() {
  return (
    <main className="stack narrow-md">
      <div className="page-head">
        <h1>Pegar un mensaje del banco</h1>
        <p>Copia el SMS o el correo y pégalo aquí. Lo leemos y queda en Por revisar para que lo confirmes. No guardamos el texto.</p>
      </div>
      <ImportForm />
      <p className="muted small">Por ahora leemos notificaciones del BCP. Si algo no cuadra, lo corriges al revisarlo.</p>
    </main>
  );
}
