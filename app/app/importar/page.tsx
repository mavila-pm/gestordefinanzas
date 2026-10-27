import { ImportForm } from '../../../components/import-form';
import { bankCoverageText } from '../../../src/web/import-input';

export const metadata = { title: 'Pegar mensaje' };

export default function ImportPage() {
  return (
    <main className="stack narrow-md">
      <div className="page-head">
        <h1>Pegar un mensaje del banco</h1>
        <p>Pega el SMS, la notificación de la app o el correo. Lo leemos y lo dejamos en Por revisar. No guardamos el texto.</p>
      </div>
      <ImportForm />
      <p className="muted small">Por ahora leemos avisos de {bankCoverageText()}. Si algo no cuadra, lo corriges al revisar.</p>
    </main>
  );
}
