# Ecovermic Backend: Documentación de la API

API REST. Esta guía describe los endpoints actuales con la información necesaria para consumirlos desde cualquier lenguaje o IA. La documentación funcional de VERMI APP describe objetivos y funcionalidades futuras; no todas están implementadas en este backend.

## Convenciones generales

- **Base URL:** `http://<HOST>:<PORT>` (por defecto `http://127.0.0.1:3000`). Configurable con `HOST` y `PORT` en `.env`.
- **Formato:** los endpoints documentados esperan un cuerpo JSON de tipo objeto con `Content-Type: application/json` y devuelven JSON. Una ruta o método no reconocido recibe la respuesta `404` predeterminada de Express, que no sigue necesariamente el formato JSON de la API.
- **Autenticación:** `POST /users/login` devuelve un JWT firmado con HS256 que expira en 7 días. El claim `sub` contiene el identificador del usuario como texto. Las rutas de dispositivos de desarrollo requieren `Authorization: Bearer <token>` y una cuenta confirmada.
- **Texto y correos:** el correo se normaliza (sin espacios en los extremos y en minúsculas). Los mensajes de error están en español.

### Registro de peticiones

El registro HTTP de consola registra cada petición al recibirla y su resultado al terminar o cerrarse la conexión; ambas entradas comparten un identificador. Muestra el método y el endpoint solicitado cuando coincide con uno de los endpoints conocidos; las rutas desconocidas se ocultan para evitar exponer datos en la URL. El resultado incluye la ruta procesada, el estado HTTP y la duración.

El cuerpo JSON interpretado se muestra con todos sus valores ocultos: se conservan los nombres de los campos conocidos y la estructura de objetos y arreglos, con límites de profundidad y tamaño; los demás nombres de campos se ocultan. Si el cuerpo no pudo interpretarse, se indica como no disponible. Los parámetros de consulta se ocultan por completo y no se registran los encabezados. El registro no muestra el texto crudo sin redactar. Para el resultado se muestran `emailSent` cuando está presente y los códigos de error, sin el cuerpo de respuesta. Otros registros del servidor pueden incluir datos sensibles: sin SMTP, el módulo de correo imprime el destinatario y el código de confirmación en consola.

### Formato de errores

Los errores JSON gestionados por los endpoints y el middleware de errores tienen esta estructura:

```json
{
  "error": {
    "code": "CODIGO_ESTABLE",
    "message": "Mensaje legible",
    "fields": {
      "campo": { "code": "CODIGO_DEL_CAMPO", "message": "Mensaje del campo" }
    }
  }
}
```

- `code` es estable y apto para lógica del cliente; `message` es para mostrar al usuario.
- `fields` solo aparece en errores de validación o de correo duplicado.

### Errores generales

| HTTP | code | Cuándo |
|---|---|---|
| 400 | `INVALID_JSON` | El JSON está mal formado o es un valor primitivo, como `null`, una cadena o un número; el parser de Express solo acepta objetos y arreglos. |
| 400 | `INVALID_BODY` | El cuerpo no fue interpretado como JSON o es un arreglo, en cualquiera de los endpoints documentados. |
| 500 | `INTERNAL_ERROR` | Error no tratado por el servidor, incluidos errores del parser distintos de `entity.parse.failed`, como un cuerpo que supera el límite predeterminado de 100 KB. |

Las rutas o métodos no reconocidos responden `404` con el manejador predeterminado de Express, no con el formato de error anterior. Un cuerpo vacío con `Content-Type: application/json` se interpreta como `{}` y produce errores de validación de campos obligatorios.

## Vinculación de dispositivos (solo desarrollo)

Esta función está **desactivada por defecto**. Para una instancia de pruebas
aislada, iniciarla con la variable `DEV_DEVICE_LINKING=true`. Usar HTTPS para
la conexión de la app al backend y configurar `AUTH_SECRET` estable; de otro
modo los tokens caducan al reiniciar el servidor. No habilitarla en producción.

La MAC eFuse del QR es pública y el backend no verifica el dispositivo ni la
conexión Wi-Fi: cualquier cuenta autenticada que conozca el ID puede reclamarlo.
BLE sin PoP tampoco lo autentica. El bloqueo exclusivo no es prueba de
propiedad; para producción se requiere autenticación criptográfica del equipo y
un procedimiento de transferencia de propiedad.

* `POST /devices/claim`: con el JWT de la cuenta, cuerpo
  `{"deviceId":"F4E065A84320"}` (12 hexadecimales mayúsculos). Retorna
  `{"deviceId":"F4E065A84320","linked":true,"mode":"development"}`.
  Repetir la solicitud con la misma cuenta es idempotente. Otra cuenta recibe
  HTTP 409 `DEVICE_ALREADY_LINKED`.
* `GET /devices`: devuelve `{"devices":[{"deviceId":"F4E065A84320"}],"mode":"development"}`
  solo para la cuenta autenticada.
* Sin token válido o con cuenta no confirmada: HTTP 401 `UNAUTHORIZED`; ID
  inválido: HTTP 400 `INVALID_DEVICE_ID`; función desactivada: HTTP 404
  `NOT_AVAILABLE`.

Los registros se guardan en la tabla `dev_device_links`, separados de un
eventual mecanismo seguro de producción. No existe aún una API de transferencia
o desvinculación. No envíes credenciales ni tokens a los logs.

## Reglas de negocio por edad

| Caso | Acceso |
|---|---|
| 18 años o más | Acceso completo (registro, monedas, publicar productos, aceptar ofertas, canjes presenciales), sujeto a los términos de la plataforma. |
| Menor de 18 años | Acceso limitado: sin canjes presenciales ni publicación de productos / aceptación de ofertas. Requiere definir la intervención del representante legal. |
| Edad no verificada | Se bloquean los canjes que requieren mayoría de edad hasta verificar. |

Estas reglas se reflejan en el objeto `access`, pero todavía no existen endpoints de monedas, publicación de productos, ofertas o canjes que las apliquen. La intervención del representante legal aún no está implementada.

La edad declarada en el registro **no está verificada** (`ageVerified: false`). Por eso todo usuario nuevo tiene `canRedeemInPerson: false`. Actualmente no existe un endpoint para verificar la edad. Para usuarios anteriores sin edad registrada, el login calcula el acceso usando `0` como edad; esto produce `level: "limited"` y `requiresLegalGuardian: true`.

### Objeto `access`

Se devuelve en el registro (paso 2) y en el login.

```json
{
  "level": "full",
  "canRedeemInPerson": false,
  "canPublishAndAcceptOffers": true,
  "requiresLegalGuardian": false,
  "ageVerified": false
}
```

| Campo | Tipo | Significado |
|---|---|---|
| `level` | `"full"` \| `"limited"` | `full` si la edad declarada es al menos 18, `limited` en caso contrario; no depende de la verificación. |
| `canRedeemInPerson` | boolean | Mayor de edad **y** edad verificada. |
| `canPublishAndAcceptOffers` | boolean | `true` si la edad declarada es al menos 18, incluso si no está verificada. |
| `requiresLegalGuardian` | boolean | `true` para menores. |
| `ageVerified` | boolean | Si la edad fue verificada. |

## Flujo de registro y acceso

```
1. POST /users/register          -> registrationToken   (válido 1 hora)
2. POST /users/register/profile  -> crea el usuario e intenta enviar el correo de confirmación
3. POST /users/confirm          -> confirma el correo con el código de 6 dígitos recibido por correo (válido 15 minutos)
   POST /users/confirm/resend   -> (opcional) envía un código nuevo
4. POST /users/login             -> JWT (solo con el correo confirmado)
```

El usuario **no existe** hasta completar el paso 2. Si repites el paso 1 con el mismo correo, el registro pendiente anterior se reemplaza y su token deja de valer. El paso 2 puede crear la cuenta aunque falle el envío del correo.

---

## `POST /users/register`: Paso 1 del registro

Valida correo y contraseña y guarda un registro pendiente. No crea el usuario.

### Cuerpo

| Campo | Tipo | Reglas |
|---|---|---|
| `email` | string | Obligatorio. Regex `^[^\s@]+@[^\s@]+\.[^\s@]+$`, máximo 254 caracteres. |
| `password` | string | Obligatorio. Regex `^(?=.*[A-Za-z])(?=.*[0-9]).{8,128}$` (8 a 128 caracteres, al menos una letra y un número). |

El correo se valida después de retirar espacios en los extremos; la contraseña se valida y procesa sin recortarla ni normalizarla. La expresión de contraseña no admite saltos de línea.

```json
{ "email": "ana@correo.com", "password": "Clave1234" }
```

### Respuesta `201 Created`

```json
{ "registrationToken": "3f9c...(64 hex)", "email": "ana@correo.com" }
```

Guarda `registrationToken` para el paso 2.

### Errores

| HTTP | code | Detalle |
|---|---|---|
| 400 | `VALIDATION_ERROR` | `fields.email` con `EMAIL_REQUIRED` o `EMAIL_INVALID`; `fields.password` con `PASSWORD_REQUIRED` o `PASSWORD_INVALID`. |
| 409 | `EMAIL_ALREADY_REGISTERED` | Ya existe un usuario con ese correo. Incluye `fields.email`. |

---

## `POST /users/register/profile`: Paso 2 del registro

Valida el perfil, crea el usuario (sin verificar) y envía el correo de confirmación.

### Cuerpo

| Campo | Tipo | Reglas |
|---|---|---|
| `registrationToken` | string | Obligatorio. El token del paso 1. |
| `name` | string | Obligatorio. Nombre o apodo, de 2 a 30 caracteres después de retirar los espacios en los extremos. |
| `age` | number | Obligatorio. Entero entre 1 y 120. Debe enviarse como número JSON, no como texto. |
| `gender` | string | Obligatorio. Exactamente uno de: `Mujer`, `Hombre`, `No binario`, `Otro`. |
| `countryCode` | string | Obligatorio. Se retiran los espacios en los extremos y se valida con `^\+[1-9][0-9]{0,3}$` (ejemplo `+52`). |
| `phone` | string | Obligatorio. Después de retirar espacios en los extremos, exactamente 10 dígitos (`^[0-9]{10}$`), independientemente del país. Enviar como texto. |

```json
{
  "registrationToken": "3f9c...",
  "name": "Ana",
  "age": 25,
  "gender": "Mujer",
  "countryCode": "+52",
  "phone": "5512345678"
}
```

### Respuesta `201 Created`

```json
{
  "id": 1,
  "email": "ana@correo.com",
  "emailSent": true,
  "access": {
    "level": "full",
    "canRedeemInPerson": false,
    "canPublishAndAcceptOffers": true,
    "requiresLegalGuardian": false,
    "ageVerified": false
  }
}
```

Si la cuenta se creó pero el correo no se pudo enviar, la respuesta sigue siendo `201` con `"emailSent": false` y un campo `"warning"`.

Sin `SMTP_HOST`, se imprime el correo en la consola y `emailSent` es `true`, aunque no se haya enviado por SMTP.

### Errores

| HTTP | code | Detalle |
|---|---|---|
| 400 | `VALIDATION_ERROR` | `fields` con códigos por campo: `TOKEN_REQUIRED`, `NAME_REQUIRED`, `NAME_INVALID`, `AGE_REQUIRED`, `AGE_INVALID`, `GENDER_REQUIRED`, `GENDER_INVALID`, `COUNTRY_CODE_REQUIRED`, `COUNTRY_CODE_INVALID`, `PHONE_REQUIRED`, `PHONE_INVALID`. |
| 401 | `REGISTRATION_TOKEN_INVALID` | El token no existe (o ya se usó). |
| 410 | `REGISTRATION_EXPIRED` | El token expiró (más de 1 hora). Reiniciar desde el paso 1. |
| 409 | `EMAIL_ALREADY_REGISTERED` | El correo ya fue registrado entre el paso 1 y el 2. |

Tras responder `REGISTRATION_EXPIRED`, el registro pendiente se elimina; un intento posterior con el mismo token devuelve `REGISTRATION_TOKEN_INVALID`.

---

## `POST /users/confirm`: Confirmar correo con código

El usuario recibe por correo un código de **6 dígitos numéricos** (válido 15 minutos) y lo envía junto con su correo. Marca la cuenta como verificada e invalida el código. Tras 5 intentos fallidos el código se bloquea y hay que pedir uno nuevo.

### Cuerpo

| Campo | Tipo | Reglas |
|---|---|---|
| `email` | string | Obligatorio. Correo con el que se registró. |
| `code` | string | Obligatorio. Después de retirar los espacios en los extremos, exactamente 6 dígitos (`^[0-9]{6}$`). Enviar como texto para conservar ceros iniciales (`"004821"`). |

```json
{ "email": "ana@correo.com", "code": "482913" }
```

### Respuesta `200 OK`

```json
{ "message": "Cuenta confirmada correctamente" }
```

Si la cuenta ya estaba confirmada responde `200` con `"La cuenta ya estaba confirmada"`.

### Errores

| HTTP | code | Detalle |
|---|---|---|
| 400 | `VALIDATION_ERROR` | `fields.email` (`EMAIL_REQUIRED`) o `fields.code` (`CODE_REQUIRED`, `CODE_INVALID_FORMAT`). |
| 400 | `CONFIRMATION_CODE_INVALID` | Código incorrecto, o correo sin código pendiente (mismo error para no revelar qué cuentas existen). Cada código incorrecto cuenta como un intento. |
| 410 | `CONFIRMATION_CODE_EXPIRED` | El código expiró. Solicitar uno nuevo. |
| 429 | `TOO_MANY_ATTEMPTS` | 5 intentos fallidos. Solicitar un código nuevo. |

El quinto intento incorrecto aún devuelve `CONFIRMATION_CODE_INVALID`; los intentos posteriores devuelven `TOO_MANY_ATTEMPTS`. Solo se cuentan los códigos con formato válido que se comparan con un código pendiente y vigente.

---

## `POST /users/confirm/resend`: Reenviar código

Genera y envía un código nuevo (el anterior deja de valer y los intentos se reinician). Espera mínima de 60 segundos entre envíos.

### Cuerpo

| Campo | Tipo | Reglas |
|---|---|---|
| `email` | string | Obligatorio. |

```json
{ "email": "ana@correo.com" }
```

### Respuesta `200 OK`

```json
{ "message": "Si la cuenta existe y no está confirmada, se envió un código nuevo" }
```

Esta respuesta `200` se devuelve tanto si la cuenta no existe o ya está confirmada como si se procesa correctamente un nuevo envío. Para una cuenta existente sin confirmar, también pueden responderse los errores `RESEND_TOO_SOON` o `EMAIL_SEND_FAILED`.

### Errores

| HTTP | code | Detalle |
|---|---|---|
| 400 | `VALIDATION_ERROR` | `fields.email` (`EMAIL_REQUIRED`). |
| 429 | `RESEND_TOO_SOON` | Pasaron menos de 60 segundos desde el último envío. |
| 502 | `EMAIL_SEND_FAILED` | No se pudo enviar el correo. |

El código anterior se invalida y se inicia el período de espera antes de intentar el envío. Si este falla, se devuelve `502` y hay que esperar antes de solicitar otro código.

---
## `POST /users/login`: Iniciar sesión

### Cuerpo

| Campo | Tipo | Reglas |
|---|---|---|
| `email` | string | Obligatorio. |
| `password` | string | Obligatorio. |

```json
{ "email": "ana@correo.com", "password": "Clave1234" }
```

### Respuesta `200 OK`

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": 1,
    "email": "ana@correo.com",
    "name": "Ana",
    "access": {
      "level": "full",
      "canRedeemInPerson": false,
      "canPublishAndAcceptOffers": true,
      "requiresLegalGuardian": false,
      "ageVerified": false
    }
  }
}
```

El token se entrega al cliente, pero actualmente ningún endpoint lo solicita ni verifica.

### Errores

| HTTP | code | Detalle |
|---|---|---|
| 400 | `VALIDATION_ERROR` | `fields.email` (`EMAIL_REQUIRED`) o `fields.password` (`PASSWORD_REQUIRED`). |
| 401 | `INVALID_CREDENTIALS` | Correo inexistente o contraseña incorrecta (mismo mensaje en ambos casos a propósito). |
| 403 | `ACCOUNT_NOT_VERIFIED` | Credenciales correctas pero el correo no está confirmado. |

---

## Ejemplos con curl

```bash
# 1. Paso 1
curl -X POST http://127.0.0.1:3000/users/register \
  -H "Content-Type: application/json" \
  -d '{"email":"ana@correo.com","password":"Clave1234"}'

# 2. Paso 2 (usa el registrationToken recibido)
curl -X POST http://127.0.0.1:3000/users/register/profile \
  -H "Content-Type: application/json" \
  -d '{"registrationToken":"<TOKEN>","name":"Ana","age":25,"gender":"Mujer","countryCode":"+52","phone":"5512345678"}'

# 3. Confirmar (código de 6 dígitos del correo)
curl -X POST http://127.0.0.1:3000/users/confirm \
  -H "Content-Type: application/json" \
  -d '{"email":"ana@correo.com","code":"482913"}'

# 4. Login
curl -X POST http://127.0.0.1:3000/users/login \
  -H "Content-Type: application/json" \
  -d '{"email":"ana@correo.com","password":"Clave1234"}'
```

## Ejemplo en JavaScript (fetch)

```js
const res = await fetch("http://127.0.0.1:3000/users/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
});
const data = await res.json();
if (!res.ok) {
  // data.error.code para la lógica, data.error.message para mostrar
  throw new Error(data.error.message);
}
const { token } = data;
```

## Configuración del servidor (`.env`)

| Variable | Descripción |
|---|---|
| `HOST`, `PORT` | Dirección y puerto (por defecto `127.0.0.1` y `3000`). |
| `AUTH_SECRET` | Secreto para firmar los JWT. Se recomienda configurarlo en producción; si falta se usa uno temporal y los tokens se invalidan al reiniciar. El servidor no lo exige. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Envío de correo. Deben estar disponibles en el entorno del proceso antes de iniciar la aplicación; el módulo de correo lee estas variables antes de que la aplicación cargue `.env`. Sin `SMTP_HOST`, el destinatario y el código se imprimen en consola en lugar de enviarse. `SMTP_PORT` es `587` por defecto y utiliza conexión segura directa cuando vale `465`. El remitente es `MAIL_FROM` o, si no está definido, `SMTP_USER`. |

La aplicación carga `.env` con `process.loadEnvFile()` y requiere que exista el archivo en el directorio de trabajo. Para que las variables SMTP de ese archivo estén disponibles antes de importar el módulo de correo, se puede iniciar con `node --env-file=.env main.mts`.

## Alcance frente a la documentación funcional

- El backend actual no registra consentimientos, versiones de términos ni el país completo: el perfil solo recibe la clave de país y un teléfono de 10 dígitos, sin longitud variable por país.
- La recuperación de contraseña y la limitación de intentos de inicio de sesión no están implementadas. La limitación documentada corresponde únicamente al código de confirmación.
- Las contraseñas se almacenan con scrypt y sal; la documentación funcional recomienda Argon2id o bcrypt.
- Dispositivos, residuos, entregas de humus, billetera, recompensas y canjes todavía no cuentan con endpoints ni tablas en este backend.

## Modelo de datos (SQLite, `ecovermic.db`)

- **`users`**: `id`, `email` (único), `password_hash` (scrypt con sal), `created_at`, `name`, `age`, `gender`, `country_code`, `phone`, `email_verified`, `age_verified`, `confirmation_code_hash`, `confirmation_expires_at`, `confirmation_attempts`, `confirmation_sent_at`.
- **`pending_registrations`**: `email` (clave), `password_hash`, `token_hash`, `expires_at`.

El token de registro se almacena como hash SHA-256. El código de confirmación se almacena como hash SHA-256 de `correo_normalizado:código`, no en texto plano.
