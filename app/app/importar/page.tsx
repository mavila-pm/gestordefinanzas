import { ImportForm } from '../../../components/import-form';

export default function ImportPage() {
  return (
    <main className="stack narrow-md">
      <h1>Importar mensaje del banco</h1>
      <p className="muted">Pega un SMS o el texto de un correo de tu banco. Lo leemos con las mismas reglas que la captura automática
        (tipo, monto, tarjeta, comercio, duplicados) y queda en “Por revisar” para que lo confirmes. No guardamos el texto pegado.</p>
      <p className="muted small">Por ahora reconocemos notificaciones del BCP. Los formatos aún se están validando con mensajes reales:
        si algo no cuadra, corrígelo en la revisión.</p>
      <ImportForm />
    </main>
  );
}
