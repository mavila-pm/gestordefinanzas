import { ImportForm } from '../../../components/import-form';

export const metadata = { title: 'Pegar mensaje' };

export default function ImportPage() {
  return (
    <main className="stack narrow-md">
      <div className="page-head">
        <h1>Pegar un mensaje del banco</h1>
        <p>Pega el SMS o el correo. Lo leemos y lo dejamos en Por revisar. No guardamos el texto.</p>
      </div>
      <ImportForm />
      <p className="muted small">Por ahora leemos avisos del BCP. Si algo no cuadra, lo corriges al revisar.</p>
    </main>
  );
}
