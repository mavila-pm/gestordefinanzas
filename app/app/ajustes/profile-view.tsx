import { ActionForm } from '../../../components/action-form';
import { ProfileFields } from '../../../components/profile-fields';
import { Avatar, SettingsRow, SettingsSection } from '../../../components/settings';
import { Sheet } from '../../../components/ui/sheet';
import { longDate } from '../../../src/domain/dates';
import { preferredName, presentName } from '../../../src/domain/profile';
import { saveProfileAction } from '../actions';
import { saveDisplayNameAction } from './actions';

export interface ProfileData {
  givenNames: string | null; familyNames: string | null; displayName: string | null;
  email: string | null; emailVerified: boolean; phone: string | null; birthDate: string | null;
}

/** "m***@gmail.com": enough to recognise it, not to read it over a shoulder. */
export const maskEmail = (e: string) => e.replace(/^(.)[^@]*(@.*)$/, '$1***$2');
/** "+51 ••• ••• 248". */
export const maskPhone = (p: string) => `${p.slice(0, 3)} ••• ••• ${p.slice(-3)}`;

export function ProfileView({ p }: { p: ProfileData }) {
  const name = preferredName(p);
  const full = [p.givenNames, p.familyNames].filter(Boolean).map((v) => presentName(v!)).join(' ');
  return (
    <>
      <div className="row" style={{ justifyContent: 'flex-start', gap: 16 }}>
        <Avatar name={name} size={56} />
        <div><strong style={{ fontSize: 18 }} data-testid="profile-name">{full || name || 'Sin nombre'}</strong>{p.email && <p className="muted small">{maskEmail(p.email)}</p>}</div>
      </div>
      <SettingsSection title="Tus datos" testId="profile-data">
        <SettingsRow label="Nombre" value={p.givenNames ? presentName(p.givenNames) : '—'} />
        <SettingsRow label="Apellidos" value={p.familyNames ? presentName(p.familyNames) : '—'} />
        <SettingsRow label="Cómo te llama Vels" value={<span data-testid="vels-name">{name ?? '—'}</span>}
          action={<DisplayNameSheet current={name} />} />
        <SettingsRow label="Correo" value={p.email ? <span data-testid="profile-email">{maskEmail(p.email)}</span> : '—'} hint={p.emailVerified ? 'Verificado' : 'Sin verificar'} />
        <SettingsRow label="Teléfono" value={p.phone ? maskPhone(p.phone) : '—'} />
        <SettingsRow label="Fecha de nacimiento" value={p.birthDate ? `${longDate(p.birthDate)} de ${p.birthDate.slice(0, 4)}` : '—'} />
      </SettingsSection>
      <div>
        <Sheet label="Editar nombres" triggerClassName="button quiet" title="Tus nombres" testId="profile-sheet" triggerLabel="Editar perfil">
          <div className="sheet-body">
            <ActionForm action={saveProfileAction} label="Perfil" closeOnSuccess>
              <ProfileFields givenNames={p.givenNames ?? ''} familyNames={p.familyNames ?? ''} displayName={p.displayName ?? ''} />
              <button type="submit" className="wide">Guardar</button>
            </ActionForm>
          </div>
        </Sheet>
      </div>
    </>
  );
}

export function DisplayNameSheet({ current }: { current: string | null }) {
  return (
    <Sheet label="Cambiar" triggerClassName="link small-link" title="Cómo te llama Vels" testId="vels-name-sheet" triggerLabel="Cambiar cómo te llama Vels"
      subtitle="Un nombre corto. Tu nombre completo no cambia.">
      <div className="sheet-body">
        <ActionForm action={saveDisplayNameAction} label="Cómo te llama Vels" closeOnSuccess>
          <label className="stack-sm"><span>Vels te llama</span><input name="displayName" defaultValue={current ?? ''} maxLength={40} autoComplete="nickname" autoCapitalize="words" placeholder="Mauro" /></label>
          <button type="submit" className="wide">Guardar</button>
        </ActionForm>
      </div>
    </Sheet>
  );
}
