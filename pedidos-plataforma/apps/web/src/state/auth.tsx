import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api/client';
import type { User } from '../api/types';

interface AuthValue {
  user: User | null;
  /** false mientras se consulta la sesión por primera vez. */
  ready: boolean;
  refresh: () => Promise<User | null>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const u = await api.me();
      setUser(u);
      return u;
    } catch (e) {
      // 401 = sin sesión (normal). Un corte de red tampoco debe romper la app.
      if (!(e instanceof ApiError)) throw e;
      setUser(null);
      return null;
    } finally {
      setReady(true);
    }
  }, []);

  const logout = useCallback(async () => {
    try { await api.logout(); } catch { /* si falla el aviso, igual se limpia la sesión local */ }
    setUser(null);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const value = useMemo(() => ({ user, ready, refresh, logout }), [user, ready, refresh, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth debe usarse dentro de <AuthProvider>');
  return v;
}

/** Solo permite volver a rutas internas (evita redirecciones a sitios externos). */
export function safeNext(next: string | null | undefined): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') ? next : '/';
}
