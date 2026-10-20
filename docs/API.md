# Ecovermic Backend: Documentación de la API

API REST en JSON. Esta guía describe todos los endpoints actuales con la información necesaria para consumirlos desde cualquier lenguaje o IA.

## Convenciones generales

- **Base URL:** `http://<HOST>:<PORT>` (por defecto `http://127.0.0.1:3000`). Configurable con `HOST` y `PORT` en `.env`.
- **Formato:** todas las peticiones con cuerpo deben enviar `Content-Type: application/json`. Todas las respuestas son JSON.
- **Autenticación:** JWT (HS256, expira en 7 días). Se obtiene en `POST /users/login` y se envía en el header `Authorization: Bearer <token>`. El id del usuario va en el claim `sub`. Aún no hay rutas protegidas.
- **Texto y correos:** el correo se normaliza (sin espacios en los extremos y en minúsculas). Los mensajes de error están en español.

### Formato de errores

Todos los errores comparten esta estructura:

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

### Errores globales (cualquier endpoint)

| HTTP | code | Cuándo |
|---|---|---|
| 400 | `INVALID_JSON` | El cuerpo no es un JSON válido. |
| 400 | `INVALID_BODY` | El cuerpo no es un objeto JSON (por ejemplo un arreglo o `null`). |
| 500 | `INTERNAL_ERROR` | Error inesperado del servidor. |

## Reglas de negocio por edad

| Caso | Acceso |
|---|---|
| 18 años o más | Acceso completo (registro, monedas, publicar productos, aceptar ofertas, canjes presenciales), sujeto a los términos de la plataforma. |
| Menor de 18 años | Acceso limitado: sin canjes presenciales ni publicación de productos / aceptación de ofertas. Requiere definir la intervención del representante legal. |
| Edad no verificada | Se bloquean los canjes que requieren mayoría de edad hasta verificar. |

La edad declarada en el registro **no está verificada** (`ageVerified: false`). Por eso todo usuario nuevo tiene `canRedeemInPerson: false`.

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
| `level` | `"full"` \| `"limited"` | `full` si es mayor de edad, `limited` si es menor. |
| `canRedeemInPerson` | boolean | Mayor de edad **y** edad verificada. |
| `canPublishAndAcceptOffers` | boolean | Solo mayores de edad. |
| `requiresLegalGuardian` | boolean | `true` para menores. |
| `ageVerified` | boolean | Si la edad fue verificada. |

## Flujo de registro y acceso

```
1. POST /users/register          -> registrationToken   (válido 1 hora)
2. POST /users/register/profile  -> crea el usuario y envía el correo de confirmación
3. GET  /users/confirm?token=... -> confirma el correo (enlace recibido por correo, válido 24 horas)
4. POST /users/login             -> JWT (solo con el correo confirmado)
```

El usuario **no existe** hasta completar el paso 2. Si repites el paso 1 con el mismo correo, el registro pendiente anterior se reemplaza y su token deja de valer.

---

## `POST /users/register`: Paso 1 del registro

Valida correo y contraseña y guarda un registro pendiente. No crea el usuario.

### Cuerpo

| Campo | Tipo | Reglas |
|---|---|---|
| `email` | string | Obligatorio. Regex `^[^\s@]+@[^\s@]+\.[^\s@]+$`, máximo 254 caracteres. |
| `password` | string | Obligatorio. Regex `^(?=.*[A-Za-z])(?=.*[0-9]).{8,128}$` (8 a 128 caracteres, al menos una letra y un número). |

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
| `name` | string | Obligatorio. Nombre o apodo, de 2 a 30 caracteres (sin espacios en los extremos). |
| `age` | number | Obligatorio. Entero entre 1 y 120. Debe enviarse como número JSON, no como texto. |
| `gender` | string | Obligatorio. Exactamente uno de: `Mujer`, `Hombre`, `No binario`, `Otro`. |
| `countryCode` | string | Obligatorio. Regex `^\+[1-9][0-9]{0,3}$` (ejemplo `+52`). |
| `phone` | string | Obligatorio. Exactamente 10 dígitos (`^[0-9]{10}$`). Enviar como texto. |

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

### Errores

| HTTP | code | Detalle |
|---|---|---|
| 400 | `VALIDATION_ERROR` | `fields` con códigos por campo: `TOKEN_REQUIRED`, `NAME_REQUIRED`, `NAME_INVALID`, `AGE_REQUIRED`, `AGE_INVALID`, `GENDER_REQUIRED`, `GENDER_INVALID`, `COUNTRY_CODE_REQUIRED`, `COUNTRY_CODE_INVALID`, `PHONE_REQUIRED`, `PHONE_INVALID`. |
| 401 | `REGISTRATION_TOKEN_INVALID` | El token no existe (o ya se usó). |
| 410 | `REGISTRATION_EXPIRED` | El token expiró (más de 1 hora). Reiniciar desde el paso 1. |
| 409 | `EMAIL_ALREADY_REGISTERED` | El correo ya fue registrado entre el paso 1 y el 2. |

---

## `GET /users/confirm?token=<token>`: Confirmar correo

El usuario llega aquí desde el enlace del correo (`<APP_URL>/users/confirm?token=...`). Marca la cuenta como verificada y invalida el token.

### Parámetros de consulta

| Parámetro | Tipo | Descripción |
|---|---|---|
| `token` | string | Obligatorio. Token de confirmación recibido por correo. |

### Respuesta `200 OK`

```json
{ "message": "Cuenta confirmada correctamente" }
```

### Errores

| HTTP | code | Detalle |
|---|---|---|
| 400 | `TOKEN_REQUIRED` | Falta el parámetro `token`. |
| 400 | `CONFIRMATION_TOKEN_INVALID` | Token desconocido o ya utilizado. |
| 410 | `CONFIRMATION_TOKEN_EXPIRED` | El enlace expiró (más de 24 horas). |

> Nota: aún no existe un endpoint para reenviar el correo de confirmación.

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

Usa el `token` en las siguientes peticiones: `Authorization: Bearer <token>`.

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

# 3. Confirmar (enlace del correo)
curl "http://127.0.0.1:3000/users/confirm?token=<TOKEN_DEL_CORREO>"

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
| `AUTH_SECRET` | Secreto para firmar los JWT. Obligatorio en producción; si falta se usa uno temporal y los tokens se invalidan al reiniciar. |
| `APP_URL` | URL pública base usada en el enlace del correo de confirmación. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Envío de correo. Sin `SMTP_HOST` el correo se imprime en la consola (desarrollo). |

## Modelo de datos (SQLite, `ecovermic.db`)

- **`users`**: `id`, `email` (único), `password_hash` (scrypt con sal), `created_at`, `name`, `age`, `gender`, `country_code`, `phone`, `email_verified`, `age_verified`, `confirmation_token_hash`, `confirmation_expires_at`.
- **`pending_registrations`**: `email` (clave), `password_hash`, `token_hash`, `expires_at`.

Los tokens de registro y de confirmación se almacenan como hash SHA-256; nunca en texto plano.
