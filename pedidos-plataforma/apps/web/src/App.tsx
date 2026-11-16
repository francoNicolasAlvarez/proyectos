import { Link, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { LoginPage, RegisterPage } from './pages/AuthPages';
import { CartPage } from './pages/CartPage';
import { MenuPage, VenueShell } from './pages/MenuPage';
import { OrderPage } from './pages/OrderPage';
import { useAuth } from './state/auth';

function Layout() {
  const { user, logout } = useAuth();
  return (
    <>
      <a className="skip" href="#main">Ir al contenido</a>
      <header className="top">
        <Link to="/" className="brand"><img src="/logo-mark.svg" alt="" width="32" height="32" /><strong>Pasamanos</strong></Link>
        <nav aria-label="Cuenta">
          {user ? <><span className="muted small">{user.name}</span> <button type="button" className="btn link" onClick={() => void logout()}>Salir</button></>
            : <Link to="/login">Ingresar</Link>}
        </nav>
      </header>
      <div id="main"><Outlet /></div>
    </>
  );
}

function Home() {
  return (
    <main className="page narrow center">
      <img src="/logo-mark.svg" alt="" width="72" height="72" />
      <h1>Pedí y pagá desde tu celular</h1>
      <p className="muted">Escaneá el QR de tu mesa o de la barra para ver el menú del local.</p>
      <p><Link className="btn primary" to="/v/el-faro">Probar con el local de demostración</Link></p>
    </main>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Home />} />
        <Route path="/v/:slug" element={<VenueShell />}>
          <Route index element={<MenuPage />} />
          <Route path="carrito" element={<CartPage />} />
        </Route>
        <Route path="/orders/:id" element={<OrderPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/registro" element={<RegisterPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
