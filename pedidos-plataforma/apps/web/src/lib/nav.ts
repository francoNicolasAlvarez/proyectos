/** Salida a un sitio externo (p. ej. la página de pago). Aislada para poder simularla en las pruebas. */
export function redirectTo(url: string): void {
  window.location.assign(url);
}
