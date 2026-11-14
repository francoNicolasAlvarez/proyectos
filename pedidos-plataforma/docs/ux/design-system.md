# Sistema de diseño (Etapa 4)

**Marca:** Pasamanos. Identidad minimalista en azules y violetas sobre fondos blancos.

## 1. Logo

Una persona simplificada (cabeza y torso) que levanta un plato con cúpula. Marca en blanco sobre cuadrado redondeado con degradado azul a violeta.

- `packages/ui/assets/logo-mark.svg`: solo el símbolo (icono de PWA, favicon).
- `packages/ui/assets/logo-full.svg`: símbolo y nombre. El texto usa la fuente del sistema; **convertirlo a trazados antes de usarlo como logo definitivo**.
- Pendiente: revisar visualmente el símbolo y verificar disponibilidad del nombre "Pasamanos" (registro de marca en INPI y dominio) antes de invertir en la identidad.

## 2. Reglas de marca (plataforma y local)

- **El local manda en su menú:** logo y color principal propios. La plataforma queda discreta ("Hecho con Pasamanos" al pie).
- El panel del local y el super admin usan la identidad de Pasamanos.
- El color del local se aplica solo a acentos (botones, selección, estados). Fondos y texto no cambian.
- El color de cada local debe pasar una verificación de contraste (texto blanco sobre el color, mínimo 4.5:1). Si no pasa, se ajusta o se rechaza al configurarlo.

## 3. Color (tokens)

| Token | Valor | Uso |
|---|---|---|
| `--brand` | `#3451D1` | Azul principal (configurable por local) |
| `--brand-2` | `#6741D9` | Violeta (configurable por local) |
| `--bg` | `#FFFFFF` | Fondo |
| `--surface` | `#F6F7FD` | Zonas de apoyo y tarjetas |
| `--surface-2` | `#ECEEFB` | Chips, seleccionados |
| `--text` | `#1B1F3B` | Texto principal (azul noche) |
| `--muted` | `#565B7C` | Texto secundario |
| `--border` | `#E1E4F4` | Bordes |
| `--ok` / `--ok-bg` | `#17794A` / `#E7F6EE` | Éxito |
| `--warn` / `--warn-bg` | `#7A4B00` / `#FFF4DD` | Aviso |
| `--err` / `--err-bg` | `#B3261E` / `#FDECEA` | Error |

Reglas: el significado nunca depende solo del color (siempre texto o icono). Texto sobre blanco con contraste de al menos 4.5:1. Solo modo claro en el MVP.

## 4. Tipografía y espacio

Inter (con respaldo a fuentes del sistema). Cuerpo 16 px, títulos 18 a 22 px, apoyo 13 a 14 px. Espaciado en múltiplos de 4 u 8. Radios de 12 a 16 px. Márgenes laterales de 16 px y sin scroll horizontal.

## 5. Componentes base

Botón primario (degradado) y secundario, tarjeta de producto, chip de categoría, hoja inferior (producto, ubicación), selector de opciones (radio o casilla), selector de cantidad, barra de carrito, aviso (info, éxito, error), línea de pasos de estado, tarjeta de retiro (QR y código), aviso temporal (toast), estados vacío, de carga y de error.

## 6. Accesibilidad

- Áreas táctiles de al menos 44 px.
- Foco visible, etiquetas en botones de icono, roles `radio`, `checkbox` y `dialog`, cierre con Escape.
- Respeta `prefers-reduced-motion`.
- Los estados importantes se anuncian a lectores de pantalla (`aria-live`).
- Código de retiro grande, legible y con espaciado, y siempre disponible junto al QR.

## 7. Textos clave

- Origen: "Solo para ubicarte. El pedido se retira en la barra."
- Retiro: "Retirá tu pedido en {punto}."
- Varios puntos: "Tu pedido se retira en N puntos. Cada parte tiene su propio QR."
- Rechazo: motivo en lenguaje claro y "Iniciamos el reembolso de $X".
- Estados: Pago aprobado · Esperando al local · Pedido aceptado · En preparación · Listo para retirar · Entregado.

## 8. Modo oscuro y movimiento (actualización)

**Modo oscuro.** Sigue la preferencia del sistema (`prefers-color-scheme: dark`) y se puede forzar el claro con `data-theme="light"`. Los tokens se redefinen en `:root:not([data-theme="light"])`. El color de texto de acento es `--accent-text`: igual a la marca en claro y más claro en oscuro, para mantener contraste 4.5:1. Cada pantalla se valida con axe (WCAG 2.1 A/AA) también en oscuro.

**Elevación y movimiento.** Tokens `--elev-1`, `--elev-2` y `--ease`. Regla: el movimiento tiene propósito y ocurre una sola vez.
- La hoja de producto anima solo al abrirse, no al elegir opciones.
- La barra de carrito rebota solo tras agregar un producto.
- El cambio de pantalla hace un fundido corto que se retira solo.
- Seguimiento: barra de avance (`role="progressbar"`), tarjeta de retiro que "respira" y confeti al entregar.
- Con `prefers-reduced-motion` no queda ninguna animación activa y el confeti se oculta (verificado con `document.getAnimations()`).

**Panel del local.**
- Envejecimiento del pedido nuevo: normal hasta 2 min, ámbar de 2 a 4 min, rojo desde 4 min (la aceptación vence a los 5).
- El pedido recién llegado se resalta 6 segundos; los que ya estaban al abrir el panel no cuentan como nuevos.
- Sonido de aviso: apagado por defecto, lo activa el personal (se recuerda en el navegador) y suena solo ante pedidos nuevos.
- Columnas con un punto de color por estado y estado vacío con icono.

Pruebas: `apps/e2e/tests/visual-customer.spec.js` y `visual-panel.spec.js`.
