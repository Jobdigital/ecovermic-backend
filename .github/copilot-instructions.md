# Reglas de negocio por edad (aplican a todo el desarrollo)

- **18 años o más:** acceso completo. Registro, acumulación de monedas, publicación de productos, aceptación de ofertas y canjes presenciales, sujetos a los términos de la plataforma.
- **Menores de 18 años:** acceso limitado (sí se admiten). Las funciones permitidas y la intervención del representante legal deben definirse expresamente. No habilitar canjes presenciales independientes entre menores y adultos sin una evaluación jurídica específica.
- **Edad no verificada o información contradictoria:** bloquear temporalmente las funciones de canje que requieran mayoría de edad hasta resolver la verificación.

Cualquier endpoint de canje, oferta o publicación debe consultar `getAccess` de `#Application/access` en lugar de comparar la edad directamente.
