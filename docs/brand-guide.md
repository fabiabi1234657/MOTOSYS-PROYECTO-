# Guía de marca MotoSys

El [logotipo original](../clients/web/public/motosys.svg) representa una motocicleta trazada sobre un cuadrado ámbar. En la Web aparece junto al nombre MotoSys. El nombre de la aplicación móvil se presenta en las pantallas de acceso y panel.

| Función | Color | Uso |
| --- | --- | --- |
| Primario | `#F59E0B` | Acción principal y selección con texto tinta |
| Tinta y superficie oscura | `#0F172A` | Texto, navegación y tarjeta móvil |
| Fondo | `#F8FAFC` | Superficie general |
| Éxito | `#10B981` | Indicador acompañado de confirmación escrita |
| Alerta | `#F97316` | Acontecimiento que requiere atención |
| Error | `#EF4444` | Indicador de error con texto oscuro de apoyo `#A31528` |
| Información | `#0EA5E9` | Indicador informativo y foco con variante oscura `#0369A1` |

Inter es la tipografía de la interfaz Web. JetBrains Mono se usa en rótulos y magnitudes. La escala base es 12–14 px para ayudas, 16 px para texto y 24–48 px para títulos. La escala de espaciado parte de 4 px y agrupa 8, 12, 16 y 24 px. Los controles principales tienen al menos 44 px de alto. Android carga Inter y JetBrains Mono como fuentes empaquetadas y usa el mismo símbolo en PNG.

La navegación conserva etiquetas visibles junto a los iconos. El estado de carga desactiva la acción activa. El vacío explica que la consulta no devolvió registros. Los errores de campo se muestran bajo su etiqueta. El éxito se comunica por texto. La cola móvil muestra cantidad de registros pendientes y distingue los conflictos retenidos. Se utiliza foco visible y anuncio de estado en la Web. La implementación está orientada a WCAG 2.2 AA y queda pendiente una auditoría completa de conformidad.


## Contraste calculado

| Uso | Texto | Fondo | Relación |
| --- | --- | --- | ---: |
| Texto base | #0F172A | #F8FAFC | 17.06:1 |
| Botón primario | #0F172A | #F59E0B | 8.31:1 |
| Texto secundario | #475569 | #F8FAFC | 7.24:1 |
| Error de campo | #A31528 | #FFFFFF | 7.79:1 |
