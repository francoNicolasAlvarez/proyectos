import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { errorMessage } from '../lib/messages';
import { safeNext, useAuth } from '../state/auth';

export function LoginPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const nav = useNavigate();
  const { refresh } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      await api.login({ email, password });
      await refresh();
      nav(next, { replace: true });
    } catch (err) { setError(errorMessage(err)); setBusy(false); }
  };

  return (
    <main className="page narrow">
      <h1>Iniciar sesión</h1>
      <form onSubmit={submit} noValidate>
        <label className="field">Email
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">Contraseña
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p role="alert" className="notice err">{error}</p>}
        <button className="btn primary block" disabled={busy || !email || !password}>{busy ? 'Ingresando…' : 'Ingresar'}</button>
      </form>
      <p className="center">¿No tenés cuenta? <Link to={`/registro?next=${encodeURIComponent(next)}`}>Creá una</Link></p>
    </main>
  );
}

export function RegisterPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const nav = useNavigate();
  const { refresh } = useAuth();
  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '' });
  const [adult, setAdult] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      await api.register({ name: form.name, email: form.email, password: form.password, phone: form.phone || null, adultDeclared: adult });
      await api.login({ email: form.email, password: form.password });
      await refresh();
      nav(next, { replace: true });
    } catch (err) { setError(errorMessage(err)); setBusy(false); }
  };

  return (
    <main className="page narrow">
      <h1>Crear cuenta</h1>
      <form onSubmit={submit} noValidate>
        <label className="field">Nombre
          <input autoComplete="name" required value={form.name} onChange={set('name')} />
        </label>
        <label className="field">Email
          <input type="email" autoComplete="email" required value={form.email} onChange={set('email')} />
        </label>
        <label className="field">Teléfono (opcional)
          <input type="tel" autoComplete="tel" value={form.phone} onChange={set('phone')} />
        </label>
        <label className="field">Contraseña
          <input type="password" autoComplete="new-password" required minLength={8} value={form.password} onChange={set('password')} />
          <small className="muted">Al menos 8 caracteres y distinta de tu email.</small>
        </label>
        <label className="opt check">
          <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} />
          <span>Declaro que soy mayor de 18 años.</span>
        </label>
        {error && <p role="alert" className="notice err">{error}</p>}
        <button className="btn primary block" disabled={busy || !adult || !form.name || !form.email || form.password.length < 8}>
          {busy ? 'Creando…' : 'Crear cuenta'}
        </button>
      </form>
      <p className="center">¿Ya tenés cuenta? <Link to={`/login?next=${encodeURIComponent(next)}`}>Iniciá sesión</Link></p>
    </main>
  );
}
