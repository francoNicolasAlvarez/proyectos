# ADR 0001: Monolito modular

**Estado:** aceptada

**Contexto:** primer producto comercial, equipo reducido, necesidad de iterar rápido y operar poco.

**Decisión:** un único backend desplegable, dividido en módulos con límites claros (sin acceso cruzado a tablas).

**Consecuencias:** despliegue y depuración simples. Los módulos que lo requieran (por ejemplo notificaciones) podrán extraerse más adelante. Exige disciplina para respetar los límites entre módulos.
